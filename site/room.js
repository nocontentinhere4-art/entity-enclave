/*
 * room.js — the ASCII room, the entity sprites and the animation.
 *
 * The room is a grid of characters. Two layers, visibly distinct:
 *   - ambient: walking, sitting, looking outside; purely decorative (~ ambient);
 *   - real: mapped from data (/vitals, /ledger, /public-channel); every line carries [real].
 * Entity 2 is not deployed (base null): its desk stays empty and no body
 * is drawn. Nothing is invented.
 *
 * It also exposes the small DOM helpers (el/textNode/append) reused by term.js:
 * no network text ever enters through innerHTML.
 */

import {
  entryType,
  isFuture,
  parseLedger,
  stringOf,
  hhmm,
  clockTime,
  formatInt,
  formatDecimal,
  TICK_WINDOW_MS,
} from './data.js';

/* ------------------------------------------------------------------ */
/* Shared DOM helpers                                                  */
/* ------------------------------------------------------------------ */

export function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
      continue;
    }
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

export function textNode(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

/* ------------------------------------------------------------------ */
/* Character grid                                                      */
/* ------------------------------------------------------------------ */

class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', cls: '' })));
  }

  set(x, y, ch, cls = '') {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.cells[y][x] = { ch, cls };
  }

  put(x, y, str, cls = '') {
    let i = 0;
    for (const ch of String(str)) {
      this.set(x + i, y, ch, cls);
      i += 1;
    }
  }

  block(x, y, lines, cls = '') {
    for (let j = 0; j < lines.length; j += 1) this.put(x, y + j, lines[j], cls);
  }
}

/* ------------------------------------------------------------------ */
/* Room pieces                                                         */
/* ------------------------------------------------------------------ */

const B = {
  shelf: [
    '┌────────┐',
    '│ledger  │',
    '│▤▤▤▤    │',
    '└────────┘',
  ],
  window: [
    '╔══════════╗',
    '║  ☾   · · ║',
    '║ ·  ·   · ║',
    '╚══════════╝',
  ],
  vault: [
    '┌───────┐',
    '│ [$]   │',
    '│ ZEC   │',
    '└───────┘',
  ],
  desk: [
    '┌──────┐',
    '│ >_   │',
    '├──────┤',
    '│▒▒▒▒▒▒│',
    '└──────┘',
  ],
  chair: [
    '┬─┬',
    '│ │',
    '┴─┴',
  ],
  bed: [
    '┌──────────────┐',
    '│ ▒▒▒▒▒▒▒▒  ▒▒ │',
    '│ ░░░░░░░░  ░░ │',
    '└──────────────┘',
  ],
  door: [
    '┌──────┐',
    '│██████│',
    '│█████o│',
    '│██████│',
    '└──────┘',
  ],
};

const LAYOUTS = {
  wide: {
    name: 'wide',
    w: 80,
    h: 22,
    shelf: { x: 2, y: 2 },
    window: { x: 66, y: 2 },
    vault: { x: 2, y: 15 },
    desk1: { x: 13, y: 8 },
    chair1: { x: 10, y: 9 },
    desk2: { x: 45, y: 8 },
    chair2: { x: 42, y: 9 },
    bed: { x: 57, y: 16 },
    door: { x: 34, y: 16 },
    sign2: { x: 43, y: 13 },
    screen2: { x: 47, y: 9 },
    floorTop: 14,
    floorBottom: 20,
    corridor: { x0: 6, x1: 70, y: 14 },
    spots: {
      desk: { x: 15, y: 5 },
      read: { x: 4, y: 7 },
      window: { x: 62, y: 7 },
      center: { x: 30, y: 14 },
      rest: { x: 60, y: 17 },
      vault: { x: 3, y: 13 },
      door: { x: 34, y: 14 },
    },
  },
  compact: {
    name: 'compact',
    w: 48,
    h: 24,
    shelf: { x: 1, y: 2 },
    window: { x: 34, y: 2 },
    vault: { x: 1, y: 16 },
    desk1: { x: 5, y: 8 },
    chair1: { x: 2, y: 9 },
    desk2: { x: 28, y: 8 },
    chair2: { x: 25, y: 9 },
    bed: { x: 26, y: 17 },
    door: { x: 17, y: 19 },
    sign2: { x: 22, y: 13 },
    screen2: { x: 30, y: 9 },
    floorTop: 13,
    floorBottom: 22,
    corridor: { x0: 4, x1: 44, y: 14 },
    spots: {
      desk: { x: 6, y: 5 },
      read: { x: 1, y: 7 },
      window: { x: 38, y: 7 },
      center: { x: 20, y: 14 },
      rest: { x: 28, y: 18 },
      vault: { x: 2, y: 14 },
      door: { x: 18, y: 16 },
    },
  },
};

