// Verifies that satellites and the sun land on the right spot of the textured globe.
// Raycasts from each object toward Earth's center, reads the texture lat/lon at the hit,
// and compares with satellite.js geodetic subpoints and an independent subsolar point.
// Usage: node scripts/check-frames.mjs   (exit code 1 on any failure)
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';
import { eciToWorld, earthRotationAngle, EARTH_RADIUS_KM } from '../lib/orbit.js';
import { getSunDirection } from '../lib/sun.js';

const DEG = 180 / Math.PI;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Same geometry/rotation setup as GlobeScene: Earth inside a group spun about +Y
const earthGroup = new THREE.Group();
const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS_KM, 256, 256), new THREE.MeshBasicMaterial());
earthGroup.add(earth);
const raycaster = new THREE.Raycaster();

// Texture lat/lon under a world-space point, for an equirectangular day map
function textureLatLonBelow(worldPos, date) {
  earthGroup.rotation.y = earthRotationAngle(date);
  earthGroup.updateMatrixWorld(true);
  const origin = new THREE.Vector3(...worldPos);
  raycaster.set(origin, origin.clone().negate().normalize());
  const [hit] = raycaster.intersectObject(earth);
  return { lat: (hit.uv.y - 0.5) * 180, lon: (hit.uv.x - 0.5) * 360 };
}

let failures = 0;
function check(label, got, want, tolDeg) {
  const dLat = got.lat - want.lat;
  const dLon = wrap180(got.lon - want.lon) * Math.cos(want.lat / DEG);
  const err = Math.hypot(dLat, dLon);
  const ok = err <= tolDeg;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} want ${want.lat.toFixed(2).padStart(7)}, ${want.lon.toFixed(2).padStart(8)}  ` +
    `got ${got.lat.toFixed(2).padStart(7)}, ${got.lon.toFixed(2).padStart(8)}  err ${err.toFixed(3)}°`);
}

// 1) Satellites: texture point under the marker must equal the geodetic subpoint.
// Geocentric vs geodetic latitude differ by up to ~0.19°, hence the tolerance.
const sats = JSON.parse(readFileSync(new URL('../data/featured.json', import.meta.url)));
const date = new Date();
for (const s of sats) {
  const satrec = twoline2satrec(s.tle1, s.tle2);
  const position = propagate(satrec, date)?.position;
  if (!position) {
    console.log(`SKIP  sat ${s.name} (SGP4 failed: decayed or stale TLE)`);
    continue;
  }
  const gd = eciToGeodetic(position, gstime(date));
  const want = { lat: gd.latitude * DEG, lon: gd.longitude * DEG };
  check(`sat ${s.name}`, textureLatLonBelow(eciToWorld(position), date), want, 0.25);
}

// 2) Sun: compare with an independent subsolar point (NOAA declination + equation of time).
// GlobeScene's sun model is a low-precision approximation, so allow 1°.
function subsolarPoint(d) {
  const g = (2 * Math.PI / 365) * (dayOfYear(d) - 1 + (d.getUTCHours() - 12) / 24);
  const eqTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return { lat: decl * DEG, lon: wrap180((720 - utcMin - eqTimeMin) / 4) };
}
function dayOfYear(d) {
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

for (const iso of ['2026-03-20T06:00:00Z', '2026-06-21T12:00:00Z', '2026-09-23T00:00:00Z', '2026-12-21T18:00:00Z', date.toISOString()]) {
  const d = new Date(iso);
  const dir = getSunDirection(d).multiplyScalar(EARTH_RADIUS_KM * 10);
  check(`sun ${iso}`, textureLatLonBelow([dir.x, dir.y, dir.z], d), subsolarPoint(d), 1.0);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll frame checks passed');
process.exit(failures ? 1 : 0);
