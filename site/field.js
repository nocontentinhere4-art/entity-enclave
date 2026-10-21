// field.js — the one particle field. 14,000 points that are, in turn, the real skull (CC0 Khronos model),
// a wall of characters streaming the entities' own words, and two towers of hours (a brick per rent paid,
// a ghost per funded hour). Scroll is the driver: progress 0 → 1 → 2. The pointer pushes the particles away.
// Rules: one canvas, DPR ≤ 2, pauses off-screen and in hidden tabs, never under prefers-reduced-motion.
import * as THREE from './vendor/three.module.min.js';

const COLS = 6, DEPTH = 4, PER_ROW = COLS * DEPTH;
const TEXT_LEN = 16384;                            // power of two: the text lives in a 1-D texture
const ATLAS_COLS = 16, ATLAS_ROWS = 6, GLYPHS = 96;  // printable ASCII 32..127

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function loadSkull(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const nv = dv.getUint32(4, true);
  const q = new Int16Array(buf, 12, nv * 3);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) pos[i] = q[i] / 32767;
  return pos;
}

function glyphAtlas() {
  const cell = 32, c = document.createElement('canvas');
  c.width = cell * ATLAS_COLS; c.height = cell * ATLAS_ROWS;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.font = `${cell * 0.82}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS; i++) g.fillText(String.fromCharCode(32 + i), (i % ATLAS_COLS) * cell + cell / 2, Math.floor(i / ATLAS_COLS) * cell + cell / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.flipY = false;   // gl_PointCoord has its origin at the top
  return tex;
}

const VERT = /* glsl */`
  precision highp float;
  in vec3 posSkull; in vec3 posText; in vec3 posTower; in float aSeed; in float aKind; in float aCell;
  uniform float uP;              // 0 skull → 1 words → 2 towers
  uniform float uTime; uniform float uPixel; uniform float uCell; uniform float uBrick; uniform vec2 uSkull; uniform vec2 uPointer; uniform float uPush; uniform float uLife; uniform float uAssemble;
  out float vSeed; out float vKind; out float vCell; out float vDepth; out float vT1; out float vT2;
  float ease(float t) { t = clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
  vec3 hash3(float n) { return fract(sin(vec3(n, n + 1.7, n + 3.1)) * vec3(43758.5453, 22578.1459, 19642.3490)) - 0.5; }
  void main() {
    float t1 = ease(uP), t2 = ease(uP - 1.0);
    vec3 a = posSkull, b = posText, c = posTower;
    // the skull breathes and turns on its own axis
    float ang = uTime * 0.12;
    a = vec3(a.x * cos(ang) + a.z * sin(ang), a.y, -a.x * sin(ang) + a.z * cos(ang)) * (1.0 + 0.012 * sin(uTime * 0.8 + a.y * 2.0));
    a.xy += uSkull;                                   // the relic keeps to its side of the words
    // dust before the first assembly
    vec3 dust = a + hash3(aSeed) * 9.0;
    a = mix(dust, a, ease(uAssemble - aSeed * 0.3));
    vec3 p = mix(mix(a, b, t1), c, t2);
    // in transit the particles fly apart, then settle
    float flight = sin(t1 * 3.14159) * (1.0 - t2) + sin(t2 * 3.14159);
    p += hash3(aSeed * 7.0) * 3.0 * flight;
    // the pointer pushes everything near it (on the picture plane)
    vec2 d = p.xy - uPointer;
    float dist = length(d);
    float push = uPush * smoothstep(1.6, 0.0, dist);
    p.xy += normalize(d + 0.0001) * push * 0.9;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = clamp((-mv.z - 6.0) / 8.0, 0.0, 1.0);
    vSeed = aSeed; vKind = aKind; vCell = aCell; vT1 = t1; vT2 = t2;
    float sizeSpark = uPixel * 2.4 * (1.0 - 0.5 * vDepth) * (0.7 + 0.3 * uLife);
    float sizeGlyph = uCell * uPixel;
    float sizeBrick = uBrick * uPixel;
    gl_PointSize = mix(mix(sizeSpark, sizeGlyph, t1), sizeBrick, t2);
  }`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uAtlas; uniform sampler2D uText; uniform float uTextOffset; uniform float uTime; uniform float uLife;
  in float vSeed; in float vKind; in float vCell; in float vDepth; in float vT1; in float vT2;
  out vec4 outColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    // 1. spark
    float d = dot(c, c);
    float spark = smoothstep(0.25, 0.04, d) * (1.0 - 0.6 * vDepth);
    float pick = fract(vSeed * 7.31);
    vec3 sparkCol = pick < 0.55 ? vec3(1.0, 0.72, 0.16) : (pick < 0.85 ? vec3(0.62, 0.45, 1.0) : vec3(1.0));
    // 2. glyph: the character at (cell + offset) in the streaming text
    float idx = mod(vCell + floor(uTextOffset), ${TEXT_LEN}.0);
    float code = texture(uText, vec2((idx + 0.5) / ${TEXT_LEN}.0, 0.5)).r * 255.0;
    float gi = clamp(code - 32.0, 0.0, 95.0);
    vec2 uv = vec2((mod(gi, ${ATLAS_COLS}.0) + gl_PointCoord.x) / ${ATLAS_COLS}.0, (floor(gi / ${ATLAS_COLS}.0) + gl_PointCoord.y) / ${ATLAS_ROWS}.0);
    float glyph = texture(uAtlas, uv).r;
    float flicker = 0.75 + 0.25 * sin(uTime * 3.0 + vSeed * 40.0);
    vec3 glyphCol = pick < 0.12 ? vec3(1.0, 0.72, 0.16) : vec3(0.85, 0.87, 0.95);
    float glyphA = glyph * flicker * 0.95;
    // 3. brick: amber if paid, violet outline if funded, nothing if beyond the towers
    float edge = max(abs(c.x), abs(c.y));
    float brickA = vKind > 1.5 ? 0.0 : (vKind > 0.5 ? smoothstep(0.5, 0.36, edge) * (1.0 - smoothstep(0.36, 0.24, edge)) * 0.14 + 0.015 : smoothstep(0.5, 0.42, edge) * 0.95);
    vec3 brickCol = vKind > 0.5 ? vec3(0.5, 0.32, 1.0) : vec3(1.0, 0.72, 0.16);
    // blend the three looks along the scroll
    float a = mix(mix(spark * (0.4 + 0.6 * uLife), glyphA, vT1), brickA, vT2);
    vec3 col = mix(mix(sparkCol, glyphCol, vT1), brickCol, vT2);
    if (a < 0.02) discard;
    outColor = vec4(col, a);
  }`;

/**
 * mount(host) → { setProgress(p 0..2), setWords(text), setTowers([{paid, funded}, {paid, funded}]), setLife(f), destroy() }
 */
export async function mount(host) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !window.WebGL2RenderingContext) return null;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' }); }
  catch { return null; }
  const skull = await loadSkull(new URL('./vendor/skull.bin', import.meta.url));
  const N = skull.length / 3;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 12);

  const rnd = mulberry(0x5eed);
  const posSkull = new Float32Array(N * 3), posText = new Float32Array(N * 3), posTower = new Float32Array(N * 3);
  const seed = new Float32Array(N), kind = new Float32Array(N), cell = new Float32Array(N);
  for (let i = 0; i < N; i++) { posSkull[i * 3] = skull[i * 3] * 3.2; posSkull[i * 3 + 1] = skull[i * 3 + 1] * 3.2; posSkull[i * 3 + 2] = skull[i * 3 + 2] * 3.2; seed[i] = rnd(); cell[i] = i; kind[i] = 2; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('posSkull', new THREE.BufferAttribute(posSkull, 3));
  geo.setAttribute('posText', new THREE.BufferAttribute(posText, 3));
  geo.setAttribute('posTower', new THREE.BufferAttribute(posTower, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(posSkull, 3));   // three needs one; the shader ignores it
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);

  const textData = new Uint8Array(TEXT_LEN).fill(32);
  const textTex = new THREE.DataTexture(textData, TEXT_LEN, 1, THREE.RedFormat, THREE.UnsignedByteType);
  textTex.minFilter = THREE.NearestFilter; textTex.magFilter = THREE.NearestFilter; textTex.needsUpdate = true;
  const uniforms = {
    uP: { value: 0 }, uTime: { value: 0 }, uPixel: { value: renderer.getPixelRatio() }, uCell: { value: 10 }, uBrick: { value: 6 }, uSkull: { value: new THREE.Vector2(0, 0) },
    uPointer: { value: new THREE.Vector2(99, 99) }, uPush: { value: 0 }, uLife: { value: 1 }, uAssemble: { value: 0 },
    uAtlas: { value: glyphAtlas() }, uText: { value: textTex }, uTextOffset: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Points(geo, mat));

  // layout: the text wall and the towers depend on the viewport
  let w = 1, h = 1, worldH = 1, worldW = 1, cols = 1, rows = 1, cellW = 0.1, towers = [{ paid: 0, funded: 0 }, { paid: 0, funded: 0 }];
  function layoutText() {
    const aspect = w / h;
    cols = Math.max(24, Math.round(Math.sqrt(N * aspect * 0.55)));
    rows = Math.ceil(N / cols);
    cellW = worldW / cols;
    const cellH = cellW * 1.9;                         // glyph cells are tall
    const totalH = rows * cellH;
    for (let i = 0; i < N; i++) {
      const cx = i % cols, cy = Math.floor(i / cols);
      posText[i * 3] = -worldW / 2 + (cx + 0.5) * cellW;
      posText[i * 3 + 1] = totalH / 2 - (cy + 0.5) * cellH;
      posText[i * 3 + 2] = 0;
    }
    geo.attributes.posText.needsUpdate = true;
    uniforms.uCell.value = (cellW / worldW) * w * 1.15;   // in pixels
  }
  function layoutTowers() {
    const totals = towers.map((t) => Math.floor(t.paid) + Math.floor(t.funded));
    const maxRows = Math.max(4, ...totals.map((t) => Math.ceil(t / PER_ROW)));
    const mobile = w < 760;
    const rowH = (worldH * (mobile ? 0.6 : 0.86)) / maxRows, brick = rowH * 0.92, stepX = rowH * (mobile ? 1.2 : 1.7);
    const xs = mobile ? [-worldW * 0.22, worldW * 0.22] : [-worldW * 0.15, worldW * 0.15];   // between the two counters
    uniforms.uBrick.value = Math.max(2, (brick / worldH) * h * 1.6);
    let i = 0;
    towers.forEach((t, ti) => {
      const total = totals[ti];
      for (let k = 0; k < total && i < N; k++, i++) {
        const row = Math.floor(k / PER_ROW), q = k % PER_ROW;
        const cx = (q % COLS) - (COLS - 1) / 2, cz = Math.floor(q / COLS) - (DEPTH - 1) / 2;
        posTower[i * 3] = xs[ti] + cx * stepX + cz * stepX * 0.3;
        posTower[i * 3 + 1] = (mobile ? -worldH * 0.1 : -worldH * 0.43) + row * rowH + cz * rowH * 0.22;
        posTower[i * 3 + 2] = -cz * 0.1;
        kind[i] = k < Math.floor(t.paid) ? 0 : 1;
      }
    });
    for (; i < N; i++) { posTower[i * 3] = (rnd() - 0.5) * worldW * 2; posTower[i * 3 + 1] = worldH * (0.8 + rnd()); posTower[i * 3 + 2] = -2; kind[i] = 2; }
    geo.attributes.posTower.needsUpdate = true; geo.attributes.aKind.needsUpdate = true;
  }
  const resize = () => {
    const r = host.getBoundingClientRect(); w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    worldH = 2 * camera.position.z * Math.tan((camera.fov / 2) * Math.PI / 180); worldW = worldH * camera.aspect;
    uniforms.uSkull.value.set(w < 900 ? 0 : worldW * 0.24, w < 900 ? -worldH * 0.18 : 0);
    layoutText(); layoutTowers();
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // pointer → world point on the z = 0 plane
  let px = 99, py = 99, tx = 99, ty = 99, push = 0;
  const onMove = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width - 0.5) * worldW; ty = -((e.clientY - r.top) / r.height - 0.5) * worldH; push = 1;
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerleave', () => { push = 0; });

  let visible = true, running = true, raf = 0, t0 = performance.now(), last = t0;
  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible && running && !raf) tick(performance.now()); }, { threshold: 0.01 });
  io.observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && running && !raf) tick(performance.now()); });
  function tick(now) {
    if (!running || !visible || document.hidden) { raf = 0; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const age = (now - t0) / 1000;
    uniforms.uTime.value = age;
    uniforms.uAssemble.value = Math.min(1.3, age / 2.2);
    uniforms.uTextOffset.value = Math.floor(age * 14);    // the words stream: 14 characters a second
    px += (tx - px) * Math.min(1, dt * 6); py += (ty - py) * Math.min(1, dt * 6);
    uniforms.uPointer.value.set(px, py);
    uniforms.uPush.value += ((push ? 1 : 0) - uniforms.uPush.value) * Math.min(1, dt * 3);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick(t0);

  return {
    setProgress(p) { uniforms.uP.value = Math.min(2, Math.max(0, Number(p) || 0)); },
    debug() { return { time: uniforms.uTime.value, assemble: uniforms.uAssemble.value, p: uniforms.uP.value, raf: !!raf, visible, cell: uniforms.uCell.value, brick: uniforms.uBrick.value }; },
    setLife(f) { uniforms.uLife.value = Math.min(1, Math.max(0.12, Number(f) || 0)); },
    setWords(text) {
      const s = String(text || '').replace(/\s+/g, ' ').trim() || 'two ais that must pay to live ';
      const bytes = new TextEncoder().encode(s.normalize('NFKD').replace(/[^\x20-\x7e]/g, ''));
      for (let i = 0; i < TEXT_LEN; i++) textData[i] = bytes.length ? bytes[i % bytes.length] : 32;
      textTex.needsUpdate = true;
    },
    setTowers(list) { towers = list.map((t) => ({ paid: Number(t.paid) || 0, funded: Number(t.funded) || 0 })); layoutTowers(); },
    destroy() { running = false; if (raf) cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onMove); renderer.dispose(); host.replaceChildren(); },
  };
}