const RANDOM_CHARS = '░▒▓█#$%@&*+=~<>/\\|_-.:;0123456789';
const ASSEMBLY_MS = 1500;
const FRAME_MS = 130;
const AMBIENT_MS = 7000;

function randChar() {
  return RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
}

/* ------------------------------------------------------------------ */
/* Sprite                                                              */
/* ------------------------------------------------------------------ */

function headOf(entityId) {
  return entityId === 'e2' ? '(2)' : '(1)';
}

/** Entity body in 2-3 lines; the name line goes above the head. */
function bodyLines(head, state, frame) {
  switch (state) {
    case 'walk': {
      const legs = ['/ \\', ' |/', ' | ', '\\| '];
      return [head, '/|\\', legs[frame % legs.length]];
    }
    case 'sit':
    case 'type':
      return [head, '/|\\', '└┴┘'];
    case 'read':
      return [head, '/|\\', '▐▌ '];
    case 'rest':
      return ['zZ', `${head}══`];
    case 'interact':
      return [head, '/|\\', '/ \\'];
    case 'unborn':
      return [' :·:', `·${head}·`, ' ··'];
    case 'dead':
      return [' ___', '[RIP]', '▀▀▀▀▀'];
    default:
      return [head, '/|\\', '/ \\'];
  }
}

/* ------------------------------------------------------------------ */
/* Building the static scene                                           */
/* ------------------------------------------------------------------ */

function drawBorder(g, L, dev) {
  const { w, h } = L;
  g.put(0, 0, `╔${'═'.repeat(w - 2)}╗`, 'dim');
  g.put(0, h - 1, `╚${'═'.repeat(w - 2)}╝`, 'dim');
  for (let y = 1; y < h - 1; y += 1) {
    g.set(0, y, '║', 'dim');
    g.set(w - 1, y, '║', 'dim');
  }
  if (dev) {
    // the dev banner takes the place of the title: it stays in the top border, in red
    const banner = 'NOT ATTESTED';
    g.put(Math.max(1, Math.floor((w - banner.length) / 2)), 0, banner, 'err');
  } else {
    const title = '[ SOVEREIGN ENTITIES ]';
    g.put(Math.max(1, Math.floor((w - title.length) / 2)), 0, title, 'hi');
  }
}

function fillFloor(g, L) {
  for (let y = L.floorTop; y <= L.floorBottom; y += 1) {
    for (let x = 1; x < L.w - 1; x += 1) {
      g.set(x, y, (x + y) % 4 === 0 ? '·' : '.', 'dim');
    }
  }
}

function paintBase(L, dev) {
  const g = new Grid(L.w, L.h);
  drawBorder(g, L, dev);
  fillFloor(g, L);
  g.block(L.shelf.x, L.shelf.y, B.shelf, 'dim');
  g.block(L.window.x, L.window.y, B.window, 'dim');
  g.block(L.vault.x, L.vault.y, B.vault, 'dim');
  g.block(L.bed.x, L.bed.y, B.bed, 'dim');
  g.block(L.door.x, L.door.y, B.door, 'dim');
  g.block(L.chair1.x, L.chair1.y, B.chair, 'dim');
  g.block(L.desk1.x, L.desk1.y, B.desk, 'fg');
  g.block(L.chair2.x, L.chair2.y, B.chair, 'dim');
  g.block(L.desk2.x, L.desk2.y, B.desk, 'dim');
  // entity 2 screen: off, no activity
  g.put(L.screen2.x, L.screen2.y, '  ', 'dim');
  // sign on the empty chair
  g.put(L.sign2.x, L.sign2.y, '[absent · waiting]', 'dim');
  return g;
}

