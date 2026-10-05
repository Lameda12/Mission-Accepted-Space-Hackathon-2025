'use client';
import { useEffect, useState, useRef } from 'react';
import GlobeScene from '@/components/GlobeScene';
import socket from '@/utils/socket';
import { createSimClock } from '@/lib/simClock';

// The sim clock ticks inside the render loop; the sidebar clock only needs a few updates a second
const DISPLAY_REFRESH_MS = 250;
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export default function Page() {
  const [sats, setSats] = useState([]);
  const [selected, setSelected] = useState([]);  // Changed to array for multiple satellites
  const [searchTerm, setSearchTerm] = useState('');

  // Time control state: clockRef is the source of truth, displayTime is for the sidebar only
  const clockRef = useRef(null);
  const [displayTime, setDisplayTime] = useState(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Track window size for responsive layout
  const [isMobile, setIsMobile] = useState(false);

  // Create the clock on the client only to avoid a hydration mismatch
  useEffect(() => {
    clockRef.current ??= createSimClock();
    setDisplayTime(new Date(clockRef.current.now()));
    const interval = setInterval(() => setDisplayTime(new Date(clockRef.current.now())), DISPLAY_REFRESH_MS);

    setIsMobile(window.innerWidth <= 768);
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Visual toggles
  const [showAtmosphere, setShowAtmosphere] = useState(true);
  const [showClouds, setShowClouds] = useState(true);
  const [showBloom, setShowBloom] = useState(true);

  const [tleById, setTleById] = useState(new Map());

  useEffect(() => {
    const handler = (data) => {
      const merged = data.map(d => {
        const meta = tleById.get(d.norad_id) || {};
        return { ...d, ...meta };
      });
      setSats(merged);
    };

    socket.on('positions', handler);
    return () => socket.off('positions', handler);
  }, [tleById]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/satellites`);
        const meta = await r.json();
        const map = new Map(meta.map(m => [m.norad_id, { tle1: m.tle1, tle2: m.tle2, name: m.name }]));
        setTleById(map);
      } catch (e) {
        console.error('Failed to fetch /api/satellites:', e);
      }
    })();
  }, []);

  const filteredSats = sats.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.norad_id.toString().includes(searchTerm)
  );

  const togglePlaying = () => {
    clockRef.current.setPlaying(!isPlaying);
    setIsPlaying(!isPlaying);
  };

  const changeSpeed = (speed) => {
    clockRef.current.setSpeed(speed);
    setPlaybackSpeed(speed);
  };

  const resetToNow = () => {
    clockRef.current.setPlaying(false);
    clockRef.current.set(Date.now());
    setIsPlaying(false);
    setDisplayTime(new Date(clockRef.current.now()));
  };

  const formatDate = (date) => {
    if (!date) return 'Loading...';
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  if (!displayTime) {
    return <div style={{ color: '#fff', padding: '20px' }}>Initializing Earth...</div>;
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : '360px 1fr',
      gridTemplateRows: isMobile ? 'auto 1fr' : '1fr',
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      <aside style={{
        padding: isMobile ? '16px' : '20px',
        background: 'linear-gradient(180deg, #0a0e1a 0%, #0d1321 100%)',
        color: '#e0e6ed',
        overflowY: 'auto',
        borderRight: isMobile ? 'none' : '1px solid #1a2332',
        borderBottom: isMobile ? '1px solid #1a2332' : 'none',
        maxHeight: isMobile ? '40vh' : '100vh'
      }}>
        <h2 style={{ margin: '0 0 20px 0', fontSize: '24px', fontWeight: '600', color: '#fff' }}>
          SatelLocator
        </h2>

        {/* Search */}
        <div style={{ marginBottom: '20px' }}>
          <input
            type="text"
            placeholder="Search satellites..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: '#1a2332',
              border: '1px solid #2a3442',
              borderRadius: '6px',
              color: '#fff',
              fontSize: '14px',
              outline: 'none',
              transition: 'border-color 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = '#4488ff'}
            onBlur={(e) => e.target.style.borderColor = '#2a3442'}
          />
        </div>

        {/* Satellite selection - Multi-select */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: '500', color: '#a0aab8' }}>
            Select Satellites (multiple)
          </label>
          <div style={{ maxHeight: '200px', overflowY: 'auto', background: '#1a2332', border: '1px solid #2a3442', borderRadius: '6px', padding: '8px' }}>
            {filteredSats.map((s) => {
              const isSelected = selected.some(sel => sel.norad_id === s.norad_id);
              return (
                <label
                  key={s.norad_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '8px',
                    cursor: 'pointer',
                    background: isSelected ? '#2a3442' : 'transparent',
                    borderRadius: '4px',
                    marginBottom: '4px'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelected([...selected, s]);
                      } else {
                        setSelected(selected.filter(sel => sel.norad_id !== s.norad_id));
                      }
                    }}
                    style={{ marginRight: '10px', accentColor: '#4488ff' }}
                  />
                  <span style={{ color: '#e0e6ed', fontSize: '13px' }}>{s.name}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Selected satellites info */}
        {selected.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600', color: '#a0aab8' }}>
              Tracking {selected.length} satellite{selected.length > 1 ? 's' : ''}
            </h4>
            {selected.map((sat) => (
              <div
                key={sat.norad_id}
                style={{
                  marginBottom: '8px',
                  padding: '12px',
                  background: '#1a2332',
                  borderRadius: '6px',
                  border: '1px solid #2a3442',
                  fontSize: '12px'
                }}
              >
                <div style={{ fontWeight: '600', color: '#fff', marginBottom: '4px' }}>{sat.name}</div>
                <div style={{ color: '#a0aab8' }}>NORAD: {sat.norad_id}</div>
              </div>
            ))}
          </div>
        )}

        {/* Time controls */}
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          background: '#1a2332',
          borderRadius: '8px',
          border: '1px solid #2a3442'
        }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600', color: '#fff' }}>
            Time Control
          </h4>

          <div style={{ fontSize: '12px', marginBottom: '12px', color: '#a0aab8' }}>
            {formatDate(displayTime)}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button
              onClick={togglePlaying}
              style={{
                flex: 1,
                padding: '8px 16px',
                background: isPlaying ? '#ff4444' : '#4488ff',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.8'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>

            <button
              onClick={resetToNow}
              style={{
                padding: '8px 16px',
                background: '#2a3442',
                border: '1px solid #3a4452',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
              onMouseOver={(e) => e.target.style.background = '#3a4452'}
              onMouseOut={(e) => e.target.style.background = '#2a3442'}
            >
              Now
            </button>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: '#a0aab8' }}>
              Speed: {playbackSpeed.toFixed(0)}x
            </label>
            <input
              type="range"
              min="0"
              max="12"
              step="1"
              value={Math.log2(playbackSpeed)}
              onChange={(e) => changeSpeed(Math.pow(2, Number(e.target.value)))}
              list="speed-ticks"
              style={{
                width: '100%',
                accentColor: '#4488ff'
              }}
            />

            <datalist id="speed-ticks">
              {Array.from({ length: 13 }, (_, i) => (
                <option key={i} value={i} />
              ))}
            </datalist>

            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              fontSize: '11px', 
              color: '#6a7481', 
              marginTop: '4px' 
            }}>
              <span>Normal</span>
              <span>4096x</span>
            </div>
          </div>
        </div>

        {/* Visual toggles */}
        <div style={{
          padding: '16px',
          background: '#1a2332',
          borderRadius: '8px',
          border: '1px solid #2a3442'
        }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600', color: '#fff' }}>
            Visual Settings
          </h4>

          <label style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', cursor: 'pointer', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={showAtmosphere}
              onChange={(e) => setShowAtmosphere(e.target.checked)}
              style={{ marginRight: '10px', accentColor: '#4488ff' }}
            />
            <span style={{ color: '#e0e6ed' }}>Atmosphere Glow</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', cursor: 'pointer', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={showClouds}
              onChange={(e) => setShowClouds(e.target.checked)}
              style={{ marginRight: '10px', accentColor: '#4488ff' }}
            />
            <span style={{ color: '#e0e6ed' }}>Cloud Layer</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={showBloom}
              onChange={(e) => setShowBloom(e.target.checked)}
              style={{ marginRight: '10px', accentColor: '#4488ff' }}
            />
            <span style={{ color: '#e0e6ed' }}>Bloom Effect</span>
          </label>
        </div>

      </aside>

      <main>
        <GlobeScene
          selectedSatellites={selected}
          clockRef={clockRef}
          showAtmosphere={showAtmosphere}
          showClouds={showClouds}
          showBloom={showBloom}
        />
      </main>
    </div>
  );
}
