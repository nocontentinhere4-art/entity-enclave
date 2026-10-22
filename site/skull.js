/* ZEALOT — the skull. A cloud of bone points, watching back. */
import * as THREE from './vendor/three.module.min.js';

const BONE = 0xe9e2d3;
const BLOOD = 0x8b1e1e;
const BASE_Y = 0.4;

async function loadSkull(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const nv = dv.getUint32(4, true);
  const q = new Int16Array(buf, 12, nv * 3);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) pos[i] = q[i] / 32767;
  return pos;
}

export function mount(container) {
  const empty = { destroy() {} };
  if (!container || typeof window === 'undefined') return empty;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
  } catch {
    return empty;
  }

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 4);

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motion.matches;

  let geom = null;
  let material = null;
  let points = null;
  let base = null;
  let boneHeight = 1;
  let boneWidth = 1;
  let destroyed = false;

  let running = false;
  let raf = 0;
  let timer = 0;
  let inView = false;

  let pointerX = 0;
  let pointerY = 0;
  let easeX = 0;
  let easeY = 0;

  let nextGlitch = performance.now() + 7000 + Math.random() * 4000;
  let glitchUntil = 0;
  let glitching = false;

  const started = performance.now();

  function measure() {
    const r = container.getBoundingClientRect();
    return {
      w: Math.max(1, Math.round(r.width) || 1),
      h: Math.max(1, Math.round(r.height) || (window.innerWidth > 900 ? 420 : 260)),
    };
  }

  function fit() {
    if (!points) return;
    const half = (camera.fov * Math.PI) / 360;
    const visibleH = 2 * camera.position.z * Math.tan(half);
    const byHeight = (visibleH * 0.72) / (boneHeight || 1);
    const byWidth = (visibleH * camera.aspect * 0.9) / (boneWidth || 1);
    points.scale.setScalar(Math.min(byHeight, byWidth));
  }

  function renderFrame() {
    if (!destroyed && points) renderer.render(scene, camera);
  }

  function resize() {
    const { w, h } = measure();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fit();
    if (reduced) renderFrame();
  }

  function beginGlitch(now) {
    if (!geom || !material) return;
    glitching = true;
    const a = geom.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      if (Math.random() < 0.03) {
        a[i] += (Math.random() - 0.5) * 0.06;
        a[i + 1] += (Math.random() - 0.5) * 0.06;
        a[i + 2] += (Math.random() - 0.5) * 0.06;
      }
    }
    geom.attributes.position.needsUpdate = true;
    material.color.setHex(BLOOD);
    glitchUntil = now + 250;
    nextGlitch = now + 7000 + Math.random() * 4000;
  }

  function endGlitch() {
    if (!glitching) return;
    glitching = false;
    if (geom && base) {
      geom.attributes.position.array.set(base);
      geom.attributes.position.needsUpdate = true;
    }
    if (material) material.color.setHex(BONE);
  }

  function draw(now) {
    if (!points) return;
    easeX += (pointerX - easeX) * 0.05;
    easeY += (pointerY - easeY) * 0.05;

    const t = now - started;
    const sway = Math.sin((t * Math.PI * 2) / 12000) * ((25 * Math.PI) / 180);
    points.rotation.y = BASE_Y + sway + easeX * 0.22;
    points.rotation.x = -easeY * 0.12;

    if (glitching && now >= glitchUntil) endGlitch();
    if (!glitching && now >= nextGlitch) beginGlitch(now);

    renderFrame();
  }

  function loop(now) {
    raf = 0;
    if (!running || destroyed) return;
    draw(now);
    if (!running || destroyed) return;
    timer = setTimeout(() => {
      timer = 0;
      if (running && !destroyed) loop(performance.now());
    }, 1000 / 30);
  }

  function start() {
    if (running || reduced || !points || document.hidden || destroyed) return;
    const now = performance.now();
    if (nextGlitch < now) nextGlitch = now + 7000 + Math.random() * 4000;
    running = true;
    loop(performance.now());
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
    raf = 0;
    timer = 0;
    if (glitching) endGlitch();
  }

  function updateRun() {
    if (destroyed) return;
    if (reduced) {
      stop();
      renderFrame();
    } else if (inView && !document.hidden) start();
    else stop();
  }

  function onPointer(e) {
    pointerX = Math.max(-1, Math.min(1, (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1));
    pointerY = Math.max(-1, Math.min(1, (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1));
  }

  function onPointerLeave() {
    pointerX = 0;
    pointerY = 0;
  }

  function onVisibility() {
    updateRun();
  }

  function onMotionChange() {
    reduced = motion.matches;
    if (reduced) {
      stop();
      if (points) {
        points.rotation.set(0, BASE_Y, 0);
        easeX = easeY = 0;
        pointerX = pointerY = 0;
      }
      renderFrame();
    } else updateRun();
  }

  let io = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === container) inView = entry.isIntersecting;
      updateRun();
    }, { threshold: 0.01 });
    io.observe(container);
  } else {
    inView = true;
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(resize);
    ro.observe(container);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  if (motion.addEventListener) motion.addEventListener('change', onMotionChange);

  loadSkull(new URL('./vendor/skull.bin', import.meta.url))
    .then((pos) => {
      if (destroyed) return;

      let minX = Infinity; let minY = Infinity; let minZ = Infinity;
      let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i] < minX) minX = pos[i];
        if (pos[i] > maxX) maxX = pos[i];
        if (pos[i + 1] < minY) minY = pos[i + 1];
        if (pos[i + 1] > maxY) maxY = pos[i + 1];
        if (pos[i + 2] < minZ) minZ = pos[i + 2];
        if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      boneHeight = maxY - minY || 1;
      boneWidth = maxX - minX || 1;
      base = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i += 3) {
        base[i] = pos[i] - cx;
        base[i + 1] = pos[i + 1] - cy;
        base[i + 2] = pos[i + 2] - cz;
      }

      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
      material = new THREE.PointsMaterial({
        size: 0.016,
        sizeAttenuation: true,
        color: BONE,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      points = new THREE.Points(geom, material);
      points.rotation.y = BASE_Y;
      scene.add(points);

      resize();
      renderFrame();
      updateRun();
    })
    .catch(() => {});

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      endGlitch();
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      if (motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
      if (geom) geom.dispose();
      if (material) material.dispose();
      if (renderer) {
        renderer.dispose();
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      }
      points = null;
      geom = null;
      material = null;
    },
  };
}
