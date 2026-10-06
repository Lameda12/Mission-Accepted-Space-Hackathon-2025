# SatelLocator

Live 3D tracker for every active satellite in Earth orbit, with pass predictions for your location.

- **Full active catalog** from CelesTrak in CCSDS OMM format (handles 6-digit catalog numbers, which TLEs cannot), refreshed every 2 hours
- **SGP4 in a Web Worker**: ~15k objects propagated off the main thread and drawn in one point cloud, colored by orbit regime (LEO, MEO, GEO, HEO)
- **Click or search** any object for live state (subpoint, altitude, speed), orbital elements and element-set age, with a warning when positions become unreliable
- **Pass predictions** for your location (rise, peak, set, naked-eye visibility), validated against Skyfield
- **Time control** from real time to 3600×, plus a **Kp space-weather** indicator from NOAA SWPC
- Shareable links: `?sat=25544` opens the ISS

## Run locally

Requires Node 20.9+.

```bash
npm install
npm run dev        # http://localhost:3000
```

No environment variables or API keys are needed. If CelesTrak or NOAA can't be reached, the app falls back to a bundled snapshot of 16 Canadian satellites and shows **Degraded** in the status bar.

## Checks

```bash
npm run lint
npm test               # catalog codec, pass prediction vs Skyfield, Kp parser
npm run check:frames   # satellites and sun land on the right spot of the textured globe
npm run build
```

`tests/fixtures/skyfield-passes.json` is the Skyfield reference for the pass tests. Regenerate it with `python tests/fixtures/generate_skyfield_passes.py` (needs `pip install skyfield`).

## Deploy

Deploy to Vercel with **Root Directory** set to `Codebase/Frontend`. There is no backend to run: the API routes are part of the Next.js app.

## How it works

| Piece | File | Notes |
|---|---|---|
| Catalog API | `app/api/catalog/route.js` | ISR, revalidated every 2 h, so there is one CelesTrak download per update cycle (their usage policy). If a refresh fails, Next keeps serving the last good catalog. |
| Wire format | `lib/catalog.js` | OMM fields as positional arrays: ~2 MB instead of ~9 MB. `json2satrec` builds SGP4 records lazily. |
| Propagation | `workers/propagate.worker.js` | Propagates all objects about 20×/s and transfers the position buffer (no copy). |
| Rendering | `components/GlobeScene.jsx` | Three.js scene. ECI → scene mapping is `(x, y, z) → (x, z, −y)` and the Earth rotates by GMST (`lib/orbit.js`). Custom shaders write logarithmic depth. |
| Sim clock | `lib/simClock.js` | Read inside the render loop and never stored in React state; the HUD samples it 4×/s. |
| Passes | `lib/passes.js` | Elevation scan at period/300 (20 s minimum), bisection for rise/set, golden-section search for the peak, cylindrical Earth shadow, observer dark below −6° sun elevation. |
| Space weather | `app/api/space-weather/route.js` | NOAA SWPC planetary K-index, revalidated every 15 min. |

## Accuracy

Positions come from SGP4 on public GP element sets. Typical error is about 1 km at epoch, growing roughly 1–3 km per day in LEO, which is fine for visualization and pass planning but not for conjunction assessment. The telemetry card shows each element set's age and flags anything older than 3 days.

## Data sources

- [CelesTrak](https://celestrak.org/NORAD/documentation/gp-data-formats.php) GP data ([usage policy](https://celestrak.org/usage-policy.php))
- [NOAA SWPC](https://www.swpc.noaa.gov/) planetary K-index
- Earth textures in `public/textures/earth` (see the README there)
