/*
 * scene.js — ZEALOT v14, the glass.
 *
 * One fixed three.js scene behind the terminal: a violet-black void with a faint nebula and drifting
 * dust, WICK as a volumetric flame (additive point shader), OBOL as a lit silver coin whose face carries
 * the ledger head hash, and v13's point-cloud skull (./skull.js) sitting "at zero" behind them. The scroll
 * dollies the camera (wide → flame → coin → skull), and the pointer eases a small parallax.
 *
 * Rules: no per-frame allocations, one draw path driven by setTimeout(…, 1000/30), paused when the tab is
 * hidden, and a single static frame under prefers-reduced-motion. The numbers never live here: the terminal
 * (term.js) pushes a normalised view in, and this file only renders what it is told.
 */
import * as THREE from './vendor/three.module.min.js';
import { mount as mountSkull } from './skull.js?v=202610220234';

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;

const FLAME_N = 2000;
const DUST_N = 340;
const VOID = 0x050507;

/* the flame: ~2,000 additive points rising with noise. warm #ffb347 → #ff5a1f → white core. */
const FLAME_VERT = /* glsl */`
  attribute vec3 aBase;    // x: angle 0..1, y: base height 0..1, z: base radius 0..1
  attribute float aSeed;
  attribute float aSeed2;
  uniform float uTime;
  uniform float uHeight;
  uniform float uWidth;
  uniform float uState;    // 0 awake · 1 asleep · 2 dead
  uniform float uFlare;    // 0..1, spikes on a received letter
  uniform float uPixel;
  varying float vLife;
  varying float vEdge;
  varying float vFlicker;
  void main() {
    float speed = mix(0.35, 0.85, aSeed);
    float life = fract(aBase.y + uTime * speed);
    float breath = 0.82 + 0.18 * sin(uTime * 1.4 + aSeed2 * 6.28318);
    float fl = 0.65 + 0.35 * sin(uTime * (6.0 + aSeed2 * 5.0) + aSeed * 100.0);
    float ang = aBase.x * 6.28318 + uTime * (0.4 + aSeed * 0.9) + life * 2.2;
    float taper = mix(1.0, 0.06, life);
    float rad = aBase.z * taper * (0.72 + 0.28 * fl);
    vec3 p;
    p.x = cos(ang) * rad * uWidth * 0.5;
    p.z = sin(ang) * rad * uWidth * 0.5;
    p.y = (life - 0.5) * uHeight * breath * (1.0 + 0.3 * uFlare);
    if (uState > 1.5) {              // dead: a thin smoke column only
      p.x *= 0.07; p.z *= 0.07;
      p.y = (life - 0.35) * uHeight * 0.7;
    } else if (uState > 0.5) {       // asleep: low ember
      p.y *= 0.45; p.x *= 0.5; p.z *= 0.5;
    }
    vLife = life;
    vEdge = clamp(rad, 0.0, 1.0);
    vFlicker = fl;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (mix(13.0, 3.0, life) * (1.0 + 0.5 * uFlare)) * uPixel * 0.8;
  }`;

const FLAME_FRAG = /* glsl */`
  precision highp float;
  uniform float uState;
  uniform float uFlare;
  varying float vLife;
  varying float vEdge;
  varying float vFlicker;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    float a = smoothstep(0.25, 0.0, d);
    if (a < 0.01) discard;
    vec3 col;
    if (uState > 1.5) {
      col = vec3(0.34, 0.34, 0.36);                       // smoke
    } else if (uState > 0.5) {
      col = vec3(0.478, 0.165, 0.039);                    // ember #7a2a0a
    } else {
      vec3 core = vec3(1.0, 0.98, 0.90);                  // white core
      vec3 mid  = vec3(1.0, 0.702, 0.278);                // #ffb347
      vec3 tip  = vec3(1.0, 0.353, 0.122);                // #ff5a1f
      col = mix(core, mid, smoothstep(0.0, 0.5, vLife));
      col = mix(col, tip, smoothstep(0.45, 1.0, vLife));
      col = mix(col, tip, vEdge * 0.45);
    }
    float glow = (0.55 + 0.45 * vFlicker) * (1.0 + 0.9 * uFlare);
    if (uState > 1.5) glow *= 0.35;
    else if (uState > 0.5) glow *= 0.55;
    gl_FragColor = vec4(col, a * glow);
  }`;

