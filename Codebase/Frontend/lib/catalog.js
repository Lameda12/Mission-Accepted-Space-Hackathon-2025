import { json2satrec } from 'satellite.js';

// Wire format for /api/catalog: one array per object, in this field order. The full
// active catalog is ~9 MB as CelesTrak OMM JSON; positional arrays keep it ~2 MB pre-gzip.
export const FIELDS = [
  'NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH',
  'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];

const EARTH_EQ_RADIUS_KM = 6378.137;
const MU_KM3_S2 = 398600.4418;

export function compactOmm(omm) {
  return FIELDS.map((k) => (k === 'NORAD_CAT_ID' ? String(omm[k]) : omm[k]));
}

export function expandOmm(row) {
  const omm = Object.fromEntries(FIELDS.map((k, i) => [k, row[i]]));
  return { ...omm, ELEMENT_SET_NO: 999, EPHEMERIS_TYPE: 0 };
}

// Alpha-5 catalog numbers: a leading letter replaces the first digit (A=10 ... Z=33,
// skipping I and O), extending the 5-column TLE field to 339,999.
export function parseCatalogNumber(field) {
  const s = field.trim();
  if (/^\d+$/.test(s)) return String(Number(s));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const idx = letters.indexOf(s[0].toUpperCase());
  if (idx < 0) throw new Error(`Bad catalog number: ${field}`);
  return String((idx + 10) * 10000 + Number(s.slice(1)));
}

// TLE implied-decimal exponent fields, e.g. " 61896-4" -> 0.61896e-4
function parseExpField(field) {
  const s = field.trim();
  if (!s) return 0;
  const m = s.match(/^([+-]?)(\d+)([+-]\d)$/);
  if (!m) return Number(s);
  return Number(`${m[1]}0.${m[2]}e${m[3]}`);
}

// Convert a TLE pair into the same OMM fields CelesTrak serves
export function tleToOmm(name, tle1, tle2) {
  const yy = Number(tle1.slice(18, 20));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const dayOfYear = Number(tle1.slice(20, 32));
  const epochMs = Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000;

  const intl = tle1.slice(9, 17).trim();
  const launchYy = Number(intl.slice(0, 2));
  const launchYear = launchYy < 57 ? 2000 + launchYy : 1900 + launchYy;

  return {
    NORAD_CAT_ID: parseCatalogNumber(tle1.slice(2, 7)),
    OBJECT_NAME: name,
    OBJECT_ID: intl ? `${launchYear}-${intl.slice(2)}` : '',
    EPOCH: new Date(epochMs).toISOString().replace('Z', ''),
    MEAN_MOTION: Number(tle2.slice(52, 63)),
    ECCENTRICITY: Number(`0.${tle2.slice(26, 33).trim()}`),
    INCLINATION: Number(tle2.slice(8, 16)),
    RA_OF_ASC_NODE: Number(tle2.slice(17, 25)),
    ARG_OF_PERICENTER: Number(tle2.slice(34, 42)),
    MEAN_ANOMALY: Number(tle2.slice(43, 51)),
    BSTAR: parseExpField(tle1.slice(53, 61)),
    MEAN_MOTION_DOT: Number(tle1.slice(33, 43)),
    MEAN_MOTION_DDOT: parseExpField(tle1.slice(44, 52)),
  };
}

// Orbit regime from mean motion (rev/day) and eccentricity
export function orbitRegime(meanMotion, ecc) {
  if (ecc >= 0.25) return 'HEO';
  if (meanMotion >= 11.25) return 'LEO'; // period <= 128 min
  if (meanMotion > 0.95 && meanMotion < 1.05) return 'GEO';
  return 'MEO';
}

export const REGIMES = {
  LEO: { label: 'Low Earth orbit', color: '#4fd1ff' },
  MEO: { label: 'Medium Earth orbit', color: '#7cff8a' },
  GEO: { label: 'Geosynchronous', color: '#ffb547' },
  HEO: { label: 'Highly elliptical', color: '#ff5fa2' },
};

// Build client records from the wire format, in row order (the propagation worker uses
// the same order). The SGP4 satrec is created on first access: parsing ~15k objects up
// front would stall the main thread, and only selected objects need one here.
export function buildRecords(rows) {
  const records = [];
  for (const row of rows) {
    const omm = expandOmm(row);
    let satrec;
    const meanMotion = Number(omm.MEAN_MOTION);
    const ecc = Number(omm.ECCENTRICITY);
    const nRadPerSec = (meanMotion * 2 * Math.PI) / 86400;
    const semiMajorKm = Math.cbrt(MU_KM3_S2 / (nRadPerSec * nRadPerSec));
    records.push({
      id: String(omm.NORAD_CAT_ID),
      name: String(omm.OBJECT_NAME ?? '').trim(),
      cosparId: omm.OBJECT_ID || null,
      epochMs: Date.parse(omm.EPOCH.endsWith('Z') ? omm.EPOCH : `${omm.EPOCH}Z`),
      inclinationDeg: Number(omm.INCLINATION),
      eccentricity: ecc,
      periodMin: 1440 / meanMotion,
      apogeeKm: semiMajorKm * (1 + ecc) - EARTH_EQ_RADIUS_KM,
      perigeeKm: semiMajorKm * (1 - ecc) - EARTH_EQ_RADIUS_KM,
      regime: orbitRegime(meanMotion, ecc),
      row,
      // null if SGP4 cannot initialise these elements
      get satrec() {
        if (satrec === undefined) satrec = satrecFromRow(row);
        return satrec;
      },
    });
  }
  return records;
}

export function satrecFromRow(row) {
  try {
    const satrec = json2satrec(expandOmm(row));
    return satrec && !satrec.error ? satrec : null;
  } catch {
    return null;
  }
}
