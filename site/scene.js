/* ZEALOT v15 — scene.js — "the obol on the eyes", drawn in terminal glyphs.
 *
 * SPLIT JOB A. This file owns the live 3D scene and the glyph render pass.
 * It only ever writes into ./gl/*.js (optional helpers) and this file.
 *
 * Contract (for the other worker):
 *   export function mountScene({ container, labels, poster })
 *     -> { setData(view), setChapter(p), destroy() }
 *   view = { e1:{name,hours,state,lastRentTs,lastLetterSeq,posts:[strings]},
 *            e2:{...same} }   state ∈ 'alive'|'asleep'|'dead'
 *   labels = DOM element (I fill two mono .hud spans, projected from the candle
 *            tip and the coins), poster = <img> hidden after the first frame.
 *   setChapter(p) = scroll progress 0..1 over the 500vh document.
 *
 * Static: three r170 + GLTFLoader from ./vendor, no network at runtime.
 */

import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

/* ------------------------------------------------------------------ */
/* TUNING — the three offsets correct the auto-measured anchors.       */
/* The skull is normalised to ~[-0.5, 0.5] on every axis, +Y up,       */
/* +Z = face. Offsets are added in that canonical skull space.         */
/* ------------------------------------------------------------------ */
const CANDLE_OFFSET   = { x: 0.00, y: 0.00, z: 0.00 }; // flame sits on the measured top cluster
const SOCKET_L_OFFSET = { x: 0.00, y: 0.00, z: 0.00 }; // left  coin (model −X side)
const SOCKET_R_OFFSET = { x: 0.00, y: 0.00, z: 0.00 }; // right coin (model +X side)

const EYE_HEIGHT  = 0.10;  // sockets sit this far above the skull centre (fraction of height)
const EYE_SPACING = 0.17;  // sockets sit this far from the midline (fraction of width)
const EYE_INSET   = 0.03;  // sockets recessed this far behind the front surface (fraction of depth)

const N_FLAME  = 2400;     // additive flame sprites (spec: 1500–3000)
const N_SMOKE  = 300;      // smoke sprites
const CELL     = 6;        // one glyph = one 8px cell  (render target = viewport / CELL)
const FPS      = 30;

/* glyph ramps — bone/coin uses the density ramp, flame/smoke the fire ramp */
const RAMP_BONE = ' .:-=+*#%@';
const RAMP_FIRE = '!@#$%&*^';
const ATLAS = RAMP_BONE + RAMP_FIRE;                 // 18 cells, bone = 0..9, fire = 10..17
const ATLAS_N = ATLAS.length;

