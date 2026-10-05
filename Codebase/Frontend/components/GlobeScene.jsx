'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2, LineMaterial, LineGeometry } from 'three-stdlib';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect } from 'postprocessing';
import { getOrbitPositions, getPositionAtTime, eciToWorld, earthRotationAngle, geoToCartesianKm, EARTH_RADIUS_KM } from '@/lib/orbit';
import { getSunDirection } from '@/lib/sun';
import { REGIMES } from '@/lib/catalog';
import styles from './GlobeScene.module.css';

const ORBIT_POINTS = 150;
const ORBIT_COLORS = [0x00e5ff, 0xff4fd8, 0xfff04f, 0x5cff7a, 0xff9a3d, 0x6ea8ff, 0xff5c8a];
const POINT_SIZE_PX = 2.6;
// Worker round trips are paced so propagation never runs flat out on a core
const PROPAGATE_INTERVAL_MS = 50;
const CLICK_MAX_MOVE_PX = 5;

// Fragments for custom shaders: the renderer uses a logarithmic depth buffer, so every
// material must write log depth or occlusion against built-in materials breaks.
const LOGDEPTH_VERTEX_PARS = '#include <common>\n#include <logdepthbuf_pars_vertex>';
const LOGDEPTH_FRAGMENT_PARS = '#include <logdepthbuf_pars_fragment>';

