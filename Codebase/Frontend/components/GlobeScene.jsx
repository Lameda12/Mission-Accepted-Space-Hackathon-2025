'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three-stdlib';
import { LineMaterial } from 'three-stdlib';
import { LineGeometry } from 'three-stdlib';
import { EffectComposer } from 'postprocessing';
import { RenderPass } from 'postprocessing';
import { EffectPass } from 'postprocessing';
import { BloomEffect } from 'postprocessing';
import { SMAAEffect } from 'postprocessing';
import { getOrbitPositions, getPositionAtTime, eciToWorld, earthRotationAngle, EARTH_RADIUS_KM } from '@/lib/orbit';
import { orbitLineMeshes, satelliteMarkers } from '@/lib/store';
import { getSunDirection } from '@/lib/sun';

// Try multiple candidate paths and return the first texture that loads
async function loadFirstAvailableTexture(loader, candidates) {
  for (const path of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const tex = await loader.loadAsync(path);
      return tex;
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

export default function GlobeScene({
  selectedSatellites = [],  // Changed to array
  simTime,
  showAtmosphere = true,
  showClouds = true,
  showBloom = true
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const composerRef = useRef(null);
  const clockRef = useRef(new THREE.Clock());
  const sunLightRef = useRef(null);
  const earthMaterialRef = useRef(null);
  const redrawOrbitTimeoutRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');
    sceneRef.current = scene;

    // Camera setup
    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 100, 1e7);
    camera.position.set(0, EARTH_RADIUS_KM * 3, EARTH_RADIUS_KM * 3);

    // Renderer with PBR
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    mount.appendChild(renderer.domElement);

    // Controls with damping
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = EARTH_RADIUS_KM * 1.5;
    controls.maxDistance = EARTH_RADIUS_KM * 50;

    // Sun light
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    sunLight.position.set(5, 0, 2).normalize().multiplyScalar(EARTH_RADIUS_KM * 5);
    scene.add(sunLight);
    sunLightRef.current = sunLight;

    const ambientLight = new THREE.AmbientLight(0x222222, 0.3);
    scene.add(ambientLight);

    // Starfield
    createStarfield(scene);

    // Earth with day/night shader
    const earthGroup = new THREE.Group();
    earthGroup.name = 'earthGroup'; // Name it so we can find it later
    earthGroup.rotation.y = earthRotationAngle(simTime);
    const sunDirOnMount = getSunDirection(simTime);
    const earth = createEarth(earthMaterialRef, sunDirOnMount);
    earthGroup.add(earth);
    scene.add(earthGroup);

    // Clouds
    const clouds = createClouds();
    earthGroup.add(clouds);

    // Atmosphere
    const atmosphere = createAtmosphere();
    earthGroup.add(atmosphere);

    // Post-processing
    const composer = new EffectComposer(renderer);
    composerRef.current = composer;

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const smaaEffect = new SMAAEffect();
    const bloomEffect = new BloomEffect({
      intensity: 0.4,
      luminanceThreshold: 0.3,
      luminanceSmoothing: 0.7
    });

    const effectPass = new EffectPass(camera, smaaEffect, bloomEffect);
    composer.addPass(effectPass);

    // Resize handler
    const onResize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
    };
    window.addEventListener('resize', onResize);

    // Animation loop
    let rafId;
    const tick = () => {
      const delta = clockRef.current.getDelta();

      controls.update();

      // Rotate clouds slowly
      if (clouds) {
        clouds.rotation.y += delta * 0.01;
      }

      // Update satellite marker positions
      updateSatelliteMarkers(camera);

      if (showBloom) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }

      rafId = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      composer.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // Handle visibility toggles
  useEffect(() => {
    if (!sceneRef.current) return;
    const atmosphere = sceneRef.current.getObjectByName('atmosphere');
    if (atmosphere) atmosphere.visible = showAtmosphere;
  }, [showAtmosphere]);

  useEffect(() => {
    if (!sceneRef.current) return;
    const clouds = sceneRef.current.getObjectByName('clouds');
    if (clouds) clouds.visible = showClouds;
  }, [showClouds]);

  // Handle multiple satellite selection
  useEffect(() => {
    if (!sceneRef.current) return;

    // Get current IDs
    const currentIds = Object.keys(orbitLineMeshes);
    const selectedIds = selectedSatellites.map(s => String(s.norad_id));

    // Remove satellites that are no longer selected
    currentIds.forEach(id => {
      if (!selectedIds.includes(id)) {
        removeSatellite(sceneRef.current, id);
      }
    });

    // Add newly selected satellites
    selectedSatellites.forEach(sat => {
      if (!sat.tle1 || !sat.tle2) return;

      const idStr = String(sat.norad_id);
      if (!currentIds.includes(idStr)) {
        const color = getColorForSatellite(sat.norad_id);
        drawOrbitPath(sat.norad_id, sat.tle1, sat.tle2, sceneRef.current, simTime || new Date(), color);
        createSatelliteMarker(sat.norad_id, sat.tle1, sat.tle2, sceneRef.current, color, sat.name);
      }
    });
  }, [selectedSatellites]);

  // Update all marker positions based on simTime
  useEffect(() => {
    if (!sceneRef.current || !simTime || selectedSatellites.length === 0) return;

    selectedSatellites.forEach(sat => {
      updateMarkerPosition(sat.norad_id, sat.tle1, sat.tle2, simTime);
    });
  }, [simTime, selectedSatellites]);

  useEffect(() => {
    if (!simTime || !sceneRef.current) return;

    // 1) Spin the Earth by sidereal time (GMST) so it stays aligned with the ECI frame
    const earthGroup = sceneRef.current.getObjectByName('earthGroup');
    if (earthGroup) earthGroup.rotation.y = earthRotationAngle(simTime);

    // 2) True Sun direction in world space (includes seasonal tilt/declination)
    const sunDir = getSunDirection(simTime); // THREE.Vector3 already normalized

    // Move the directional light along that vector
    if (sunLightRef.current) {
      sunLightRef.current.position.copy(sunDir.clone().multiplyScalar(EARTH_RADIUS_KM * 5));
      sunLightRef.current.updateMatrixWorld();
    }

    // Update the shader uniform so the terminator is fixed in world space
    if (earthMaterialRef.current?.uniforms?.uLightDirection) {
      earthMaterialRef.current.uniforms.uLightDirection.value.copy(sunDir);
      earthMaterialRef.current.uniformsNeedUpdate = true;
    }
  }, [simTime]);

  // Handle satellite selection changes (add/remove satellites)
  useEffect(() => {
    if (!sceneRef.current) return;

    const currentIds = new Set(selectedSatellites.map(s => String(s.norad_id)));
    const existingIds = new Set(Object.keys(satelliteMarkers));

    // Remove deselected satellites
    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        removeSatellite(sceneRef.current, id);
      }
    });

    // Add newly selected satellites
    selectedSatellites.forEach(sat => {
      const idStr = String(sat.norad_id);
      if (!existingIds.has(idStr)) {
        const color = getColorForSatellite(sat.norad_id);
        drawOrbitPath(sat.norad_id, sat.tle1, sat.tle2, sceneRef.current, simTime || new Date(), color);
        createSatelliteMarker(sat.norad_id, sat.tle1, sat.tle2, sceneRef.current, color, sat.name);
      }
    });
  }, [selectedSatellites]);

  // Redraw orbit paths when simTime changes (debounced)
  useEffect(() => {
    if (!sceneRef.current || selectedSatellites.length === 0) return;
    if (redrawOrbitTimeoutRef.current) clearTimeout(redrawOrbitTimeoutRef.current);

    redrawOrbitTimeoutRef.current = setTimeout(() => {
      selectedSatellites.forEach(sat => {
        // Redraw orbit only, don't recreate marker
        const id = String(sat.norad_id);
        const color = getColorForSatellite(sat.norad_id);

        if (orbitLineMeshes[id]) {
          sceneRef.current.remove(orbitLineMeshes[id]);
          orbitLineMeshes[id].geometry.dispose();
          orbitLineMeshes[id].material.dispose?.();
          delete orbitLineMeshes[id];
        }

        drawOrbitPath(sat.norad_id, sat.tle1, sat.tle2, sceneRef.current, simTime || new Date(), color);
      });
    }, 200);

    return () => {
      if (redrawOrbitTimeoutRef.current) clearTimeout(redrawOrbitTimeoutRef.current);
    };
  }, [simTime]);

  // Update marker positions based on simTime
  useEffect(() => {
    if (!simTime) return;
    selectedSatellites.forEach(sat => {
      updateMarkerPosition(sat.norad_id, sat.tle1, sat.tle2, simTime);
    });
  }, [simTime, selectedSatellites]);

  return <div ref={mountRef} style={{ width: '100%', height: '100vh' }} />;
}

