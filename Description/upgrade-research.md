# SatelLocator: Upgrade Research

Audit of the hackathon codebase (state at commit `e48bac1`, 2025-10-26) plus research on how comparable space software is built. Written 2026-10-05.

**Verdict: compress first, then grow in one direction.** The app has correctness bugs that make every new feature built on it wrong, and about 40 MB of weight it doesn't need. Fix and slim it (roughly a weekend), then expand into **live catalog + pass prediction for your location**. That one feature combines the existing "Future Work" list, real public data, and the parts of space software that are actually hard.

---

## 1. What exists today

| Layer | What it does | Size |
|---|---|---|
| `Backend/app.py` (Flask + Socket.IO) | Loads 14 hardcoded TLEs, runs SGP4 every 3 s, finds the nearest city by brute force, then broadcasts everything over a websocket | ~130 LOC |
| `Backend/data/cities500.txt` | Full GeoNames dump, 224,834 cities, 19 columns | **38 MB** |
| `Frontend/components/GlobeScene.jsx` | Three.js globe, day/night shader, orbits (Line2), sprite markers, bloom | 684 LOC |
| `Frontend/app/page.js` | Sidebar, multi-select, time control at 1x to 4096x | 382 LOC |
| `Frontend/*.md` | 8 docs, ~2,100 lines, several describing an older design | |

---

## 2. Bugs found (fix before adding anything)

### 2.1 Coordinate frame mismatch (critical)
`satellite.js` `propagate()` returns TEME coordinates, where **+Z is the north pole**. `THREE.SphereGeometry` puts its poles on **+Y**, and `earthGroup.rotation.y` spins Earth around Y. Satellites, orbits and the sun vector are drawn Z-up while the textured Earth is Y-up, so orbits are tilted 90° relative to the continents. The day/night terminator has the same problem, because `getSunDirection()` returns a Z-up vector.

Fix: put all inertial objects (orbits, markers, sun direction) inside one group that maps Z-up to Y-up.
```js
const inertial = new THREE.Group();
inertial.rotation.x = -Math.PI / 2;   // (x, y, z)_TEME -> (x, z, -y)_three
scene.add(inertial);
// sunDir must be transformed the same way before going into the shader uniform
```

### 2.2 Earth rotates by solar time, not sidereal time
`GlobeScene.jsx:215` uses `UTC hours * 15°`. The Earth's orientation relative to the inertial frame is **GMST**, not UTC. The difference from UTC is about 1°/day and wraps fully over a year, so depending on the date, satellites can sit over the wrong continent by anywhere from 0° to 360°. There is also no calibration between the texture's prime meridian and the frame's X axis.

Fix: `earthGroup.rotation.y = satellite.gstime(simTime) + TEXTURE_LON_OFFSET` (calibrate the offset once, e.g. make sure a satellite whose geodetic longitude is 0 appears over Greenwich).

### 2.3 TLEs are ~346 days stale
All 14 TLE epochs are day 287 to 299 of 2025 (Oct 14 to 26, 2025). SGP4 error in LEO grows by roughly 1 to 3 km/day from about 1 km at epoch, and is commonly treated as unusable for LEO after 2 to 3 days. A year out, positions are essentially fiction, and objects may have decayed or manoeuvred. [Inference: the exact error depends on drag and space weather; it is not measured here.]

### 2.4 Backend nearest-city lookup is O(N) per satellite and blocks the event loop
Measured locally: **0.102 s per lookup** against 224,834 cities, so 14 satellites ≈ 1.4 s of CPU every 3 s cycle, all inside an eventlet green thread. At ~30 satellites, a cycle takes longer than its 3 s interval. Fix: a KD-tree on unit vectors (`scipy.spatial.cKDTree` or `sklearn BallTree(metric="haversine")`), which drops this to microseconds per query.

