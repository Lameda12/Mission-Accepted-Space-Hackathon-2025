import { propagate, gstime, eciToEcf, ecfToEci, ecfToLookAngles, geodeticToEcf } from 'satellite.js';
import { sunEciDirection } from './sun.js';

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6378.137;
// Elevation is sampled at ~1/300 of the orbital period (20 s minimum): short enough not
// to step over a low LEO pass, long enough that deep-space (GEO, HEO) scans stay cheap
const MIN_SCAN_STEP_S = 20;
const SCAN_STEPS_PER_ORBIT = 300;
const REFINE_TOLERANCE_MS = 500;
const VISIBILITY_STEP_S = 10;
// Civil twilight: the sky is dark enough to see a sunlit satellite
const OBSERVER_DARK_SUN_ELEVATION = -6 * DEG;

// observer: { lat, lon } in degrees, { altKm } optional
function toObserverGd({ lat, lon, altKm = 0 }) {
  return { latitude: lat * DEG, longitude: lon * DEG, height: altKm };
}

function elevationAt(satrec, observerGd, ms) {
  const date = new Date(ms);
  const position = propagate(satrec, date)?.position;
  if (!position) return NaN;
  return ecfToLookAngles(observerGd, eciToEcf(position, gstime(date))).elevation;
}

export function lookAnglesAt(satrec, observer, date) {
  const position = propagate(satrec, date)?.position;
  if (!position) return null;
  const la = ecfToLookAngles(toObserverGd(observer), eciToEcf(position, gstime(date)));
  return { azimuthDeg: la.azimuth / DEG, elevationDeg: la.elevation / DEG, rangeKm: la.rangeSat };
}

// Cylindrical Earth-shadow model: good to a few seconds at shadow entry/exit
export function isSunlit(positionEci, sunDir) {
  const p = positionEci.x * sunDir.x + positionEci.y * sunDir.y + positionEci.z * sunDir.z;
  if (p > 0) return true;
  const dx = positionEci.x - p * sunDir.x;
  const dy = positionEci.y - p * sunDir.y;
  const dz = positionEci.z - p * sunDir.z;
  return Math.hypot(dx, dy, dz) > EARTH_RADIUS_KM;
}

export function sunElevationAt(observer, date) {
  const gmst = gstime(date);
  const lat = observer.lat * DEG;
  const lon = observer.lon * DEG;
  const zenith = ecfToEci({ x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) }, gmst);
  const s = sunEciDirection(date);
  return Math.asin(zenith.x * s.x + zenith.y * s.y + zenith.z * s.z);
}

function isVisibleAt(satrec, observer, ms) {
  const date = new Date(ms);
  if (sunElevationAt(observer, date) > OBSERVER_DARK_SUN_ELEVATION) return false;
  const position = propagate(satrec, date)?.position;
  return !!position && isSunlit(position, sunEciDirection(date));
}

// Time where elevation crosses minEl between lo (below) and hi (above), or the reverse
function refineCrossing(f, lo, hi) {
  const loAbove = f(lo) > 0;
  while (hi - lo > REFINE_TOLERANCE_MS) {
    const mid = (lo + hi) / 2;
    if ((f(mid) > 0) === loAbove) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Elevation over a single pass is unimodal, so a golden-section search finds the peak
function refinePeak(f, lo, hi) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  while (b - a > REFINE_TOLERANCE_MS) {
    const c = b - phi * (b - a);
    const d = a + phi * (b - a);
    if (f(c) > f(d)) b = d;
    else a = c;
  }
  return (a + b) / 2;
}

/**
 * Predict passes of one satellite over an observer.
 * Returns { passes: [{ riseMs, peakMs, setMs, maxElevationDeg, riseAzimuthDeg, setAzimuthDeg, visible }],
 *           alwaysUp: boolean }
 * A pass in progress at startMs gets riseMs = null; one still up at the window end gets setMs = null.
 */
export function predictPasses(satrec, observer, { startMs = Date.now(), hours = 48, minElevationDeg = 10 } = {}) {
  const observerGd = toObserverGd(observer);
  const minEl = minElevationDeg * DEG;
  const f = (ms) => elevationAt(satrec, observerGd, ms) - minEl;
  const endMs = startMs + hours * 3600000;
  const periodS = (2 * Math.PI / satrec.no) * 60; // satrec.no is rad/min
  const stepMs = Math.max(MIN_SCAN_STEP_S, periodS / SCAN_STEPS_PER_ORBIT) * 1000;

  const passes = [];
  let prevMs = startMs;
  let prevAbove = f(startMs) > 0;
  let riseMs = prevAbove ? null : undefined;
  let everSet = false;

  for (let ms = startMs + stepMs; ms <= endMs + stepMs; ms += stepMs) {
    const t = Math.min(ms, endMs);
    const value = f(t);
    if (Number.isNaN(value)) break; // decayed or element set no longer propagates
    const above = value > 0;

    if (above && !prevAbove) {
      riseMs = refineCrossing(f, prevMs, t);
    } else if (!above && prevAbove) {
      everSet = true;
      passes.push(buildPass(satrec, observer, f, riseMs, refineCrossing(f, prevMs, t), startMs));
      riseMs = undefined;
    }
    prevMs = t;
    prevAbove = above;
    if (t === endMs) break;
  }

  if (prevAbove && riseMs !== undefined) {
    if (riseMs === null && !everSet) return { passes: [], alwaysUp: true };
    passes.push(buildPass(satrec, observer, f, riseMs, null, startMs, endMs));
  }
  return { passes, alwaysUp: false };
}

function buildPass(satrec, observer, f, riseMs, setMs, startMs, endMs = setMs) {
  const lo = riseMs ?? startMs;
  const hi = setMs ?? endMs;
  const peakMs = refinePeak(f, lo, hi);
  const at = (ms) => (ms == null ? null : lookAnglesAt(satrec, observer, new Date(ms)));

  let visible = false;
  for (let ms = lo; ms <= hi && !visible; ms += VISIBILITY_STEP_S * 1000) {
    visible = isVisibleAt(satrec, observer, ms);
  }

  return {
    riseMs,
    peakMs,
    setMs,
    maxElevationDeg: at(peakMs).elevationDeg,
    riseAzimuthDeg: at(riseMs)?.azimuthDeg ?? null,
    setAzimuthDeg: at(setMs)?.azimuthDeg ?? null,
    visible,
  };
}