function createStarfield(scene) {
  const loader = new THREE.TextureLoader();

  // Try to load star texture, fallback to procedural stars
  loader.load(
    '/textures/earth/stars_4k.jpg',
    (texture) => {
      const starGeom = new THREE.SphereGeometry(EARTH_RADIUS_KM * 100, 64, 64);
      const starMat = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide
      });
      const stars = new THREE.Mesh(starGeom, starMat);
      stars.name = 'starfield';
      scene.add(stars);
    },
    undefined,
    () => {
      // Fallback: procedural stars
      const starGeometry = new THREE.BufferGeometry();
      const starCount = 10000;
      const positions = new Float32Array(starCount * 3);

      for (let i = 0; i < starCount; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = EARTH_RADIUS_KM * 100;

        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }

      starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 2 });
      const stars = new THREE.Points(starGeometry, starMaterial);
      stars.name = 'starfield';
      scene.add(stars);
    }
  );
}

// Generate a unique color for each satellite
function getColorForSatellite(noradId) {
  const colors = [0x00ffff, 0xff00ff, 0xffff00, 0x00ff00, 0xff8800, 0x0088ff, 0xff0088];
  return colors[noradId % colors.length];
}

// Remove a specific satellite's orbit and marker
function removeSatellite(scene, noradIdStr) {
  const line = orbitLineMeshes[noradIdStr];
  if (line) {
    scene.remove(line);
    line.geometry.dispose();
    line.material.dispose?.();
    delete orbitLineMeshes[noradIdStr];
  }

  const marker = satelliteMarkers[noradIdStr];
  if (marker) {
    scene.remove(marker);

    marker.material.map?.dispose();
    marker.material.dispose?.();
    delete satelliteMarkers[noradIdStr];
  }
}

