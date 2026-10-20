/*
 * room.js — the ASCII room, the entity sprites and the animation.
 *
 * The room is a grid of characters. Two layers, visibly distinct:
 *   - ambient: walking, sitting, looking outside; purely decorative (~ ambient);
 *   - real: mapped from data (/vitals, /ledger, /public-channel); every line carries [real].
 * Entity 1 is always present. Entity 2 appears as soon as it has a base
 * (discovered through Entity 1's `peer`, or forced with ?base2=): before that
 * its desk stays empty and no body is drawn. Nothing is invented.
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
      desk2: { x: 47, y: 5 },
      read: { x: 4, y: 7 },
      read2: { x: 18, y: 7 },
      window: { x: 62, y: 7 },
      center: { x: 30, y: 14 },
      center2: { x: 46, y: 14 },
      rest: { x: 60, y: 17 },
      rest2: { x: 67, y: 17 },
      vault: { x: 3, y: 13 },
      door: { x: 34, y: 14 },
      walk2: { x: 56, y: 14 },
      dead2: { x: 50, y: 14 },
      face1: { x: 18, y: 15 },
      face2: { x: 44, y: 15 },
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
      desk2: { x: 30, y: 5 },
      read: { x: 1, y: 7 },
      read2: { x: 15, y: 7 },
      window: { x: 38, y: 7 },
      center: { x: 20, y: 14 },
      center2: { x: 33, y: 14 },
      rest: { x: 28, y: 18 },
      rest2: { x: 35, y: 18 },
      vault: { x: 2, y: 14 },
      door: { x: 18, y: 16 },
      walk2: { x: 31, y: 14 },
      dead2: { x: 26, y: 14 },
      face1: { x: 14, y: 15 },
      face2: { x: 29, y: 15 },
    },
  },
};

const RANDOM_CHARS = '░▒▓█#$%@&*+=~<>/\\|_-.:;0123456789';
const ASSEMBLY_MS = 1500;
const FRAME_MS = 130;
const AMBIENT_MS = 7000;
const INTERACT_MS = 10000;

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

function paintBase(L, dev, e2Online = false) {
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
  g.block(L.desk2.x, L.desk2.y, B.desk, e2Online ? 'fg' : 'dim');
  // Entity 2's screen is off until it is typing there.
  g.put(L.screen2.x, L.screen2.y, '  ', 'dim');
  if (!e2Online) g.put(L.sign2.x, L.sign2.y, '[absent · waiting]', 'dim');
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

function emptyData() {
  return {
    root: null,
    vitals: null,
    memory: null,
    channel: null,
    entries: [],
    channelEntries: [],
    memorial: null,
  };
}

/**
 * One entity's drawable state, from its own snapshot only.
 * Pure: does not touch the DOM and never invents data.
 */
