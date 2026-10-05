'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GlobeScene from '@/components/GlobeScene';
import TopBar from '@/components/TopBar';
import CatalogPanel from '@/components/CatalogPanel';
import TelemetryCard from '@/components/TelemetryCard';
import TimeBar from '@/components/TimeBar';
import { createSimClock } from '@/lib/simClock';
import { buildRecords, REGIMES } from '@/lib/catalog';
import featured from '@/data/featured.json';

// The sim clock ticks inside the render loop; the HUD only needs a few updates a second
const DISPLAY_REFRESH_MS = 250;
const MAX_TRACKED = 12;
const ISS_ID = '25544';
const DEFAULT_OBSERVER = { lat: 44.6488, lon: -63.5752, label: 'Halifax, NS' };
const OBSERVER_STORAGE_KEY = 'satellocator:observer';
const featuredById = new Map(featured.map((f) => [f.norad_id, f]));

function readStoredObserver() {
  try {
    const stored = JSON.parse(localStorage.getItem(OBSERVER_STORAGE_KEY));
    if (Number.isFinite(stored?.lat) && Number.isFinite(stored?.lon)) return stored;
  } catch {
    // storage unavailable or corrupt: fall back to the default
  }
  return DEFAULT_OBSERVER;
}

export default function Page() {
  const clockRef = useRef(null);
  // Sim time and wall-clock time, sampled together for the HUD
  const [tick, setTick] = useState(null);
  const now = tick?.sim ?? null;
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [kp, setKp] = useState(null);

  const [search, setSearch] = useState('');
  const [visibleRegimes, setVisibleRegimes] = useState(() => new Set(Object.keys(REGIMES)));
  const [selectedIds, setSelectedIds] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const [observer, setObserver] = useState(DEFAULT_OBSERVER);
  const [locating, setLocating] = useState(false);
  const [showAtmosphere, setShowAtmosphere] = useState(true);
  const [showBloom, setShowBloom] = useState(true);

  // Client-only setup: clock, HUD refresh, stored observer
  useEffect(() => {
    clockRef.current ??= createSimClock();
    const sample = () => setTick({ sim: new Date(clockRef.current.now()), realMs: Date.now() });
    sample();
    const interval = setInterval(sample, DISPLAY_REFRESH_MS);
    setObserver(readStoredObserver());
    return () => clearInterval(interval);
  }, []);

  // Catalog and space weather
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/catalog', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Catalog request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        const records = buildRecords(data.objects);
        const byId = new Map(records.map((r) => [r.id, r]));
        const maxEpochMs = records.reduce((m, r) => Math.max(m, r.epochMs), 0);
        setCatalog({ ...data, records, byId, maxEpochMs, objects: undefined });

        const fromUrl = new URLSearchParams(window.location.search).get('sat');
        const initial = [fromUrl, ISS_ID, featured[1]?.norad_id].find((id) => id && byId.has(id));
        if (initial) {
          setSelectedIds([initial]);
          setActiveId(initial);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setCatalogError(err.message);
      });

    fetch('/api/space-weather', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(setKp)
      .catch(() => {});

    return () => controller.abort();
  }, []);

  // Keep ?sat= in sync so a view can be shared
  useEffect(() => {
    if (!catalog) return;
    const url = new URL(window.location.href);
    if (activeId) url.searchParams.set('sat', activeId);
    else url.searchParams.delete('sat');
    window.history.replaceState(null, '', url);
  }, [activeId, catalog]);

  const selected = useMemo(
    () => (catalog ? selectedIds.map((id) => catalog.byId.get(id)).filter(Boolean) : []),
    [selectedIds, catalog],
  );

  const select = useCallback((id) => {
    if (!id) return;
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-MAX_TRACKED)));
    setActiveId(id);
    setCatalogOpen(false);
  }, []);

  const remove = useCallback((id) => {
    const next = selectedIds.filter((x) => x !== id);
    setSelectedIds(next);
    if (activeId === id) setActiveId(next.at(-1) ?? null);
  }, [selectedIds, activeId]);

  const toggleRegime = useCallback((key) => {
    setVisibleRegimes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePlaying = useCallback(() => {
    const next = !clockRef.current.isPlaying();
    clockRef.current.setPlaying(next);
    setIsPlaying(next);
  }, []);

  const changeSpeed = (s) => {
    clockRef.current.setSpeed(s);
    setSpeed(s);
    if (!isPlaying) {
      clockRef.current.setPlaying(true);
      setIsPlaying(true);
    }
  };

  const goLive = () => {
    clockRef.current.set(Date.now());
    clockRef.current.setSpeed(1);
    clockRef.current.setPlaying(true);
    setSpeed(1);
    setIsPlaying(true);
    setTick({ sim: new Date(clockRef.current.now()), realMs: Date.now() });
  };

  const locate = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const next = { lat: coords.latitude, lon: coords.longitude, label: 'Your location' };
        setObserver(next);
        try {
          localStorage.setItem(OBSERVER_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // storage unavailable: the location still applies for this visit
        }
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
    );
  };

  // Space toggles play/pause unless the user is typing or on a button
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || e.target.closest('input, textarea, button')) return;
      e.preventDefault();
      togglePlaying();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlaying]);

  if (!tick) return null;

  const catalogStatus = catalogError
    ? { state: 'error', detail: catalogError }
    : !catalog
      ? { state: 'loading', detail: 'Loading the satellite catalog' }
      : catalog.source === 'celestrak'
        ? {
          state: 'live',
          count: catalog.records.length,
          ageMs: tick.realMs - Date.parse(catalog.generatedAt),
          detail: 'CelesTrak GP data (OMM), refreshed every 2 hours',
        }
        : {
          state: 'degraded',
          count: catalog.records.length,
          ageMs: tick.realMs - catalog.maxEpochMs,
          detail: `CelesTrak was unreachable (${catalog.error ?? 'unknown error'}); showing the bundled snapshot`,
        };

  const active = activeId ? catalog?.byId.get(activeId) : null;

  return (
    <main>
      <GlobeScene
        records={catalog?.records}
        visibleRegimes={visibleRegimes}
        selected={selected}
        activeId={activeId}
        observer={observer}
        clockRef={clockRef}
        showAtmosphere={showAtmosphere}
        showBloom={showBloom}
        onPick={select}
      />
      <TopBar
        now={now}
        catalogStatus={catalogStatus}
        kp={kp}
        catalogOpen={catalogOpen}
        onToggleCatalog={() => setCatalogOpen((o) => !o)}
      />
      <CatalogPanel
        records={catalog?.records}
        byId={catalog?.byId ?? EMPTY_MAP}
        featured={featured}
        search={search}
        onSearch={setSearch}
        visibleRegimes={visibleRegimes}
        onToggleRegime={toggleRegime}
        selectedIds={selectedIds}
        activeId={activeId}
        onSelect={select}
        onRemove={remove}
        open={catalogOpen}
      />
      {active && (
        <TelemetryCard
          record={active}
          meta={featuredById.get(active.id)}
          now={now}
          observer={observer}
          onLocate={locate}
          locating={locating}
          onClose={() => setActiveId(null)}
        />
      )}
      <TimeBar
        now={now}
        realNowMs={tick.realMs}
        isPlaying={isPlaying}
        speed={speed}
        onTogglePlay={togglePlaying}
        onSpeed={changeSpeed}
        onLive={goLive}
        showAtmosphere={showAtmosphere}
        onToggleAtmosphere={() => setShowAtmosphere((v) => !v)}
        showBloom={showBloom}
        onToggleBloom={() => setShowBloom((v) => !v)}
      />
    </main>
  );
}

const EMPTY_MAP = new Map();
