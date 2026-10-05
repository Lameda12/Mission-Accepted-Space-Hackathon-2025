import * as THREE from 'three';
import { eciToWorld } from './orbit.js';

// Low-precision solar position (Astronomical Almanac, ~0.01°): unit vector toward the
// Sun in the equatorial (ECI) frame, Z = north pole.
export function sunEciDirection(date) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;
  const g = 357.529 + 0.98560028 * d; // mean anomaly (deg)
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  const L = q + 1.915 * Math.sin(g * Math.PI / 180) + 0.020 * Math.sin(2 * g * Math.PI / 180);
  const e = 23.439 - 0.00000036 * d; // obliquity (deg)
  const Lr = L * Math.PI / 180;
  const er = e * Math.PI / 180;
  return {
    x: Math.cos(Lr),
    y: Math.cos(er) * Math.sin(Lr),
    z: Math.sin(er) * Math.sin(Lr),
  };
}

// Same direction in scene coordinates, as a normalized THREE.Vector3
export function getSunDirection(date) {
  return new THREE.Vector3(...eciToWorld(sunEciDirection(date))).normalize();
}
