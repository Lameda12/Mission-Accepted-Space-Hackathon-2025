// Simulation clock: sim time advances at `speed` x wall time while playing.
// Read it with now() inside the render loop; it never lives in React state,
// so the clock ticking does not re-render the page.
export function createSimClock(startMs = Date.now()) {
  let anchorSim = startMs;
  let anchorWall = performance.now();
  let speed = 1;
  let playing = true;

  const now = () => (playing ? anchorSim + (performance.now() - anchorWall) * speed : anchorSim);
  const reanchor = () => {
    anchorSim = now();
    anchorWall = performance.now();
  };

  return {
    now,
    setSpeed(next) {
      reanchor();
      speed = next;
    },
    setPlaying(next) {
      reanchor();
      playing = next;
    },
    set(ms) {
      anchorSim = ms;
      anchorWall = performance.now();
    },
  };
}