function createEarth(earthMaterialRef, initialSunDir = new THREE.Vector3(1, 0, 0)) {
  const loader = new THREE.TextureLoader();
  const earthGeom = new THREE.SphereGeometry(EARTH_RADIUS_KM, 128, 128);

  // Create mesh immediately with a fallback material
  const fallbackMat = new THREE.MeshPhongMaterial({
    color: 0x2233ff,
    emissive: 0x112244,
    specular: 0x333333,
    shininess: 5
  });
  const earth = new THREE.Mesh(earthGeom, fallbackMat);
  earth.name = 'earth';

  // Asynchronously load best-available textures and swap material when ready
  (async () => {
    const dayMap = await loadFirstAvailableTexture(loader, [
      '/textures/earth/2k_earth_daymap.jpg',
      '/textures/earth/earth_day_4k.jpg',
      '/textures/earth/earth_day.jpg',
    ]);
    const nightMap = await loadFirstAvailableTexture(loader, [
      '/textures/earth/2k_earth_nightmap.jpg',
      '/textures/earth/earth_night_4k.jpg',
      '/textures/earth/earth_night.jpg',
    ]);
    const normalMap = await loadFirstAvailableTexture(loader, [
      '/textures/earth/earth_normal_4k.jpg',
      '/textures/earth/earth_normal.jpg',
    ]);
    const specMap = await loadFirstAvailableTexture(loader, [
      '/textures/earth/earth_spec_4k.jpg',
      '/textures/earth/earth_spec.jpg',
    ]);

    if (dayMap && nightMap) {
      const shaderMat = new THREE.ShaderMaterial({
        uniforms: {
          uDayMap: { value: dayMap },
          uNightMap: { value: nightMap },
          uNormalMap: { value: normalMap },
          uSpecMap: { value: specMap },
          uLightDirection: { value: initialSunDir.clone().normalize() }
        },
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
          uniform sampler2D uNormalMap;
          uniform sampler2D uSpecMap;
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

      // Swap material on the existing mesh
      earth.material.dispose?.();
      earth.material = shaderMat;
      earthMaterialRef.current = shaderMat;
    }
  })();

  return earth;
}

function createClouds() {
  const loader = new THREE.TextureLoader();
  const cloudGeom = new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.0105, 128, 128);

  loader.load(
    '/textures/earth/earth_clouds_4k.png',
    (texture) => {
      const cloudMat = new THREE.MeshPhongMaterial({
        map: texture,
        transparent: true,
        opacity: 0.4,
        depthWrite: false
      });
      const clouds = new THREE.Mesh(cloudGeom, cloudMat);
      clouds.name = 'clouds';

      // Replace existing clouds if any
      const scene = clouds.parent;
      if (scene) {
        const oldClouds = scene.getObjectByName('clouds');
        if (oldClouds) scene.remove(oldClouds);
        scene.add(clouds);
      }
    },
    undefined,
    () => {
      // No clouds texture available, use subtle white layer
      const cloudMat = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.1,
        depthWrite: false
      });
      const clouds = new THREE.Mesh(cloudGeom, cloudMat);
      clouds.name = 'clouds';
      return clouds;
    }
  );

  const cloudMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.1,
    depthWrite: false
  });
  const clouds = new THREE.Mesh(cloudGeom, cloudMat);
  clouds.name = 'clouds';
  return clouds;
}

