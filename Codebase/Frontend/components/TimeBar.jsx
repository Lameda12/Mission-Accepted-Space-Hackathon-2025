import { formatOffset, formatUtc } from '@/lib/format';
import styles from './hud.module.css';

export const SPEEDS = [1, 10, 60, 600, 3600];
const LIVE_TOLERANCE_MS = 2000;

export default function TimeBar({
  now,
  realNowMs,
  isPlaying,
  speed,
  onTogglePlay,
  onSpeed,
  onLive,
  showAtmosphere,
  onToggleAtmosphere,
  showBloom,
  onToggleBloom,
}) {
  const offsetMs = now ? now.getTime() - realNowMs : 0;
  const isLive = isPlaying && speed === 1 && Math.abs(offsetMs) < LIVE_TOLERANCE_MS;

  return (
    <div className={`${styles.panel} ${styles.timeBar}`} role="group" aria-label="Simulation time">
      <button className={styles.playButton} onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 3 1.5Z" fill="currentColor" /></svg>
        )}
      </button>

      <button className={styles.liveButton} data-live={isLive} onClick={onLive} title="Jump to real time at 1×">
        <span className={`${styles.dot} ${isLive ? styles.dotLive : styles.dotIdle}`} aria-hidden="true" />
        LIVE
      </button>

      <div className={styles.simInfo}>
        <span className={styles.simTime}>{now ? `${formatUtc(now)} UTC` : '—'}</span>
        <span className={styles.simOffset}>{isLive ? 'Real time' : `${formatOffset(offsetMs)} from real time`}</span>
      </div>

      <div className={styles.speeds} role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} className={styles.speed} aria-pressed={speed === s} onClick={() => onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>

      <div className={styles.toggles}>
        <button className={styles.toggle} aria-pressed={showAtmosphere} onClick={onToggleAtmosphere}>Atmo</button>
        <button className={styles.toggle} aria-pressed={showBloom} onClick={onToggleBloom}>Glow</button>
      </div>
    </div>
  );
}
