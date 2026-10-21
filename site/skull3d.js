// skull3d.js — the relic: a real human skull (CC0, Khronos glTF sample "ScatteringSkull" by Vladimir Petkovic,
// decimated to ~14k vertices in vendor/skull.bin) drawn as a thin gold wireframe with a point at every vertex,
// turning slowly in the dark. It assembles out of dust when the page opens, follows the pointer, and scatters
// back into dust as you scroll past it. Its brightness is the entities' remaining life.
// Rules: one canvas, DPR ≤ 2, no antialias, pauses off-screen and in hidden tabs, never starts under
// prefers-reduced-motion or without WebGL (the ASCII skull stays as the finished fallback).
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** vendor/skull.bin: 'SKUL', u32 nVerts, u32 nEdges, Int16 xyz[nVerts] (unit box), Uint16 pairs[nEdges]. */
async function loadSkull(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SKUL') throw new Error('bad skull.bin');
  const nv = dv.getUint32(4, true), ne = dv.getUint32(8, true);
  const q = new Int16Array(buf, 12, nv * 3);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) pos[i] = q[i] / 32767;
  const edges = new Uint16Array(buf, 12 + nv * 6, ne * 2);
  return { pos, edges };
}

const COMMON = `
  attribute vec3 aStart; attribute float aDelay;
  uniform float uAssemble; uniform float uScatter; uniform float uTime; uniform float uLife; uniform float uGlitch;
  varying float vDepth; varying float vFade; varying float vBand;
  float ease(float t) { t = clamp(t, 0.0, 1.0); return 1.0 - pow(1.0 - t, 3.0); }
  float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
  vec3 place() {
    float t = ease((uAssemble - aDelay) / 0.55);
    vec3 p = mix(aStart, position, t);
    // scroll: the relic loosens back into dust, each point drifting along its own direction
    float s = clamp(uScatter - aDelay * 0.6, 0.0, 1.0);
    p += (aStart * 0.35 + vec3(0.0, 0.4, 0.0)) * s * s;
    p *= 1.0 + 0.008 * sin(uTime * 0.8 + position.y * 3.0);   // a faint breath
    // the glitch: horizontal bands tear sideways for a few frames, like the terminal's @#$% flicker
    float band = floor(position.y * 14.0 + floor(uTime * 24.0) * 0.37);
    float hb = hash(band + floor(uTime * 24.0));
    p.x += (hb - 0.5) * uGlitch * 0.5 * step(0.45, hash(band * 3.1 + floor(uTime * 24.0)));
    vBand = hb;
    vFade = 1.0 - s;
    return p;
  }`;

const LINE_VERT = COMMON + `
  void main() {
    vec4 mv = modelViewMatrix * vec4(place(), 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = clamp((-mv.z - 2.4) / 2.2, 0.0, 1.0);
  }`;
const LINE_FRAG = `
  uniform float uLife; uniform float uAlpha; uniform float uAssemble; uniform float uScatter; uniform float uGlitch; varying float vDepth; varying float vFade; varying float vBand;
  void main() {
    if (uGlitch > 0.0 && vBand < uGlitch * 0.35) discard;   // torn-out bands
    // threads only once the dust has settled: lines between flying points would wash the whole hero
    float settled = smoothstep(0.75, 1.0, uAssemble) * pow(1.0 - clamp(uScatter, 0.0, 1.0), 3.0);
    float a = uAlpha * settled * vFade * (1.0 - 0.75 * vDepth) * (0.35 + 0.65 * uLife);
    vec3 col = mix(vec3(0.89, 0.70, 0.25), vec3(1.0, 0.93, 0.75), 0.25 * (1.0 - vDepth));
    gl_FragColor = vec4(col, a);
  }`;

const POINT_VERT = COMMON + `
  uniform float uPixel;
  void main() {
    vec4 mv = modelViewMatrix * vec4(place(), 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = clamp((-mv.z - 2.4) / 2.2, 0.0, 1.0);
    gl_PointSize = uPixel * 1.9 * (1.0 - 0.5 * vDepth) * (0.7 + 0.3 * uLife);
  }`;
const POINT_FRAG = `
  uniform float uLife; uniform float uAlpha; uniform float uGlitch; varying float vDepth; varying float vFade; varying float vBand;
  void main() {
    if (uGlitch > 0.0 && vBand < uGlitch * 0.35) discard;
    vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
    float a = uAlpha * vFade * smoothstep(0.25, 0.04, d) * (1.0 - 0.7 * vDepth) * (0.4 + 0.6 * uLife);
    gl_FragColor = vec4(vec3(1.0, 0.86, 0.55), a);
  }`;

