import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKpProduct, stormLevel } from '../lib/spaceWeather.js';

test('array-of-arrays product with header row', () => {
  const r = parseKpProduct([
    ['time_tag', 'Kp', 'a_running', 'station_count'],
    ['2026-10-05 15:00:00.000', '2.33', '9', '8'],
    ['2026-10-05 18:00:00.000', '5.67', '56', '8'],
  ]);
  assert.equal(r.kp, 5.67);
  assert.equal(r.observedAt, '2026-10-05T18:00:00.000Z');
  assert.equal(r.scale, 'G1');
});

test('array-of-objects product, unsorted', () => {
  const r = parseKpProduct([
    { time_tag: '2026-10-05T21:00:00', Kp: 3.0 },
    { time_tag: '2026-10-05T18:00:00', Kp: 7.0 },
  ]);
  assert.equal(r.kp, 3);
  assert.equal(r.label, 'Quiet');
});

test('rejects empty and unreadable products', () => {
  assert.throws(() => parseKpProduct([]));
  assert.throws(() => parseKpProduct([['time_tag', 'Kp']]));
  assert.throws(() => parseKpProduct([{ time_tag: 'x', Kp: 'n/a' }]));
});

test('NOAA G-scale boundaries', () => {
  assert.equal(stormLevel(4.67).label, 'Active');
  assert.equal(stormLevel(5).scale, 'G1');
  assert.equal(stormLevel(9).scale, 'G5');
});
