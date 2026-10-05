const pad = (n) => String(n).padStart(2, '0');

export function formatUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// "41 min", "5.2 h", "346 d"
export function formatAge(ms) {
  const min = Math.abs(ms) / 60000;
  if (min < 1) return '<1 min';
  if (min < 120) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

// Signed offset of sim time from real time: "+2h 14m", "−36m", "+3d 4h"
export function formatOffset(ms) {
  const sign = ms < 0 ? '−' : '+';
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${sign}${d}d ${h}h`;
  if (h) return `${sign}${h}h ${pad(m)}m`;
  if (m) return `${sign}${m}m ${pad(s)}s`;
  return `${sign}${s}s`;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
}

export function formatLocalDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(azimuthDeg) {
  if (azimuthDeg == null) return '—';
  return COMPASS[Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

// How far SGP4 can be trusted given the element set's age (LEO errors grow ~1–3 km/day)
export function elementAgeStatus(ageMs) {
  const days = ageMs / 86400000;
  if (days < 3) return { level: 'ok', note: 'Fresh elements' };
  if (days < 14) return { level: 'warn', note: 'Aging elements: position error may be tens of km' };
  return { level: 'bad', note: 'Stale elements: positions are unreliable' };
}