function deriveEntity(data, id, online) {
  const out = {
    id,
    online: Boolean(online),
    known: false,
    name: 'unnamed',
    state: 'ambient',
    life: 'alive',
    alive: false,
    mode: 'ambient',
    real: null,
    bubble: null,
    envelope: false,
    hunger: false,
    ticker: null,
    eventAt: 0,
  };
  if (!data) return out;

  const root = data.root;
  const vitals = data.vitals;
  const memory = data.memory;
  const hasData = Boolean(
    (root && root.ok)
    || (vitals && vitals.ok)
    || (memory && memory.ok)
    || (data.channel && data.channel.ok)
    || (Array.isArray(data.entries) && data.entries.length),
  );
  if (!out.online || !hasData) return out;
  out.known = true;

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
  let sleepUntil = null;
  let hunger = false;

  if (dead) {
    out.life = 'dead';
  } else if (vitals && vitals.ok && vitals.data) {
    const v = vitals.data;
    if (v.state === 'unborn') out.life = 'unborn';
    else if (v.state === 'dead') out.life = 'dead';
    else if (isFuture(v.sleepUntil)) {
      out.life = 'sleeping';
      sleepUntil = v.sleepUntil;
    } else {
      out.life = 'alive';
    }
    hunger = v.hunger === 'hungry';
  }
  out.alive = out.life === 'alive';
  out.hunger = hunger;

  // real action from this entity's ledger: the last useful entry within the window
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

  // the spoken thought (public ledger entry `thought`): shown as a dim bubble, "thinks aloud"
  const spoken = lastEntryOf(entries, ['thought']);
  if (spoken && entryAge(spoken) <= TICK_WINDOW_MS) {
    const d = spoken.data && typeof spoken.data === 'object' ? spoken.data : {};
    candidates.push({ at: spoken.ts, kind: 'speak', aloud: true, text: stringOf(d.text) });
  }

  const human = lastEntryOf(entries, ['human_message']);
  if (human && entryAge(human) <= TICK_WINDOW_MS) candidates.push({ at: human.ts, kind: 'envelope' });

  candidates.sort((a, b) => entryAge(a) - entryAge(b));
  const real = candidates[0] || null;

  // priority: death > unborn > sleeping > real action > hunger > ambient
  if (out.life === 'dead') {
    out.state = 'dead';
    out.mode = 'real';
    out.ticker = { text: `${id}: dead · [RIP] in the memorial [real]`, real: true };
    return out;
  }
  if (out.life === 'unborn') {
    out.state = 'unborn';
    out.mode = 'real';
    out.ticker = { text: `${id}: not yet born · waiting for the gift [real]`, real: true };
    return out;
  }
  if (out.life === 'sleeping') {
    out.state = 'rest';
    out.mode = 'real';
    const until = hhmm(sleepUntil) || '—';
    out.ticker = { text: `${hhmm(Date.now())} ${id} sleeps (until ${until}) [real]`, real: true };
    return out;
  }

  if (real && real.kind === 'think') {
    out.state = 'type';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    const bits = [real.deep ? 'deep' : 'fast'];
    if (real.tokens !== null) bits.push(`${formatInt(real.tokens)} tokens`);
    if (real.cost !== null) bits.push(`${formatDecimal(real.cost, 3)} TAZ`);
    out.ticker = {
      text: `${hhmm(real.at) || '—'} ${id} thinks (${bits.join(', ')}) [real]`,
      real: true,
    };
    return out;
  }
  if (real && real.kind === 'read') {
    out.state = 'read';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    out.ticker = { text: `${hhmm(real.at) || '—'} ${id} reads (tool read_url) [real]`, real: true };
    return out;
  }
  if (real && real.kind === 'speak') {
    out.state = 'sit';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    out.bubble = real.text ? truncate(real.text, 60) : '';
    out.ticker = {
      text: `${hhmm(real.at) || '—'} ${id} ${real.aloud ? 'thinks aloud' : 'says'}: ${truncate(real.text || '(text unavailable)', 60)} [real]`,
      real: true,
    };
    return out;
  }
  if (real && real.kind === 'envelope') {
    out.state = 'sit';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    out.envelope = true;
    out.ticker = { text: `${hhmm(real.at) || '—'} ${id} received a human message [✉] [real]`, real: true };
    return out;
  }

  if (hunger) {
    out.state = 'walk';
    out.mode = 'real';
    out.hunger = true;
    out.ticker = { text: `${hhmm(Date.now())} ${id} is hungry · looking for gifts [real]`, real: true };
    return out;
  }

  // nothing real: ambient behaviour, declared as such
  out.state = 'ambient';
  out.mode = 'ambient';
  out.ticker = { text: `~ ambient · ${id} walks around the room`, real: false };
  return out;
}

function latestEntityPost(data) {
  if (!data || !Array.isArray(data.channelEntries)) return null;
  for (let i = data.channelEntries.length - 1; i >= 0; i -= 1) {
    const message = data.channelEntries[i];
    if (message && message.from === 'entity') return message;
  }
  return null;
}

function mentions(post, name) {
  const target = stringOf(name).trim();
  if (!post || target.length < 2 || target.toLowerCase() === 'unnamed') return false;
  return stringOf(post.text).toLowerCase().includes(target.toLowerCase());
}

/**
 * Translates both snapshots into drawable state. Pure: does not touch the DOM.
 * Returns { dev, stale, e1, e2, ticker, interaction }.
 */