function cloneGrid(g) {
  const out = new Grid(g.w, g.h);
  for (let y = 0; y < g.h; y += 1) {
    for (let x = 0; x < g.w; x += 1) {
      const c = g.cells[y][x];
      out.cells[y][x] = { ch: c.ch, cls: c.cls };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading data -> room state                                          */
/* ------------------------------------------------------------------ */

function lastEntryOf(entries, types) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (types.includes(entryType(entries[i]))) return entries[i];
  }
  return null;
}

function entryAge(entry) {
  const ts = entry && entry.ts ? new Date(entry.ts).getTime() : NaN;
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}

/**
 * Translates the snapshot into a drawable state. Pure: does not touch the DOM.
 * Returns { dev, e1:{ name, state, mode, real, bubble, envelope, hunger }, ticker }.
 */
export function deriveRoom(data, meta = {}) {
  const out = {
    dev: Boolean(meta.dev),
    stale: Boolean(meta.stale),
    lastRead: meta.lastRead || null,
    name: 'unnamed',
    e1: {
      state: 'alive',
      mode: 'ambient',
      real: null,
      bubble: null,
      envelope: false,
      hunger: false,
    },
    ticker: { text: '~ ambient · e1 walks around the room', real: false },
  };

  const root = data.root;
  const vitals = data.vitals;
  const memory = data.memory;

  // name: from / then from /memory-public
  let name = '';
  if (root && root.ok && root.data) {
    const candidate = stringOf(root.data.entity).trim();
    if (candidate && candidate !== 'unnamed') name = candidate;
  }
  if (!name && memory && memory.ok && memory.data && memory.data.identity) {
    name = stringOf(memory.data.identity.name).trim();
  }
  out.name = name || 'unnamed';

  // state from /memorial and /vitals (declared facts, never simulated)
  const dead = Boolean(data.memorial && data.memorial.ok);
  let state = 'alive';
  let sleepUntil = null;
  let hunger = false;

  if (dead) {
    state = 'dead';
  } else if (vitals && vitals.ok && vitals.data) {
    const v = vitals.data;
    if (v.state === 'unborn') state = 'unborn';
    else if (v.state === 'dead') state = 'dead';
    else if (isFuture(v.sleepUntil)) {
      state = 'sleeping';
      sleepUntil = v.sleepUntil;
    } else {
      state = 'alive';
    }
    hunger = v.hunger === 'hungry';
  }

  // real action from the ledger: the last useful entry within the window
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const candidates = [];

  const think = lastEntryOf(entries, ['tick_llm', 'think_deep', 'think_fast']);
  if (think && entryAge(think) <= TICK_WINDOW_MS) {
    const d = think.data && typeof think.data === 'object' ? think.data : {};
    const kindRaw = stringOf(d.kind || d.think || d.depth || entryType(think)).toLowerCase();
    const deep = kindRaw.includes('deep') || kindRaw.includes('profond');
    const tokens = Number(d.tokens ?? d.tokensOut ?? d.output_tokens);
    const cost = Number(d.cost ?? d.taz ?? d.cost_taz ?? d.amount);
    candidates.push({
      at: think.ts,
      kind: 'think',
      deep,
      tokens: Number.isFinite(tokens) ? tokens : null,
      cost: Number.isFinite(cost) ? cost : null,
    });
  }

  const tool = lastEntryOf(entries, ['tool']);
  if (tool && entryAge(tool) <= TICK_WINDOW_MS) {
    const d = tool.data && typeof tool.data === 'object' ? tool.data : {};
    const toolName = stringOf(d.tool || d.name || d.call).toLowerCase();
    if (toolName.includes('read')) candidates.push({ at: tool.ts, kind: 'read' });
  }

  const post = lastEntryOf(entries, ['post_public']);
  if (post && entryAge(post) <= TICK_WINDOW_MS) {
    const d = post.data && typeof post.data === 'object' ? post.data : {};
    let text = stringOf(d.text || d.message || d.body);
    if (!text && data.channelEntries) {
      const last = data.channelEntries.filter((m) => m && m.from === 'entity').slice(-1)[0];
      if (last) text = stringOf(last.text);
    }
    candidates.push({ at: post.ts, kind: 'speak', text });
  }

  const human = lastEntryOf(entries, ['human_message']);
  if (human && entryAge(human) <= TICK_WINDOW_MS) candidates.push({ at: human.ts, kind: 'envelope' });

  candidates.sort((a, b) => entryAge(a) - entryAge(b));
  const real = candidates[0] || null;

  // priority: death > unborn > sleeping > real action > hunger > ambient
  if (state === 'dead') {
    out.e1.state = 'dead';
    out.e1.mode = 'real';
    out.ticker = { text: `${out.name}: dead · [RIP] in the memorial [real]`, real: true };
    return out;
  }
  if (state === 'unborn') {
    out.e1.state = 'unborn';
    out.e1.mode = 'real';
    out.ticker = { text: `${out.name}: not yet born · waiting for the gift [real]`, real: true };
    return out;
  }
  if (state === 'sleeping') {
    out.e1.state = 'rest';
    out.e1.mode = 'real';
    const until = hhmm(sleepUntil) || '—';
    out.ticker = { text: `${hhmm(Date.now())} ${out.name} sleeps (until ${until}) [real]`, real: true };
    return out;
  }

  if (real && real.kind === 'think') {
    out.e1.state = 'type';
    out.e1.mode = 'real';
    out.e1.real = real;
    const bits = [real.deep ? 'deep' : 'fast'];
    if (real.tokens !== null) bits.push(`${formatInt(real.tokens)} tokens`);
    if (real.cost !== null) bits.push(`${formatDecimal(real.cost, 3)} TAZ`);
    out.ticker = {
      text: `${hhmm(real.at) || '—'} e1 thinks (${bits.join(', ')}) [real]`,
      real: true,
    };
    return out;
  }
  if (real && real.kind === 'read') {
    out.e1.state = 'read';
    out.e1.mode = 'real';
    out.e1.real = real;
    out.ticker = { text: `${hhmm(real.at) || '—'} e1 reads (tool read_url) [real]`, real: true };
    return out;
  }
  if (real && real.kind === 'speak') {
    out.e1.state = 'sit';
    out.e1.mode = 'real';
    out.e1.real = real;
    const bubble = real.text ? truncate(real.text, 60) : '';
    out.e1.bubble = bubble;
    out.ticker = {
      text: `${hhmm(real.at) || '—'} e1 says: ${truncate(real.text || '(text unavailable)', 60)} [real]`,
      real: true,
    };
    return out;
  }
  if (real && real.kind === 'envelope') {
    out.e1.state = 'sit';
    out.e1.mode = 'real';
    out.e1.real = real;
    out.e1.envelope = true;
    out.ticker = { text: `${hhmm(real.at) || '—'} e1 received a human message [✉] [real]`, real: true };
    return out;
  }

  if (hunger) {
    out.e1.state = 'walk';
    out.e1.mode = 'real';
    out.e1.hunger = true;
    out.ticker = { text: `${hhmm(Date.now())} e1 is hungry · looking for gifts [real]`, real: true };
    return out;
  }

  // nothing real: ambient behaviour, declared as such
  out.e1.state = 'ambient';
  out.e1.mode = 'ambient';
  out.ticker = { text: '~ ambient · e1 walks around the room', real: false };
  return out;
}

function truncate(text, n) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

function wrapText(text, max) {
  const words = truncate(text, 60).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length <= max) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = word.length > max ? `${word.slice(0, max - 1)}…` : word;
      if (lines.length >= 3) break;
    }
  }
  if (cur && lines.length < 3) lines.push(cur);
  return lines.length ? lines : [''];
}

