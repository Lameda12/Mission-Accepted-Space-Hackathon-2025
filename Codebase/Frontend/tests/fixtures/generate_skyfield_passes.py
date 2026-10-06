"""Regenerate skyfield-passes.json, the reference for tests/passes.test.mjs.

Usage: pip install skyfield && python tests/fixtures/generate_skyfield_passes.py
Each satellite starts at its TLE epoch (rounded up to the minute) so the elements are fresh.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from skyfield.api import EarthSatellite, load, wgs84

HERE = Path(__file__).parent
OBSERVER = {'lat': 44.6488, 'lon': -63.5752}  # Halifax
SATELLITES = ['RADARSAT-2', 'CASSIOPE', 'GHGSAT-C1', 'MOST', 'CANX-4']
HOURS = 48
MIN_ELEVATION = 10.0

ts = load.timescale()
obs = wgs84.latlon(OBSERVER['lat'], OBSERVER['lon'])
featured = {s['name']: s for s in json.loads((HERE.parent.parent / 'data' / 'featured.json').read_text())}

cases = []
for name in SATELLITES:
    s = featured[name]
    sat = EarthSatellite(s['tle1'], s['tle2'], name, ts)
    epoch_ms = sat.epoch.utc_datetime().timestamp() * 1000
    start_ms = math.ceil(epoch_ms / 60000) * 60000
    t0 = ts.from_datetime(datetime.fromtimestamp(start_ms / 1000, timezone.utc))
    times, events = sat.find_events(obs, t0, t0 + HOURS / 24, altitude_degrees=MIN_ELEVATION)

    passes, cur = [], {}
    for t, e in zip(times, events):
        ms = round(t.utc_datetime().timestamp() * 1000)
        if e == 0:
            cur = {'riseMs': ms}
        elif e == 1:
            cur.update(peakMs=ms, maxElevationDeg=round((sat - obs).at(t).altaz()[0].degrees, 4))
        else:
            cur['setMs'] = ms
            passes.append(cur)
            cur = {}
    cases.append({'name': name, 'startMs': start_ms, 'passes': passes})

out = {'observer': OBSERVER, 'hours': HOURS, 'minElevationDeg': MIN_ELEVATION, 'cases': cases}
(HERE / 'skyfield-passes.json').write_text(json.dumps(out, indent=2) + '\n')
print(f"wrote {sum(len(c['passes']) for c in cases)} passes")