export default function GlobeScene({
  records = null,
  visibleRegimes,
  selected = [],
  activeId = null,
  observer = null,
  clockRef,
  showAtmosphere = true,
  showBloom = true,
  onPick,
}) {
  const mountRef = useRef(null);
  const tooltipRef = useRef(null);
  const sceneRef = useRef(null);
  const earthGroupRef = useRef(null);
  const resolutionRef = useRef(new THREE.Vector2(1, 1));
  // norad_id -> { satrec, periodMs, line, marker, orbitDrawnAt }
  const trackedRef = useRef(new Map());
  const catalogLayerRef = useRef(null);
  const showBloomRef = useRef(showBloom);
  const onPickRef = useRef(onPick);
  const activeIdRef = useRef(activeId);

  useEffect(() => { showBloomRef.current = showBloom; }, [showBloom]);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // Scene, render loop, picking
  useEffect(() => {
    const mount = mountRef.current;
    const tracked = trackedRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#02040a');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 100, 1e7);
    camera.position.set(0, EARTH_RADIUS_KM * 2.2, EARTH_RADIUS_KM * 3.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    mount.appendChild(renderer.domElement);
    resolutionRef.current.set(mount.clientWidth, mount.clientHeight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = EARTH_RADIUS_KM * 1.3;
    controls.maxDistance = EARTH_RADIUS_KM * 25;
    controls.rotateSpeed = 0.5;

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    scene.add(sunLight, new THREE.AmbientLight(0x222222, 0.3));
    scene.add(createStarfield());

    const earthGroup = new THREE.Group();
    earthGroupRef.current = earthGroup;
    const { earth, uniforms: earthUniforms } = createEarth();
    const clouds = createClouds();
    earthGroup.add(earth, clouds, createAtmosphere());
    scene.add(earthGroup);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera, new SMAAEffect(), new BloomEffect({
      intensity: 0.45,
      luminanceThreshold: 0.35,
      luminanceSmoothing: 0.7,
    })));

    const onResize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
      resolutionRef.current.set(width, height);
      for (const t of tracked.values()) t.line.material.resolution.copy(resolutionRef.current);
    };
    window.addEventListener('resize', onResize);

    // Picking: nearest visible catalog point to the cursor ray, ignoring points behind Earth
    const raycaster = new THREE.Raycaster();
    const earthSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_RADIUS_KM);
    const pointer = new THREE.Vector2();
    const pickAt = (clientX, clientY) => {
      const layer = catalogLayerRef.current;
      if (!layer) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      // ~6 px pick radius at the distance of Earth's centre
      raycaster.params.Points.threshold = (camera.position.length() * 6 * 2 * Math.tan((camera.fov * Math.PI) / 360)) / rect.height;
      const earthHit = raycaster.ray.intersectSphere(earthSphere, new THREE.Vector3());
      const earthDist = earthHit ? earthHit.distanceTo(raycaster.ray.origin) : Infinity;
      let best = null;
      for (const hit of raycaster.intersectObject(layer.points)) {
        if (!layer.visible[hit.index] || hit.distance > earthDist) continue;
        if (!best || hit.distanceToRay < best.distanceToRay) best = hit;
      }
      return best ? layer.records[best.index] : null;
    };

    let downAt = null;
    let hoverQueued = null;
    const onPointerDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onPointerUp = (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > CLICK_MAX_MOVE_PX) return;
      downAt = null;
      const record = pickAt(e.clientX, e.clientY);
      onPickRef.current?.(record?.id ?? null);
    };
    const onPointerMove = (e) => { hoverQueued = { x: e.clientX, y: e.clientY }; };
    const onPointerLeave = () => {
      hoverQueued = null;
      if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    const updateHover = () => {
      if (!hoverQueued || downAt) return;
      const { x, y } = hoverQueued;
      hoverQueued = null;
      const tooltip = tooltipRef.current;
      const record = pickAt(x, y);
      renderer.domElement.style.cursor = record ? 'pointer' : 'grab';
      if (!tooltip) return;
      if (!record) {
        tooltip.style.opacity = '0';
        return;
      }
      const rect = mount.getBoundingClientRect();
      tooltip.textContent = `${record.name} · ${record.id}`;
      tooltip.style.transform = `translate(${x - rect.left + 14}px, ${y - rect.top + 14}px)`;
      tooltip.style.opacity = '1';
    };

    const clock = new THREE.Clock();
    let rafId;
    const tick = () => {
      const delta = clock.getDelta();
      const nowMs = clockRef.current.now();
      const now = new Date(nowMs);

      earthGroup.rotation.y = earthRotationAngle(now);
      const sunDir = getSunDirection(now);
      sunLight.position.copy(sunDir).multiplyScalar(EARTH_RADIUS_KM * 5);
      earthUniforms.uLightDirection.value.copy(sunDir);
      clouds.rotation.y += delta * 0.01;

      catalogLayerRef.current?.requestPositions(nowMs);

      for (const [id, t] of tracked) {
        // Each line spans one period from orbitDrawnAt in the inertial frame. The plane
        // drifts only slowly (J2, drag), so redraw once sim time leaves that window.
        if (Math.abs(nowMs - t.orbitDrawnAt) > t.periodMs) updateOrbitGeometry(t, now);
        const pos = getPositionAtTime(t.satrec, now);
        t.marker.visible = !!pos;
        if (pos) t.marker.position.set(...eciToWorld(pos));
        scaleMarker(t.marker, camera, id === activeIdRef.current);
        t.line.material.opacity = id === activeIdRef.current ? 1 : 0.55;
      }

      updateHover();
      controls.update();
      if (showBloomRef.current) composer.render(delta);
      else renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      for (const t of tracked.values()) disposeTracked(t);
      tracked.clear();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      earthGroupRef.current = null;
    };
  }, [clockRef]);

  // Catalog point cloud, fed by the propagation worker
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !records?.length) return;
    const layer = createCatalogLayer(records);
    scene.add(layer.points);
    catalogLayerRef.current = layer;
    return () => {
      catalogLayerRef.current = null;
      layer.dispose();
    };
  }, [records]);

  useEffect(() => {
    catalogLayerRef.current?.setVisibleRegimes(visibleRegimes);
  }, [visibleRegimes, records]);

  useEffect(() => {
    const atmosphere = sceneRef.current?.getObjectByName('atmosphere');
    if (atmosphere) atmosphere.visible = showAtmosphere;
  }, [showAtmosphere]);

  // Observer marker, fixed to the rotating Earth
  useEffect(() => {
    const earthGroup = earthGroupRef.current;
    if (!earthGroup || !observer) return;
    const marker = createObserverMarker();
    marker.position.set(...geoToCartesianKm(observer.lat * Math.PI / 180, observer.lon * Math.PI / 180, 15));
    earthGroup.add(marker);
    return () => {
      marker.removeFromParent();
      marker.material.map?.dispose();
      marker.material.dispose();
    };
  }, [observer]);

  // Orbit lines and markers for selected objects
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const tracked = trackedRef.current;
    const selectedIds = new Set(selected.map((r) => r.id));

    for (const [id, t] of tracked) {
      if (!selectedIds.has(id)) {
        disposeTracked(t);
        tracked.delete(id);
      }
    }

    const now = new Date(clockRef.current.now());
    for (const record of selected) {
      const satrec = record.satrec;
      if (tracked.has(record.id) || !satrec) continue;

      const color = ORBIT_COLORS[Number(record.id) % ORBIT_COLORS.length];
      const material = new LineMaterial({ color, linewidth: 2.5, resolution: resolutionRef.current.clone(), transparent: true });
      material.depthWrite = false;
      const line = new Line2(new LineGeometry(), material);
      line.renderOrder = 1;
      const marker = createMarker(color);
      scene.add(line, marker);

      const t = { satrec, periodMs: record.periodMin * 60000, line, marker, orbitDrawnAt: -Infinity };
      updateOrbitGeometry(t, now);
      tracked.set(record.id, t);
    }
  }, [selected, clockRef]);

  return (
    <div ref={mountRef} className={styles.mount}>
      <div ref={tooltipRef} className={styles.tooltip} aria-hidden="true" />
    </div>
  );
}