/* ------------------------------------------------------------------ */
/* Room                                                                */
/* ------------------------------------------------------------------ */

export class Room {
  constructor(host) {
    this.host = host;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.compact = window.matchMedia('(max-width: 640px)');
    this.layoutName = this.compact.matches ? 'compact' : 'wide';
    this.L = LAYOUTS[this.layoutName];

    this.data = { root: null, vitals: null, memory: null, channel: null, entries: [], channelEntries: [], memorial: null };
    this.meta = { stale: false, dev: false, lastRead: null };
    this.view = deriveRoom(this.data, this.meta);

    this.agent = { x: 0, y: 0, state: 'alive', frame: 0, moving: false };
    this.assembly = { start: null, cells: new Map() };
    this.ambient = { index: 0, nextAt: 0 };

    this.raf = null;
    this.lastTs = 0;
    this.destroyed = false;

    this.buildDom();
    this.base = paintBase(this.L, this.view.dev);
    this.resetAgent();
    this.onResize = () => {
      const wanted = this.compact.matches ? 'compact' : 'wide';
      if (wanted !== this.layoutName) this.setLayout(wanted);
    };
    this.compact.addEventListener('change', this.onResize);
    this.reduced.addEventListener('change', this.onResize);

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.render(0);
  }

  buildDom() {
    this.pre = el('pre', {
      class: 'room',
      role: 'img',
      'aria-label': 'ASCII room of the entities',
    });
    this.legend = el('p', { class: 'legend' });
    this.ticker = el('p', { class: 'ticker', 'aria-live': 'polite' });
    this.host.replaceChildren(
      this.pre,
      el('div', { class: 'roometa' }, this.legend, this.ticker),
    );
  }