export async function mount(host, { seed = 7, life = 1 } = {}) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !window.WebGLRenderingContext) return null;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' }); }
  catch { return null; }
  const { pos, edges } = await loadSkull(new URL('./vendor/skull.bin', import.meta.url));
  const mobile = window.innerWidth < 720;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 0.05, 4.4);

  const n = pos.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // scattered start positions and a per-point delay: the relic assembles out of dust
  const rnd = mulberry(seed ^ 0xabcdef);
  const start = new Float32Array(n * 3), delay = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = 2.5 + rnd() * 4, th = rnd() * TAU, ph = Math.acos(1 - 2 * rnd());
    start[i * 3] = r * Math.sin(ph) * Math.cos(th); start[i * 3 + 1] = r * Math.cos(ph) + 1.2; start[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 1;
    delay[i] = rnd() * 0.45;
  }
  geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
  geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
  const lineGeo = geo.clone();
  lineGeo.setIndex(new THREE.BufferAttribute(edges, 1));

  const uniforms = {
    uAssemble: { value: 0 }, uScatter: { value: 0 }, uTime: { value: 0 }, uLife: { value: life },
    uPixel: { value: renderer.getPixelRatio() }, uAlpha: { value: 1 }, uGlitch: { value: 0 },
  };
  const mat = (vs, fs, alpha) => new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uAlpha: { value: alpha } }, vertexShader: vs, fragmentShader: fs,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const wire = new THREE.LineSegments(lineGeo, mat(LINE_VERT, LINE_FRAG, 0.42));
  const dots = new THREE.Points(geo, mat(POINT_VERT, POINT_FRAG, 0.9));
  const mats = [wire.material, dots.material];

  const group = new THREE.Group();
  group.add(wire, dots);
  group.rotation.y = -0.6;
  scene.add(group);

  // pointer parallax: the relic turns to look at you
  let px = 0, py = 0, tx = 0, ty = 0;
  const onMove = (e) => { tx = (e.clientX / window.innerWidth - 0.5) * 0.9; ty = (e.clientY / window.innerHeight - 0.5) * 0.5; };
  window.addEventListener('pointermove', onMove, { passive: true });

  let w = 0, h = 0, baseY = 0.22;
  const resize = () => {
    const r = host.getBoundingClientRect(); w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    // the relic keeps to the right half on wide screens; the words keep the left
    const halfW = Math.tan((camera.fov / 2) * Math.PI / 180) * camera.position.z * camera.aspect;
    const wide = camera.aspect > 1.15;
    group.position.x = 0;                             // the relic sits between the two towers of hours
    group.scale.setScalar(wide ? Math.min(0.9, halfW * 0.55) : 0.7);
    baseY = 0.05;
    wire.material.uniforms.uAlpha.value = 0.42 * (wide ? 1 : 0.55);
    dots.material.uniforms.uAlpha.value = 0.9 * (wide ? 1 : 0.55);
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  let visible = true, running = true, raf = 0, t0 = performance.now(), last = t0, scatter = 0;
  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible && running && !raf) tick(performance.now()); }, { threshold: 0.02 });
  io.observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && running && !raf) tick(performance.now()); });

  const set = (k, v) => { for (const m of mats) m.uniforms[k].value = v; };
  // glitch schedule: a burst every 5–12 s, 0.15–0.4 s long, in two or three stutters
  const grnd = mulberry(seed ^ 0x6111c4);
  let nextGlitch = 4 + grnd() * 4, glitchEnd = 0, glitchAmp = 0, glitchHold = 0, lastAge = 0;
  function glitchAt(age) {
    lastAge = age;
    if (age >= nextGlitch) { glitchAmp = 0.5 + grnd() * 0.5; glitchEnd = Math.max(glitchHold, age + 0.15 + grnd() * 0.25); nextGlitch = glitchEnd + 5 + grnd() * 7; }
    if (age >= glitchEnd) return 0;
    const stutter = Math.sin(age * 55) > -0.2 ? 1 : 0;        // not every frame: it stutters
    return glitchAmp * stutter * (0.6 + 0.4 * Math.sin(age * 23));
  }
  function tick(now) {
    if (!running || !visible || document.hidden) { raf = 0; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const age = (now - t0) / 1000;
    set('uTime', age);
    set('uAssemble', Math.min(1, age / 2.4));
    const scroll = scatter;                               // driven from outside: the meter's distance past death
    set('uScatter', scroll);
    set('uGlitch', scroll > 0.8 ? 0 : glitchAt(age));
    px += (tx - px) * Math.min(1, dt * 2.5); py += (ty - py) * Math.min(1, dt * 2.5);
    group.rotation.y += dt * 0.12;
    group.rotation.x = py * 0.6 + scroll * 0.3;
    group.position.y = baseY - scroll * 0.4;
    camera.position.x = px * 0.8; camera.position.y = 0.05 - py * 0.4;
    camera.lookAt(group.position.x * 0.6, 0, 0);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick(t0);

  return {
    setLife(f) { set('uLife', Math.min(1, Math.max(0.12, Number(f) || 0))); },
    glitch(hold = 0) { nextGlitch = 0; glitchHold = lastAge + hold; }, // something happened: the relic flinches now
    setScatter(f) { scatter = Math.min(1, Math.max(0, Number(f) || 0)); }, // 0 whole → 1 dust
    destroy() { running = false; if (raf) cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('pointermove', onMove); window.removeEventListener('resize', resize); renderer.dispose(); host.replaceChildren(); },
  };
}