/* ---------------- shared scratch (no per-frame allocation) --------------- */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _col = new THREE.Color();

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smooth(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

/* ----------------------------- glyph atlas ------------------------------ */
function makeAtlas() {
  const cell = 18;
  const c = document.createElement('canvas');
  c.width = ATLAS_N * cell;
  c.height = cell;
  const ctx = c.getContext('2d');
  ctx.font = '13px "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < ATLAS_N; i++) ctx.fillText(ATLAS[i], i * cell + cell / 2, cell / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/* ------------------------- texture normalisation ------------------------ */
/* Meshy bakes a dark photo into the albedo (mean ~0.27). Stretch it once so the
   bone reads as bone under the glyph ramp; the shading still comes from the lights. */
function brightenTexture(map, targetMean) {
  try {
    const img = map.image;
    const w = Math.min(1024, img.width || 1024), h = Math.min(1024, img.height || 1024);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
    const mean = sum / (d.length / 4) || 1;
    const gain = Math.min(4, targetMean / mean);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, d[i] * gain);
      d[i + 1] = Math.min(255, d[i + 1] * gain);
      d[i + 2] = Math.min(255, d[i + 2] * gain);
    }
    ctx.putImageData(id, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = map.flipY;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = map.wrapS; tex.wrapT = map.wrapT;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  } catch (e) {
    return map;
  }
}

/* ------------------------------ soft sprite ------------------------------ */
function makeSoftSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/* ------------------------------- shaders -------------------------------- */
const POINT_VERT = /* glsl */`
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main(){
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const POINT_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uTint;
  varying vec3 vColor;
  varying float vAlpha;
  void main(){
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * uTint, 1.0) * a;
  }`;

const GLYPH_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const GLYPH_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uFire;
  uniform sampler2D uAtlas;
  uniform vec2 uGrid;
  uniform float uSeed;
  uniform float uExposure;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main(){
    vec2 cell = floor(vUv * uGrid);
    vec2 cuv = (cell + 0.5) / uGrid;
    vec3 c = texture2D(uScene, cuv).rgb * uExposure;
    vec3 f = texture2D(uFire, cuv).rgb;

    float idx;
    bool smoke = f.g > 0.02 && f.g > f.r;
    bool flame = f.r > 0.02;
    if (flame || smoke){
      idx = 10.0 + floor(hash(cell + vec2(fract(uSeed * 1.37), fract(uSeed * 0.83))) * 8.0);
      if (smoke) c *= 0.65;
    } else {
      float lum = pow(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0), 0.6);
      idx = floor(lum * 9.999);
    }

    /* bone: one warm ramp by luminance, quantised to 5 steps — terminal, not photo */
    float lum2 = pow(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0), 0.6);
    float qb = floor(lum2 * 5.0) / 5.0;
    vec3 col = mix(vec3(0.30, 0.27, 0.22), vec3(0.93, 0.88, 0.76), qb);
    if (idx < 0.5) col = vec3(0.0);
    if (flame || smoke) {
      vec3 cf = pow(max(c, 0.0), vec3(0.4545));
      col = mix(cf, vec3(1.0, 0.72, 0.35), 0.35);
    }

    vec2 inCell = fract(vUv * uGrid);
    float u = (idx + inCell.x) / ${ATLAS_N}.0;
    float a = texture2D(uAtlas, vec2(u, inCell.y)).a;
    a = smoothstep(0.25, 0.75, a);

    vec2 q = vUv - 0.5;
    float vig = clamp(1.0 - dot(q, q) * 1.5, 0.0, 1.0);

    gl_FragColor = vec4(col * a * vig, 1.0);
  }`;

/* ------------------------------------------------------------------ */
/* mountScene                                                          */
/* ------------------------------------------------------------------ */
export function mountScene({ container, labels, poster }) {
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    renderer = null;
  }

  const noop = {
    setData() {}, setChapter() {}, destroy() {},
  };

  if (!renderer) {
    // WebGL missing: keep the poster (key-visual) visible.
    if (poster) poster.style.display = '';
    return noop;
  }

  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  /* ---------- scene graph ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 30);

  const skullHolder = new THREE.Group();
  scene.add(skullHolder);
  const coinGroup = new THREE.Group();
  scene.add(coinGroup);
  const textGroup = new THREE.Group();
  scene.add(textGroup);
  const fireGroup = new THREE.Group();
  scene.add(fireGroup);

  /* ---------- lights ---------- */
  const flameLight = new THREE.PointLight(0xff9a4d, 3.0, 6, 1.5);
  scene.add(flameLight);
  const rimLight = new THREE.PointLight(0x7fb4ff, 0, 6, 2);
  rimLight.position.set(-1.4, 0.6, -1.6);
  scene.add(rimLight);
  const amb = new THREE.AmbientLight(0x383840, 2.0);
  scene.add(amb);
  const fill = new THREE.DirectionalLight(0xc8b89a, 2.6); // soft from the camera side, warm bone
  fill.position.set(0.6, 0.8, 2.0);
  scene.add(fill);

  /* ---------- particles ---------- */
  const softTex = makeSoftSprite();
  const uScale = { value: 900 };
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: softTex }, uTint: { value: new THREE.Color(1, 1, 1) }, uScale },
    vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: softTex }, uTint: { value: new THREE.Color(1, 1, 1) }, uScale },
    vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });

  function makePoints(n, mat) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    return { pts, pos, col, size, alpha, age: new Float32Array(n), life: new Float32Array(n), seed: new Float32Array(n) };
  }

  const flame = makePoints(N_FLAME, flameMat);
  const smoke = makePoints(N_SMOKE, smokeMat);
  fireGroup.add(flame.pts, smoke.pts);

  for (let i = 0; i < N_FLAME; i++) { flame.age[i] = 1e9; flame.life[i] = 0; flame.seed[i] = Math.random() * 1000; }
  for (let i = 0; i < N_SMOKE; i++) { smoke.age[i] = 1e9; smoke.life[i] = 0; smoke.seed[i] = Math.random() * 1000; }

  /* ---------- haze (faint volumetric depth, scene pass only) ---------- */
  const hazeMat = new THREE.SpriteMaterial({
    map: makeSoftSprite(), color: 0x1a2030, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, transparent: true, opacity: 0.22,
  });
  const haze = new THREE.Sprite(hazeMat);
  haze.position.set(0, 0, -2.4);
  haze.scale.setScalar(7);
  scene.add(haze);

  /* ---------- low-res render targets ---------- */
  let sceneRT = null, fireRT = null, rtW = 1, rtH = 1;
  function makeRT() {
    const rt = new THREE.WebGLRenderTarget(rtW, rtH, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });
    rt.texture.generateMipmaps = false;
    return rt;
  }

  /* ---------- glyph pass (full-screen quad) ---------- */
  const glyphMat = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: null }, uFire: { value: null }, uAtlas: { value: makeAtlas() },
      uGrid: { value: new THREE.Vector2(1, 1) }, uSeed: { value: 0 }, uExposure: { value: 2.2 },
    },
    vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
    depthTest: false, depthWrite: false,
  });
  const glyphCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const glyphQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glyphMat);
  const glyphScene = new THREE.Scene();
  glyphScene.add(glyphQuad);

  /* ---------- state ---------- */
  const view = { e1: null, e2: null };
  let flameState = 'alive';
  let obolState = 'alive';
  let prevSeq = { e1: undefined, e2: undefined };
  let chapterP = 0;
  let t = 0;
  let frame = 0;
  let flare = 0;
  let glint = 0;
  let coinRing = 0;
  let firstFrame = false;

  /* anchors, filled after the skull is measured */
  let candle = new THREE.Vector3(0, 0.42, 0);
  let socketL = new THREE.Vector3(-0.16, 0.06, 0.34);
  let socketR = new THREE.Vector3(0.16, 0.06, 0.34);

  /* coins */
  const coinRadius = 0.115;
  const floorY = -0.55;
  const coins = [];
  let coinMatTemplate = null;

  /* text particles (last posts) */
  const TEXT_MAX = 48;
  const textSprites = [];
  const charCache = new Map();
  const textLife = new Float32Array(TEXT_MAX);
  const textVel = new Float32Array(TEXT_MAX * 3);
  let textActive = 0;

  function charTex(ch) {
    let t = charCache.get(ch);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = '700 42px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff9a4d';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffd9a0';
    ctx.fillText(ch, 32, 34);
    t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    charCache.set(ch, t);
    return t;
  }

  function spawnText(text, anchor) {
    const s = String(text || '').replace(/\s+/g, ' ').slice(0, TEXT_MAX);
    if (!s.length) return;
    textActive = s.length;
    for (let i = 0; i < textActive; i++) {
      let sp = textSprites[i];
      if (!sp) {
        sp = new THREE.Sprite(new THREE.SpriteMaterial({
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
        }));
        sp.scale.setScalar(0.07);
        textGroup.add(sp);
        textSprites[i] = sp;
      }
      sp.material.map = charTex(s[i]);
      sp.material.needsUpdate = true;
      const a = (i / (textActive - 1 || 1)) * Math.PI * 2 - Math.PI; // gentle arc
      sp.position.set(anchor.x + Math.cos(a) * 0.05 * i * 0.09, anchor.y + 0.15 + i * 0.016, anchor.z + Math.sin(a) * 0.04);
      sp.material.opacity = 1;
      sp.visible = true;
      textLife[i] = 4.0 + Math.random() * 2.0;
      textVel[i * 3] = Math.cos(a) * 0.012;
      textVel[i * 3 + 1] = 0.05 + Math.random() * 0.03;
      textVel[i * 3 + 2] = Math.sin(a) * 0.008;
    }
    for (let i = textActive; i < TEXT_MAX; i++) if (textSprites[i]) textSprites[i].visible = false;
  }

  /* --------------------------- geometry loading --------------------------- */
  function coinGeometry(obolScene) {
    let src = null;
    obolScene.traverse(o => { if (o.isMesh && o.geometry && !src) src = o.geometry; });
    if (!src) {
      // procedural silver coin (CylinderGeometry is thin along Y)
      return { geo: new THREE.CylinderGeometry(coinRadius, coinRadius, 0.02, 48), thin: 1 };
    }
    const g = src.clone();
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const ex = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    const thin = ex[0] <= ex[1] && ex[0] <= ex[2] ? 0 : (ex[1] <= ex[2] ? 1 : 2);
    g.center();
    const wide = Math.max(ex[0], ex[1], ex[2]);
    const s = (coinRadius * 2) / wide;
    g.scale(s, s, s);
    g.center();
    return { geo: g, thin };
  }

  function buildCoins(obolScene) {
    const { geo, thin } = coinGeometry(obolScene);
    const thinVec = new THREE.Vector3(thin === 0 ? 1 : 0, thin === 1 ? 1 : 0, thin === 2 ? 1 : 0);
    _q1.setFromUnitVectors(thinVec, new THREE.Vector3(0, 0, 1));

    let map = null;
    obolScene.traverse(o => { if (o.isMesh && o.material && !map && o.material.map) map = o.material.map; });

    coinMatTemplate = new THREE.MeshStandardMaterial({
      color: 0xc9c4b8, metalness: 0.9, roughness: 0.32,
      emissive: new THREE.Color(0x9aa4b0), emissiveIntensity: 0.3,
    });
    if (map) coinMatTemplate.map = map;

    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(geo.clone(), coinMatTemplate.clone());
      m.quaternion.copy(_q1);
      m.rotation.x += 0.28;
      coinGroup.add(m);
      coins.push({
        mesh: m,
        home: k === 0 ? socketL : socketR,
        socketY: (k === 0 ? socketL : socketR).y,
        falling: false, fallT: 0, hit: false,
      });
    }
  }

  /* ---------------------------- measurement ----------------------------- */
  function gatherPositions(obj) {
    const out = [];
    obj.updateMatrixWorld(true);
    obj.traverse(o => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        const p = o.geometry.attributes.position;
        const m = o.matrixWorld;
        for (let i = 0; i < p.count; i++) {
          _v1.fromBufferAttribute(p, i).applyMatrix4(m);
          out.push(_v1.x, _v1.y, _v1.z);
        }
      }
    });
    return new Float32Array(out);
  }

  function axisBounds(pos, a) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const v = pos[i + a];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return { mn, mx, ext: mx - mn };
  }

  function bandCount(pos, a, end, frac) {
    const { mn, mx, ext } = axisBounds(pos, a);
    const th = end > 0 ? mx - ext * frac : mn + ext * frac;
    let c = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const v = pos[i + a];
      if ((end > 0 && v >= th) || (end < 0 && v <= th)) c++;
    }
    return c;
  }

  function detectUp(pos) {
    let best = Infinity, up = 1;
    for (let a = 0; a < 3; a++) {
      const { mx, ext } = axisBounds(pos, a);
      const th = mx - ext * 0.05;
      const o1 = (a + 1) % 3, o2 = (a + 2) % 3;
      let cx = 0, cy = 0, cz = 0, c = 0;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i + a] >= th) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; c++; }
      }
      if (c < 3) continue;
      cx /= c; cy /= c; cz /= c;
      let spread = 0;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i + a] >= th) {
          const d1 = pos[i + o1] - (o1 === 0 ? cx : o1 === 1 ? cy : cz);
          const d2 = pos[i + o2] - (o2 === 0 ? cx : o2 === 1 ? cy : cz);
          spread += d1 * d1 + d2 * d2;
        }
      }
      spread = Math.sqrt(spread / c);
      if (spread < best) { best = spread; up = a; }
    }
    return up;
  }

  function detectFront(pos, up) {
    const horiz = [0, 1, 2].filter(a => a !== up);
    const e0 = axisBounds(pos, horiz[0]).ext;
    const e1 = axisBounds(pos, horiz[1]).ext;
    const depth = e0 <= e1 ? horiz[0] : horiz[1];
    const nPlus = bandCount(pos, depth, 1, 0.02);
    const nMinus = bandCount(pos, depth, -1, 0.02);
    const sign = nPlus <= nMinus ? 1 : -1;
    return { axis: depth, sign };
  }

  function alignHolder(pos) {
    const up = detectUp(pos);
    const front = detectFront(pos, up);
    const eUp = new THREE.Vector3(up === 0 ? 1 : 0, up === 1 ? 1 : 0, up === 2 ? 1 : 0);
    const eFront = new THREE.Vector3(front.axis === 0 ? front.sign : 0, front.axis === 1 ? front.sign : 0, front.axis === 2 ? front.sign : 0);
    const eLat = _v2.crossVectors(eUp, eFront).normalize();
    _m1.makeBasis(eLat, eUp, eFront);
    skullHolder.quaternion.setFromRotationMatrix(_m1);
  }

  /* (re)measure anchors in canonical space */
  function measureAnchors() {
    const pos = gatherPositions(skullHolder);
    const by = axisBounds(pos, 1);
    const bx = axisBounds(pos, 0);
    const bz = axisBounds(pos, 2);

    // candle tip = centroid of the top 1.5% cluster
    const th = by.mx - by.ext * 0.015;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] >= th) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; n++; }
    }
    cx /= n; cy /= n; cz /= n;
    candle.set(cx + CANDLE_OFFSET.x, cy + CANDLE_OFFSET.y, cz + CANDLE_OFFSET.z);

    const cyy = (by.mn + by.mx) / 2 + EYE_HEIGHT * by.ext;
    const sx = EYE_SPACING * bx.ext;
    const sz = bz.mx - EYE_INSET * bz.ext;
    socketL.set(-sx + SOCKET_L_OFFSET.x, cyy + SOCKET_L_OFFSET.y, sz + SOCKET_L_OFFSET.z);
    socketR.set(sx + SOCKET_R_OFFSET.x, cyy + SOCKET_R_OFFSET.y, sz + SOCKET_R_OFFSET.z);

    console.log('[scene] measured anchors (skull-local):',
      'candle=', candle.toArray().map(v => v.toFixed(3)),
      'socketL=', socketL.toArray().map(v => v.toFixed(3)),
      'socketR=', socketR.toArray().map(v => v.toFixed(3)),
      'upExtent=', by.ext.toFixed(3));
  }

  function onSkull(gltf) {
    skullHolder.add(gltf.scene);
    let pos = gatherPositions(skullHolder);
    alignHolder(pos);

    skullHolder.updateMatrixWorld(true);
    const b = new THREE.Box3();
    skullHolder.traverse(o => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        const p = o.geometry.attributes.position, m = o.matrixWorld;
        for (let i = 0; i < p.count; i++) {
          _v1.fromBufferAttribute(p, i).applyMatrix4(m);
          b.expandByPoint(_v1);
        }
      }
    });
    const size = b.getSize(_v2);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const center = b.getCenter(_v3);
    const s = 1 / maxDim;
    skullHolder.scale.multiplyScalar(s);
    skullHolder.position.sub(center.multiplyScalar(s));
    skullHolder.updateMatrixWorld(true);

    // warm the PBR slightly so the bone reads under the flame light
    skullHolder.traverse(o => {
      if (o.isMesh && o.material) {
        if (o.material.map) o.material.map = brightenTexture(o.material.map, 150);
        if ('metalness' in o.material) { o.material.metalness = 0; o.material.roughness = 0.85; }
        o.material.needsUpdate = true;
      }
    });

    measureAnchors();
    // chapter 1 looks at the measured flame, wherever the model put the candle
    camKeys[1].pos = [candle.x + 0.26, candle.y - 0.04, candle.z + 0.80];
    camKeys[1].tgt = [candle.x, candle.y - 0.14, candle.z]; // flame lands in the upper half, above the terminal
    // chapter 2 looks between the two sockets
    camKeys[2].pos = [0.08, socketL.y - 0.02, socketL.z + 0.72];
    camKeys[2].tgt = [0, socketL.y - 0.16, socketL.z];
    flameLight.position.copy(candle);
    candle.y += 0.005;

    const loader2 = new GLTFLoader();
    loader2.load('./vendor/obol.glb', onObol, undefined, () => buildCoins({ scene: new THREE.Group() }));
    if (reduced) draw(0.016);
  }

  function onObol(gltf) { buildCoins(gltf.scene); if (reduced) draw(0.016); }

  function onSkullFail() {
    if (poster) poster.style.display = '';
    console.warn('[scene] skull-candle.glb failed to load — keeping poster');
  }

  /* ------------------------------ camera ------------------------------ */
  const camKeys = [
    { pos: [0.00, 0.10, 2.30], tgt: [0, -0.25, 0] },   // ch0 front, whole skull above the terminal
    { pos: [0.20, 0.32, 1.05], tgt: [0, 0.42, 0] },   // ch1 flame
    { pos: [0.10, 0.10, 1.15], tgt: [0, 0.06, 0.34] }, // ch2 coins
    { pos: [0.00, 1.10, 2.30], tgt: [0, -0.05, 0] },  // ch3 pull back / up
    { pos: [0.00, 0.30, 2.20], tgt: [0, -0.20, 0] },  // ch4 end
  ];

  function updateCamera(dt) {
    const cp = chapterP * 4;
    const i = Math.min(3, Math.floor(cp));
    const f = smooth(0, 1, cp - i);
    const a = camKeys[i], b = camKeys[i + 1];

    _v1.set(lerp(a.pos[0], b.pos[0], f), lerp(a.pos[1], b.pos[1], f), lerp(a.pos[2], b.pos[2], f));
    _v2.set(lerp(a.tgt[0], b.tgt[0], f), lerp(a.tgt[1], b.tgt[1], f), lerp(a.tgt[2], b.tgt[2], f));

    // slow orbit at rest (ch0), fades with scroll
    const orbit = (1 - clamp01(chapterP * 2.2));
    if (!reduced && orbit > 0.01) {
      const a2 = t * 0.10;
      _v1.x += Math.sin(a2) * 0.30 * orbit;
      _v1.z += Math.cos(a2) * 0.22 * orbit - 0.22 * orbit;
    }
    // pointer parallax
    if (!reduced) {
      _v1.x += mouse.x * 0.18;
      _v1.y += mouse.y * 0.12;
    }
    camera.position.copy(_v1);
    camera.lookAt(_v2);
  }

  /* ------------------------------ labels ------------------------------ */
  let hud1 = null, hud2 = null;
  if (labels) {
    hud1 = labels.querySelector('[data-label="e1"]') || labels.querySelectorAll('.hud')[0] || null;
    hud2 = labels.querySelector('[data-label="e2"]') || labels.querySelectorAll('.hud')[1] || null;
    if (!hud1) { hud1 = document.createElement('span'); hud1.className = 'hud'; labels.appendChild(hud1); }
    if (!hud2) { hud2 = document.createElement('span'); hud2.className = 'hud'; labels.appendChild(hud2); }
  }

  function fmtHours(h) { return (h == null ? '—' : Math.round(h)) + ' H'; }
  function fmtUTC(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
  }

  function updateLabelText() {
    const e1 = view.e1, e2 = view.e2;
    const n1 = (e1 && e1.name) ? String(e1.name).toUpperCase() : 'WICK';
    const n2 = (e2 && e2.name) ? String(e2.name).toUpperCase() : 'OBOL';
    const st = s => (s || 'alive').toUpperCase();

    if (chapterP < 0.22) {
      if (hud1) hud1.textContent = `${n1} · ${fmtHours(e1 && e1.hours)} · ${st(e1 && e1.state)}`;
      if (hud2) hud2.textContent = `${n2} · ${fmtHours(e2 && e2.hours)} · ${st(e2 && e2.state)}`;
    } else if (chapterP < 0.42) {
      if (hud1) hud1.textContent = `${n1} · last rent ${fmtUTC(e1 && e1.lastRentTs)}`;
      if (hud2) hud2.textContent = '';
    } else if (chapterP < 0.62) {
      if (hud1) hud1.textContent = '';
      if (hud2) hud2.textContent = `${n2} · ${fmtHours(e2 && e2.hours)}`;
    } else {
      if (hud1) hud1.textContent = '';
      if (hud2) hud2.textContent = '';
    }
  }

  function projectLabel(span, world, side) {
    if (!span) return;
    _v1.copy(world).project(camera);
    if (_v1.z > 1) { span.style.opacity = 0; return; }
    // the tag sits beside its anchor, never over the bone: right of the flame, left of the coin
    const gap = Math.max(36, widthCss * 0.09);
    const x = (_v1.x * 0.5 + 0.5) * widthCss + (side < 0 ? -gap : gap);
    const y = (-_v1.y * 0.5 + 0.5) * heightCss;
    span.style.transform = 'translate(' + (x | 0) + 'px,' + (y | 0) + 'px)' + (side < 0 ? ' translateX(-100%)' : '');
    span.style.opacity = chapterP > 0.62 ? 0 : 1;
  }

  /* ------------------------------ resize ------------------------------ */
  let widthCss = 1, heightCss = 1;
  function resize() {
    widthCss = container.clientWidth || window.innerWidth || 1;
    heightCss = container.clientHeight || window.innerHeight || 1;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(widthCss, heightCss, false);
    renderer.domElement.style.width = widthCss + 'px';
    renderer.domElement.style.height = heightCss + 'px';
    camera.aspect = widthCss / heightCss;
    camera.updateProjectionMatrix();

    rtW = Math.max(1, Math.floor(widthCss / CELL));
    rtH = Math.max(1, Math.floor(heightCss / CELL));
    if (sceneRT) { sceneRT.dispose(); fireRT.dispose(); }
    sceneRT = makeRT();
    fireRT = makeRT();
    glyphMat.uniforms.uGrid.value.set(rtW, rtH);
    uScale.value = heightCss * pr;
  }

  /* ------------------------------ pointer ----------------------------- */
  const mouse = { x: 0, y: 0 };
  function onMove(e) {
    mouse.x = (e.clientX / widthCss) * 2 - 1;
    mouse.y = -((e.clientY / heightCss) * 2 - 1);
  }
  window.addEventListener('pointermove', onMove, { passive: true });

  /* --------------------------- particle update ------------------------ */
  const ORANGE = new THREE.Color(1.0, 0.48, 0.14);
  const WHITE = new THREE.Color(1.0, 0.95, 0.8);
  const SMOKE_COL = new THREE.Color(0.34, 0.36, 0.40);

  function respawnFlame(i) {
    flame.age[i] = 0;
    flame.life[i] = 0.35 + Math.random() * 0.85;
    flame.seed[i] = Math.random() * 1000;
  }
  function respawnSmoke(i) {
    smoke.age[i] = 0;
    smoke.life[i] = 1.6 + Math.random() * 1.6;
    smoke.seed[i] = Math.random() * 1000;
  }

  function updateParticles(dt, flameIntensity, flameScale, smokeIntensity) {
    // flame
    for (let i = 0; i < N_FLAME; i++) {
      flame.age[i] += dt;
      if (flame.age[i] >= flame.life[i]) respawnFlame(i);
      const s = flame.seed[i];
      const tt = clamp01(flame.age[i] / flame.life[i]);
      const curl = Math.sin(tt * 5.2 + s) * 0.030 * (1 - tt) + Math.sin(s * 1.7 + t * 0.6) * 0.012;
      const curl2 = Math.cos(tt * 4.4 + s * 1.3) * 0.030 * (1 - tt);
      const bx = candle.x + (Math.sin(s * 12.9) * 0.5) * 0.018;
      const bz = candle.z + (Math.cos(s * 12.9) * 0.5) * 0.018;
      flame.pos[i * 3] = bx + curl;
      flame.pos[i * 3 + 1] = candle.y + tt * 0.46 * flameScale;
      flame.pos[i * 3 + 2] = bz + curl2;
      _col.copy(ORANGE).lerp(WHITE, Math.pow(1 - tt, 1.4));
      const boost = 1 + flare * 1.4;
      flame.col[i * 3] = _col.r * flameIntensity * boost;
      flame.col[i * 3 + 1] = _col.g * flameIntensity * boost;
      flame.col[i * 3 + 2] = _col.b * flameIntensity * boost;
      flame.size[i] = (0.030 + 0.016 * Math.sin(s + t * 9)) * (1 - tt * 0.45) * flameIntensity;
      flame.alpha[i] = 0.9 * (1 - tt * 0.6) * flameIntensity;
    }
    flame.pts.geometry.attributes.position.needsUpdate = true;
    flame.pts.geometry.attributes.aColor.needsUpdate = true;
    flame.pts.geometry.attributes.aSize.needsUpdate = true;
    flame.pts.geometry.attributes.aAlpha.needsUpdate = true;

    // smoke
    for (let i = 0; i < N_SMOKE; i++) {
      smoke.age[i] += dt;
      if (smoke.age[i] >= smoke.life[i]) respawnSmoke(i);
      const s = smoke.seed[i];
      const tt = clamp01(smoke.age[i] / smoke.life[i]);
      const curl = Math.sin(tt * 3.1 + s) * 0.05 * (1 - tt) + Math.sin(s * 2.3 + t * 0.4) * 0.02;
      smoke.pos[i * 3] = candle.x + curl;
      smoke.pos[i * 3 + 1] = candle.y + tt * 0.85;
      smoke.pos[i * 3 + 2] = candle.z + Math.cos(tt * 2.7 + s * 1.1) * 0.05 * (1 - tt);
      smoke.col[i * 3] = SMOKE_COL.r * smokeIntensity;
      smoke.col[i * 3 + 1] = SMOKE_COL.g * smokeIntensity;
      smoke.col[i * 3 + 2] = SMOKE_COL.b * smokeIntensity;
      smoke.size[i] = (0.07 + tt * 0.05) * (0.6 + smokeIntensity * 0.4);
      smoke.alpha[i] = 0.10 * (1 - tt) * smokeIntensity;
    }
    smoke.pts.geometry.attributes.position.needsUpdate = true;
    smoke.pts.geometry.attributes.aColor.needsUpdate = true;
    smoke.pts.geometry.attributes.aSize.needsUpdate = true;
    smoke.pts.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /* ---------------------------- coins update --------------------------- */
  function updateCoins(dt, deathBlend) {
    if (coins.length < 2) return; // obol.glb not in yet
    const dead = obolState === 'dead' || deathBlend > 0.5;
    for (let k = 0; k < 2; k++) {
      const c = coins[k];
      const mat = c.mesh.material;
      if (dead) {
        if (!c.falling) { c.falling = true; c.fallT = 0; c.hit = false; }
        c.fallT += dt * 1.6;
        const p = Math.min(1, c.fallT);
        const y = lerp(c.socketY, floorY, p * p);
        if (p >= 1 && !c.hit) { c.hit = true; coinRing = 1; }
        let bounce = 0;
        if (p >= 1) bounce = Math.sin((c.fallT - 1) * 16) * 0.02 * Math.exp(-(c.fallT - 1) * 2.5);
        c.mesh.position.set(c.home.x, y + bounce, c.home.z);
        c.mesh.rotation.x = lerp(0.28, -Math.PI / 2, p);
        mat.emissiveIntensity = 0.02 + coinRing * 1.8;
      } else {
        c.falling = false; c.fallT = 0;
        const alive = obolState === 'alive';
        c.mesh.position.set(c.home.x, c.home.y, c.home.z);
        c.mesh.rotation.x = 0.28;
        mat.emissiveIntensity = alive
          ? (0.9 + 0.25 * Math.sin(t * 2.6) + glint * 1.6)
          : 0.45;
      }
    }
    if (coinRing > 0) coinRing = Math.max(0, coinRing - dt * 1.6);
    if (glint > 0) glint = Math.max(0, glint - dt * 1.8);
  }

  /* ---------------------------- text update ---------------------------- */
  function updateText(dt) {
    for (let i = 0; i < textActive; i++) {
      const sp = textSprites[i];
      if (!sp) continue;
      textLife[i] -= dt;
      if (textLife[i] <= 0) { sp.visible = false; continue; }
      sp.position.x += textVel[i * 3] * dt;
      sp.position.y += textVel[i * 3 + 1] * dt;
      sp.position.z += textVel[i * 3 + 2] * dt;
      sp.material.opacity = clamp01(textLife[i] / 2.0);
      const sc = 0.07 + (4.0 - textLife[i]) * 0.01;
      sp.scale.setScalar(sc);
    }
  }

  /* ------------------------------- draw -------------------------------- */
  function draw(dt) {
    frame++;
    if (!reduced) t += dt;
    const deathBlend = smooth(0.78, 0.95, chapterP);

    const fiBase = flameState === 'alive' ? 1 : flameState === 'asleep' ? 0.28 : 0;
    const fsBase = flameState === 'alive' ? 1 : flameState === 'asleep' ? 0.3 : 0;
    const smBase = flameState === 'dead' ? 1 : flameState === 'alive' ? 0.45 : 0.25;
    const flameIntensity = fiBase * (1 - deathBlend);
    const flameScale = fsBase * (1 - deathBlend);
    const smokeIntensity = Math.max(smBase, deathBlend);

    if (!reduced) {
      flare = Math.max(0, flare - dt * 2.0);
      updateParticles(dt, flameIntensity, flameScale, smokeIntensity);
      updateCoins(dt, deathBlend);
      updateText(dt);
    } else {
      updateParticles(0.016, flameIntensity, flameScale, smokeIntensity);
      updateCoins(0.016, deathBlend);
    }

    // light flicker
    const flick = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 11.3) * Math.sin(t * 7.1 + 1.7) * Math.sin(t * 17.3 + 0.4));
    flameLight.intensity = flameIntensity * flick * 6.0 + flare * 6;
    rimLight.intensity = (obolState === 'alive' && deathBlend < 0.5) ? 1.1 : 0;
    flameLight.position.copy(candle);

    updateCamera(dt);
    projectLabel(hud1, candle, 1);
    projectLabel(hud2, coinGroup.children.length >= 2 ? coins[0].mesh.position : socketL, -1);

    // ---- pass 1: scene (bone + fire visual) ----
    skullHolder.visible = true; coinGroup.visible = true; textGroup.visible = true; haze.visible = true; fireGroup.visible = true;
    flameMat.uniforms.uTint.value.setRGB(1, 1, 1);
    smokeMat.uniforms.uTint.value.setRGB(1, 1, 1);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // ---- pass 2: fire mask ----
    skullHolder.visible = false; coinGroup.visible = false; textGroup.visible = false; haze.visible = false; fireGroup.visible = true;
    flameMat.uniforms.uTint.value.setRGB(1, 0, 0);
    smokeMat.uniforms.uTint.value.setRGB(0, 1, 0);
    renderer.setRenderTarget(fireRT);
    renderer.render(scene, camera);

    // ---- pass 3: glyph quad ----
    skullHolder.visible = true; coinGroup.visible = true; textGroup.visible = true; haze.visible = true;
    flameMat.uniforms.uTint.value.setRGB(1, 1, 1);
    smokeMat.uniforms.uTint.value.setRGB(1, 1, 1);
    glyphMat.uniforms.uScene.value = sceneRT.texture;
    glyphMat.uniforms.uFire.value = fireRT.texture;
    glyphMat.uniforms.uSeed.value = frame + Math.random() * 0.5;
    renderer.setRenderTarget(null);
    renderer.render(glyphScene, glyphCam);

    if (!firstFrame) {
      firstFrame = true;
      if (poster) poster.style.display = 'none';
    }
  }

  /* ------------------------------- loop -------------------------------- */
  let timer = null;
  let running = true;
  let last = performance.now();
  function loop() {
    if (!running) return;
    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    draw(dt);
    timer = setTimeout(loop, 1000 / FPS);
  }
  function onVis() {
    if (document.hidden) { running = false; if (timer) clearTimeout(timer); timer = null; }
    else if (!running) { running = true; last = performance.now(); loop(); }
  }
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', resize);

  /* ------------------------------- API -------------------------------- */
  function setData(v) {
    view.e1 = v && v.e1 ? v.e1 : view.e1;
    view.e2 = v && v.e2 ? v.e2 : view.e2;
    if (view.e1) {
      const seq = view.e1.lastLetterSeq;
      if (prevSeq.e1 !== undefined && seq !== prevSeq.e1) {
        flare = 1;
        const post = (view.e1.posts && view.e1.posts.length) ? view.e1.posts[view.e1.posts.length - 1] : '';
        if (post) spawnText(post, candle);
      }
      prevSeq.e1 = seq;
    }
    if (view.e2) {
      const seq = view.e2.lastLetterSeq;
      if (prevSeq.e2 !== undefined && seq !== prevSeq.e2) {
        glint = 1;
        const post = (view.e2.posts && view.e2.posts.length) ? view.e2.posts[view.e2.posts.length - 1] : '';
        if (post) spawnText(post, coins.length ? coins[0].mesh.position : socketL);
      }
      prevSeq.e2 = seq;
    }
    if (view.e1) flameState = view.e1.state === 'alive' || view.e1.state === 'asleep' ? view.e1.state : 'dead';
    if (view.e2) obolState = view.e2.state === 'alive' || view.e2.state === 'asleep' ? view.e2.state : 'dead';
    updateLabelText();
    if (reduced) draw(0.016);
  }

  function setChapter(p) {
    chapterP = clamp01(p || 0);
    updateLabelText();
    if (reduced) draw(0.016);
  }

  function destroy() {
    running = false;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onMove);
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
    softTex.dispose();
    glyphMat.uniforms.uAtlas.value.dispose();
    charCache.forEach(tex => tex.dispose());
    glyphScene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    if (sceneRT) sceneRT.dispose();
    if (fireRT) fireRT.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  /* ------------------------------ boot -------------------------------- */
  resize();
  const loader = new GLTFLoader();
  loader.load('./vendor/skull-candle.glb', onSkull, undefined, onSkullFail);

  if (!reduced) {
    last = performance.now();
    loop();
  }

  return { setData, setChapter, destroy, flare() { flare = 1; } };
}