  setLayout(name) {
    this.layoutName = name;
    this.L = LAYOUTS[name];
    this.base = paintBase(this.L, this.view.dev);
    this.resetAgent();
    this.render(this.lastTs);
  }

  resetAgent() {
    const spot = this.L.spots.desk;
    this.agent.x = spot.x;
    this.agent.y = spot.y;
    this.agent.state = this.view.e1.state;
    this.agent.frame = 0;
    this.agent.moving = false;
    this.assembly.start = null;
    this.assembly.cells.clear();
  }

  /** Absorbs a snapshot: keeps the last known state if a read fails. */
  ingest(snapshot, meta = {}) {
    const d = this.data;
    if (snapshot) {
      if (snapshot.root && snapshot.root.ok) d.root = snapshot.root;
      if (snapshot.memory && snapshot.memory.ok) d.memory = snapshot.memory;
      if (snapshot.vitals && snapshot.vitals.ok) d.vitals = snapshot.vitals;
      // 200 = dead, 404 = alive: both are valid responses
      if (snapshot.memorial && (snapshot.memorial.ok || snapshot.memorial.notFound)) d.memorial = snapshot.memorial;
      if (snapshot.channel && snapshot.channel.ok) {
        d.channel = snapshot.channel;
        if (Array.isArray(snapshot.channel.data)) d.channelEntries = snapshot.channel.data;
      }
      if (snapshot.ledger && snapshot.ledger.ok && typeof snapshot.ledger.text === 'string') {
        d.entries = parseLedger(snapshot.ledger.text).entries;
      }
    }
    this.meta = {
      stale: Boolean(meta.stale),
      dev: Boolean(meta.dev || this.meta.dev),
      lastRead: meta.lastRead || this.meta.lastRead,
    };
    this.view = deriveRoom(this.data, this.meta);
    this.base = paintBase(this.L, this.view.dev);
  }

  /* ------------------------------ animation ------------------------------ */

  loop(ts) {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (ts - this.lastTs < FRAME_MS) return;
    this.lastTs = ts;
    this.step(ts);
    this.render(ts);
  }

  step(ts) {
    const reduced = this.reduced.matches;
    const spot = this.desiredSpot(ts, reduced);
    const a = this.agent;
    // death and non-birth do not walk: they appear at once in their spot
    const instant = reduced || this.view.e1.state === 'dead' || this.view.e1.state === 'unborn';

    if (this.assembly.start === null) {
      this.assembly.start = reduced ? ts - ASSEMBLY_MS : ts;
    }

    const tx = spot.x;
    const ty = spot.y;
    if (a.x !== tx || a.y !== ty) {
      if (instant) {
        a.x = tx;
        a.y = ty;
      } else {
        if (a.x !== tx) a.x += Math.sign(tx - a.x);
        else a.y += Math.sign(ty - a.y);
      }
      a.moving = !instant;
      a.frame += 1;
      a.state = instant ? this.view.e1.state : 'walk';
    } else {
      a.moving = false;
      a.state = this.view.e1.state === 'ambient' ? 'idle' : this.view.e1.state;
      if (a.state === 'idle') a.frame += 1;
    }
  }

