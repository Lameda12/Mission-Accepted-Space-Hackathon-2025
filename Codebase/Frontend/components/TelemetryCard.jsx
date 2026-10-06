import { useMemo } from 'react';
import { propagate, gstime, eciToGeodetic } from 'satellite.js';
import { REGIMES } from '@/lib/catalog';
import { predictPasses, lookAnglesAt } from '@/lib/passes';
import {
  compass, elementAgeStatus, formatAge, formatDuration, formatLatLon, formatLocalDateTime,
} from '@/lib/format';
import styles from './hud.module.css';

const PASS_HOURS = 48;
const MIN_ELEVATION_DEG = 10;
const MAX_PASSES_SHOWN = 6;
// Passes are computed for a window starting at a 12 h bucket and running PASS_HOURS past
// its end, so at least PASS_HOURS ahead of sim time is always covered while recomputing
// only twice per sim day (not every frame at high playback speeds)
const PASS_BUCKET_MS = 12 * 3600 * 1000;
const AGE_CLASS = { ok: styles.ageOk, warn: styles.ageWarn, bad: styles.ageBad };

function Stat({ label, value, unit }) {
  return (
    <div className={styles.stat}>
      <span className={styles.label}>{label}</span>
      <span className={styles.statValue}>
        {value}
        {unit && <span className={styles.statUnit}>{unit}</span>}
      </span>
    </div>
  );
}

export default function TelemetryCard({ record, meta, now, observer, onLocate, locating, onClose }) {
  const satrec = record.satrec;
  const nowMs = now.getTime();

  const live = useMemo(() => {
    if (!satrec) return null;
    const pv = propagate(satrec, now);
    if (!pv?.position) return null;
    const gd = eciToGeodetic(pv.position, gstime(now));
    const { x, y, z } = pv.velocity;
    return {
      lat: (gd.latitude * 180) / Math.PI,
      lon: (gd.longitude * 180) / Math.PI,
      altKm: gd.height,
      speedKms: Math.hypot(x, y, z),
    };
  }, [satrec, now]);

  const passBucket = Math.floor(nowMs / PASS_BUCKET_MS) * PASS_BUCKET_MS;
  const passInfo = useMemo(() => {
    if (!satrec || !observer) return null;
    return predictPasses(satrec, observer, {
      startMs: passBucket,
      hours: PASS_HOURS + PASS_BUCKET_MS / 3600000,
      minElevationDeg: MIN_ELEVATION_DEG,
    });
  }, [satrec, observer, passBucket]);
  const horizonMs = nowMs + PASS_HOURS * 3600000;
  const upcoming = passInfo?.passes
    .filter((p) => (p.setMs ?? Infinity) > nowMs && (p.riseMs ?? nowMs) < horizonMs)
    .slice(0, MAX_PASSES_SHOWN) ?? [];
  const currentLook = passInfo?.alwaysUp ? lookAnglesAt(satrec, observer, now) : null;

  const ageMs = nowMs - record.epochMs;
  const age = elementAgeStatus(Math.abs(ageMs));
  const regime = REGIMES[record.regime];

  return (
    <section className={`${styles.panel} ${styles.card}`} aria-label={`${record.name} telemetry`}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>{record.name}</h2>
          <div className={styles.cardIds}>
            NORAD {record.id}{record.cosparId ? ` · COSPAR ${record.cosparId}` : ''}
          </div>
          <span className={styles.tag} style={{ background: regime.color }}>{record.regime} · {regime.label}</span>
        </div>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close telemetry">×</button>
      </div>

      {meta && (
        <div className={styles.section}>
          <span className={styles.label}>{meta.operator ?? 'Operator unknown'}{meta.launch_date ? ` · Launched ${meta.launch_date}` : ''}</span>
          {meta.mission && <p className={styles.mission}>{meta.mission}</p>}
        </div>
      )}

      <div className={styles.section}>
        <span className={styles.label}>Live state</span>
        {live ? (
          <div className={styles.grid}>
            <Stat label="Subpoint" value={formatLatLon(live.lat, live.lon)} />
            <Stat label="Altitude" value={live.altKm.toFixed(0)} unit="km" />
            <Stat label="Speed" value={live.speedKms.toFixed(2)} unit="km/s" />
            <Stat label="Period" value={record.periodMin.toFixed(1)} unit="min" />
          </div>
        ) : (
          <p className={styles.note}>SGP4 cannot propagate this element set at the current time. The object may have decayed.</p>
        )}
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Orbit</span>
        <div className={styles.grid}>
          <Stat label="Inclination" value={record.inclinationDeg.toFixed(2)} unit="°" />
          <Stat label="Eccentricity" value={record.eccentricity.toFixed(4)} />
          <Stat label="Apogee" value={record.apogeeKm.toFixed(0)} unit="km" />
          <Stat label="Perigee" value={record.perigeeKm.toFixed(0)} unit="km" />
        </div>
        <p className={`${styles.ageNote} ${AGE_CLASS[age.level]}`}>
          Elements {formatAge(ageMs)} {ageMs >= 0 ? 'old' : 'ahead of epoch'} · {age.note}
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Passes over observer · next {PASS_HOURS} h · above {MIN_ELEVATION_DEG}°</span>
        <div className={styles.observerRow}>
          <span className={styles.observer}>
            {observer.label}
            <span className={styles.mono}>{formatLatLon(observer.lat, observer.lon)}</span>
          </span>
          <button className={styles.linkButton} onClick={onLocate} disabled={locating}>
            {locating ? 'Locating…' : 'Use my location'}
          </button>
        </div>

        {passInfo?.alwaysUp && currentLook && (
          <p className={styles.note}>
            Always above the horizon: elevation <span className={styles.mono}>{currentLook.elevationDeg.toFixed(1)}°</span>,
            azimuth <span className={styles.mono}>{currentLook.azimuthDeg.toFixed(1)}° {compass(currentLook.azimuthDeg)}</span>.
          </p>
        )}
        {passInfo && !passInfo.alwaysUp && upcoming.length === 0 && (
          <p className={styles.note}>No passes above {MIN_ELEVATION_DEG}° in the next {PASS_HOURS} hours from this location.</p>
        )}
        {upcoming.length > 0 && (
          <ol className={`${styles.list} ${styles.passes}`}>
            {upcoming.map((p) => (
              <li key={p.peakMs} className={`${styles.pass} ${p.visible ? styles.passVisible : ''}`}>
                <span className={styles.passWhen}>{p.riseMs ? formatLocalDateTime(p.riseMs) : 'In progress'}</span>
                <span className={styles.passEl}>{p.maxElevationDeg.toFixed(0)}° max</span>
                <span className={styles.passDetail}>
                  {compass(p.riseAzimuthDeg)} → {compass(p.setAzimuthDeg)}
                  {p.riseMs && p.setMs ? ` · ${formatDuration(p.setMs - p.riseMs)}` : ''}
                </span>
                {p.visible ? <span className={styles.badgeVisible}>VISIBLE</span> : <span />}
              </li>
            ))}
          </ol>
        )}
        <p className={styles.note}>
          Times in your local time zone. Visible means the object is sunlit while your sky is dark.
        </p>
      </div>
    </section>
  );
}
