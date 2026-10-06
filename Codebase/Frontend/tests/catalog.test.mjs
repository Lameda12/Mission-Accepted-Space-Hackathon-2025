import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { twoline2satrec, propagate } from 'satellite.js';
import { tleToOmm, compactOmm, buildRecords, parseCatalogNumber, orbitRegime } from '../lib/catalog.js';

const featured = JSON.parse(readFileSync(new URL('../data/featured.json', import.meta.url)));

test('OMM wire format reproduces TLE propagation', () => {
  const records = buildRecords(featured.map((s) => compactOmm(tleToOmm(s.name, s.tle1, s.tle2))));
  assert.equal(records.length, featured.length);

  for (const s of featured) {
    const fromTle = twoline2satrec(s.tle1, s.tle2);
    const rec = records.find((r) => r.id === s.norad_id);
    assert.ok(rec, `missing ${s.name}`);
    // Within a day of epoch: element sets are fresh enough to propagate for every object
    const epoch = rec.epochMs;
    for (const dtMin of [0, 90, 720, 1440]) {
      const t = new Date(epoch + dtMin * 60000);
      const a = propagate(fromTle, t)?.position;
      const b = propagate(rec.satrec, t)?.position;
      assert.ok(a && b, `${s.name} failed to propagate at +${dtMin} min`);
      const errKm = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      // TLE epoch has 1e-8 day (0.9 ms) resolution; JS Date keeps 1 ms, so ~10 m at LEO speed
      assert.ok(errKm < 0.05, `${s.name} +${dtMin} min differs by ${errKm.toFixed(4)} km`);
    }
  }
});

test('intl designator and epoch are converted like CelesTrak OMM', () => {
  const s = featured.find((x) => x.name === 'RADARSAT-2');
  const omm = tleToOmm(s.name, s.tle1, s.tle2);
  assert.equal(omm.OBJECT_ID, '2007-061A');
  assert.equal(omm.NORAD_CAT_ID, '32382');
  assert.match(omm.EPOCH, /^2025-10-24T\d\d:\d\d:\d\d\.\d{3}$/);
  assert.equal(omm.BSTAR, 0.61896e-4);
});

test('Alpha-5 catalog numbers', () => {
  assert.equal(parseCatalogNumber('25544'), '25544');
  assert.equal(parseCatalogNumber('00005'), '5');
  assert.equal(parseCatalogNumber('A0000'), '100000');
  assert.equal(parseCatalogNumber('E8493'), '148493');
  assert.equal(parseCatalogNumber('J0001'), '180001'); // I is skipped
  assert.equal(parseCatalogNumber('Z9999'), '339999');
});

test('orbit regimes', () => {
  const byName = Object.fromEntries(
    buildRecords(featured.map((s) => compactOmm(tleToOmm(s.name, s.tle1, s.tle2)))).map((r) => [r.name, r.regime]),
  );
  assert.equal(byName['RADARSAT-2'], 'LEO');
  assert.equal(byName['ANIK F1R'], 'GEO');
  assert.equal(byName['COSMOS 2518'], 'HEO'); // Tundra, e ≈ 0.71
  assert.equal(orbitRegime(2.0056, 0.001), 'MEO'); // GPS-like
});

test('derived orbit geometry is sane', () => {
  const [rec] = buildRecords([compactOmm(tleToOmm('RADARSAT-2', ...['tle1', 'tle2'].map((k) => featured.find((x) => x.name === 'RADARSAT-2')[k])))]);
  assert.ok(Math.abs(rec.periodMin - 100.7) < 0.2, `period ${rec.periodMin}`);
  assert.ok(rec.perigeeKm > 780 && rec.apogeeKm < 810, `${rec.perigeeKm} x ${rec.apogeeKm}`);
});
