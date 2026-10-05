import * as THREE from 'three';
import { eciToWorld } from './orbit.js';

// Very lightweight approximate sun direction, computed in the equatorial (ECI) frame
// and returned in scene coordinates as a normalized THREE.Vector3
export function getSunDirection(date) {
  const d = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;
  const g = 357.529 + 0.98560028 * d; // mean anomaly (deg)
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  const L = q + 1.915 * Math.sin(g * Math.PI / 180) + 0.020 * Math.sin(2 * g * Math.PI / 180);
  const e = 23.439 - 0.00000036 * d; // obliquity (deg)
  const Lr = L * Math.PI / 180;
  const er = e * Math.PI / 180;
  const x = Math.cos(Lr);
  const y = Math.cos(er) * Math.sin(Lr);
  const z = Math.sin(er) * Math.sin(Lr);
  return new THREE.Vector3(...eciToWorld({ x, y, z })).normalize();
}