function createCatalogLayer(records) {
  const n = records.length;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  position.setUsage(THREE.DynamicDrawUsage);
  const visibleAttr = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
  const colors = new Float32Array(n * 3);
  const regimeColors = Object.fromEntries(Object.entries(REGIMES).map(([k, v]) => [k, new THREE.Color(v.color)]));
  records.forEach((r, i) => regimeColors[r.regime].toArray(colors, i * 3));
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aVisible', visibleAttr);
  // Positions change every update; a fixed bound past GEO avoids recomputing it
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_RADIUS_KM * 40);

  const material = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: POINT_SIZE_PX * Math.min(window.devicePixelRatio, 1.5) } },
    vertexShader: `
      ${LOGDEPTH_VERTEX_PARS}
      attribute vec3 aColor;
      attribute float aVisible;
      uniform float uSize;
      varying vec3 vColor;
      varying float vVisible;
      void main() {
        vColor = aColor;
        vVisible = aVisible;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * aVisible;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      ${LOGDEPTH_FRAGMENT_PARS}
      varying vec3 vColor;
      varying float vVisible;
      void main() {
        #include <logdepthbuf_fragment>
        if (vVisible < 0.5) discard;
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, smoothstep(0.5, 0.15, d));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false; // until the first positions arrive

  const visible = new Uint8Array(n).fill(1);
  const worker = new Worker(new URL('../workers/propagate.worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'catalog', rows: records.map((r) => r.row) });

  let inFlight = false;
  let lastRequestWall = 0;
  let spare = null;
  worker.onmessage = ({ data }) => {
    if (data.type !== 'positions') return;
    const incoming = new Float32Array(data.buffer);
    position.array.set(incoming);
    position.needsUpdate = true;
    points.visible = true;
    spare = data.buffer; // hand the buffer back to the worker next time
    inFlight = false;
  };

  return {
    points,
    records,
    visible,
    requestPositions(timeMs) {
      const wall = performance.now();
      if (inFlight || wall - lastRequestWall < PROPAGATE_INTERVAL_MS) return;
      inFlight = true;
      lastRequestWall = wall;
      const buffer = spare;
      spare = null;
      worker.postMessage({ type: 'propagate', timeMs, buffer }, buffer ? [buffer] : []);
    },
    setVisibleRegimes(regimes) {
      records.forEach((r, i) => {
        visible[i] = !regimes || regimes.has(r.regime) ? 1 : 0;
        visibleAttr.array[i] = visible[i];
      });
      visibleAttr.needsUpdate = true;
    },
    dispose() {
      worker.terminate();
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

// Rebuild one orbit's vertices; the material (and its compiled shader) is reused
function updateOrbitGeometry(t, start) {
  const positions = [];
  for (const [x, y, z] of getOrbitPositions(t.satrec, ORBIT_POINTS, start)) {
    positions.push(...eciToWorld({ x, y, z }));
  }
  if (positions.length >= 3) positions.push(positions[0], positions[1], positions[2]);

  const geometry = new LineGeometry();
  if (positions.length >= 6) geometry.setPositions(positions);
  t.line.geometry.dispose();
  t.line.geometry = geometry;
  t.line.computeLineDistances();
  t.line.visible = positions.length >= 6;
  t.orbitDrawnAt = start.getTime();
}

function disposeTracked(t) {
  t.line.removeFromParent();
  t.line.geometry.dispose();
  t.line.material.dispose();
  t.marker.removeFromParent();
  t.marker.material.map?.dispose();
  t.marker.material.dispose();
}

function createStarfield() {
  const starCount = 8000;
  const r = EARTH_RADIUS_KM * 100;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x8090a8, size: 1.5, sizeAttenuation: false }));
  stars.name = 'starfield';
  return stars;
}

// Earth mesh starts with a flat material, then swaps to the day/night shader once
// textures load. Uniforms are shared so the render loop can update the sun direction.
function createEarth() {
  const uniforms = {
    uDayMap: { value: null },
    uNightMap: { value: null },
    uLightDirection: { value: new THREE.Vector3(1, 0, 0) },
  };
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM, 128, 128),
    new THREE.MeshPhongMaterial({ color: 0x0b1a33, emissive: 0x050a14, shininess: 5 }),
  );
  earth.name = 'earth';

  const loader = new THREE.TextureLoader();
  Promise.all([
    loader.loadAsync('/textures/earth/2k_earth_daymap.jpg'),
    loader.loadAsync('/textures/earth/2k_earth_nightmap.jpg'),
  ]).then(([dayMap, nightMap]) => {
    uniforms.uDayMap.value = dayMap;
    uniforms.uNightMap.value = nightMap;
    earth.material.dispose();
    earth.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        ${LOGDEPTH_VERTEX_PARS}
        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: `
        ${LOGDEPTH_FRAGMENT_PARS}
        uniform sampler2D uDayMap;
        uniform sampler2D uNightMap;
        uniform vec3 uLightDirection;

        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
          #include <logdepthbuf_fragment>
          vec3 normal = normalize(vWorldNormal);
          float sunDot = dot(normal, normalize(uLightDirection));

          vec3 dayColor = texture2D(uDayMap, vUv).rgb;
          vec3 nightColor = texture2D(uNightMap, vUv).rgb;

          float dayFactor = smoothstep(-0.02, 0.02, sunDot);
          vec3 color = mix(nightColor * 1.8, dayColor, dayFactor);

          float terminatorGlow = 1.0 - abs(sunDot);
          terminatorGlow = pow(terminatorGlow, 12.0) * 0.4;
          color += vec3(1.0, 0.6, 0.2) * terminatorGlow;

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }).catch((err) => console.error('Earth textures failed to load:', err));

  return { earth, uniforms };
}