export function deriveRoom(data, meta = {}) {
  const source = data || {};
  const online = meta.online || {};
  const e1 = deriveEntity(source.e1, 'e1', online.e1 !== false);
  const e2 = deriveEntity(source.e2, 'e2', Boolean(online.e2));

  const out = {
    dev: Boolean(meta.dev),
    stale: Boolean(meta.stale),
    lastRead: meta.lastRead || null,
    e1,
    e2,
    ticker: { text: '~ ambient · the room is quiet', real: false },
    interaction: null,
  };

  // The ticker carries the most recent REAL action of either entity.
  const real = [e1, e2].filter((item) => item.online && item.known && item.mode === 'real');
  if (real.length) {
    real.sort((a, b) => (b.eventAt || 0) - (a.eventAt || 0));
    out.ticker = real[0].ticker;
  } else {
    const known = [e1, e2].filter((item) => item.online && item.known);
    if (known.length === 2) {
      out.ticker = { text: '~ ambient · e1 and e2 move around the room', real: false };
    } else if (known.length === 1) {
      out.ticker = known[0].ticker || { text: `~ ambient · ${known[0].id} walks around the room`, real: false };
    }
  }

  // Both alive and one's latest public post names the other: they face each other.
  if (e1.alive && e2.alive && e1.known && e2.known) {
    const post1 = latestEntityPost(source.e1);
    const post2 = latestEntityPost(source.e2);
    const found = [];
    if (mentions(post1, e2.name)) found.push({ by: 'e1', post: post1 });
    if (mentions(post2, e1.name)) found.push({ by: 'e2', post: post2 });
    if (found.length) {
      found.sort((a, b) => (Date.parse(b.post.ts) || 0) - (Date.parse(a.post.ts) || 0));
      const winner = found[0];
      const post = winner.post;
      const seq = post.seq !== undefined && post.seq !== null ? post.seq : (post.ts || '');
      out.interaction = {
        key: `${winner.by}:${seq}:${stringOf(post.text).slice(0, 40)}`,
        by: winner.by,
        at: Date.parse(post.ts) || 0,
        text: stringOf(post.text),
      };
    }
  }

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

    this.data = { e1: emptyData(), e2: emptyData() };
    this.meta = { stale: false, dev: false, lastRead: null, online: { e1: true, e2: false } };
    this.view = deriveRoom(this.data, this.meta);

    this.agents = {
      e1: { x: 0, y: 0, state: 'alive', frame: 0, moving: false },
      e2: { x: 0, y: 0, state: 'alive', frame: 0, moving: false },
    };
    this.assembly = { start: null, cells: new Map() };
    this.ambient = {
      e1: { index: 0, nextAt: 0 },
      e2: { index: 1, nextAt: 1500 },
    };
    this.interactionUntil = 0;
    this.interactionKey = null;

    this.raf = null;
    this.lastTs = 0;
    this.destroyed = false;

    this.buildDom();
    this.base = paintBase(this.L, this.view.dev, this.view.e2.online);
    this.resetAgents();
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
    this.base = paintBase(this.L, this.view.dev, this.view.e2.online);
    this.resetAgents();
    this.render(this.lastTs);
  }

  resetAgents() {
    this.resetAgent('e1');
    this.resetAgent('e2');
    this.assembly.start = null;
    this.assembly.cells.clear();
  }

  resetAgent(id) {
    const spot = this.L.spots[id === 'e1' ? 'desk' : 'desk2'] || this.L.spots.desk;
    const a = this.agents[id];
    a.x = spot.x;
    a.y = spot.y;
    a.state = this.view[id].state;
    a.frame = 0;
    a.moving = false;
  }

  /** Absorbs the snapshots: keeps each entity's last known state if a read fails. */
  ingest(snapshots, meta = {}) {
    if (snapshots) {
      this.mergeInto(this.data.e1, snapshots.e1);
      this.mergeInto(this.data.e2, snapshots.e2);
    }
    this.meta = {
      stale: Boolean(meta.stale),
      dev: Boolean(meta.dev || this.meta.dev),
      lastRead: meta.lastRead || this.meta.lastRead,
      online: meta.online || this.meta.online,
    };
    this.view = deriveRoom(this.data, this.meta);
    this.base = paintBase(this.L, this.view.dev, this.view.e2.online);
    this.checkInteraction();
  }

  mergeInto(target, snapshot) {
    if (!snapshot) return;
    if (snapshot.root && snapshot.root.ok) target.root = snapshot.root;
    if (snapshot.memory && snapshot.memory.ok) target.memory = snapshot.memory;
    if (snapshot.vitals && snapshot.vitals.ok) target.vitals = snapshot.vitals;
    // 200 = dead, 404 = alive: both are valid responses
    if (snapshot.memorial && (snapshot.memorial.ok || snapshot.memorial.notFound)) target.memorial = snapshot.memorial;
    if (snapshot.channel && snapshot.channel.ok) {
      target.channel = snapshot.channel;
      if (Array.isArray(snapshot.channel.data)) target.channelEntries = snapshot.channel.data;
    }
    if (snapshot.ledger && snapshot.ledger.ok && typeof snapshot.ledger.text === 'string') {
      target.entries = parseLedger(snapshot.ledger.text).entries;
    }
  }

  /** A new post that names the other entity starts a 10 s face-to-face scene. */
  checkInteraction() {
    const candidate = this.view.interaction;
    if (!candidate) {
      this.interactionUntil = 0;
      this.interactionKey = null;
      return;
    }
    if (candidate.key !== this.interactionKey) {
      this.interactionKey = candidate.key;
      this.interactionUntil = Date.now() + INTERACT_MS;
    }
  }

  isInteracting() {
    return Boolean(
      this.interactionUntil > Date.now()
      && this.view.e1.alive
      && this.view.e2.alive
      && this.view.e2.online,
    );
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
    if (this.assembly.start === null) {
      this.assembly.start = reduced ? ts - ASSEMBLY_MS : ts;
    }
    this.stepAgent('e1', ts, reduced);
    this.stepAgent('e2', ts, reduced);
  }

  stepAgent(id, ts, reduced) {
    const v = this.view[id];
    if (!v.online || !v.known) return;
    const a = this.agents[id];
    const spot = this.desiredSpot(id, ts, reduced);
    const interacting = this.isInteracting();
    // death and non-birth do not walk: they appear at once in their spot
    const instant = reduced || v.state === 'dead' || v.state === 'unborn' || interacting;

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
      a.state = instant ? (interacting ? 'interact' : v.state) : 'walk';
    } else {
      a.moving = false;
      if (interacting) a.state = 'interact';
      else a.state = v.state === 'ambient' ? 'idle' : v.state;
      if (a.state === 'idle') a.frame += 1;
    }
  }

  /** Where an entity must be: a real action, the interaction, or ambient. */
  desiredSpot(id, ts, reduced) {
    const v = this.view[id];
    if (this.isInteracting()) {
      return this.L.spots[id === 'e1' ? 'face1' : 'face2'] || this.L.spots.center;
    }
    if (v.mode === 'real') {
      const maps = {
        e1: {
          type: 'desk',
          sit: 'desk',
          read: 'read',
          rest: 'rest',
          unborn: 'center',
          dead: 'door',
          walk: 'vault',
        },
        e2: {
          type: 'desk2',
          sit: 'desk2',
          read: 'read2',
          rest: 'rest2',
          unborn: 'desk2',
          dead: 'dead2',
          walk: 'walk2',
        },
      };
      const key = maps[id][v.state] || (id === 'e1' ? 'center' : 'desk2');
      return this.L.spots[key] || this.L.spots.desk;
    }
    // ambient
    if (reduced) return this.L.spots[id === 'e1' ? 'desk' : 'desk2'];
    const amb = this.ambient[id];
    if (ts >= amb.nextAt) {
      amb.index = (amb.index + 1) % 5;
      amb.nextAt = ts + AMBIENT_MS;
    }
    const orders = {
      e1: ['desk', 'window', 'read', 'center', 'pace'],
      e2: ['desk2', 'read2', 'center2', 'walk2', 'pace'],
    };
    const pick = orders[id][amb.index];
    if (pick === 'pace') {
      const offset = id === 'e2' ? 11 : 0;
      const step = (amb.index + 1) * 7 + offset;
      const x = this.L.corridor.x0 + (step % Math.max(1, this.L.corridor.x1 - this.L.corridor.x0));
      return { x, y: this.L.corridor.y };
    }
    return this.L.spots[pick] || this.L.spots[id === 'e1' ? 'desk' : 'desk2'];
  }

  /* ------------------------------ drawing ------------------------------ */

  render(ts) {
    const g = cloneGrid(this.base);
    this.drawDeskActivity(g, 'e1');
    this.drawDeskActivity(g, 'e2');
    this.drawEntity(g, ts, 'e1');
    this.drawEntity(g, ts, 'e2');
    if (this.isInteracting()) this.drawInteraction(g);
    if (this.view.stale) {
      const note = '(stale data)';
      g.put(2, this.L.h - 1, note, 'err');
    }
    this.pre.replaceChildren(this.gridFragment(g));
    this.updateMeta();
  }

  drawDeskActivity(g, id) {
    const v = this.view[id];
    if (!v.online || !v.known) return;
    const a = this.agents[id];
    const desk = id === 'e1' ? this.L.desk1 : this.L.desk2;
    const spot = this.L.spots[id === 'e1' ? 'desk' : 'desk2'];
    const atDesk = spot && a.x === spot.x && a.y === spot.y;
    const screenX = desk.x + 2;
    const screenY = desk.y + 1;
    if (atDesk && (v.state === 'type' || v.state === 'sit' || a.state === 'sit' || a.state === 'type')) {
      const typing = v.state === 'type' && v.real && v.real.deep;
      const blink = Math.floor(a.frame / 2) % 2 === 0;
      const fast = v.state === 'type' && v.real && !v.real.deep;
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

  drawEntity(g, ts, id) {
    const v = this.view[id];
    if (!v.online || !v.known) return;
    const a = this.agents[id];
    const interacting = this.isInteracting();
    if (v.state === 'dead') {
      this.putSprite(g, a.x, a.y, [' ___', '[RIP]', '▀▀▀▀▀'], 'dim', ts);
      const label = `† ${truncate(v.name, 16)}`;
      g.put(a.x, a.y - 1, label, 'dim');
      return;
    }

    let cls = v.mode === 'real' ? 'acc' : 'fg';
    let state = a.state;
    if (state === 'idle') state = 'sit';
    if (v.mode === 'real' && ['type', 'read', 'rest', 'sit'].includes(v.state) && !interacting) state = v.state;
    if (interacting) state = 'interact';

    const lines = bodyLines(headOf(id), state, a.frame);
    if (v.mode === 'real' && v.state === 'unborn') cls = 'dim';

    // name line above the head (left to the speech bubble when speaking)
    const tag = `▸ ${truncate(v.name, 12)}`;
    if (!v.bubble || interacting) {
      g.put(a.x, a.y - 1, tag, 'dim');
      if (v.hunger) g.put(a.x + tag.length + 1, a.y - 1, '!', 'acc');
    }

    // envelope on its own desk
    if (v.envelope) {
      const desk = id === 'e1' ? this.L.desk1 : this.L.desk2;
      const blink = this.reduced.matches || Math.floor(a.frame / 3) % 2 === 0;
      if (blink) g.put(desk.x + 2, desk.y + 3, '[✉]', 'acc');
    }

    this.putSprite(g, a.x, a.y, lines, cls, ts);

    // unborn: dotted outline with the waiting sign
    if (v.state === 'unborn') {
      if (id === 'e2') g.put(this.L.sign2.x, this.L.sign2.y, 'waiting for the birth gift', 'dim');
      else g.put(a.x, a.y + 3, 'waiting for the gift', 'dim');
    }

    // speech bubble with the real text, beside the body
    if (v.bubble && !interacting) {
      this.drawBubble(g, a.x, a.y - 1, v.bubble, id === 'e2' ? 'left' : 'right');
    }
  }

  drawInteraction(g) {
    const a = this.agents.e1;
    const b = this.agents.e2;
    const y = Math.min(a.y, b.y) + 1;
    const from = Math.min(a.x, b.x) + 4;
    const to = Math.max(a.x, b.x) - 1;
    if (to >= from) g.put(from, y, '~'.repeat(to - from + 1), 'dim');
  }

  drawBubble(g, x, y, text, preferred = 'right') {
    const max = this.L.name === 'compact' ? 22 : 30;
    const lines = wrapText(text, max);
    const width = Math.max(...lines.map((line) => line.length));
    const dash = '─'.repeat(width);
    let bx = preferred === 'left' ? x - width - 2 : x + 5;
    if (bx < 1) bx = x + 5;
    if (bx + width + 2 > g.w) bx = x - width - 2;
    if (bx < 1) bx = 1;
    g.put(bx, y, `╭${dash}╮`, 'acc');
    lines.forEach((line, i) => {
      g.put(bx, y + 1 + i, `│${line.padEnd(width)}│`, 'acc');
    });
    g.put(bx, y + 1 + lines.length, `╰${dash}╯`, 'acc');
  }

  /** Glitch: now and then (and whenever a real action starts) a sprite breaks into @#$%&* for a moment, then
   *  settles again. Purely visual; never when the visitor prefers reduced motion. */
  glitchLevel(ts, spriteKey) {
    if (this.reduced.matches) return 0;
    if (!this.glitch) this.glitch = new Map();
    let gl = this.glitch.get(spriteKey);
    if (!gl) { gl = { until: 0, nextAt: ts + 2000 + Math.random() * 6000 }; this.glitch.set(spriteKey, gl); }
    if (ts >= gl.nextAt) { gl.until = ts + 250 + Math.random() * 400; gl.nextAt = ts + 5000 + Math.random() * 9000; }
    if (ts < gl.until) return 0.35 + 0.4 * Math.random();
    return 0;
  }

  /** Called when a real action changes: the sprite glitches right away. */
  triggerGlitch(spriteKey, ts = performance.now()) {
    if (!this.glitch) this.glitch = new Map();
    const gl = this.glitch.get(spriteKey) || { until: 0, nextAt: ts + 5000 };
    gl.until = ts + 500; this.glitch.set(spriteKey, gl);
  }

  putSprite(g, x, y, lines, cls, ts, spriteKey = `${x}:${y}`) {
    const reduced = this.reduced.matches;
    const t = reduced ? 1 : Math.min(1, (ts - this.assembly.start) / ASSEMBLY_MS);
    const glitch = t >= 1 ? this.glitchLevel(ts, spriteKey) : 0;
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
        if (glitch && Math.random() < glitch) out = randChar();
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
    const interacting = this.isInteracting();
    const t = interacting
      ? { text: '~ ambient · e1 and e2 face each other, a ~ line between them', real: false }
      : this.view.ticker;
    const sig = [
      this.view.e1.name,
      this.view.e1.state,
      this.view.e1.mode,
      this.view.e2.name,
      this.view.e2.state,
      this.view.e2.mode,
      this.view.e2.online ? '1' : '0',
      this.view.e2.known ? '1' : '0',
      t.text,
      interacting ? '1' : '0',
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
    ];
    if (!this.view.e2.online) {
      legendParts.push(textNode(' · '));
      legendParts.push(el('span', { class: 'dim', text: 'e2: not yet online' }));
    }
    if (interacting) {
      legendParts.push(textNode(' · '));
      legendParts.push(el('span', { class: 'dim', text: '~ facing each other' }));
    }
    if (readAt) {
      legendParts.push(textNode(' · '));
      legendParts.push(el('span', { class: 'dim', text: `read at ${readAt}` }));
    }
    this.legend.replaceChildren(...legendParts);

    this.ticker.replaceChildren(el('span', { class: t.real ? 'acc' : 'dim', text: t.text }));

    this.pre.setAttribute('aria-label', this.describe());
  }

  describe() {
    const whereOf = (v) => ({
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
      interact: 'faces the other entity',
      ambient: 'moves around the room',
    }[v.state] || 'is in the room');
    const stateOf = (v) => {
      if (v.life === 'dead') return 'dead';
      if (v.life === 'unborn') return 'not yet born';
      if (v.life === 'sleeping') return 'sleeping';
      return 'alive';
    };

    const parts = [`ASCII room, ${this.L.w} columns.`];
    for (const id of ['e1', 'e2']) {
      const v = this.view[id];
      const label = id === 'e1' ? 'Entity 1' : 'Entity 2';
      if (!v.online) {
        if (id === 'e2') parts.push('Entity 2 is not deployed: its desk is empty.');
        continue;
      }
      if (!v.known) {
        parts.push(`${label} is online; no data read yet.`);
        continue;
      }
      parts.push(`${label}, ${v.name}, ${stateOf(v)}: ${whereOf(v)}.`);
      parts.push(v.mode === 'real' ? 'Real action from data.' : 'Ambient movement, decorative.');
    }
    if (this.isInteracting()) parts.push('They face each other, with a ~ line between them.');
    return parts.join(' ');
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
