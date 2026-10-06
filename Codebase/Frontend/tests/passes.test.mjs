import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { twoline2satrec } from 'satellite.js';
import { predictPasses, isSunlit, sunElevationAt } from '../lib/passes.js';

const featured = JSON.parse(readFileSync(new URL('../data/featured.json', import.meta.url)));
const reference = JSON.parse(readFileSync(new URL('./fixtures/skyfield-passes.json', import.meta.url)));
const satrecFor = (name) => {
  const s = featured.find((x) => x.name === name);
  return twoline2satrec(s.tle1, s.tle2);
};

test('passes match Skyfield find_events', () => {
  for (const c of reference.cases) {
    const { passes } = predictPasses(satrecFor(c.name), reference.observer, {
      startMs: c.startMs,
      hours: reference.hours,
      minElevationDeg: reference.minElevationDeg,
    });
    assert.equal(passes.length, c.passes.length, `${c.name}: pass count`);
    c.passes.forEach((want, i) => {
      const got = passes[i];
      for (const k of ['riseMs', 'peakMs', 'setMs']) {
        assert.ok(Math.abs(got[k] - want[k]) < 2000, `${c.name} pass ${i} ${k} off by ${(got[k] - want[k]) / 1000}s`);
      }
      assert.ok(Math.abs(got.maxElevationDeg - want.maxElevationDeg) < 0.05, `${c.name} pass ${i} max elevation`);
    });
  }
});

test('geostationary satellite is reported as always up', () => {
  const satrec = satrecFor('ANIK F1R');
  const epochMs = Date.UTC(2000 + satrec.epochyr, 0, 1) + (satrec.epochdays - 1) * 864e5;
  const r = predictPasses(satrec, { lat: 44.6488, lon: -63.5752 }, { startMs: epochMs, hours: 24 });
  assert.equal(r.alwaysUp, true);
  assert.equal(r.passes.length, 0);
});

test('pass already in progress at the window start has no rise time', () => {
  const c = reference.cases[0];
  const first = c.passes[0];
  const midPass = Math.round((first.riseMs + first.setMs) / 2);
  const { passes } = predictPasses(satrecFor(c.name), reference.observer, { startMs: midPass, hours: 1 });
  assert.equal(passes[0].riseMs, null);
  assert.ok(Math.abs(passes[0].setMs - first.setMs) < 2000);
});

test('Earth shadow model', () => {
  const sun = { x: 1, y: 0, z: 0 };
  assert.equal(isSunlit({ x: 7000, y: 0, z: 0 }, sun), true); // day side
  assert.equal(isSunlit({ x: -7000, y: 0, z: 0 }, sun), false); // directly behind Earth
  assert.equal(isSunlit({ x: -7000, y: 7000, z: 0 }, sun), true); // behind, but outside the shadow cylinder
});

test('sun elevation: local noon high, midnight below horizon (Halifax, June solstice)', () => {
  const halifax = { lat: 44.6488, lon: -63.5752 };
  const noon = sunElevationAt(halifax, new Date('2026-06-21T16:20:00Z')) * 180 / Math.PI;
  const midnight = sunElevationAt(halifax, new Date('2026-06-22T04:20:00Z')) * 180 / Math.PI;
  assert.ok(Math.abs(noon - (90 - 44.6488 + 23.44)) < 1, `noon elevation ${noon}`);
  assert.ok(midnight < -18, `midnight elevation ${midnight}`);
});
