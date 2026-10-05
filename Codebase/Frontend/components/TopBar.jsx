import { formatAge, formatUtc } from '@/lib/format';
import styles from './hud.module.css';

const STATUS = {
  loading: { dot: styles.dotDegraded, title: 'Connecting' },
  live: { dot: `${styles.dotLive}`, title: 'Live' },
  degraded: { dot: styles.dotDegraded, title: 'Degraded' },
  error: { dot: styles.dotDown, title: 'Offline' },
};

export default function TopBar({ now, catalogStatus, kp, catalogOpen, onToggleCatalog }) {
  const status = STATUS[catalogStatus.state];

  return (
    <header className={styles.topBar}>
      <div className={`${styles.panel} ${styles.brand}`}>
        <span className={styles.brandMark} aria-hidden="true" />
        <span className={styles.brandText}>SATELLOCATOR</span>
      </div>

      <div className={`${styles.panel} ${styles.chip}`} title={catalogStatus.detail} role="status">
        <span className={`${styles.dot} ${status.dot}`} aria-hidden="true" />
        <strong>{status.title}</strong>
        {catalogStatus.count != null && (
          <span className={styles.hideNarrow}>
            <span className={styles.mono}>{catalogStatus.count.toLocaleString()}</span> objects
            {catalogStatus.ageMs != null && <> · data {formatAge(catalogStatus.ageMs)} old</>}
          </span>
        )}
      </div>

      {kp?.available && (
        <div className={`${styles.panel} ${styles.chip} ${styles.hideNarrow}`} title={`Planetary K-index, NOAA SWPC, observed ${kp.observedAt}`}>
          <span className={styles.label}>Kp</span>
          <strong className={`${styles.mono} ${kp.kp >= 5 ? styles.kpStorm : kp.kp >= 4 ? styles.kpActive : styles.kpQuiet}`}>
            {kp.kp.toFixed(1)}
          </strong>
          <span>{kp.scale ? `${kp.scale} · ` : ''}{kp.label}</span>
        </div>
      )}

      <div className={styles.spacer} />

      <button
        className={`${styles.panel} ${styles.chip} ${styles.mobileOnly}`}
        onClick={onToggleCatalog}
        aria-expanded={catalogOpen}
      >
        <strong>{catalogOpen ? 'Close' : 'Catalog'}</strong>
      </button>

      <div className={`${styles.panel} ${styles.clock}`}>
        <span className={styles.clockTime}>{now ? formatUtc(now) : '—'}</span>
        <span className={styles.clockSub}>Sim time · UTC</span>
      </div>
    </header>
  );
}
