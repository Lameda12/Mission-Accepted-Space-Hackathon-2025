import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';

const EARTH_RADIUS_KM = 6371;

// Scene frame: Three.js is Y-up, and SphereGeometry with a standard equirectangular
// texture puts lon 0 on +X and lon 90E on -Z. ECI/ECEF are Z-up (Z = north pole),
// so (x, y, z) maps to (x, z, -y). With this mapping the Earth mesh rotates about +Y
// by GMST, with no texture offset.
export function eciToWorld({ x, y, z }) {
  return [x, z, -y];
}

// Earth rotation angle (rad) between ECI (TEME) and Earth-fixed frames.
export function earthRotationAngle(date) {
  return gstime(date);
}

// Parse once per satellite and reuse; twoline2satrec is the expensive step.
export function parseTle(tle1, tle2) {
  return twoline2satrec(tle1, tle2);
}

export function getOrbitPositions(satrec, numPoints = 150, startDate = new Date()) {
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const periodMinutes = (2 * Math.PI) / satrec.no;
  const dtMs = (periodMinutes * 60 * 1000) / numPoints;

  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const t = new Date(start.getTime() + i * dtMs);
    const pv = propagate(satrec, t);
    if (!pv?.position) continue;

    const { x, y, z } = pv.position;
    points.push([x, y, z]);
  }

  return points;
}

export function getPositionAtTime(satrec, date) {
  const pv = propagate(satrec, date);

  if (!pv?.position) return null;

  const { x, y, z } = pv.position;
  return { x, y, z };
}

export function getGroundTrack(satrec, durationMin = 90, stepSec = 30) {
  const start = new Date();
  const numPoints = Math.floor((durationMin * 60) / stepSec);
  const points = [];

  for (let i = 0; i < numPoints; i++) {
    const t = new Date(start.getTime() + i * stepSec * 1000);
    const pv = propagate(satrec, t);
    if (!pv?.position) continue;
    const gmst = gstime(t);
    const gd = eciToGeodetic(pv.position, gmst);
    points.push({ lat: gd.latitude, lon: gd.longitude, altKm: gd.height });
  }
  return points;
}

export function geoToCartesianKm(latRad, lonRad, altKm = 0) {
  const r = EARTH_RADIUS_KM + altKm;
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  const x = r * cosLat * cosLon;
  const y = r * sinLat; // Y up
  const z = -r * cosLat * sinLon;
  return [x, y, z];
}

export { EARTH_RADIUS_KM };
