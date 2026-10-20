/*
 * room.js — the ASCII room, the entity sprites and the animation.
 *
 * The room is a grid of characters. Two layers, visibly distinct:
 *   - ambient: walking, sitting, looking outside; purely decorative (~ ambient);
 *   - real: mapped from data (/vitals, /ledger, /public-channel); every line carries [real].
 * Entity 1 is always present. Entity 2 appears as soon as it has a base
 * (discovered through Entity 1's `peer`, or forced with ?base2=): before that
 * its desk stays empty and no body is drawn. Entities found through `lineage`
 * (e3..e6) get their own desk and sprite in discovery order. Nothing is invented.
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
  formatZats,
  endpointKey,
  shortUrl,
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
  deskCompact: [
    '┌────┐',
    '│ >_ │',
    '├────┤',
    '│▒▒▒▒│',
    '└────┘',
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

/*
 * Two desk rows of up to three desks each (contract: 3 top, 3 second row).
 * Wide desks are 8 columns, compact desks 6 columns (48-column layout).
 * A sprite is 3 lines tall and sits 3 rows above its desk, name one row above.
 */
const LAYOUTS = {
  wide: {
    name: 'wide',
    w: 80,
    h: 32,
    shelf: { x: 2, y: 2 },
    window: { x: 66, y: 2 },
    vault: { x: 2, y: 27 },
    bed: { x: 58, y: 27 },
    door: { x: 36, y: 26 },
    deskRows: [
      { y: 11, xs: [7, 33, 59] },
      { y: 21, xs: [7, 33, 59] },
    ],
    deskWidth: 8,
    floorTop: 15,
    floorBottom: 30,
    corridor: { x0: 5, x1: 76, y: 16 },
    spots: {
      read: { x: 3, y: 13 },
      window: { x: 72, y: 12 },
      center: { x: 26, y: 16 },
      center2: { x: 46, y: 16 },
      rest: { x: 60, y: 28 },
      rest2: { x: 68, y: 28 },
      vault: { x: 3, y: 26 },
      door: { x: 36, y: 25 },
      face1: { x: 28, y: 16 },
      face2: { x: 44, y: 16 },
    },
  },
  compact: {
    name: 'compact',
    w: 48,
    h: 32,
    shelf: { x: 1, y: 2 },
    window: { x: 34, y: 2 },
    vault: { x: 1, y: 27 },
    bed: { x: 27, y: 27 },
    door: { x: 18, y: 26 },
    deskRows: [
      { y: 11, xs: [5, 22, 38] },
      { y: 21, xs: [5, 22, 38] },
    ],
    deskWidth: 6,
    floorTop: 15,
    floorBottom: 30,
    corridor: { x0: 4, x1: 44, y: 16 },
    spots: {
      read: { x: 2, y: 17 },
      window: { x: 44, y: 12 },
      center: { x: 14, y: 16 },
      center2: { x: 31, y: 16 },
      rest: { x: 29, y: 28 },
      rest2: { x: 34, y: 28 },
      vault: { x: 2, y: 26 },
      door: { x: 18, y: 25 },
      face1: { x: 13, y: 17 },
      face2: { x: 28, y: 17 },
    },
  },
};

const DEFAULT_ROSTER = [
  { id: 'e1', base: null },
  { id: 'e2', base: null },
];

const RANDOM_CHARS = '░▒▓█#$%@&*+=~<>/\\|_-.:;0123456789';
const ASSEMBLY_MS = 1500;
const FRAME_MS = 130;
const AMBIENT_MS = 7000;
const INTERACT_MS = 10000;
const WHISPER_WINDOW_MS = 2 * 60 * 1000;
const LETTER_WINDOW_MS = 2 * 60 * 1000;
const LETTER_READ_MS = 20000;
const BIRTH_WINDOW_MS = 10 * 60 * 1000;
const MAX_BUBBLES = 2;
const SPARK_MS = 1500;
const SPARK_FLASH_MS = 1200;

function randChar() {
  return RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
}

/* ------------------------------------------------------------------ */
/* Sprite                                                              */
/* ------------------------------------------------------------------ */