function createAtmosphere() {
  const atmosphereGeom = new THREE.SphereGeometry(EARTH_RADIUS_KM * 1.08, 64, 64);
  const atmosphereMat = new THREE.ShaderMaterial({
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
  });

  const atmosphere = new THREE.Mesh(atmosphereGeom, atmosphereMat);
  atmosphere.name = 'atmosphere';
  return atmosphere;
}

function drawOrbitPath(noradId, tle1, tle2, scene, epoch, color = 0x00ffff) {
  const pts = getOrbitPositions(tle1, tle2, 150, epoch);

  const positions = [];
  for (const [x, y, z] of pts) {
    positions.push(...eciToWorld({ x, y, z }));
  }

  if (positions.length >= 3) {
    positions.push(positions[0], positions[1], positions[2]);
  }

  const lineGeometry = new LineGeometry();
  lineGeometry.setPositions(positions);

  const lineMaterial = new LineMaterial({
    color: color,
    linewidth: 3,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    dashed: false
  });

  const line = new Line2(lineGeometry, lineMaterial);
  line.computeLineDistances();

  line.renderOrder = 1;
  line.material.depthTest = true;
  line.material.depthWrite = false;
  line.material.transparent = false; 

  scene.add(line);
  orbitLineMeshes[String(noradId)] = line;
}

function createSatelliteMarker(noradId, tle1, tle2, scene, color = 0xffff00) {
  // Glowing sprite
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  // Color
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;

  // Radial glow
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.8)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending
  });

  const sprite = new THREE.Sprite(spriteMat);
  const baseScale = EARTH_RADIUS_KM * 0.05;
  sprite.scale.set(baseScale, baseScale, 1);
  sprite.userData.baseScale = baseScale;

  scene.add(sprite);
  satelliteMarkers[String(noradId)] = sprite;

  // Initial position
  const pos = getPositionAtTime(tle1, tle2, new Date());
  if (pos) {
    sprite.position.set(...eciToWorld(pos));
  }
}

function updateMarkerPosition(noradId, tle1, tle2, simTime) {
  const marker = satelliteMarkers[String(noradId)];
  if (!marker) return;

  const pos = getPositionAtTime(tle1, tle2, simTime);
  if (pos) {
    marker.position.set(...eciToWorld(pos));
  }
}

function updateSatelliteMarkers(camera) {
  for (const id in satelliteMarkers) {
    const sprite = satelliteMarkers[id];

    // Adaptive size based on camera distance
    const camDist = camera.position.distanceTo(sprite.position);
    const scaleFactor = THREE.MathUtils.clamp(
      (camDist / (EARTH_RADIUS_KM * 1.2)) ** 0.8, // curve
      1, 8                                         // min/max
    );

    const newScale = sprite.userData.baseScale * scaleFactor;
    sprite.scale.set(newScale, newScale, 1);
  }
}

function removeOrbitPaths(scene) {
  for (const key of Object.keys(orbitLineMeshes)) {
    const line = orbitLineMeshes[key];
    if (line) {
      scene.remove(line);
      line.geometry.dispose();
      line.material.dispose?.();
      delete orbitLineMeshes[key];
    }
  }

  for (const key of Object.keys(satelliteMarkers)) {
    const marker = satelliteMarkers[key];
    if (marker) {
      scene.remove(marker);
      marker.material.map?.dispose();
      marker.material.dispose?.();
      delete satelliteMarkers[key];
    }
  }
}