### 2.5 Backend frame shortcut
`app.py` puts the TEME vector directly into Skyfield's `Geocentric` (which assumes GCRS). Precession since J2000 is about 0.36°, which works out to tens of km on the ground track. [Inference] Use `skyfield.api.EarthSatellite` instead, which handles the TEME conversion.

### 2.6 Frontend performance and dead code
- `page.js` calls `setSimTime` on every animation frame, so React re-renders the whole tree about 60 times a second, and `getPositionAtTime` re-parses the TLE (`twoline2satrec`) for each satellite on every frame. Parse each `satrec` once, keep sim time in a ref, and advance markers inside the Three.js `tick()` loop.
- The orbit redraw is debounced to 200 ms but the effect re-runs on every frame, so the timeout is always cancelled. **Orbits never redraw during playback.** At 4096x, the marker visibly drifts off its line as RAAN precesses.
- `GlobeScene` has two duplicate effects for adding and removing satellites, and two for updating markers.
- `LineMaterial.resolution` is never updated on resize, so line widths distort.
- `livePositions` prop, `SatelliteFeed.jsx` and `removeOrbitPaths()` are unused.
- The backend computes `geodetic`, `speed_kmps` and `nearby_city` every 3 s, but the UI never shows them. It only reads `name` and `norad_id`, because the frontend propagates on its own anyway.

### 2.7 Setup docs don't work as written
README says `cd Codebase/backend` and `cd Codebase/frontend` (the real dirs are `Backend` and `Frontend`, which matters on Linux and case-sensitive macOS volumes) and `cp .env.example`, but no `.env.example` exists.

---

## 3. Compress: what to cut

| Cut | Saves | How |
|---|---|---|
| `cities500.txt` → 4-column extract (name, lat, lon, country), gzip | 38 MB → **2.9 MB** (measured) | `cut -f2,5,6,9 cities500.txt \| gzip -9`. Or switch to GeoNames `cities15000` if only large cities matter. |
| Socket.IO position stream | Removes Flask-SocketIO, eventlet, the 3 s loop, and `socket.js` | The client already propagates. Replace it with `GET /api/satellites` (cached TLE/OMM). Keep a websocket only for something the client can't compute (alerts, space weather). |
| Duplicate effects, dead files | ~150 LOC | See 2.6 |
| 8 frontend markdown files | ~2,100 lines → 1 README | Several (ARCHITECTURE.md) describe Phong materials, magenta `THREE.Line`, a geodetic pipeline: none of which match the code now. |
| `Frontend/public/data/Satellite-TLE-Data.json` | Duplicate of backend data | One source of truth |
| `.DS_Store` in `Codebase/` | | Add to root `.gitignore` |

Once the socket goes away, the backend is a thin TLE cache plus nearest-city/pass API. It could become a Next.js Route Handler and the project could ship as a single Vercel deploy. [Inference: this depends on whether you want to keep Python for later Skyfield work.]

---

## 4. Increase: how real space software does it

### 4.1 Data: TLE is a legacy format and has now hit its limit
- **The 5-digit catalog ran out on 2026-07-11** at 69,999 (70,000 to 99,999 were reserved for analyst objects). New objects now get 6-digit numbers starting at 100,000. A plain TLE has 5 columns for the catalog number, so **new launches are already missing from TLE feeds.**
- The stop-gap is **Alpha-5** (first digit replaced by a letter, good up to 339,999). The long-term format is **CCSDS OMM** (Orbit Mean-Elements Message), which CelesTrak has served as JSON/CSV/XML/KVN since 2020.
- The current app uses `norad_id % colors.length` and treats `norad_id` as a number. Alpha-5 IDs parse as `NaN`, which is a real bug class other trackers have hit.
- CelesTrak endpoint: `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`. GP data updates **every 2 hours**, and CelesTrak enforces **one download per update** (starting with the `active` and `starlink` groups), so the backend must cache. Never fetch from the browser per user.
- satellite.js `json2satrec()` (v6) and `sgp4.api.Satrec` (via `omm` module) both ingest OMM directly. [Unverified: check the exact function names against your installed versions.]
- Space-Track.org is the authoritative source (needs an account) and has conjunction data messages (CDMs).