/* ------------------------------------------------------------------ */
/* mount                                                               */
/* ------------------------------------------------------------------ */
export function mountScene({ scene, skull, labels, zero }) {
  const empty = { update() {}, flare() {}, destroy() {} };
  if (!scene || typeof window === 'undefined') return empty;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedOn = reduced.matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
  } catch {
    return empty;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(VOID, 0);                       // transparent: the void is the CSS behind
  renderer.domElement.setAttribute('aria-hidden', 'true');
  scene.appendChild(renderer.domElement);

  const world = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.set(0, 0.4, 12);

  /* ---------- nebula: two soft violet-blue radial gradients ---------- */
  const nebula = (() => {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const g = c.getContext('2d');
    const blob = (x, y, r, rgb) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(${rgb},0.32)`);
      grd.addColorStop(0.5, `rgba(${rgb},0.12)`);
      grd.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grd;
      g.fillRect(0, 0, c.width, c.height);
    };
    blob(300, 180, 420, '58,42,105');    // violet
    blob(760, 300, 460, '30,52,102');    // blue
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(44, 22), mat);
    plane.position.set(0, 0, -16);
    plane.renderOrder = -1;
    world.add(plane);
    return plane;
  })();

  /* ---------- dust: a few hundred drifting motes ---------- */
  const dustPositions = new Float32Array(DUST_N * 3);
  const dustVel = new Float32Array(DUST_N * 3);
  {
    const rnd = mulberry(0xd05 + 7);
    for (let i = 0; i < DUST_N; i++) {
      dustPositions[i * 3] = (rnd() - 0.5) * 26;
      dustPositions[i * 3 + 1] = (rnd() - 0.5) * 14;
      dustPositions[i * 3 + 2] = (rnd() - 0.5) * 12 - 4;
      dustVel[i * 3] = (rnd() - 0.5) * 0.12;
      dustVel[i * 3 + 1] = (rnd() - 0.5) * 0.06;
      dustVel[i * 3 + 2] = (rnd() - 0.5) * 0.05;
    }
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 30);
  const dustMat = new THREE.PointsMaterial({
    color: 0x8a93c9, size: 0.03, sizeAttenuation: true, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  world.add(dust);

  /* ---------- WICK: the flame ---------- */
  const flameBase = new Float32Array(FLAME_N * 3);
  const flameSeed = new Float32Array(FLAME_N);
  const flameSeed2 = new Float32Array(FLAME_N);
  {
    const rnd = mulberry(0x1f14 + 13);
    for (let i = 0; i < FLAME_N; i++) {
      flameBase[i * 3] = rnd();                 // angle 0..1
      flameBase[i * 3 + 1] = Math.pow(rnd(), 1.6);  // height, denser at the base
      flameBase[i * 3 + 2] = Math.sqrt(rnd());      // radius (uniform disk)
      flameSeed[i] = rnd();
      flameSeed2[i] = rnd();
    }
  }
  const flameGeo = new THREE.BufferGeometry();
  flameGeo.setAttribute('aBase', new THREE.BufferAttribute(flameBase, 3));
  flameGeo.setAttribute('aSeed', new THREE.BufferAttribute(flameSeed, 1));
  flameGeo.setAttribute('aSeed2', new THREE.BufferAttribute(flameSeed2, 1));
  flameGeo.setAttribute('position', new THREE.BufferAttribute(flameBase.slice(), 3));
  flameGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
  const flameUniforms = {
    uTime: { value: 0 },
    uHeight: { value: 1.4 },
    uWidth: { value: 1.1 },
    uState: { value: 0 },
    uFlare: { value: 0 },
    uPixel: { value: renderer.getPixelRatio() },
  };
  const flameMat = new THREE.ShaderMaterial({
    uniforms: flameUniforms,
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const flame = new THREE.Points(flameGeo, flameMat);
  const flameGroup = new THREE.Group();
  flameGroup.add(flame);
  world.add(flameGroup);

  /* ---------- OBOL: the coin ---------- */
  const coinGroup = new THREE.Group();
  const coinMesh = new THREE.Mesh();
  coinMesh.geometry = new THREE.CylinderGeometry(1, 1, 1, 56);   // unit: scaled by radius/thickness
  coinMesh.rotation.x = Math.PI / 2;                              // face toward the camera
  const silverMat = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.92, roughness: 0.24 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.0, roughness: 0.95 });
  coinMesh.material = silverMat;
  coinGroup.add(coinMesh);
  world.add(coinGroup);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(3, 4, 5);
  world.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x9fb4ff, 1.1);
  rimLight.position.set(-4, 1, -3);
  world.add(rimLight);
  world.add(new THREE.AmbientLight(0x2a2f3a, 0.8));

  /* ---------- post sprites (last 3 posts, text particles) ---------- */
  const postsGroup = new THREE.Group();
  world.add(postsGroup);

  /* ---------- skull (v13 point cloud, reused behind the glass) ---------- */
  let skullApi = null;
  if (skull) {
    try { skullApi = mountSkull(skull); } catch { skullApi = null; }
  }

  /* ---------- label elements ---------- */
  const labelEls = {
    e1: labels ? labels.querySelector('[data-label="e1"]') : null,
    e2: labels ? labels.querySelector('[data-label="e2"]') : null,
  };

  /* ---------- state ---------- */
  const view = {
    e1: { id: 'e1', label: 'WICK · — H · —', state: 'awake', hours: 0, zats: 0, head: '', posts: [] },
    e2: { id: 'e2', label: 'OBOL · — H · —', state: 'awake', hours: 0, zats: 0, head: '', posts: [] },
  };
  let flareUntil = 0;
  let destroyed = false;
  let running = false;
  let timer = 0;
  let raf = 0;

  /* pointer parallax */
  let ptrX = 0, ptrY = 0, parX = 0, parY = 0;

  /* coin easing targets */
  let coinTarget = { rx: Math.PI / 2, y: 0, light: 2.4, dead: false };
  let coinCur = { rx: Math.PI / 2, y: 0, light: 2.4, dead: false };
  let coinSpin = 0;

  /* camera keyframes rebuilt on resize */
  let keys = [];
  let flameX = -2.2, flameY = -0.6, coinX = 2.2, coinY = 0.2, flameMaxH = 5.2;

  /* reusable vectors (no per-frame allocation) */
  const vTmp = new THREE.Vector3();
  const vTmp2 = new THREE.Vector3();
  const vPos = new THREE.Vector3();
  const vLook = new THREE.Vector3();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();

  /* ------------------------------------------------------------------ */
  /* coin face texture: the "O" ring + the ledger head hash              */
  /* ------------------------------------------------------------------ */
  function coinTexture(head) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(256, 256, 30, 256, 256, 300);
    bg.addColorStop(0, '#dfe4ec');
    bg.addColorStop(0.7, '#b6bdc9');
    bg.addColorStop(1, '#7d8491');
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#5a606a';
    g.lineWidth = 20;
    g.beginPath(); g.arc(256, 256, 232, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#262a30';
    g.font = '900 270px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('O', 256, 262);
    if (head) {
      g.fillStyle = '#3c424b';
      g.font = '13px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(String(head).slice(0, 34), 256, 472);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function applyCoinTexture(head) {
    const old = silverMat.map;
    if (head !== view.e2.__head) {
      view.e2.__head = head;
      silverMat.map = coinTexture(head);
      silverMat.needsUpdate = true;
    }
    if (old && old !== silverMat.map) old.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* text post sprites                                                   */
  /* ------------------------------------------------------------------ */
  function makeTextSprite(text, colorHex) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 80;
    const g = c.getContext('2d');
    g.font = '600 30px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = '#ffffff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 40);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, color: colorHex,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(2.6, 0.4, 1);
    return s;
  }

  let postSprites = [];
  function rebuildPosts() {
    for (const s of postSprites) { postsGroup.remove(s); if (s.material.map) s.material.map.dispose(); s.material.dispose(); }
    postSprites = [];
    const add = (id, color) => {
      let i = 0;
      for (const text of view[id].posts.slice(0, 3)) {
        const t = String(text).replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const s = makeTextSprite(t.length > 44 ? t.slice(0, 43) + '…' : t, color);
        s.userData.id = id;
        s.userData.i = i++;
        postSprites.push(s);
        postsGroup.add(s);
      }
    };
    add('e1', 0xffa24a);
    add('e2', 0xbfd2ff);
  }

  /* ------------------------------------------------------------------ */
  /* labels: project 3D anchors to screen                                */
  /* ------------------------------------------------------------------ */
  function projectLabel(id, wx, wy, wz) {
    const el = labelEls[id];
    if (!el) return;
    vTmp.set(wx, wy, wz).project(camera);
    if (vTmp.z > 1) { el.style.opacity = '0'; return; }
    const x = (vTmp.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-vTmp.y * 0.5 + 0.5) * window.innerHeight;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    el.style.opacity = '1';
  }

  /* ------------------------------------------------------------------ */
  /* layout (viewport-dependent)                                         */
  /* ------------------------------------------------------------------ */
  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    const aspect = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    flameUniforms.uPixel.value = renderer.getPixelRatio();

    const narrow = aspect < 0.85;
    flameX = narrow ? -0.78 : -1.7;
    coinX = narrow ? 0.78 : 1.7;
    flameY = narrow ? 0.75 : 0.2;
    coinY = narrow ? 0.55 : 0.2;
    flameMaxH = narrow ? 3.0 : 5.2;

    const camBase = { pos: new THREE.Vector3(0, 0.4, 12), look: new THREE.Vector3(0, 0.15, 0) };
    const camFlame = { pos: new THREE.Vector3(flameX * 0.82, flameY + 0.25, 5.2), look: new THREE.Vector3(flameX, flameY, 0) };
    const camCoin = { pos: new THREE.Vector3(coinX * 0.82, coinY + 0.25, 5.2), look: new THREE.Vector3(coinX, coinY, 0) };
    const camEnd = { pos: new THREE.Vector3(0, 0.4, 13), look: new THREE.Vector3(0, 0.15, 0) };
    keys = [camBase, camFlame, camCoin, camEnd];
  }

  /* ------------------------------------------------------------------ */
  /* the coin targets from state                                         */
  /* ------------------------------------------------------------------ */
  function coinTargets() {
    const d = view.e2;
    const radius = 0.6 + 0.9 * clamp((d.hours || 0) / 1500, 0, 1);
    const thick = 0.12 + 0.45 * clamp((d.zats || 0) / 3e7, 0, 1);
    if (d.state === 'dead') {
      return { rx: Math.PI / 2, y: -3.2, light: 0.06, dead: true, radius: radius * 0.9, thick };
    }
    if (d.state === 'asleep') {
      return { rx: 0, y: 0, light: 1.1, dead: false, radius, thick: thick * 1.4 };
    }
    return { rx: Math.PI / 2, y: 0, light: 2.4, dead: false, radius, thick };
  }

  /* ------------------------------------------------------------------ */
  /* the draw                                                            */
  /* ------------------------------------------------------------------ */
  function draw(now) {
    const t = now * 0.001;

    /* pointer parallax, 0.05 ease */
    parX += (ptrX - parX) * 0.05;
    parY += (ptrY - parY) * 0.05;

    /* scroll progress: 0 (both) → 0.33 flame → 0.66 coin → 1 skull */
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const p = clamp(window.scrollY / maxScroll, 0, 1);

    /* ---- flame ---- */
    const w = view.e1;
    const hScale = clamp((w.hours || 0) / 1500, 0.25, 1);
    const stNum = w.state === 'dead' ? 2 : w.state === 'asleep' ? 1 : 0;
    flameUniforms.uTime.value = t;
    flameUniforms.uState.value = stNum;
    flameUniforms.uFlare.value = Math.max(0, (flareUntil - now) / 1500);
    flameUniforms.uHeight.value = stNum === 2 ? flameMaxH * 0.7 : flameMaxH * hScale * (stNum === 1 ? 0.45 : 1);
    flameUniforms.uWidth.value = (narrowWidth() ? 1.2 : 1.8) * (stNum === 1 ? 0.6 : 1);
    flameGroup.position.set(flameX, flameY, 0);

    /* ---- coin ---- */
    const tgt = coinTargets();
    const ease = reducedOn ? 1 : 0.08;
    coinCur.rx += (tgt.rx - coinCur.rx) * ease;
    coinCur.y += (tgt.y - coinCur.y) * ease;
    coinCur.light += (tgt.light - coinCur.light) * ease;
    if (tgt.dead && !coinCur.dead) { coinMesh.material = blackMat; coinCur.dead = true; }
    else if (!tgt.dead && coinCur.dead) { coinMesh.material = silverMat; coinCur.dead = false; }
    coinMesh.rotation.x = coinCur.rx;
    if (tgt.dead) { coinSpin += 0.02; coinMesh.rotation.y = coinSpin; coinMesh.rotation.z += 0.015; }
    else { coinSpin += 0.004; coinMesh.rotation.y = coinSpin; }
    coinMesh.scale.set(tgt.radius, tgt.radius, tgt.thick);
    coinGroup.position.set(coinX, coinCur.y, 0);
    keyLight.intensity = coinCur.light;

    /* ---- dust drift ---- */
    for (let i = 0; i < DUST_N; i++) {
      dustPositions[i * 3] += dustVel[i * 3];
      dustPositions[i * 3 + 1] += dustVel[i * 3 + 1];
      dustPositions[i * 3 + 2] += dustVel[i * 3 + 2];
      if (dustPositions[i * 3] > 13) dustPositions[i * 3] = -13;
      else if (dustPositions[i * 3] < -13) dustPositions[i * 3] = 13;
      if (dustPositions[i * 3 + 1] > 7) dustPositions[i * 3 + 1] = -7;
      else if (dustPositions[i * 3 + 1] < -7) dustPositions[i * 3 + 1] = 7;
    }
    dustGeo.attributes.position.needsUpdate = true;

    /* ---- post sprites ---- */
    const flameWin = smooth((p - 0.2) / 0.1) * (1 - smooth((p - 0.42) / 0.1));
    const coinWin = smooth((p - 0.54) / 0.1) * (1 - smooth((p - 0.76) / 0.1));
    postSprites.forEach((s) => {
      const id = s.userData.id;
      const idx = s.userData.i || 0;
      if (id === 'e1') {
        const ang = t * 1.15 + idx * 2.094;
        const r = 1.7;
        s.position.set(flameX + Math.cos(ang) * r, flameY - 0.4 + ((t * 0.55 + idx * 0.95) % 2.6), Math.sin(ang) * r * 0.4);
        s.material.opacity = flameWin * 0.85;
      } else {
        const ang = t * 0.8 + idx * 2.094;
        const r = tgt.radius + 1.4;
        s.position.set(coinX + Math.cos(ang) * r, coinY + Math.sin(ang) * 0.4, Math.sin(ang) * r * 0.5);
        s.material.opacity = coinWin * 0.85;
      }
    });

    /* ---- camera dolly ---- */
    if (!reducedOn) {
      const seg = p * (keys.length - 1);
      const i = Math.min(keys.length - 2, Math.floor(seg));
      const f = smooth(seg - i);
      vA.copy(keys[i].pos); vB.copy(keys[i + 1].pos);
      vPos.lerpVectors(vA, vB, f);
      vA.copy(keys[i].look); vB.copy(keys[i + 1].look);
      vLook.lerpVectors(vA, vB, f);
      camera.position.copy(vPos);
      camera.position.x += parX * 0.4;
      camera.position.y += parY * 0.22;
      camera.lookAt(vLook.x + parX * 0.3, vLook.y + parY * 0.16, vLook.z);
    } else {
      camera.position.set(0, 0.4, 12);
      camera.lookAt(0, 0.15, 0);
    }

    /* ---- skull reveal + scene fade at the end ---- */
    const sr = smooth((p - 0.78) / 0.2);
    if (scene) scene.style.opacity = String(1 - sr * 0.96);
    if (skull) skull.style.opacity = String(0.14 + sr * 0.8);
    if (zero) zero.style.opacity = String(sr);

    renderer.render(world, camera);
    projectLabel('e1', flameX, flameY + flameMaxH * hScale * (stNum === 1 ? 0.45 : 1) * 0.5 + 0.15, 0);
    projectLabel('e2', coinX, coinY + tgt.radius + 0.35, 0);
  }

  function narrowWidth() {
    return window.innerWidth / window.innerHeight < 0.85;
  }

  function loop(now) {
    timer = 0;
    if (!running || destroyed || document.hidden) return;
    draw(now);
    if (!running || destroyed) return;
    timer = setTimeout(() => { timer = 0; if (running && !destroyed && !document.hidden) loop(performance.now()); }, 1000 / 30);
  }

  function renderOnce() {
    draw(performance.now());
  }

  function start() {
    if (running || reducedOn || destroyed) return;
    running = true;
    loop(performance.now());
  }
  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0; raf = 0;
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */
  function onResize() { layout(); if (reducedOn) renderOnce(); }
  function onPointer(e) {
    ptrX = clamp((e.clientX / Math.max(1, window.innerWidth)) * 2 - 1, -1, 1);
    ptrY = clamp((e.clientY / Math.max(1, window.innerHeight)) * 2 - 1, -1, 1);
  }
  function onPointerLeave() { ptrX = 0; ptrY = 0; }
  function onVisibility() {
    if (document.hidden) stop();
    else if (!reducedOn) { if (!running) start(); }
  }
  function onMotionChange() {
    reducedOn = reduced.matches;
    if (reducedOn) { stop(); camera.position.set(0, 0.4, 12); camera.lookAt(0, 0.15, 0); renderOnce(); }
    else start();
  }

  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  if (reduced.addEventListener) reduced.addEventListener('change', onMotionChange);

  layout();

  /* ------------------------------------------------------------------ */
  /* public API                                                          */
  /* ------------------------------------------------------------------ */
  function update(views) {
    if (!Array.isArray(views)) return;
    for (const v of views) {
      if (!v) continue;
      const slot = view[v.id] || view.e1;
      slot.label = v.label || slot.label;
      slot.state = v.state || 'awake';
      slot.hours = Number(v.hours) || 0;
      slot.zats = Number(v.zats) || 0;
      slot.head = v.head || '';
      slot.posts = Array.isArray(v.posts) ? v.posts : [];
    }
    for (const el of Object.keys(labelEls)) {
      if (labelEls[el]) labelEls[el].textContent = view[el].label;
    }
    applyCoinTexture(view.e2.head || '');
    rebuildPosts();
    if (reducedOn) renderOnce();
  }

  function flare(id) {
    if (id === 'e1') flareUntil = performance.now() + 1500;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    if (reduced.removeEventListener) reduced.removeEventListener('change', onMotionChange);
    if (skullApi) skullApi.destroy();
    for (const s of postSprites) { if (s.material.map) s.material.map.dispose(); s.material.dispose(); }
    flameGeo.dispose(); flameMat.dispose();
    dustGeo.dispose(); dustMat.dispose();
    coinMesh.geometry.dispose();
    silverMat.dispose(); blackMat.dispose();
    if (silverMat.map) silverMat.map.dispose();
    nebula.material.map.dispose(); nebula.material.dispose(); nebula.geometry.dispose();
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    if (renderer.domElement.parentNode === scene) scene.removeChild(renderer.domElement);
  }

  /* render one frame as soon as the scene exists */
  renderOnce();
  if (!reducedOn) start();

  return { update, flare, destroy };
}