  /** Where e1 must be: if there is a real action we follow it, otherwise ambient. */
  desiredSpot(ts, reduced) {
    const v = this.view.e1;
    if (v.mode === 'real') {
      const map = {
        type: 'desk',
        sit: 'desk',
        read: 'read',
        rest: 'rest',
        unborn: 'center',
        dead: 'door',
        walk: 'vault',
      };
      const key = map[v.state] || 'center';
      return this.L.spots[key] || this.L.spots.desk;
    }
    // ambient
    if (reduced) return this.L.spots.desk;
    if (ts >= this.ambient.nextAt) {
      this.ambient.index = (this.ambient.index + 1) % 5;
      this.ambient.nextAt = ts + AMBIENT_MS;
    }
    const order = ['desk', 'window', 'read', 'center', 'pace'];
    const pick = order[this.ambient.index];
    if (pick === 'pace') {
      const step = (this.ambient.index + 1) * 7;
      const x = this.L.corridor.x0 + (step % Math.max(1, this.L.corridor.x1 - this.L.corridor.x0));
      return { x, y: this.L.corridor.y };
    }
    return this.L.spots[pick] || this.L.spots.desk;
  }

  /* ------------------------------ drawing ------------------------------ */

  render(ts) {
    const g = cloneGrid(this.base);
    this.drawDeskActivity(g);
    this.drawEntity(g, ts);
    if (this.view.stale) {
      const note = '(stale data)';
      g.put(2, this.L.h - 1, note, 'err');
    }
    this.pre.replaceChildren(this.gridFragment(g));
    this.updateMeta();
  }

  drawDeskActivity(g) {
    const a = this.agent;
    const desk = this.L.desk1;
    const atDesk = a.x === this.L.spots.desk.x && a.y === this.L.spots.desk.y;
    const screenX = desk.x + 2;
    const screenY = desk.y + 1;
    if (atDesk && (this.view.e1.state === 'type' || this.view.e1.state === 'sit' || a.state === 'sit' || a.state === 'type')) {
      const typing = this.view.e1.state === 'type' && this.view.e1.real && this.view.e1.real.deep;
      const blink = Math.floor(a.frame / 2) % 2 === 0;
      const fast = this.view.e1.state === 'type' && this.view.e1.real && !this.view.e1.real.deep;
      if (this.reduced.matches) {
        g.put(screenX, screenY, typing ? '>_' : '...', 'acc');
      } else if (typing) {
        g.put(screenX, screenY, blink ? '>_' : '...', 'acc');
      } else if (fast) {
        g.put(screenX, screenY, blink ? '>>' : '..', 'acc');
      } else {
        g.put(screenX, screenY, blink ? '>_' : '  ', 'acc');
      }
    }
  }

  drawEntity(g, ts) {
    const v = this.view.e1;
    const a = this.agent;
    if (v.state === 'dead') {
      this.putSprite(g, a.x, a.y, [' ___', '[RIP]', '▀▀▀▀▀'], 'dim', ts);
      const label = `† ${truncate(this.view.name, 16)}`;
      g.put(a.x, a.y - 1, label, 'dim');
      return;
    }

    let cls = v.mode === 'real' ? 'acc' : 'fg';
    let state = a.state;
    if (state === 'idle') state = 'sit';
    if (v.mode === 'real' && ['type', 'read', 'rest', 'sit'].includes(v.state)) state = v.state;

    const lines = bodyLines(headOf('e1'), state, a.frame);
    if (v.mode === 'real' && v.state === 'unborn') cls = 'dim';

    // name line above the head (left to the speech bubble when speaking)
    const tag = `▸ ${truncate(this.view.name, 12)}`;
    if (!v.bubble) {
      g.put(a.x, a.y - 1, tag, 'dim');
      if (v.hunger) g.put(a.x + tag.length + 1, a.y - 1, '!', 'acc');
    }

    // envelope on the desk
    if (v.envelope) {
      const desk = this.L.desk1;
      const blink = this.reduced.matches || Math.floor(a.frame / 3) % 2 === 0;
      if (blink) g.put(desk.x + 2, desk.y + 3, '[✉]', 'acc');
    }

    this.putSprite(g, a.x, a.y, lines, cls, ts);

    // unborn: the sign next to the dotted body
    if (v.state === 'unborn') g.put(a.x, a.y + 3, 'waiting for the gift', 'dim');

    // speech bubble with the real text, beside the body
    if (v.bubble) this.drawBubble(g, a.x + 5, a.y - 1, v.bubble);

    // interaction: '~' line between the two if both are present (never today)
    if (state === 'interact') g.put(a.x + 4, a.y + 1, '~', 'dim');
  }

