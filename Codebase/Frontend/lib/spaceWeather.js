// Parse NOAA SWPC's planetary K-index product. SWPC has served it both as an array of
// arrays with a header row and as an array of objects, so accept either.
export function parseKpProduct(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('Kp product is empty');

  let rows;
  if (Array.isArray(data[0])) {
    const header = data[0].map((h) => String(h).toLowerCase());
    rows = data.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  } else {
    rows = data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
  }

  const readings = rows
    .map((r) => ({
      time: parseSwpcTime(r.time_tag),
      kp: Number(r.kp ?? r.kp_index ?? r.estimated_kp),
    }))
    .filter((r) => Number.isFinite(r.kp) && Number.isFinite(r.time));
  if (!readings.length) throw new Error('Kp product has no readable rows');

  const latest = readings.reduce((a, b) => (b.time > a.time ? b : a));
  return { kp: latest.kp, observedAt: new Date(latest.time).toISOString(), ...stormLevel(latest.kp) };
}

// SWPC timestamps are UTC without a zone suffix, e.g. "2026-10-05 21:00:00.000"
function parseSwpcTime(tag) {
  if (!tag) return NaN;
  const iso = String(tag).trim().replace(' ', 'T');
  return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

// NOAA geomagnetic storm scale
export function stormLevel(kp) {
  if (kp >= 9) return { scale: 'G5', label: 'Extreme storm' };
  if (kp >= 8) return { scale: 'G4', label: 'Severe storm' };
  if (kp >= 7) return { scale: 'G3', label: 'Strong storm' };
  if (kp >= 6) return { scale: 'G2', label: 'Moderate storm' };
  if (kp >= 5) return { scale: 'G1', label: 'Minor storm' };
  if (kp >= 4) return { scale: null, label: 'Active' };
  return { scale: null, label: 'Quiet' };
}