### 4.2 Scale: dozens of satellites → the full catalog (~30k+ tracked objects)
How others do it:
- **KeepTrack.space** (TypeScript/WebGL, AGPL) runs SGP4 in a Web Worker ("position cruncher") and renders every object as a point. It's the closest open-source reference to SatelLocator.
- **satellite.js v6** (Apr 2025, already in your `package.json`) added a **bulk propagation API in WASM, 3x to 12x faster** than a JS loop, with single-threaded and pthreads builds.
- GPU SGP4 (WebGPU, JAX) exists in research. [Unverified: published speedups vary and aren't comparable to yours.]

Recipe for this codebase: one `THREE.Points` (or `InstancedMesh`) with a `Float32Array` position buffer, filled by a Worker running satellite.js bulk propagation, transferred back as a transferable buffer at about 10 Hz and interpolated between ticks. Draw orbit lines only for selected satellites.

### 4.3 Features, ranked by value per effort

1. **Live catalog (OMM from CelesTrak, cached server-side)**, which fixes 2.3 and 4.1. *Small.*
2. **Pass prediction for the user's location** ("ISS over Halifax at 19:42, max elevation 61°, visible"). Skyfield `EarthSatellite.find_events()` does rise/culminate/set. Add a sunlit-satellite plus dark-observer check for naked-eye visibility. This is the one that makes people come back. *Medium.*
3. **Ground track + sensor footprint** for Canadian EO sats (RADARSAT Constellation, RADARSAT-2): swath on the globe. Fits the MDA/CSA theme of the hackathon. *Medium.*
4. **Space weather overlay** from NOAA SWPC's free JSON: `services.swpc.noaa.gov/products/noaa-planetary-k-index.json` and `.../json/planetary_k_index_1m.json`. Show Kp, and explain that storms increase drag and degrade TLE accuracy. *Small.*
5. **Conjunction screening**: CelesTrak SOCRATES or Space-Track CDMs to start; your own screening (apogee/perigee filter → coarse grid → TCA refinement) is a real project. *Large.*
6. **Re-entry / decay view** of CelesTrak recently-decayed lists. *Small.*

### 4.4 Libraries and standards worth knowing
| Need | Tool |
|---|---|
| Browser SGP4 | satellite.js v6 (bulk WASM API) |
| Python SGP4 + frames + passes | `sgp4`, Skyfield (already in requirements) |
| High-fidelity propagation (numerical, drag, SRP) | Orekit (Java, Python wrapper), hapsira (maintained fork of poliastro, which was archived Oct 2023) |
| Globe engine alternative | CesiumJS, which has a real WGS84 ellipsoid, time-dynamic CZML and correct ICRF/Fixed frames built in. It would remove bugs 2.1 and 2.2 by construction, at the cost of the custom shader look. |
| Mission design | NASA GMAT |
| Data standards | CCSDS OMM (elements), OEM (ephemeris), CDM (conjunctions) |
| Flight software (out of scope, context only) | NASA cFS, NASA/JPL F Prime |

---

## 5. Recommended plan

**Progress**
- [x] 2.1, 2.2: ECI → scene mapping (`eciToWorld`), Earth spun by GMST, sun model moved to `lib/sun.js`. `npm run check:frames` raycasts the real globe mesh: satellites land within 0.18° of their geodetic subpoint and the sun within 0.5° of an independent subsolar point. The old code fails all 20 checks, by up to 178°.
- [x] 2.5: backend uses `EarthSatellite.from_satrec`, so subpoints now match satellite.js (the old code was 14 to 40 km off).
- [x] Found during verification: `propagate()` returns `null` in satellite.js v6 when SGP4 fails (M3MSAT's stale TLE does), which crashed `lib/orbit.js`. Fresh installs also crashed the Socket.IO connect handler (`flask-socketio` 5.3 vs Flask 3.1.3, now pinned `~=5.6`), and `/api/satellites` had no CORS header.
- [x] 2.6: sim time lives in `lib/simClock.js` and is read inside the render loop (no React state per frame); satrecs parsed once; orbit materials reused and redrawn once per orbital period; bloom toggle fixed (stale closure); duplicate effects, `lib/store.js`, `SatelliteFeed.jsx` and 6 always-404 texture requests removed; line resolution follows resize. Headless Chromium, 5 satellites: main-thread script time 692 → 46 ms/s at 1x and 750 → 51 ms/s at 4096x. The old 200 ms debounce rebuilt every orbit with a new `LineMaterial` whenever frames were slow, recompiling shaders constantly (~590 ms/s).
- [x] Sprints 1 and 2 shipped as a Next.js-only MVP (Flask retired): CelesTrak OMM catalog via an ISR route (2 h, one download per update) with a degraded fallback; full catalog propagated in a Web Worker and drawn as one point cloud with picking; pass prediction matching Skyfield to 0.27 s on 39 passes; Kp from NOAA SWPC; mission-control UI with `?sat=` deep links; docs collapsed into `Codebase/Frontend/README.md`. Browser test with a 14,497-object synthetic catalog: ~50 ms/s main-thread script time at 1×, 38 ms/s at 600×.
- [ ] Not done: conjunction screening (4.3 #5), re-entry view (4.3 #6), Canadian EO swath footprints (4.3 #3).

**Sprint 1, compress and correct (about 1 to 2 days)**
1. Inertial group rotation + GMST Earth rotation + texture offset calibration (2.1, 2.2). Verify against ISS on a public tracker.
2. Cache satrecs, move animation into the Three.js loop, delete duplicate effects and dead code (2.6).
3. Replace the socket stream with `GET /api/satellites` backed by a 2-hour CelesTrak OMM cache (2.3, 4.1). Store IDs as strings.
4. Shrink cities data to 2.9 MB and use a KD-tree (2.4). Fix the README paths, add `.env.example`, collapse the docs into one README.

**Sprint 2, grow (about 3 to 5 days)**
5. Full `active` catalog as a Points cloud via Worker + satellite.js bulk API (4.2).
6. Pass prediction for browser geolocation via Skyfield `find_events` (4.3 #2).
7. Kp space-weather badge (4.3 #4).

Skip conjunction screening until 1 to 7 are done; it's a project on its own.

---

## Sources
- [CelesTrak: A New Way to Obtain GP Data](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- [CelesTrak: Usage Policy](https://celestrak.org/usage-policy.php)
- [Satellite Catalog Numbers Ran Out at 69,999, Not 99,999 (orbitalnodes.ai)](https://orbitalnodes.ai/satellite-catalog-numbers/)
- [Space-Track.org documentation (Alpha-5)](https://www.space-track.org/documentation)
- [gods-eye-view issue #751: Alpha-5 IDs collapse onto one NaN key](https://github.com/bilawalsidhu/gods-eye-view/issues/751)
- [satellite.js releases (v6 bulk WASM API)](https://github.com/shashwatak/satellite-js/releases)
- [KeepTrack.space README](https://github.com/thkruz/keeptrack.space/blob/main/README.md)
- [Improved orbit predictions using two-line elements (arXiv:1002.2277)](https://arxiv.org/pdf/1002.2277)
- [NOAA SWPC data access](https://www.spaceweather.gov/content/data-access), [SWPC products index](https://services.swpc.noaa.gov/products/)
- [hapsira (poliastro fork)](https://github.com/pleiszenburg/hapsira)
- [Skyfield: Earth Satellites](https://rhodesmill.org/skyfield/earth-satellites.html)

Measured locally: nearest-city lookup time (0.102 s/query), compressed cities size (2,929,543 bytes), TLE epochs. Everything else is from the sources above or labeled.
