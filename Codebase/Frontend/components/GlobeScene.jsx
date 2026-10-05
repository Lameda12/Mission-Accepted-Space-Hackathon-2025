'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2, LineMaterial, LineGeometry } from 'three-stdlib';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect } from 'postprocessing';
import { parseTle, getOrbitPositions, getPositionAtTime, eciToWorld, earthRotationAngle, EARTH_RADIUS_KM } from '@/lib/orbit';
import { getSunDirection } from '@/lib/sun';

const ORBIT_POINTS = 150;
const ORBIT_COLORS = [0x00ffff, 0xff00ff, 0xffff00, 0x00ff00, 0xff8800, 0x0088ff, 0xff0088];

export default function GlobeScene({
  selectedSatellites = [],
  clockRef,
  showAtmosphere = true,
  showClouds = true,
  showBloom = true
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const resolutionRef = useRef(new THREE.Vector2(1, 1));
  // norad_id -> { satrec, periodMs, line, marker, orbitDrawnAt }
  const trackedRef = useRef(new Map());
  const showBloomRef = useRef(showBloom);

  useEffect(() => {
    showBloomRef.current = showBloom;
  }, [showBloom]);

  useEffect(() => {
    const mount = mountRef.current;
    const tracked = trackedRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 100, 1e7);
    camera.position.set(0, EARTH_RADIUS_KM * 3, EARTH_RADIUS_KM * 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    mount.appendChild(renderer.domElement);
    resolutionRef.current.set(mount.clientWidth, mount.clientHeight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = EARTH_RADIUS_KM * 1.5;
    controls.maxDistance = EARTH_RADIUS_KM * 50;

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x222222, 0.3));

    scene.add(createStarfield());

    const earthGroup = new THREE.Group();
    const { earth, uniforms: earthUniforms } = createEarth();
    const clouds = createClouds();
    earthGroup.add(earth, clouds, createAtmosphere());
    scene.add(earthGroup);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera, new SMAAEffect(), new BloomEffect({
      intensity: 0.4,
      luminanceThreshold: 0.3,
      luminanceSmoothing: 0.7
    })));

    const onResize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
      resolutionRef.current.set(width, height);
      for (const t of tracked.values()) t.line?.material.resolution.copy(resolutionRef.current);
    };
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();
    let rafId;
    const tick = () => {
      const delta = clock.getDelta();
      const nowMs = clockRef.current.now();
      const now = new Date(nowMs);

      // Earth orientation and sunlight follow sim time
      earthGroup.rotation.y = earthRotationAngle(now);
      const sunDir = getSunDirection(now);
      sunLight.position.copy(sunDir).multiplyScalar(EARTH_RADIUS_KM * 5);
      earthUniforms.uLightDirection.value.copy(sunDir);
      clouds.rotation.y += delta * 0.01;

      for (const t of tracked.values()) {
        // Each line spans one period from orbitDrawnAt in the inertial frame. The plane
        // drifts only slowly (J2, drag), so redraw once sim time leaves that window.
        if (Math.abs(nowMs - t.orbitDrawnAt) > t.periodMs) {
          updateOrbitGeometry(t, now);
        }
        const pos = getPositionAtTime(t.satrec, now);
        if (pos) t.marker.position.set(...eciToWorld(pos));
        scaleMarker(t.marker, camera);
      }

      controls.update();
      if (showBloomRef.current) composer.render(delta);
      else renderer.render(scene, camera);

      rafId = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      for (const t of tracked.values()) disposeTracked(t);
      tracked.clear();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [clockRef]);

  useEffect(() => {
    const atmosphere = sceneRef.current?.getObjectByName('atmosphere');
    if (atmosphere) atmosphere.visible = showAtmosphere;
  }, [showAtmosphere]);

  useEffect(() => {
    const clouds = sceneRef.current?.getObjectByName('clouds');
    if (clouds) clouds.visible = showClouds;
  }, [showClouds]);

  // Add/remove tracked satellites to match the selection
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const tracked = trackedRef.current;
    const selectedIds = new Set(selectedSatellites.map(s => String(s.norad_id)));

    for (const [id, t] of tracked) {
      if (!selectedIds.has(id)) {
        disposeTracked(t);
        tracked.delete(id);
      }
    }

    const now = new Date(clockRef.current.now());
    for (const sat of selectedSatellites) {
      const id = String(sat.norad_id);
      if (tracked.has(id) || !sat.tle1 || !sat.tle2) continue;

      const color = ORBIT_COLORS[sat.norad_id % ORBIT_COLORS.length];
      const material = new LineMaterial({ color, linewidth: 3, resolution: resolutionRef.current.clone() });
      material.depthWrite = false;
      const line = new Line2(new LineGeometry(), material);
      line.renderOrder = 1;
      const marker = createMarker(color);
      scene.add(line, marker);

      const satrec = parseTle(sat.tle1, sat.tle2);
      const periodMs = (2 * Math.PI / satrec.no) * 60 * 1000; // satrec.no is rad/min
      const t = { satrec, periodMs, line, marker, orbitDrawnAt: -Infinity };
      updateOrbitGeometry(t, now);
      tracked.set(id, t);
    }
  }, [selectedSatellites, clockRef]);

  return <div ref={mountRef} style={{ width: '100%', height: '100vh' }} />;
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
  const starCount = 10000;
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
  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 2 }));
  stars.name = 'starfield';
  return stars;
}

// Earth mesh starts with a flat material, then swaps to the day/night shader once
// textures load. Uniforms are shared so the render loop can update the sun direction.
function createEarth() {
  const uniforms = {
    uDayMap: { value: null },
    uNightMap: { value: null },
    uLightDirection: { value: new THREE.Vector3(1, 0, 0) }
  };
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM, 128, 128),
    new THREE.MeshPhongMaterial({ color: 0x2233ff, emissive: 0x112244, specular: 0x333333, shininess: 5 })
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
        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uDayMap;
        uniform sampler2D uNightMap;
        uniform vec3 uLightDirection;

        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
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
      `
    });
  }).catch((err) => console.error('Earth textures failed to load:', err));

  return { earth, uniforms };
}

function createClouds() {
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.0105, 128, 128),
    new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false })
  );
  clouds.name = 'clouds';
  return clouds;
}

function createAtmosphere() {
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.08, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        uAtmosphereColor: { value: new THREE.Color(0x4488ff) }
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uAtmosphereColor;
        varying vec3 vNormal;

        void main() {
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 3.0);
          float alpha = fresnel * 0.6;
          gl_FragColor = vec4(uAtmosphereColor, alpha);
        }
      `,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  atmosphere.name = 'atmosphere';
  return atmosphere;
}

// Glowing sprite marker in the satellite's orbit color
function createMarker(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.8)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    blending: THREE.AdditiveBlending
  }));
  const baseScale = EARTH_RADIUS_KM * 0.05;
  sprite.scale.set(baseScale, baseScale, 1);
  sprite.userData.baseScale = baseScale;
  return sprite;
}

// Keep markers readable at any zoom
function scaleMarker(sprite, camera) {
  const camDist = camera.position.distanceTo(sprite.position);
  const scaleFactor = THREE.MathUtils.clamp((camDist / (EARTH_RADIUS_KM * 1.2)) ** 0.8, 1, 8);
  const s = sprite.userData.baseScale * scaleFactor;
  sprite.scale.set(s, s, 1);
}
