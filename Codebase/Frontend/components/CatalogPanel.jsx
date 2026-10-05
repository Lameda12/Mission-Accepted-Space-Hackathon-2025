import { memo, useMemo } from 'react';
import { REGIMES } from '@/lib/catalog';
import styles from './hud.module.css';

const MAX_RESULTS = 60;

function CatalogPanel({
  records,
  byId,
  featured,
  search,
  onSearch,
  visibleRegimes,
  onToggleRegime,
  selectedIds,
  activeId,
  onSelect,
  onRemove,
  open,
}) {
  const regimeCounts = useMemo(() => {
    const counts = Object.fromEntries(Object.keys(REGIMES).map((k) => [k, 0]));
    for (const r of records ?? []) counts[r.regime]++;
    return counts;
  }, [records]);

  const query = search.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query || !records) return null;
    const matches = records.filter((r) => r.id.startsWith(query) || r.name.toLowerCase().includes(query));
    return { total: matches.length, shown: matches.slice(0, MAX_RESULTS) };
  }, [query, records]);

  const featuredRecords = featured.map((f) => byId.get(f.norad_id)).filter(Boolean);
  const item = (r) => (
    <li key={r.id}>
      <button
        className={`${styles.item} ${r.id === activeId ? styles.itemActive : ''}`}
        onClick={() => onSelect(r.id)}
        aria-current={r.id === activeId ? 'true' : undefined}
      >
        <span className={styles.dot} style={{ background: REGIMES[r.regime].color }} aria-hidden="true" />
        <span className={styles.itemName}>{r.name}</span>
        <span className={styles.itemMeta}>{r.id}</span>
      </button>
    </li>
  );

  return (
    <aside className={`${styles.panel} ${styles.catalog} ${open ? '' : styles.catalogClosed}`} aria-label="Satellite catalog">
      <div className={styles.catalogHeader}>
        <input
          className={styles.search}
          type="search"
          placeholder={records ? 'Search by name or NORAD ID' : 'Loading catalog…'}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          disabled={!records}
          aria-label="Search satellites"
        />
        <div className={styles.regimes} role="group" aria-label="Orbit regimes shown on the globe">
          {Object.entries(REGIMES).map(([key, { label, color }]) => (
            <button
              key={key}
              className={styles.regime}
              aria-pressed={visibleRegimes.has(key)}
              onClick={() => onToggleRegime(key)}
              title={label}
            >
              <span className={styles.regimeName}>
                <span className={styles.dot} style={{ background: color }} aria-hidden="true" />
                {key}
              </span>
              <span className={styles.regimeCount}>{regimeCounts[key].toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.listScroll}>
        {selectedIds.length > 0 && (
          <>
            <div className={`${styles.sectionLabel} ${styles.label}`}>
              <span>Tracking</span>
              <span>{selectedIds.length}</span>
            </div>
            <div className={styles.tracked}>
              {selectedIds.map((id) => byId.get(id)).filter(Boolean).map((r) => (
                <span key={r.id} className={styles.trackedChip}>
                  <button className={styles.trackedName} onClick={() => onSelect(r.id)}>
                    {r.name}
                  </button>
                  <button onClick={() => onRemove(r.id)} aria-label={`Stop tracking ${r.name}`}>×</button>
                </span>
              ))}
            </div>
          </>
        )}

        {results ? (
          <>
            <div className={`${styles.sectionLabel} ${styles.label}`}>
              <span>Results</span>
              <span>{results.total > MAX_RESULTS ? `${MAX_RESULTS} of ${results.total.toLocaleString()}` : results.total}</span>
            </div>
            {results.total === 0 ? (
              <p className={styles.empty}>No objects match “{search}”.</p>
            ) : (
              <ul className={styles.list}>{results.shown.map(item)}</ul>
            )}
          </>
        ) : (
          <>
            <div className={`${styles.sectionLabel} ${styles.label}`}>
              <span>Featured · Canada</span>
              <span>{featuredRecords.length}</span>
            </div>
            <ul className={styles.list}>{featuredRecords.map(item)}</ul>
          </>
        )}
      </div>
    </aside>
  );
}

export default memo(CatalogPanel);