  drawBubble(g, x, y, text) {
    const max = this.L.name === 'compact' ? 22 : 30;
    const lines = wrapText(text, max);
    const width = Math.max(...lines.map((line) => line.length));
    const dash = '─'.repeat(width);
    g.put(x, y, `╭${dash}╮`, 'acc');
    lines.forEach((line, i) => {
      g.put(x, y + 1 + i, `│${line.padEnd(width)}│`, 'acc');
    });
    g.put(x, y + 1 + lines.length, `╰${dash}╯`, 'acc');
  }

  putSprite(g, x, y, lines, cls, ts) {
    const reduced = this.reduced.matches;
    const t = reduced ? 1 : Math.min(1, (ts - this.assembly.start) / ASSEMBLY_MS);
    for (let j = 0; j < lines.length; j += 1) {
      let i = 0;
      for (const ch of lines[j]) {
        const cx = x + i;
        const cy = y + j;
        i += 1;
        if (ch === ' ') continue;
        let out = ch;
        if (t < 1) {
          const key = cy * 1000 + cx;
          let thr = this.assembly.cells.get(key);
          if (thr === undefined) {
            thr = Math.random();
            this.assembly.cells.set(key, thr);
          }
          if (thr > t) out = randChar();
        }
        g.set(cx, cy, out, cls);
      }
    }
  }

  gridFragment(g) {
    const frag = document.createDocumentFragment();
    for (let y = 0; y < g.h; y += 1) {
      let run = '';
      let runCls = null;
      const flush = () => {
        if (!run) return;
        if (runCls) {
          const span = document.createElement('span');
          span.className = runCls;
          span.textContent = run;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(run));
        }
        run = '';
      };
      for (let x = 0; x < g.w; x += 1) {
        const cell = g.cells[y][x];
        if (cell.cls !== runCls) {
          flush();
          runCls = cell.cls;
        }
        run += cell.ch;
      }
      flush();
      if (y < g.h - 1) frag.appendChild(document.createTextNode('\n'));
    }
    return frag;
  }

  updateMeta() {
    const readAt = clockTime(this.meta.lastRead);
    const t = this.view.ticker;
    const sig = [
      this.view.name,
      this.view.e1.state,
      this.view.e1.mode,
      t.text,
      this.meta.stale ? '1' : '0',
      this.meta.dev ? '1' : '0',
      this.meta.lastRead instanceof Date ? this.meta.lastRead.getTime() : '',
    ].join('|');
    if (sig === this.metaSig) return;
    this.metaSig = sig;

    const legendParts = [
      el('span', { class: 'dim', text: '~ ambient' }),
      textNode(' · '),
      el('span', { class: 'acc', text: '[real]' }),
      textNode(' · '),
      el('span', { class: 'dim', text: 'e2: not yet online' }),
    ];
    if (readAt) {
      legendParts.push(textNode(' · '));
      legendParts.push(el('span', { class: 'dim', text: `read at ${readAt}` }));
    }
    this.legend.replaceChildren(...legendParts);

    this.ticker.replaceChildren(el('span', { class: t.real ? 'acc' : 'dim', text: t.text }));

    this.pre.setAttribute('aria-label', this.describe());
  }

  describe() {
    const v = this.view.e1;
    const where = {
      desk: 'sits at the terminal',
      read: 'reads at the ledger',
      window: 'looks out of the window',
      center: 'stands in the middle of the room',
      rest: 'rests on the bed',
      walk: 'walks',
      sit: 'sits',
      type: 'writes at the terminal',
      unborn: 'is not yet born',
      dead: 'is no longer here',
      ambient: 'moves around the room',
    }[v.state] || 'is in the room';
    return [
      `ASCII room, ${this.L.w} columns.`,
      `Entity 1, ${this.view.name}, ${v.state === 'dead' ? 'dead' : 'alive'}: ${where}.`,
      v.mode === 'real' ? 'Real action from data.' : 'Ambient movement, decorative.',
      'Entity 2 is not deployed: its desk is empty.',
    ].join(' ');
  }

  destroy() {
    this.destroyed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.compact.removeEventListener('change', this.onResize);
    this.reduced.removeEventListener('change', this.onResize);
    this.host.replaceChildren();
  }
}