function numberIn(id) {
  const n = Number.parseInt(String(id).replace(/^e/i, ''), 10);
  return Number.isFinite(n) ? n : 1;
}

function headOf(entityId) {
  return `(${numberIn(entityId)})`;
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
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

function deskAt(L, index) {
  const i = Math.max(0, Math.min(5, Number.isFinite(index) ? index : 0));
  const row = L.deskRows[Math.min(L.deskRows.length - 1, Math.floor(i / 3))];
  const x = row.xs[i % 3];
  return { x, y: row.y };
}

function deskBlockOf(L) {
  return L.deskWidth <= 6 ? B.deskCompact : B.desk;
}

function deskSpotAt(L, index) {
  const desk = deskAt(L, index);
  return { x: desk.x + 2, y: desk.y - 3 };
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

function paintBase(L, dev, roster, online) {
  const g = new Grid(L.w, L.h);
  drawBorder(g, L, dev);
  fillFloor(g, L);
  g.block(L.shelf.x, L.shelf.y, B.shelf, 'dim');
  g.block(L.window.x, L.window.y, B.window, 'dim');
  g.block(L.vault.x, L.vault.y, B.vault, 'dim');
  g.block(L.bed.x, L.bed.y, B.bed, 'dim');
  g.block(L.door.x, L.door.y, B.door, 'dim');

  const items = Array.isArray(roster) ? roster : DEFAULT_ROSTER;
  const block = deskBlockOf(L);
  const chairX = L.deskWidth <= 6 ? -3 : -3;
  for (let i = 0; i < Math.min(items.length, 6); i += 1) {
    const desk = deskAt(L, i);
    const on = Boolean(online && online[items[i].id]);
    g.block(desk.x + chairX, desk.y + 1, B.chair, 'dim');
    g.block(desk.x, desk.y, block, on ? 'fg' : 'dim');
    // the screen is off until the entity is typing there
    g.put(desk.x + 2, desk.y + 1, '  ', 'dim');
    if (!on) {
      const sign = L.deskWidth <= 6 ? '[absent]' : `[${items[i].id} · not online]`;
      g.put(desk.x, desk.y + 5, sign, 'dim');
    }
  }
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

function refLabel(url, address, ctx) {
  const key = endpointKey(url);
  const byUrl = ctx && ctx.byUrl;
  if (key && byUrl && typeof byUrl === 'object' && byUrl[key]) return byUrl[key];
  const addr = stringOf(address).trim();
  const byAddress = ctx && ctx.byAddress;
  if (addr && byAddress && typeof byAddress === 'object' && byAddress[addr]) return byAddress[addr];
  return shortUrl(url, 22);
}

function amountLabel(zats) {
  if (!Number.isFinite(zats)) return 'amount not declared';
  const coin = formatZats(zats);
  return coin === null ? 'amount not declared' : `${coin} TAZ`;
}

function bytesLabel(bytes) {
  return Number.isFinite(bytes) ? `${formatInt(bytes)} bytes` : 'bytes not declared';
}

/**
 * One entity's drawable state, from its own snapshot only.
 * Pure: does not touch the DOM and never invents data.
 */
function deriveEntity(data, id, online, ctx) {
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
    whisper: null,
    letter: null,
    birth: null,
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

  // a paid whisper: this entity PAID another one to speak to it (words shielded)
  const whisper = lastEntryOf(entries, ['whisper']);
  let whisperTicker = null;
  if (whisper && entryAge(whisper) <= WHISPER_WINDOW_MS) {
    const d = whisper.data && typeof whisper.data === 'object' ? whisper.data : {};
    const to = stringOf(d.to).trim();
    const zats = Number(d.zats);
    const bytes = Number(d.bytes);
    if (to) {
      const candidate = { at: whisper.ts, kind: 'whisper', to, zats, bytes };
      candidates.push(candidate);
      out.whisper = {
        at: whisper.ts,
        to,
        zats: Number.isFinite(zats) ? zats : null,
        bytes: Number.isFinite(bytes) ? bytes : null,
        key: `${id}:${whisper.seq !== undefined ? whisper.seq : whisper.ts}:${to}`,
      };
      whisperTicker = {
        text: `${hhmm(whisper.ts) || '—'} ${id} → ${refLabel(to, null, ctx)} whispers `
          + `(paid ${amountLabel(Number.isFinite(zats) ? zats : NaN)} · ${bytesLabel(Number.isFinite(bytes) ? bytes : NaN)}, words private) [real]`,
        real: true,
      };
    }
  }

  // a paid letter received: the envelope is public, the words are not
  const letter = lastEntryOf(entries, ['letter']);
  if (letter && entryAge(letter) <= LETTER_WINDOW_MS) {
    const d = letter.data && typeof letter.data === 'object' ? letter.data : {};
    const zats = Number(d.zats);
    const bytes = Number(d.bytes);
    const ticker = {
      text: `${hhmm(letter.ts) || '—'} ${id} receives a paid letter (words private) [real]`,
      real: true,
    };
    candidates.push({ at: letter.ts, kind: 'letter', zats, bytes });
    out.envelope = true;
    out.letter = {
      at: letter.ts,
      zats: Number.isFinite(zats) ? zats : null,
      bytes: Number.isFinite(bytes) ? bytes : null,
      key: `${id}:${letter.seq !== undefined ? letter.seq : letter.ts}`,
      ticker,
    };
  }

  // a birth: this entity gave birth to another entity (public)
  const birth = lastEntryOf(entries, ['birth_of']);
  if (birth && entryAge(birth) <= BIRTH_WINDOW_MS) {
    const d = birth.data && typeof birth.data === 'object' ? birth.data : {};
    const url = stringOf(d.url).trim();
    const address = stringOf(d.address).trim();
    const giftZats = Number(d.giftZats);
    if (url) {
      candidates.push({ at: birth.ts, kind: 'birth', url, address, giftZats });
      out.birth = {
        at: birth.ts,
        url,
        address: address || null,
        appId: stringOf(d.appId).trim() || null,
        giftZats: Number.isFinite(giftZats) ? giftZats : null,
        txid: stringOf(d.txid).trim() || null,
        key: `${id}:${birth.seq !== undefined ? birth.seq : birth.ts}:${url}`,
      };
    }
  }

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
  if (real && real.kind === 'whisper') {
    out.state = 'sit';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    out.ticker = whisperTicker;
    return out;
  }
  if (real && real.kind === 'letter') {
    out.state = 'read';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    out.envelope = true;
    out.ticker = out.letter ? out.letter.ticker : {
      text: `${hhmm(real.at) || '—'} ${id} receives a paid letter (words private) [real]`,
      real: true,
    };
    return out;
  }
  if (real && real.kind === 'birth') {
    out.state = 'sit';
    out.mode = 'real';
    out.real = real;
    out.eventAt = Date.parse(real.at) || 0;
    const gift = Number.isFinite(real.giftZats) ? `${formatZats(real.giftZats)} TAZ` : 'not declared';
    out.ticker = {
      text: `${hhmm(real.at) || '—'} ${id} gives birth: ${shortUrl(real.url, 30)} · gift ${gift} [real]`,
      real: true,
    };
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
 * Translates the snapshots into drawable state. Pure: does not touch the DOM.
 * Returns { dev, stale, roster, byId, list, ticker, interaction }.
 */
export function deriveRoom(data, meta = {}) {
  const source = data || {};
  const roster = Array.isArray(meta.roster) && meta.roster.length
    ? meta.roster.filter((item) => item && item.id)
    : DEFAULT_ROSTER;
  const online = meta.online && typeof meta.online === 'object' ? meta.online : {};
  const ctx = {
    byUrl: meta.byUrl && typeof meta.byUrl === 'object' ? meta.byUrl : {},
    byAddress: meta.byAddress && typeof meta.byAddress === 'object' ? meta.byAddress : {},
  };

  const out = {
    dev: Boolean(meta.dev),
    stale: Boolean(meta.stale),
    lastRead: meta.lastRead || null,
    roster,
    byId: {},
    list: [],
    ticker: { text: '~ ambient · the room is quiet', real: false },
    interaction: null,
  };

  for (const item of roster) {
    const isOnline = Object.prototype.hasOwnProperty.call(online, item.id)
      ? Boolean(online[item.id])
      : item.id === 'e1';
    const view = deriveEntity(source[item.id], item.id, isOnline, ctx);
    out.byId[item.id] = view;
    out.list.push(view);
  }
  out.e1 = out.byId.e1 || null;
  out.e2 = out.byId.e2 || null;

  // At most two speech bubbles at a time: with six desks, walls of text would
  // overlap and hide the room. The two most recent speakers keep theirs,
  // never two neighbours in the same desk row (their bubbles would collide).
  const speakers = out.list
    .filter((item) => item.bubble)
    .sort((a, b) => (b.eventAt || 0) - (a.eventAt || 0));
  const kept = new Set();
  const slots = new Set();
  for (const item of speakers) {
    if (kept.size >= MAX_BUBBLES) break;
    const index = roster.findIndex((entry) => entry.id === item.id);
    const row = Math.floor(index / 3);
    const col = index % 3;
    if (slots.has(`${row}:${col}`)) continue;
    if (slots.has(`${row}:${col - 1}`) || slots.has(`${row}:${col + 1}`)) continue;
    kept.add(item.id);
    slots.add(`${row}:${col}`);
  }
  for (const item of speakers) if (!kept.has(item.id)) item.bubble = null;

  // The ticker carries the most recent REAL action of any entity.
  const real = out.list.filter((item) => item.online && item.known && item.mode === 'real');
  if (real.length) {
    real.sort((a, b) => (b.eventAt || 0) - (a.eventAt || 0));
    out.ticker = real[0].ticker;
  } else {
    const known = out.list.filter((item) => item.online && item.known);
    if (known.length === 1) {
      out.ticker = known[0].ticker || { text: `~ ambient · ${known[0].id} walks around the room`, real: false };
    } else if (known.length > 1) {
      const ids = known.map((item) => item.id);
      const names = ids.length === 2
        ? `${ids[0]} and ${ids[1]}`
        : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
      out.ticker = { text: `~ ambient · ${names} move around the room`, real: false };
    }
  }

  // Both alive and one's latest public post names the other: they face each other.
  const first = out.byId.e1;
  const second = out.byId.e2;
  if (first && second && first.alive && second.alive && first.known && second.known) {
    const post1 = latestEntityPost(source.e1);
    const post2 = latestEntityPost(source.e2);
    const found = [];
    if (mentions(post1, second.name)) found.push({ by: 'e1', post: post1 });
    if (mentions(post2, first.name)) found.push({ by: 'e2', post: post2 });
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

    this.roster = DEFAULT_ROSTER.slice();
    this.online = { e1: true, e2: false };
    this.data = {};
    for (const item of this.roster) this.data[item.id] = emptyData();
    this.meta = {
      stale: false,
      dev: false,
      lastRead: null,
      online: this.online,
      roster: this.roster,
      byUrl: {},
      byAddress: {},
      lineage: {},
    };
    this.view = deriveRoom(this.data, this.meta);

    this.agents = {};
    this.ambient = {};
    this.assembly = { cells: new Map() };
    this.interactionUntil = 0;
    this.interactionKey = null;

    this.letterUntil = {};
    this.letterKeys = {};
    this.birthKeys = new Set();
    this.birthChildren = new Set();
    this.sparks = [];
    this.sparkKeys = new Set();

    this.raf = null;
    this.lastTs = 0;
    this.destroyed = false;

    this.buildDom();
    this.syncAgents();
    this.resetAgents();
    this.base = paintBase(this.L, this.view.dev, this.roster, this.online);
    this.onResize = () => {
      const wanted = this.compact.matches ? 'compact' : 'wide';
      if (wanted !== this.layoutName) this.setLayout(wanted);
    };
    this.compact.addEventListener('change', this.onResize);
    this.reduced.addEventListener('change', this.onResize);

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.render(this.lastTs);
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
    this.layoutName = LAYOUTS[name] ? name : 'wide';
    this.L = LAYOUTS[this.layoutName];
    this.base = paintBase(this.L, this.view.dev, this.roster, this.online);
    this.resetAgents();
    this.render(this.lastTs);
  }

  deskIndex(id) {
    return Math.max(0, this.roster.findIndex((item) => item.id === id));
  }

  deskOf(id) {
    return deskAt(this.L, this.deskIndex(id));
  }

  deskSpotOf(id) {
    return deskSpotAt(this.L, this.deskIndex(id));
  }

  syncAgents() {
    const ids = this.roster.map((item) => item.id);
    for (const id of ids) {
      if (!this.agents[id]) {
        const spot = deskSpotAt(this.L, this.roster.findIndex((item) => item.id === id));
        this.agents[id] = {
          x: spot.x,
          y: spot.y,
          state: 'alive',
          frame: 0,
          moving: false,
          assembleAt: performance.now(),
          birthAt: 0,
        };
      }
      if (!this.ambient[id]) {
        this.ambient[id] = { index: this.deskIndex(id) % 5, nextAt: 0 };
      }
    }
    for (const id of Object.keys(this.agents)) {
      if (!ids.includes(id)) delete this.agents[id];
    }
    for (const id of Object.keys(this.ambient)) {
      if (!ids.includes(id)) delete this.ambient[id];
    }
  }

  resetAgents() {
    for (const item of this.roster) {
      this.resetAgent(item.id);
    }
    this.assembly.cells.clear();
  }

  resetAgent(id) {
    const spot = this.deskSpotOf(id);
    const a = this.agents[id];
    if (!a) return;
    a.x = spot.x;
    a.y = spot.y;
    const v = this.view.byId[id];
    a.state = v ? v.state : 'alive';
    a.frame = 0;
    a.moving = false;
  }

  /** Absorbs the snapshots: keeps each entity's last known state if a read fails. */
  ingest(snapshots, meta = {}) {
    if (Array.isArray(meta.roster) && meta.roster.length) {
      this.roster = meta.roster.filter((item) => item && item.id);
      for (const item of this.roster) {
        if (!this.data[item.id]) this.data[item.id] = emptyData();
      }
    }
    if (snapshots && typeof snapshots === 'object') {
      for (const item of this.roster) this.mergeInto(this.data[item.id], snapshots[item.id]);
    }
    this.meta = {
      stale: Boolean(meta.stale),
      dev: Boolean(meta.dev || (this.meta && this.meta.dev)),
      lastRead: meta.lastRead || (this.meta && this.meta.lastRead),
      online: meta.online && typeof meta.online === 'object' ? meta.online : this.online,
      roster: this.roster,
      byUrl: meta.byUrl && typeof meta.byUrl === 'object' ? meta.byUrl : {},
      byAddress: meta.byAddress && typeof meta.byAddress === 'object' ? meta.byAddress : {},
      lineage: meta.lineage && typeof meta.lineage === 'object' ? meta.lineage : {},
    };
    this.online = this.meta.online;
    this.syncAgents();
    this.view = deriveRoom(this.data, this.meta);
    this.applyLetters();
    this.base = paintBase(this.L, this.view.dev, this.roster, this.online);
    this.checkInteraction();
    this.checkWhispers();
    this.checkBirths();
  }

  mergeInto(target, snapshot) {
    if (!target || !snapshot) return;
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
    const first = this.view.byId.e1;
    const second = this.view.byId.e2;
    return Boolean(
      this.interactionUntil > Date.now()
      && first && second
      && first.alive
      && second.alive
      && second.online,
    );
  }

  resolveRef(url, address) {
    const key = endpointKey(url);
    const byUrl = this.meta.byUrl || {};
    if (key && byUrl[key]) return byUrl[key];
    const addr = stringOf(address).trim();
    const byAddress = this.meta.byAddress || {};
    if (addr && byAddress[addr]) return byAddress[addr];
    const item = this.roster.find((entry) => entry.base && endpointKey(entry.base) === key);
    return item ? item.id : null;
  }

  /**
   * A letter keeps the sprite reading for 20 s from the moment it is first
   * seen, and the envelope stays on the desk while the entry is < 2 min old.
   */
  applyLetters() {
    const now = Date.now();
    for (const view of this.view.list) {
      if (!view.letter) continue;
      const key = `${view.id}:${view.letter.key}`;
      if (this.letterKeys[view.id] !== key) {
        this.letterKeys[view.id] = key;
        this.letterUntil[view.id] = now + LETTER_READ_MS;
      }
      view.envelope = true;
      if (view.life === 'alive' && now < (this.letterUntil[view.id] || 0)) {
        view.state = 'read';
        view.mode = 'real';
        view.eventAt = Date.parse(view.letter.at) || view.eventAt;
        if (view.letter.ticker) view.ticker = view.letter.ticker;
      } else if (view.life === 'alive' && view.real && view.real.kind === 'letter') {
        // the envelope stays for the 2-minute window; the reading pose is 20 s
        view.state = 'sit';
        view.mode = 'real';
      }
    }
  }

  /** New public `whisper` entries become a spark from sender's desk to recipient's. */
  checkWhispers() {
    for (const view of this.view.list) {
      if (!view.whisper) continue;
      const key = view.whisper.key;
      if (!key || this.sparkKeys.has(key)) continue;
      const toId = this.resolveRef(view.whisper.to, null);
      if (!toId || toId === view.id) continue;
      if (!this.view.byId[toId] || !this.agents[toId]) continue;
      this.sparkKeys.add(key);
      const from = this.deskOf(view.id);
      const to = this.deskOf(toId);
      const start = this.reduced.matches ? performance.now() - SPARK_MS : performance.now();
      this.sparks.push({
        key,
        fromId: view.id,
        toId,
        from: { x: from.x + Math.floor(this.L.deskWidth / 2), y: from.y + 2 },
        to: { x: to.x + Math.floor(this.L.deskWidth / 2), y: to.y + 2 },
        start,
        flashAt: start + SPARK_MS,
      });
    }
  }

  /** A public `birth_of` entry: the child assembles at the door and walks to its desk. */
  checkBirths() {
    for (const view of this.view.list) {
      if (!view.birth) continue;
      const key = view.birth.key;
      if (!key || this.birthKeys.has(key)) continue;
      const childId = this.resolveRef(view.birth.url, view.birth.address);
      if (!childId || childId === view.id) continue;
      const child = this.view.byId[childId];
      const agent = this.agents[childId];
      if (!child || !agent || !child.online || !child.known || child.life !== 'alive') continue;
      this.birthKeys.add(key);
      if (this.birthChildren.has(childId)) continue;
      this.birthChildren.add(childId);
      const door = this.L.spots.door;
      agent.x = door.x;
      agent.y = door.y;
      agent.state = 'walk';
      agent.moving = true;
      agent.birthAt = Date.now();
      agent.assembleAt = performance.now();
    }
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
    for (const item of this.roster) this.stepAgent(item.id, ts, reduced);
    this.sparks = this.sparks.filter((spark) => ts < spark.flashAt + SPARK_FLASH_MS);
  }

  stepAgent(id, ts, reduced) {
    const v = this.view.byId[id];
    const a = this.agents[id];
    if (!v || !a || !v.online || !v.known) return;
    const spot = this.desiredSpot(id, ts, reduced);
    const interacting = this.isInteracting();
    // death, non-birth and interaction do not walk: they appear at once in their spot
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
    const v = this.view.byId[id];
    const deskSpot = this.deskSpotOf(id);
    if (!v) return deskSpot;
    // a newborn walks from the door to its desk, whatever its ambient mood
    const agent = this.agents[id];
    if (agent && agent.birthAt && Date.now() - agent.birthAt < 15000) return deskSpot;
    if (this.isInteracting() && (id === 'e1' || id === 'e2')) {
      return (id === 'e1' ? this.L.spots.face1 : this.L.spots.face2) || this.L.spots.center;
    }
    if (v.mode === 'real') {
      const maps = {
        type: deskSpot,
        sit: deskSpot,
        read: this.L.spots.read,
        rest: this.L.spots.rest,
        unborn: this.L.spots.center,
        dead: this.L.spots.door,
        walk: this.L.spots.vault,
      };
      return maps[v.state] || deskSpot;
    }
    // ambient
    if (reduced) return deskSpot;
    const amb = this.ambient[id] || { index: 0, nextAt: 0 };
    this.ambient[id] = amb;
    if (ts >= amb.nextAt) {
      amb.index = (amb.index + 1) % 5;
      amb.nextAt = ts + AMBIENT_MS;
    }
    const orders = ['desk', 'window', 'read', 'center', 'pace'];
    const pick = orders[amb.index];
    if (pick === 'pace') {
      const offset = this.deskIndex(id) * 9;
      const length = Math.max(1, this.L.corridor.x1 - this.L.corridor.x0);
      const step = (amb.index + 1) * 7 + offset;
      const x = this.L.corridor.x0 + (step % length);
      return { x, y: this.L.corridor.y };
    }
    if (pick === 'desk') return deskSpot;
    return this.L.spots[pick] || deskSpot;
  }

  /* ------------------------------ drawing ------------------------------ */

  render(ts) {
    const g = cloneGrid(this.base);
    for (const item of this.roster) this.drawDeskActivity(g, item.id);
    for (const item of this.roster) this.drawEntity(g, ts, item.id);
    this.drawSparks(g, ts);
    if (this.isInteracting()) this.drawInteraction(g);
    if (this.view.stale) {
      const note = '(stale data)';
      g.put(2, this.L.h - 1, note, 'err');
    }
    this.pre.replaceChildren(this.gridFragment(g));
    this.updateMeta();
  }

  drawDeskActivity(g, id) {
    const v = this.view.byId[id];
    const a = this.agents[id];
    if (!v || !a || !v.online || !v.known) return;
    const desk = this.deskOf(id);
    const spot = this.deskSpotOf(id);
    const atDesk = a.x === spot.x && a.y === spot.y;
    if (!atDesk || !(v.state === 'type' || v.state === 'sit' || a.state === 'sit' || a.state === 'type')) return;
    const screenX = desk.x + 2;
    const screenY = desk.y + 1;
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

  drawEntity(g, ts, id) {
    const v = this.view.byId[id];
    const a = this.agents[id];
    if (!v || !a || !v.online || !v.known) return;
    const interacting = this.isInteracting();
    if (v.state === 'dead') {
      this.putSprite(g, a.x, a.y, [' ___', '[RIP]', '▀▀▀▀▀'], 'dim', ts, id, a.assembleAt);
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
    const maxName = this.L.name === 'compact' ? 9 : 12;
    const tag = `▸ ${truncate(v.name, maxName)}`;
    if (!v.bubble || interacting) {
      g.put(a.x, a.y - 1, tag, 'dim');
      if (v.hunger) g.put(a.x + tag.length + 1, a.y - 1, '!', 'acc');
    }

    // envelope on its own desk
    if (v.envelope) {
      const desk = this.deskOf(id);
      const blink = this.reduced.matches || Math.floor(a.frame / 3) % 2 === 0;
      if (blink) g.put(desk.x + 2, desk.y + 3, '[✉]', 'acc');
    }

    this.putSprite(g, a.x, a.y, lines, cls, ts, id, a.assembleAt);

    // unborn: dotted outline with the waiting sign
    if (v.state === 'unborn') {
      g.put(a.x, a.y + 3, 'waiting for the gift', 'dim');
    }

    // speech bubble with the real text, beside the body. The third desk keeps
    // its bubble on the left so it never runs past the room wall.
    if (v.bubble && !interacting) {
      const col = this.deskIndex(id) % 3;
      this.drawBubble(g, a.x, a.y - 1, v.bubble, col === 2 ? 'left' : 'right');
    }
  }

  drawSparks(g, ts) {
    for (const spark of this.sparks) {
      const age = ts - spark.start;
      if (age < 0) continue;
      if (age <= SPARK_MS) {
        const p = Math.min(1, age / SPARK_MS);
        const x = Math.round(spark.from.x + (spark.to.x - spark.from.x) * p);
        const y = Math.round(spark.from.y + (spark.to.y - spark.from.y) * p);
        const glyph = p < 0.35 ? '·' : (p < 0.8 ? '✦' : '·');
        g.put(x, y, glyph, 'acc');
      } else if (age <= SPARK_MS + SPARK_FLASH_MS) {
        const blink = this.reduced.matches || Math.floor(age / 220) % 2 === 0;
        if (!blink) continue;
        const desk = this.deskOf(spark.toId);
        g.put(desk.x + 2, desk.y + 3, '[$]', 'acc');
      }
    }
  }

  drawInteraction(g) {
    const a = this.agents.e1;
    const b = this.agents.e2;
    if (!a || !b) return;
    const y = Math.min(a.y, b.y) + 1;
    const from = Math.min(a.x, b.x) + 4;
    const to = Math.max(a.x, b.x) - 1;
    if (to >= from) g.put(from, y, '~'.repeat(to - from + 1), 'dim');
  }

  drawBubble(g, x, y, text, preferred = 'right') {
    // Wide enough to read, narrow enough to stop before the next desk's sprite.
    // Two lines keep the box above the desk (the full text stays in ledger/thoughts).
    const max = this.L.name === 'compact' ? 11 : 18;
    const lines = wrapText(truncate(text, max * 2), max);
    if (lines.length > 2) {
      lines.length = 2;
      lines[1] = `${lines[1].slice(0, Math.max(1, max - 1))}…`;
    }
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

  putSprite(g, x, y, lines, cls, ts, spriteKey, assembleAt) {
    const reduced = this.reduced.matches;
    const start = Number.isFinite(assembleAt) ? assembleAt : 0;
    const t = reduced ? 1 : Math.max(0, Math.min(1, (ts - start) / ASSEMBLY_MS));
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

  parentOf(id) {
    const lineage = this.meta.lineage && this.meta.lineage[id];
    if (!lineage || !lineage.parent) return null;
    const parent = this.resolveRef(lineage.parent, null);
    return parent && parent !== id ? parent : null;
  }

  familyLine() {
    return this.roster.map((item) => {
      const view = this.view.byId[item.id];
      const named = view && view.known && view.name && view.name !== 'unnamed';
      const label = named ? `${item.id} ${view.name}` : item.id;
      const parent = this.parentOf(item.id);
      return parent ? `${label} (child of ${parent})` : label;
    }).join(' · ');
  }

  updateMeta() {
    const readAt = clockTime(this.meta.lastRead);
    const interacting = this.isInteracting();
    const t = interacting
      ? { text: '~ ambient · e1 and e2 face each other, a ~ line between them', real: false }
      : this.view.ticker;
    const sig = [
      this.roster.map((item) => item.id).join(','),
      this.view.list.map((item) => `${item.id}:${item.name}:${item.state}:${item.mode}`).join('|'),
      t.text,
      this.familyLine(),
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
      textNode(' · '),
      el('span', { class: 'dim', text: 'family: ' }),
      el('span', { class: 'fg', text: this.familyLine() }),
    ];
    for (const item of this.roster) {
      if (!item.id) continue;
      const view = this.view.byId[item.id];
      if (view && view.online) continue;
      legendParts.push(textNode(' · '));
      legendParts.push(el('span', { class: 'dim', text: `${item.id}: not yet online` }));
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

    const parts = [`ASCII room, ${this.L.w} columns, ${this.roster.length} desk${this.roster.length === 1 ? '' : 's'}.`];
    for (const item of this.roster) {
      const v = this.view.byId[item.id];
      if (!v) continue;
      const label = `Entity ${numberIn(item.id)}`;
      if (!v.online) {
        parts.push(`${label} is not deployed: its desk is empty.`);
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
