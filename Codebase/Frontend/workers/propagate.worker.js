// Propagates the whole catalog off the main thread. Positions are written in scene
// coordinates (see eciToWorld) into a Float32Array that is transferred, not copied.
import { propagate } from 'satellite.js';
import { satrecFromRow } from '../lib/catalog.js';

let satrecs = [];

self.onmessage = ({ data }) => {
  if (data.type === 'catalog') {
    satrecs = data.rows.map(satrecFromRow);
    self.postMessage({ type: 'ready', count: satrecs.length });
    return;
  }

  if (data.type === 'propagate') {
    const n = satrecs.length;
    const out = data.buffer?.byteLength === n * 12 ? new Float32Array(data.buffer) : new Float32Array(n * 3);
    const date = new Date(data.timeMs);
    for (let i = 0; i < n; i++) {
      const p = satrecs[i] && propagate(satrecs[i], date)?.position;
      // Objects that fail to propagate (decayed, stale elements) park at Earth's centre,
      // where the globe hides them
      out[i * 3] = p ? p.x : 0;
      out[i * 3 + 1] = p ? p.z : 0;
      out[i * 3 + 2] = p ? -p.y : 0;
    }
    self.postMessage({ type: 'positions', timeMs: data.timeMs, buffer: out.buffer }, [out.buffer]);
  }
};