function createClouds() {
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.0105, 96, 96),
    new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false }),
  );
  clouds.name = 'clouds';
  return clouds;
}

function createAtmosphere() {
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.08, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: { uAtmosphereColor: { value: new THREE.Color(0x4488ff) } },
      vertexShader: `
        ${LOGDEPTH_VERTEX_PARS}
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: `
        ${LOGDEPTH_FRAGMENT_PARS}
        uniform vec3 uAtmosphereColor;
        varying vec3 vNormal;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 3.0);
          gl_FragColor = vec4(uAtmosphereColor, fresnel * 0.6);
        }
      `,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  atmosphere.name = 'atmosphere';
  return atmosphere;
}

function glowTexture(color, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.18, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.45)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function createMarker(color) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(color),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sprite.renderOrder = 2;
  sprite.userData.baseScale = EARTH_RADIUS_KM * 0.035;
  return sprite;
}

function createObserverMarker() {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(0xffb547),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sprite.scale.set(EARTH_RADIUS_KM * 0.05, EARTH_RADIUS_KM * 0.05, 1);
  sprite.name = 'observer';
  return sprite;
}

// Keep markers readable at any zoom; the active object is drawn larger
function scaleMarker(sprite, camera, active) {
  const camDist = camera.position.distanceTo(sprite.position);
  const scaleFactor = THREE.MathUtils.clamp((camDist / (EARTH_RADIUS_KM * 1.2)) ** 0.8, 1, 8);
  const s = sprite.userData.baseScale * scaleFactor * (active ? 1.6 : 1);
  sprite.scale.set(s, s, 1);
}
