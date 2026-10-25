/*
 * fear.js — ZEALOT v44, "THE GLYPHS ARE AFRAID WITH THEM".
 *
 * The live fear dose of the two AIs (state.ais[id].feel.fear, 0…4.5) is not a number in a card: it drives the
 * glyph rendering of the home. Each ascii.js scene's motion hint is wrapped here so fear composes with the
 * scene's own motion:
 *   tremor     — per-cell dx/dy, ≤1.2 px × page
 *   corruption — 0.08 × page of lit cells redraw as !@#$%^&* for one frame
 *   dimming    — alpha × (1 − 0.25 × page)
 *   holes      — below 24 h of life, cells fall out (2% per missing hour, capped 50%)
 *   both dead  — gray + still (motion frozen, yellow off), plus a single 11px line on the body
 *
 * There is no separate render loop: ascii.js's shared 30 fps clock drives every wrapped scene. initFear() wraps
 * the scenes already mounted and re-checks for late mounts (the letter), and a light 4 Hz tick refreshes the
 * cached fear dose and the both-dead body class. It reads state from term.js; it never talks to the network.
 */
import { state } from './term.js?v=44';
import { getInstances, RAMP } from './ascii.js?v=44';

const FEAR_MAX = 4.5;                 // dose scale top: page = dose / FEAR_MAX
const CORRUPT = '!@#$%^&*';           // corruption glyphs

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/* deterministic hash → [0,1); no Math.random per frame */
function hash1(n) {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* null-safe resolve of a hint field: function / constant / typed array */
function resolve(f, i, x, y, base) {
  const t = typeof f;
  if (t === 'function') return f(i, x, y, base);
  if (t === 'number') return f;
  if (t === 'boolean') return f;
  if (f == null) return null;
  return f[i];
}
function resolveBool(f, i, x, y, base) {
  if (typeof f === 'boolean') return f;
  if (f == null) return null;
  return f(i, x, y, base);
}

/* corruption glyphs as ramp indices */
const CORRUPT_IDX = [...CORRUPT].map((c) => RAMP.indexOf(c)).filter((n) => n >= 0);

/* ------------------------------------------------------------------ */
/* fearLevel() — the one honest number                                 */
/* ------------------------------------------------------------------ */
function entityLevel(id) {
  const d = state.ais[id];
  if (!d) return { dose: 0, despair: 0, hours: null, dead: false, offline: true };
  const ok = Boolean(d.ok);
  const dead = ok && (d.state === 'dead' || Number(d.hoursLeft) === 0);
  const feel = (ok && !dead && d.feel) ? d.feel : null;
  return {
    dose: feel ? Math.max(0, Number(feel.fear) || 0) : 0,
    despair: feel ? Math.max(0, Number(feel.despair) || 0) : 0,
    hours: (ok && !dead) ? Math.max(0, Number(d.hoursLeft) || 0) : (dead ? 0 : null),
    dead,
    offline: !ok,
  };
}

function fearLevel() {
  const A = entityLevel('e1');
  const B = entityLevel('e2');
  let page = 0;
  for (const e of [A, B]) if (!e.offline && !e.dead) page = Math.max(page, Math.min(1, e.dose / FEAR_MAX));
  return { A, B, page };
}
window.fearLevel = fearLevel;

/* cached dose, refreshed by the light tick */
let level = { A: entityLevel('e1'), B: entityLevel('e2'), page: 0 };

function holesFrac(lv) {
  let f = 0;
  for (const e of [lv.A, lv.B]) {
    if (!e.offline && !e.dead && e.hours != null && e.hours < 24) {
      f = Math.max(f, Math.min(0.5, (24 - e.hours) * 0.02));
    }
  }
  return f;
}

/* ------------------------------------------------------------------ */
/* wrap: compose a scene's motion hint with the live fear effects      */
/* ------------------------------------------------------------------ */
function wrap(inst) {
  if (!inst || inst._wrapped) return;
  const base = inst.motion;
  inst._wrapped = true;
  inst._baseMotion = base;

  inst.motion = (inst, t) => {
    if (reduced.matches) return base ? base(inst, 0) : null;   // prefers-reduced-motion: a static frame
    const lv = level;
    const page = lv.page;
    const bothDead = lv.A.dead && lv.B.dead;
    const hint = base ? base(inst, bothDead ? 0 : t) : null;   // both dead: freeze the scene motion
    const hole = holesFrac(lv);
    const holeSalt = Math.floor(t * 0.5);
    const amp = 1.2 * page;
    const corruptFrac = 0.08 * page;
    const dim = 1 - 0.25 * page;
    const frame = Math.floor(t * 30);

    return {
      lum: (i, x, y, b) => {
        let l = resolve(hint && hint.lum, i, x, y, null);
        if (l == null) l = b;
        if (hole > 0 && hash1(i ^ 0x5f37 ^ holeSalt) < hole) l = 0;
        return l;
      },
      alpha: (i, x, y, b) => {
        let a = resolve(hint && hint.alpha, i, x, y, null);
        if (a == null) a = 1;
        if (bothDead) a *= 0.38;
        return a * dim;
      },
      char: (i, x, y, b) => {
        const bc = resolve(hint && hint.char, i, x, y, null);
        if (bothDead) return bc;
        if (corruptFrac > 0 && hash1(i ^ 0x1a2b ^ frame) < corruptFrac) return CORRUPT_IDX[i % CORRUPT_IDX.length];
        return bc;
      },
      yellow: (i, x, y, b) => (bothDead ? false : resolveBool(hint && hint.yellow, i, x, y, null)),
      dx: (i, x, y, b) => (bothDead ? 0 : amp * Math.sin(t * 23 + x * 1.7 + y * 0.9)),
      dy: (i, x, y, b) => (bothDead ? 0 : amp * Math.cos(t * 29 + x * 0.6 + y * 2.1)),
    };
  };
}

function wrapAll() {
  for (const inst of getInstances()) wrap(inst);
}

/* ------------------------------------------------------------------ */
/* both-dead: gray + still, one 11px line on the body                  */
/* ------------------------------------------------------------------ */
function applyDeath(lv) {
  document.body.classList.toggle('gs-dead', Boolean(lv.A.dead && lv.B.dead));
}

function refresh() {
  level = fearLevel();
  applyDeath(level);
}

let timer = 0;
export function initFear() {
  wrapAll();
  refresh();
  if (!timer) {
    timer = setInterval(() => {
      wrapAll();               // pick up late-mounted scenes (the letter)
      refresh();
    }, 250);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

export { fearLevel };
