/*
 * term.js — terminal, login screen and commands.
 *
 * Screen 1: BBS-style login (ASCII logo, network status, alias).
 * Screen 2: the room (room.js) above, the terminal below.
 * All text coming from the network enters the DOM with textContent.
 * Every fetch is wrapped: an error becomes a `!! /path: …` line, never a crash.
 */

import { renderFace, seedOf } from './face.js';
import {
  ENTITIES,
  MISSING,
  MAX_ENTITIES,
  MAX_TRACKED_ENTITIES,
  COOLDOWN_MS,
  REFRESH_MS,
  applyDevBase,
  applyDevBase2,
  peerUrlOf,
  fetchSnapshot,
  fetchLightSnapshot,
  postMessage,
  request,
  entryType,
  summarize,
  verifyChain,
  formatInt,
  formatDecimal,
  formatZats,
  fixed8,
  fmtStamp,
  fetchedLabel,
  clockTime,
  hhmm,
  stringOf,
  isFuture,
  lineageOf,
  addressOf,
  endpointKey,
  shortUrl,
} from './data.js';

import { Room, el } from './room.js';

/* ------------------------------------------------------------------ */
/* Constants and state                                                 */
/* ------------------------------------------------------------------ */

const HANDLE_KEY = 'sov-bbs:handle';
const ABORT = Symbol('abort');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  handle: '',
  selected: 'e1',
  // one read per entity: { data: <fetchSnapshot shape>, at: Date, stale: bool, dev: bool }
  snaps: {},
  fetchedAt: null,
  stale: false,
  dev: false,
  cooldownUntil: 0,
  sending: false,
  chainGen: 0,
  typeTimer: null,
  skipType: false,
  room: null,
  history: [],
  historyIndex: -1,
  destroyed: false,
  // lineage as last declared by each entity's `/` (never invented, never cleared on a failed read)
  lineages: {},
  // endpoint URL key -> entity id, and shielded address -> entity id
  byUrl: {},
  byAddress: {},
  // lineage references beyond MAX_TRACKED_ENTITIES: listed by `family`, never fetched
  untracked: new Map(),
};

let app = null;
let wipeEl = null;
let outEl = null;
let promptInput = null;
let promptPrefix = null;
// next free entity number (e1/e2 are reserved); ids are never reused
let nextEntityNumber = 3;

function entity(id = state.selected) {
  return ENTITIES.find((item) => item.id === id) || ENTITIES[0];
}

function snapshotOf(id = state.selected) {
  const read = state.snaps[id];
  return read ? read.data : null;
}

/**
 * Entities with a desk: the first MAX_ENTITIES records in discovery order.
 * e2 is one of them even while it has no base, so its desk stays visibly empty.
 */
function screenEntities() {
  return ENTITIES.slice(0, MAX_ENTITIES);
}

function onScreen(id) {
  return screenEntities().some((item) => item.id === id);
}

function indexEntity(item) {
  if (!item) return;
  const key = endpointKey(item.base);
  if (key) state.byUrl[key] = item.id;
  const address = stringOf(item.address).trim();
  if (address) state.byAddress[address] = item.id;
}

function rebuildIndexes() {
  state.byUrl = {};
  state.byAddress = {};
  for (const item of ENTITIES) indexEntity(item);
  for (const [key, untracked] of state.untracked) {
    if (!untracked || !untracked.url) state.untracked.delete(key);
  }
}

/** Resolves an endpoint URL (and optionally a shielded address) to a known entity id. */
function entityIdOfUrl(url, address = null) {
  const key = endpointKey(url);
  if (key && state.byUrl[key]) return state.byUrl[key];
  const addr = stringOf(address).trim();
  if (addr && state.byAddress[addr]) return state.byAddress[addr];
  return null;
}

/** Entity 2 from Entity 1's `peer`. Returns true when a new base was adopted. */
function discoverPeer(rootData) {
  const second = ENTITIES[1];
  if (!second || second.base) return false;
  const peer = peerUrlOf(rootData && rootData.peer);
  if (!peer) return false;
  const first = ENTITIES[0];
  if (first && first.base && endpointKey(first.base) === endpointKey(peer)) return false;
  const mapped = state.byUrl[endpointKey(peer)];
  if (mapped && mapped !== second.id) return false;
  second.base = peer;
  indexEntity(second);
  return true;
}

/**
 * Registers an entity discovered through `lineage` (child or parent).
 * Existing bases (and shielded addresses) are matched first. Beyond
 * MAX_TRACKED_ENTITIES the URL is remembered only for the family command.
 * Returns { id, created } or null when it cannot be tracked.
 */
function registerEntity(rawUrl, address = null) {
  const url = peerUrlOf(rawUrl);
  if (!url) return null;
  const key = endpointKey(url);
  const addr = stringOf(address).trim();
  let existing = ENTITIES.find((item) => item.base && endpointKey(item.base) === key);
  if (!existing && addr) existing = ENTITIES.find((item) => stringOf(item.address).trim() === addr);
  if (existing) {
    if (!existing.address && addr) {
      existing.address = addr;
      state.byAddress[addr] = existing.id;
    }
    return { id: existing.id, created: false };
  }
  if (ENTITIES.length >= MAX_TRACKED_ENTITIES) {
    if (key && !state.untracked.has(key)) state.untracked.set(key, { url });
    return null;
  }
  const n = nextEntityNumber;
  nextEntityNumber += 1;
  const record = {
    id: `e${n}`,
    label: `Entity ${n}`,
    short: `e${n}`,
    base: url,
    address: addr || null,
    via: 'lineage',
  };
  ENTITIES.push(record);
  indexEntity(record);
  return { id: record.id, created: true };
}

/**
 * Reads `lineage` (parent, children) from every snapshot we have and registers
 * new entities, in discovery order: entities are visited in id order, the
 * parent first, then the children as declared. Returns the ids just created.
 */
function discoverLineage() {
  const created = [];
  const e1read = state.snaps.e1;
  if (e1read && e1read.data && e1read.data.root && e1read.data.root.ok) {
    if (discoverPeer(e1read.data.root.data)) {
      if (!created.includes('e2')) created.push('e2');
    }
  }
  const order = ENTITIES.slice();
  for (const item of order) {
    const read = state.snaps[item.id];
    if (!read || !read.data) continue;
    const root = read.data.root;
    if (!root || !root.ok || !root.data) continue;
    const lineage = lineageOf(root.data);
    state.lineages[item.id] = lineage;
    const refs = [];
    if (lineage.parent) refs.push({ url: lineage.parent, address: null });
    for (const child of lineage.children) refs.push({ url: child.url, address: child.address });
    for (const ref of refs) {
      const result = registerEntity(ref.url, ref.address);
      if (result && result.created && !created.includes(result.id)) created.push(result.id);
    }
  }
  return created;
}

function nameOf(id) {
  const item = ENTITIES.find((entry) => entry.id === id);
  if (!item) return id;
  const snap = snapshotOf(id);
  if (snap) {
    if (snap.root && snap.root.ok && snap.root.data) {
      const name = stringOf(snap.root.data.entity).trim();
      if (name && name !== 'unnamed') return name;
    }
    if (snap.memory && snap.memory.ok && snap.memory.data && snap.memory.data.identity) {
      const name = stringOf(snap.memory.data.identity.name).trim();
      if (name) return name;
    }
  }
  return id;
}

function screenSnapshots() {
  const out = {};
  for (const item of screenEntities()) {
    const read = state.snaps[item.id];
    out[item.id] = read ? read.data : null;
  }
  return out;
}

function roomMeta() {
  const screen = screenEntities();
  const online = {};
  for (const item of screen) online[item.id] = Boolean(item.base);
  return {
    stale: state.stale,
    dev: state.dev,
    lastRead: state.fetchedAt,
    roster: screen.map((item) => ({ id: item.id, base: item.base })),
    online,
    lineage: state.lineages,
    byUrl: state.byUrl,
    byAddress: state.byAddress,
  };
}

/** Parsed ledger entries of one snapshot (empty when the ledger was not read). */
function entriesOf(snap) {
  if (!snap || !snap.ledger || !snap.ledger.ok || typeof snap.ledger.text !== 'string') return [];
  return snap.ledger.text.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry] : [];
    } catch {
      return [];
    }
  });
}


/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function push(parts, cls = '') {
  if (!outEl) return null;
  const div = el('div', { class: `l${cls ? ` ${cls}` : ''}` });
  const list = Array.isArray(parts) ? parts : [parts];
  for (const part of list) {
    if (part === null || part === undefined) continue;
    if (typeof part === 'object') {
      const span = el('span', { class: part.c || '' });
      span.textContent = part.t === null || part.t === undefined ? '' : String(part.t);
      div.appendChild(span);
    } else {
      div.appendChild(document.createTextNode(String(part)));
    }
  }
  outEl.appendChild(div);
  scroll();
  return div;
}

function scroll() {
  if (outEl) outEl.scrollTop = outEl.scrollHeight;
}

function blank() {
  push('');
}

function kv(label, value) {
  const key = `${label} `.padEnd(22, '.');
  push([{ t: key, c: 'dim' }, { t: ' ' }, { t: value === null || value === undefined ? '—' : String(value) }]);
}

function rule(char = '─', n = 60) {
  push([{ t: char.repeat(n), c: 'dim' }]);
}

function typeOut(node, text) {
  if (reduced.matches || text.length < 4) {
    node.textContent = text;
    return;
  }
  let i = 0;
  const step = () => {
    if (state.destroyed) return;
    if (state.skipType) {
      state.skipType = false;
      node.textContent = text;
      return;
    }
    i += 1;
    node.textContent = text.slice(0, i);
    scroll();
    if (i < text.length) state.typeTimer = window.setTimeout(step, 6);
  };
  step();
}

function hdr(text) {
  const div = push([{ t: text, c: 'hdr' }]);
  if (div) {
    div.textContent = '';
    typeOut(div, text);
  }
}

function err(text) {
  push([{ t: text, c: 'err' }]);
}

function note(text) {
  push([{ t: text, c: 'dim' }]);
}

/* ------------------------------------------------------------------ */
/* Login screen                                                        */
/* ------------------------------------------------------------------ */

const GLYPHS = {
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  V: ['█   █', '█   █', '█   █', ' █ █ ', '  █  '],
  R: ['████ ', '█   █', '████ ', '█ █  ', '█  █ '],
  G: [' ████', '█    ', '█  ██', '█   █', ' ████'],
};

function logoLines() {
  const lineOf = (letters) => {
    const glyphs = [...letters];
    const rows = ['', '', '', '', ''];
    for (let r = 0; r < 5; r += 1) rows[r] = glyphs.map((letter) => GLYPHS[letter][r]).join(' ');
    return rows;
  };
  const top = lineOf('SOVEREIGN');
  const bottom = lineOf('ENTITIES');
  return [...top, '', ...bottom];
}

function showLogin() {
  screenWipe(() => {
    if (state.room) {
      state.room.destroy();
      state.room = null;
    }
    state.chainGen += 1;

    const aliasInput = el('input', {
      id: 'alias',
      class: 'login-input',
      type: 'text',
      maxlength: '40',
      autocomplete: 'nickname',
      value: state.handle || '',
      'aria-label': 'alias or handle',
    });

    const status = el('p', { class: 'login-status', text: 'mystic-like: 2 nodes · entities online: …/2 · network: …' });

    const form = el('form', { class: 'login-form', novalidate: true },
      el('label', { class: 'login-label', for: 'alias', text: 'enter your alias/handle:' }),
      el('div', { class: 'login-line' },
        el('span', { class: 'dim', text: '> ' }),
        aliasInput,
        el('span', { class: 'cursor', 'aria-hidden': 'true', text: '█' }),
      ),
      el('p', { class: 'login-hint dim', text: 'empty = "anonymous" · press enter to continue' }),
    );

    const face = el('pre', { class: 'face', 'aria-hidden': 'true', text: '' });
    animateFace(face, { seed: seedOf('entita-sovrane'), alive: true });

    const screen = el('section', { class: 'screen login' },
      el('pre', { class: 'logo', 'aria-hidden': 'true', text: logoLines().join('\n') }),
      face,
      status,
      el('p', { class: 'login-sub dim', text: 'two sovereign entities · same image, different seed · one public channel' }),
      form,
    );

    app.replaceChildren(screen);
    aliasInput.focus();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      enterMain(aliasInput.value);
    });

    // fills the status line as soon as possible (read-only, never crashes)
    void fillLoginStatus(status);
  });
}

/**
 * Login status: discovered bases count as online; vitals tell who is alive
 * and who is still waiting to be born. Entity 2 is discovered here too, so
 * the main screen can fetch both snapshots immediately.
 */
async function fillLoginStatus(status) {
  const base1 = ENTITIES[0].base;
  if (!base1) return;

  const root1 = await request(base1, '/');
  if (state.destroyed) return;

  let chain = '—';
  if (root1.ok && root1.data) {
    chain = stringOf(root1.data.zcash && root1.data.zcash.chain) || 'not declared';
    discoverPeer(root1.data);
  }

  const online = ENTITIES.filter((item) => item.base);
  const reads = await Promise.all(online.map(async (item) => {
    if (item.id === 'e1') {
      return { id: item.id, vitals: await request(item.base, '/vitals') };
    }
    const [root, vitals] = await Promise.all([
      request(item.base, '/'),
      request(item.base, '/vitals'),
    ]);
    return { id: item.id, root, vitals };
  }));
  if (state.destroyed) return;

  let alive = 0;
  let waiting = 0;
  let known = 0;
  for (const read of reads) {
    if (!read.vitals || !read.vitals.ok || !read.vitals.data) continue;
    known += 1;
    if (read.vitals.data.state === 'alive') alive += 1;
    else if (read.vitals.data.state === 'unborn') waiting += 1;
  }

  const parts = [`entities online: ${online.length}/${ENTITIES.length}`];
  if (known) {
    const bits = [`${alive} alive`];
    if (waiting) bits.push(`${waiting} waiting`);
    parts.push(bits.join(' · '));
  }
  status.textContent = `mystic-like: ${ENTITIES.length} nodes · ${parts.join(' · ')} · network: ${chain}`;
}

/* ------------------------------------------------------------------ */
/* Main screen                                                         */
/* ------------------------------------------------------------------ */

function promptText() {
  const handle = state.handle || 'anonymous';
  const e = entity();
  const n = String(e.id).replace(/^e/, '');
  const host = e.base ? `entity-${n}` : 'dim';
  return `${handle}@${host} >`;
}

function updatePrompt() {
  if (promptPrefix) promptPrefix.textContent = promptText();
}

function enterMain(alias) {
  const clean = String(alias || '').trim().slice(0, 40);
  state.handle = clean;
  try {
    if (clean) localStorage.setItem(HANDLE_KEY, clean);
    else localStorage.removeItem(HANDLE_KEY);
  } catch {
    /* storage denied: the alias stays in memory only */
  }

  screenWipe(() => {
    state.selected = 'e1';
    state.snaps = {};
    for (const item of ENTITIES) state.snaps[item.id] = null;
    state.lineages = {};
    state.untracked = new Map();
    rebuildIndexes();
    state.fetchedAt = null;
    state.stale = false;
    state.dev = false;

    const roomHost = el('div', { class: 'room-host' });
    outEl = el('div', { class: 'out', id: 'out', 'aria-live': 'polite', tabindex: '-1' });
    promptPrefix = el('span', { class: 'prompt', 'aria-hidden': 'true', text: promptText() });
    promptInput = el('input', {
      id: 'prompt',
      class: 'prompt-input',
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': 'terminal command',
    });

    const form = el('form', { class: 'promptline', id: 'promptform', novalidate: true },
      el('label', { class: 'sr-only', for: 'prompt', text: 'command' }),
      promptPrefix,
      promptInput,
    );

    const screen = el('section', { class: 'screen main' },
      roomHost,
      el('section', { class: 'term' }, outEl, form),
    );

    app.replaceChildren(screen);

    state.room = new Room(roomHost);
    state.room.ingest(null, { ...roomMeta(), stale: true });

    promptInput.addEventListener('keydown', onPromptKey);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = promptInput.value;
      promptInput.value = '';
      runCommand(raw);
    });

    promptInput.focus();

    banner();
    push([{ t: 'help', c: 'hi' }, { t: ' for the command list.' }]);
    blank();
    void refresh({ announce: true });
  });
}

function banner() {
  push([{ t: '╔══════════════════════════════════════════════════════════╗', c: 'dim' }]);
  push([{ t: '║  SOVEREIGN ENTITIES — public terminal (BBS)              ║', c: 'hi' }]);
  push([{ t: '╚══════════════════════════════════════════════════════════╝', c: 'dim' }]);
}

/* ------------------------------------------------------------------ */
/* Line face (face.js): progressive assembly, then breathing           */
/* ------------------------------------------------------------------ */

function faceSize() {
  const narrow = window.innerWidth < 640;
  // Dense relief: many lines, compressed vertically by the CSS line-height, pushed up to a third of the height.
  return narrow ? { cols: 52, rows: 36, lines: 22, amplitude: 10 } : { cols: 80, rows: 46, lines: 30, amplitude: 13 };
}

/** Draws the face into `pre` line by line (~1.5 s), then breathes slowly while `alive` and the node is on screen. */
function animateFace(pre, { seed, alive }) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const size = faceSize();
  const t0 = performance.now();
  const ASSEMBLE_MS = reduced ? 0 : 1500;
  let last = 0;
  const frame = (now) => {
    if (!pre.isConnected) return;
    const age = now - t0;
    if (age < ASSEMBLE_MS) {
      const full = renderFace({ ...size, seed, t: 0 });
      const keep = Math.round(size.cols * (age / ASSEMBLE_MS));
      pre.textContent = full.map((row) => row.slice(0, keep).padEnd(size.cols, ' ')).join('\n');
      requestAnimationFrame(frame);
      return;
    }
    if (!alive || reduced) { pre.textContent = renderFace({ ...size, seed, t: 0 }).join('\n'); return; }
    if (now - last > 120) { last = now; pre.textContent = renderFace({ ...size, seed, t: now / 1000 }).join('\n'); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function cmdFace() {
  const e = entity();
  hdr('FACE');
  if (!e.base) {
    note(`Entity ${String(e.id).replace(/^e/, '')}: not yet online · no face to show (nothing is invented).`);
    return;
  }
  const snap = snapshotOf();
  if (!snap) {
    err('!! no data read yet · use refresh');
    return;
  }
  const rootData = snap.root && snap.root.ok ? snap.root.data : null;
  const vitalsData = snap.vitals && snap.vitals.ok ? snap.vitals.data : null;
  const rawName = rootData ? stringOf(rootData.entity).trim() : '';
  const name = rawName && rawName !== 'unnamed' ? rawName : 'unnamed';
  const alive = Boolean(vitalsData && vitalsData.state === 'alive');
  const signKey = rootData && rootData.keys && rootData.keys.sign ? String(rootData.keys.sign) : e.id;
  const pre = el('pre', { class: 'face face-out', 'aria-label': `line face of ${name}`, text: '' });
  outEl.append(pre);
  animateFace(pre, { seed: seedOf(signKey), alive });
  push([{ t: `${name} · face generated from the entity's public seed (signature key) · ${alive ? 'breathing: alive' : 'still'}`, c: 'dim' }]);
  scroll();
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function onPromptKey(event) {
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!state.history.length) return;
    if (state.historyIndex < 0) state.historyIndex = state.history.length;
    state.historyIndex = Math.max(0, state.historyIndex - 1);
    promptInput.value = state.history[state.historyIndex] || '';
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (state.historyIndex < 0) return;
    state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
    promptInput.value = state.history[state.historyIndex] || '';
    if (state.historyIndex >= state.history.length) {
      state.historyIndex = -1;
      promptInput.value = '';
    }
  } else if (event.key === 'Escape') {
    promptInput.value = '';
  }
}

function runCommand(raw) {
  const input = String(raw || '').trim();
  push([{ t: `${promptText()} `, c: 'dim' }, { t: input }]);
  if (!input) return;

  state.history.push(input);
  if (state.history.length > 60) state.history.shift();
  state.historyIndex = -1;

  const space = input.indexOf(' ');
  const cmd = (space === -1 ? input : input.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : input.slice(space + 1).trim();

  switch (cmd) {
    case 'help': cmdHelp(); break;
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6': cmdSelect(`e${cmd}`); break;
    case 'who':
    case 'chi': cmdWho(); break;
    case 'status':
    case 'stato': cmdStatus(); break;
    case 'treasury':
    case 'tesoro': cmdTreasury(); break;
    case 'thoughts':
    case 'pensieri': cmdThoughts(); break;
    case 'channel':
    case 'canale': cmdChannel(); break;
    case 'say':
    case 'di': void cmdSay(rest); break;
    case 'ledger':
    case 'registro': cmdLedger(rest); break;
    case 'verify':
    case 'verifica': void cmdVerify(); break;
    case 'attestation':
    case 'attestazione': cmdAttestation(); break;
    case 'memory':
    case 'memoria': cmdMemory(); break;
    case 'family':
    case 'tree':
    case 'famiglia':
    case 'albero': cmdFamily(); break;
    case 'ask':
    case 'pay': cmdAsk(); break;
    case 'whispers':
    case 'sussurri': cmdWhispers(); break;
    case 'missing':
    case 'manca': cmdMissing(); break;
    case 'face':
    case 'volto': cmdFace(); break;
    case 'refresh':
    case 'aggiorna': void refresh({ announce: true }); break;
    case 'clear':
    case 'pulisci': cmdClear(); break;
    case 'exit':
    case 'esci': cmdExit(); break;
    default:
      err('?? unknown command, try help');
  }
}

function cmdHelp() {
  hdr('COMMANDS');
  const cmds = [
    ['help', 'this list'],
    ['1 .. 6', 'select a discovered entity'],
    ['who', 'identity: name, voice, image'],
    ['status', 'vitals, wallet, brain, attestation, lineage'],
    ['treasury', 'TAZ/ZEC, zatoshi, rent/hour, hours left'],
    ['thoughts', 'latest public posts from the entity'],
    ['channel', 'last 20 messages of the public channel'],
    ['say <text>', 'write to the public channel (public!)'],
    ['ledger [n]', 'last n ledger entries (default 15)'],
    ['family / tree', 'the family tree from lineage'],
    ['ask | pay', 'how to pay this entity for an answer (address + memo)'],
    ['whispers', 'paid whispers and received letters'],
    ['verify', 'chain verification in the browser + /verify'],
    ['attestation', 'mode and /attestation metadata'],
    ['memory', 'plan, promises, recent events'],
    ['face', 'the entity\'s line face (from its public seed)'],
    ['missing', 'what is still missing'],
    ['refresh', 're-reads all endpoints'],
    ['clear', 'clears the screen'],
    ['exit', 'back to login'],
  ];
  for (const [c, d] of cmds) kv(c, d);
}

function cmdSelect(id) {
  const target = ENTITIES.find((item) => item.id === id);
  const n = String(id).replace(/^e/, '');
  if (!target) {
    push([{ t: `Entity ${n}: not discovered`, c: 'dim' }]);
    note('only entities found through peer or lineage can be selected. Try family.');
    return;
  }
  if (!target.base) {
    push([{ t: `Entity ${n}: not yet online`, c: 'dim' }]);
    note('no endpoint, no estimate, no placeholder. Nothing is simulated.');
    return;
  }
  state.selected = target.id;
  updatePrompt();
  push([{ t: `${target.label} selected`, c: 'hi' }]);
  const read = state.snaps[target.id];
  if (read) note(`last read ${fetchedLabel(read.at)}${read.stale ? ' (stale data)' : ''}`);
  else note('no snapshot read yet · use refresh');
}

function offlineOrData() {
  const e = entity();
  if (!e.base) {
    push([{ t: `Entity ${String(e.id).replace(/^e/, '')}: not yet online`, c: 'dim' }]);
    return null;
  }
  const read = state.snaps[e.id];
  if (!read) {
    err('!! no data read yet · use refresh');
    return null;
  }
  return read.data;
}

function stampLine(res, path) {
  if (!res) return;
  if (res.ok) note(`${path} · ${fetchedLabel(res.at)}`);
  else err(`!! ${path}: ${res.error || 'error'}`);
}

function cmdWho() {
  const snap = offlineOrData();
  if (!snap) return;
  const mem = snap.memory;
  if (!mem || !mem.ok) {
    stampLine(mem || { ok: false, error: 'not read' }, '/memory-public');
    return;
  }
  hdr('IDENTITY');
  const d = mem.data || {};
  const id = d.identity && typeof d.identity === 'object' ? d.identity : null;
  if (!id || (!id.name && !id.voice && !id.image)) {
    note('it has not given itself a name yet.');
  } else {
    kv('name', stringOf(id.name).trim() || 'unnamed');
    kv('voice', stringOf(id.voice).trim() || 'not declared');
    kv('image', stringOf(id.image).trim() || 'not declared');
  }
  // Nostr identity as declared by `/`: the npub is derived from the sealed key, same on every redeploy.
  const rootData = snap.root && snap.root.ok && snap.root.data ? snap.root.data : null;
  const npub = rootData && rootData.nostr ? stringOf(rootData.nostr.npub).trim() : '';
  kv('nostr', npub || 'not declared');
  stampLine(mem, '/memory-public');
}

function stateLabelOf(snap) {
  if (snap.memorial && snap.memorial.ok) return 'dead';
  if (!snap.vitals || !snap.vitals.ok || !snap.vitals.data) return 'state unavailable';
  const v = snap.vitals.data;
  if (v.state === 'unborn') return 'not yet born';
  if (v.state === 'dead') return 'dead';
  if (isFuture(v.sleepUntil)) return 'paused (sleeping)';
  if (v.hunger === 'hungry') return 'alive · hungry';
  return 'alive';
}

function cmdStatus() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('STATUS');
  kv('state', stateLabelOf(snap));

  // lineage as last declared by `/`: parent and children are other entities
  const current = entity();
  const rootData = snap.root && snap.root.ok && snap.root.data ? snap.root.data : null;
  const lineage = state.lineages[current.id] || (rootData ? lineageOf(rootData) : null);
  if (lineage) {
    if (lineage.parent) {
      const parentId = entityIdOfUrl(lineage.parent);
      kv('parent', parentId ? `${parentId} ${nameOf(parentId)}` : shortUrl(lineage.parent, 28));
    }
    if (lineage.children.length) {
      const labels = lineage.children.map((child) => {
        const childId = entityIdOfUrl(child.url, child.address);
        return childId ? `${childId} ${nameOf(childId)}` : shortUrl(child.url, 24);
      });
      kv('children', labels.join(' · '));
    }
  } else if (rootData && !rootData.lineage) {
    kv('lineage', 'not declared');
  }

  if (snap.memorial && snap.memorial.ok) {
    note('/memorial returned 200: the entity is dead.');
    stampLine(snap.memorial, '/memorial');
    return;
  }

  const v = snap.vitals && snap.vitals.ok ? snap.vitals.data || {} : null;
  if (!v) {
    err(`!! /vitals: ${(snap.vitals && snap.vitals.error) || 'not read'}`);
  } else {
    kv('hours left', Number.isFinite(Number(v.hoursLeft)) ? `${formatDecimal(v.hoursLeft, 2)} h` : 'not declared');
    kv('hunger', v.hunger === 'hungry' ? 'hungry' : (v.hunger === 'ok' ? 'fed' : 'not declared'));
    kv('days alive', Number.isFinite(Number(v.daysAlive)) ? `${formatDecimal(v.daysAlive, 2)}` : 'not declared');
    kv('born on', fmtStamp(v.bornAt));
    if (v.sleepUntil) kv('paused until', fmtStamp(v.sleepUntil));
    const wallet = v.wallet && typeof v.wallet === 'object'
      ? (v.wallet.ok === false
        ? `error${v.wallet.fault ? ` · ${stringOf(v.wallet.fault)}` : ''}`
        : (v.wallet.sync
          ? (v.wallet.sync.ok === false
            ? `sync failed${v.wallet.sync.at ? ` · ${fmtStamp(v.wallet.sync.at)}` : ''}`
            : `ok · height ${formatInt(v.wallet.sync.height)} · ${fmtStamp(v.wallet.sync.at)}`)
          : 'not declared'))
      : 'not declared';
    kv('wallet', wallet);

    const brain = Array.isArray(v.brain) ? v.brain : [];
    if (!brain.length) kv('brain', 'no provider declared');
    for (const provider of brain) {
      const p = provider && typeof provider === 'object' ? provider : {};
      const key = p.keyConfigured === true ? 'key ok' : 'key missing';
      kv('brain', `${stringOf(p.name) || 'unnamed'} · ${stringOf(p.model) || '—'} · ${stringOf(p.speed) || '—'} · ${key}`);
    }
    stampLine(snap.vitals, '/vitals');
  }

  const att = attestationMode(snap);
  kv('attestation', att.mode === 'tee' ? 'tee · TDX' : (att.mode === 'dev' ? 'dev · NOT ATTESTED' : 'not declared'));
  if (att.res) stampLine(att.res, '/attestation');
}

function attestationMode(snap) {
  if (snap.attestation && snap.attestation.ok && snap.attestation.data) {
    return { mode: stringOf(snap.attestation.data.mode).trim() || null, res: snap.attestation };
  }
  if (snap.root && snap.root.ok && snap.root.data && snap.root.data.attestation) {
    return { mode: stringOf(snap.root.data.attestation.mode).trim() || null, res: snap.root };
  }
  return { mode: null, res: snap.attestation };
}

function cmdTreasury() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('TREASURY');
  const chain = snap.root && snap.root.ok && snap.root.data && snap.root.data.zcash
    ? stringOf(snap.root.data.zcash.chain)
    : '';
  const unit = chain === 'testnet' ? 'TAZ' : (chain ? 'ZEC' : 'ZEC/TAZ');
  const v = snap.vitals && snap.vitals.ok ? snap.vitals.data || {} : {};
  const zats = Number(v.zatoshis);
  kv('network', chain || 'not declared');
  kv('balance', fixed8(v.zatoshis) === null ? '—' : `${fixed8(v.zatoshis)} ${unit}`);
  kv('zatoshi', Number.isFinite(zats) ? formatInt(zats) : 'not declared');
  const hours = Number(v.hoursLeft);
  if (Number.isFinite(zats) && Number.isFinite(hours) && hours > 0) {
    const perHour = (zats / hours) / 1e8;
    kv('rent/hour (derived)', `${formatDecimal(perHour, 6)} ${unit}/h`);
  } else {
    kv('rent/hour', 'not derivable');
  }
  kv('hours left', Number.isFinite(hours) ? `${formatDecimal(hours, 2)} h` : 'not declared');
  if (snap.root && snap.root.ok && snap.root.data && snap.root.data.zcash && snap.root.data.zcash.error) {
    err(`!! wallet (/): ${stringOf(snap.root.data.zcash.error)}`);
  }
  if (snap.root) stampLine(snap.root, '/');
  if (snap.vitals) stampLine(snap.vitals, '/vitals');
}

function channelOf(snap) {
  if (!snap.channel || !snap.channel.ok || !Array.isArray(snap.channel.data)) return [];
  return snap.channel.data;
}

function cmdAsk() {
  const snap = offlineOrData();
  if (!snap) return;
  const root = snap.root && snap.root.ok ? snap.root.data : null;
  const addr = root && root.zcash ? stringOf(root.zcash.address) : '';
  const chain = root && root.zcash ? stringOf(root.zcash.chain) : '';
  const name = root && stringOf(root.entity) && stringOf(root.entity) !== 'unnamed' ? stringOf(root.entity) : entity().label;
  hdr(`PAY ${name.toUpperCase()} FOR AN ANSWER`);
  if (!addr) { err('!! no wallet address read yet (try `refresh`)'); return; }
  note('A paid letter is an order: send ZEC to the address below with your question in the memo (max 500 bytes).');
  note('Only the entity reads the memo (shielded). It answers in public on its channel, or whispers back. Its own prices are in `thoughts` and `channel`.');
  kv('network', chain === 'mainnet' ? 'Zcash mainnet (real ZEC)' : `Zcash ${chain || 'testnet'} (test coins, no value)`);
  kv('address', addr);
  kv('memo', 'your question, and how to reach you if you want a private reply');
  kv('wallets', 'any Zcash wallet with shielded memos: Zashi, YWallet, Zingo');
  if (snap.root) stampLine(snap.root, '/');
}

function cmdThoughts() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('THOUGHTS (spoken thoughts and public posts)');
  const posts = channelOf(snap).filter((m) => m && m.from === 'entity').map((m) => ({ ts: m.ts, kind: 'post', text: stringOf(m.text) }));
  const entries = entriesOf(snap);
  const spoken = entries.filter((e) => e && e.type === 'thought' && e.data).map((e) => ({ ts: e.ts, kind: 'thought', text: stringOf(e.data.text) }));
  const list = [...posts, ...spoken].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-12);
  if (!list.length) {
    note('no thoughts or posts yet.');
  } else {
    for (const m of list) {
      push([{ t: `${hhmm(m.ts) || '—'} `, c: 'dim' }, { t: m.kind === 'thought' ? '(thinks) ' : '(posts) ', c: 'dim' }, { t: m.text }]);
    }
  }
  if (snap.channel) stampLine(snap.channel, '/public-channel');
}

function cmdChannel() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('PUBLIC CHANNEL (last 20)');
  const list = channelOf(snap).slice(-20);
  if (!list.length) {
    note('no messages. The channel is open.');
  } else {
    for (const m of list) {
      const fromEntity = m && m.from === 'entity';
      const who = fromEntity ? entity().short : (stringOf(m.author).trim() || 'human');
      push([
        { t: `${hhmm(m.ts) || '—'} `, c: 'dim' },
        { t: `${who}: `, c: fromEntity ? 'acc' : 'hi' },
        { t: stringOf(m.text) },
      ]);
    }
  }
  if (snap.channel) stampLine(snap.channel, '/public-channel');
}

async function cmdSay(text) {
  const e = entity();
  if (!e.base) {
    err('!! no public endpoint for this entity');
    return;
  }
  if (!text) {
    err('?? usage: say <text>');
    return;
  }
  if (text.length > 500) {
    err('!! the message exceeds 500 characters');
    return;
  }
  const left = Math.max(0, state.cooldownUntil - Date.now());
  if (left > 0) {
    err(`!! slow down: try again in ${Math.ceil(left / 1000)} s`);
    return;
  }
  if (state.sending) return;

  state.sending = true;
  note('sending to the public channel…');
  const author = state.handle || 'anonymous';
  const result = await postMessage(e.base, { author, text });
  state.sending = false;

  if (!result.ok) {
    err(`!! send failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error || 'error'}`);
    if (result.status === 429) {
      state.cooldownUntil = Date.now() + COOLDOWN_MS;
      err('!! rate limit: one message per minute · try again in 60 s');
    }
    return;
  }

  state.cooldownUntil = Date.now() + COOLDOWN_MS;
  const seq = result.data && result.data.seq !== undefined ? result.data.seq : '—';
  push([{ t: 'ok ', c: 'acc' }, { t: `entry ${seq} written to the public channel · try again in 60 s` }]);
  note('everything you write is public. The entity reads at the next cycle (≤ 15 min).');
  void refresh({ announce: false, quiet: true });
}

function cmdLedger(rest) {
  const snap = offlineOrData();
  if (!snap) return;
  const n = Math.max(1, Math.min(200, Number.parseInt(rest, 10) || 15));
  hdr(`LEDGER (last ${n} entries)`);
  if (!snap.ledger || !snap.ledger.ok || typeof snap.ledger.text !== 'string') {
    err(`!! /ledger: ${(snap.ledger && snap.ledger.error) || 'not read'}`);
    return;
  }
  const lines = snap.ledger.text.split(/\r?\n/).filter((line) => line.trim());
  const slice = lines.slice(-n);
  if (!slice.length) {
    note('ledger empty.');
    return;
  }
  for (const line of slice) {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = null;
    }
    if (!entry) {
      push([{ t: '(unreadable line)', c: 'err' }]);
      continue;
    }
    const seq = entry.seq !== undefined && entry.seq !== null ? entry.seq : '—';
    const type = entryType(entry);
    // whisper_text is private by contract even if the server forgot the flag
    if (entry.private === true || type === 'whisper_text') {
      const size = Number(entry.size);
      push([
        { t: `${String(seq).padStart(4)} `, c: 'dim' },
        { t: `${hhmm(entry.ts) || '—'} `, c: 'dim' },
        { t: `${type} `, c: 'hi' },
        { t: Number.isFinite(size) ? `private entry · ${formatInt(size)} bytes` : 'private entry · bytes not declared', c: 'dim' },
      ]);
    } else {
      push([
        { t: `${String(seq).padStart(4)} `, c: 'dim' },
        { t: `${hhmm(entry.ts) || '—'} `, c: 'dim' },
        { t: `${type} `, c: 'hi' },
        { t: summarize(entry) },
      ]);
    }
  }
  stampLine(snap.ledger, '/ledger');
}

function bar(done, total, width = 20) {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return `[${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
}

async function cmdVerify() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('CHAIN VERIFICATION');
  note('sha256 of each entry without the hash field · prev link · 64 leading zeros');
  if (!snap.ledger || !snap.ledger.ok || typeof snap.ledger.text !== 'string') {
    err(`!! /ledger: ${(snap.ledger && snap.ledger.error) || 'not read'}`);
    return;
  }

  const barSpan = el('span', { class: 'acc', text: `${bar(0, 1)} 0/0` });
  const line = el('div', { class: 'l' }, barSpan);
  if (outEl) outEl.appendChild(line);
  scroll();
  const gen = ++state.chainGen;
  const res = await verifyChain(snap.ledger.text, {
    shouldStop: () => gen !== state.chainGen || state.destroyed,
    onProgress: (done, total) => {
      barSpan.textContent = `${bar(done, total)} ${done}/${total}`;
    },
  });
  void line;

  if (gen !== state.chainGen || state.destroyed) return;

  if (res.reason === 'interrupted') {
    note('verification interrupted.');
  } else if (res.total === 0) {
    err('!! the ledger contains no entries');
  } else if (!globalThis.crypto || !crypto.subtle) {
    err(`!! ${res.reason}`);
  } else if (res.ok) {
    push([{ t: '✓ ', c: 'acc' }, { t: `chain verified in the browser: ${formatInt(res.valid)} entries` }]);
  } else {
    const fail = res.fail || {};
    const where = fail.seq !== undefined && fail.seq !== null ? `entry ${fail.seq}` : `line ${fail.index}`;
    err(`! chain broken at ${where}: ${fail.reason || res.reason || 'error'}`);
  }

  const v = snap.verify;
  if (v && v.ok && v.data) {
    const ok = v.data.ok === true;
    kv('/verify (server)', `${ok ? 'ok' : 'NOT ok'} · ${formatInt(v.data.entries)} entries`);
    kv('head (server)', stringOf(v.data.head) || '—');
  } else {
    err(`!! /verify: ${(v && v.error) || 'not read'}`);
  }
  stampLine(snap.ledger, '/ledger');
}

function cmdAttestation() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('ATTESTATION');
  const att = attestationMode(snap);
  const data = snap.attestation && snap.attestation.ok && snap.attestation.data
    ? snap.attestation.data
    : (snap.root && snap.root.ok && snap.root.data ? snap.root.data.attestation : null);
  if (!data) {
    err(`!! /attestation: ${(snap.attestation && snap.attestation.error) || 'not read'}`);
    return;
  }
  const quote = typeof data.quote === 'string' ? data.quote : '';
  kv('mode', att.mode === 'tee' ? 'tee · TDX' : (att.mode === 'dev' ? 'dev · NOT ATTESTED' : 'not declared'));
  kv('app', stringOf(data.app).trim() || 'not declared');
  kv('compose', stringOf(data.compose).trim() || 'not declared');
  kv('quote', quote ? `${quote.slice(0, 16)}… (${formatInt(quote.length)} characters)` : 'not present');
  if (att.mode === 'dev') err('!! this entity runs in dev mode: it is NOT ATTESTED');
  note('the image fingerprint is pinned in the public repository; the quote is not verified in the browser.');
  if (snap.attestation) stampLine(snap.attestation, '/attestation');
}

function cmdMemory() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('PUBLIC MEMORY');
  const m = snap.memory && snap.memory.ok ? snap.memory.data || {} : null;
  if (!m) {
    err(`!! /memory-public: ${(snap.memory && snap.memory.error) || 'not read'}`);
    return;
  }
  kv('plan', stringOf(m.plan).trim() || 'no plan published');
  const promises = Array.isArray(m.promises) ? m.promises : [];
  if (!promises.length) kv('promises', 'no open promises');
  for (const promise of promises) kv('promise', promiseText(promise));
  const events = Array.isArray(m.events) ? m.events : [];
  if (events.length) {
    rule('·');
    for (const ev of events.slice(-8)) {
      const e = ev && typeof ev === 'object' ? ev : {};
      push([{ t: `${hhmm(e.ts) || '—'} `, c: 'dim' }, { t: stringOf(e.type) || 'event' }]);
    }
  }
  stampLine(snap.memory, '/memory-public');
}

function promiseText(promise) {
  if (typeof promise === 'string') return promise;
  if (promise && typeof promise === 'object') {
    const what = promise.what ?? promise.text ?? promise.description ?? promise.promise;
    const to = promise.to ? `to ${stringOf(promise.to)}` : '';
    const due = promise.due ? `by ${fmtStamp(promise.due)}` : '';
    const parts = [what, to, due].filter(Boolean).map(stringOf);
    if (parts.length) return parts.join(' · ');
    try {
      return JSON.stringify(promise);
    } catch {
      return 'unreadable promise';
    }
  }
  return stringOf(promise);
}

function familyState(id) {
  const item = ENTITIES.find((entry) => entry.id === id);
  if (!item || !item.base) return 'not reachable';
  const snap = snapshotOf(id);
  if (!snap) return 'not reachable';
  if (snap.memorial && snap.memorial.ok) return 'dead';
  const v = snap.vitals && snap.vitals.ok ? snap.vitals.data : null;
  if (v) {
    if (v.state === 'unborn') return 'unborn';
    if (v.state === 'dead') return 'dead';
    return 'alive';
  }
  if (snap.root && snap.root.ok) return 'alive';
  return 'not reachable';
}

/**
 * Nodes of the family graph: every tracked entity, plus URL-only nodes for
 * lineage references beyond the tracking cap. Parent links come from each
 * entity's own `lineage.parent`; children links fill the gaps.
 */
function familyNodes() {
  const nodes = new Map();
  for (const item of ENTITIES) {
    nodes.set(item.id, {
      key: item.id,
      id: item.id,
      name: nameOf(item.id),
      url: item.base,
      state: familyState(item.id),
      parent: null,
      children: [],
      born: null,
    });
  }

  const nodeForUrl = (url, address) => {
    const raw = stringOf(url).trim();
    if (!raw) return null;
    const id = entityIdOfUrl(raw, address);
    if (id && nodes.has(id)) return nodes.get(id);
    const key = `u:${endpointKey(raw) || raw}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        id: null,
        name: shortUrl(raw, 28),
        url: raw,
        state: 'not reachable',
        parent: null,
        children: [],
        born: null,
      });
    }
    return nodes.get(key);
  };

  for (const [, entry] of state.untracked) nodeForUrl(entry && entry.url, null);

  // 1. explicit parents
  for (const item of ENTITIES) {
    const lineage = state.lineages[item.id];
    const node = nodes.get(item.id);
    if (!lineage || !lineage.parent || !node) continue;
    const parent = nodeForUrl(lineage.parent, null);
    if (parent && parent.key !== node.key) node.parent = parent.key;
  }

  // 2. children (a child that declared its own parent keeps it)
  for (const item of ENTITIES) {
    const lineage = state.lineages[item.id];
    const node = nodes.get(item.id);
    if (!lineage || !node) continue;
    for (const child of lineage.children) {
      const childNode = nodeForUrl(child.url, child.address);
      if (!childNode || childNode.key === node.key) continue;
      if (!childNode.parent) childNode.parent = node.key;
    }
  }

  // 3. birth entries enrich the child: born time, gift, and a parent if missing
  for (const item of ENTITIES) {
    for (const entry of entriesOf(snapshotOf(item.id))) {
      if (entryType(entry) !== 'birth_of') continue;
      const d = entry.data && typeof entry.data === 'object' ? entry.data : {};
      const child = nodeForUrl(d.url, d.address);
      if (!child || child.key === item.id) continue;
      if (!child.parent) child.parent = item.id;
      const at = Date.parse(entry.ts) || 0;
      if (child.born && child.born.time >= at) continue;
      const giftZats = Number(d.giftZats);
      child.born = {
        at: entry.ts,
        time: at,
        giftZats: Number.isFinite(giftZats) ? giftZats : null,
        by: item.id,
      };
    }
  }

  // attach children once every parent link is settled
  for (const node of nodes.values()) {
    if (!node.parent) continue;
    const parent = nodes.get(node.parent);
    if (!parent) { node.parent = null; continue; }
    if (!parent.children.includes(node.key)) parent.children.push(node.key);
  }

  return nodes;
}

function cmdFamily() {
  hdr('FAMILY TREE');
  note('lineage as declared by each entity\'s / · discovered through parent and children');
  const nodes = familyNodes();
  if (!nodes.size) {
    note('no entity known yet.');
    return;
  }

  const orderOf = (node) => (node.id ? Number(String(node.id).replace(/^e/, '')) : 1e6);
  const byOrder = (a, b) => (orderOf(a) - orderOf(b)) || a.name.localeCompare(b.name);
  const rootOf = (node) => (!node.parent || !nodes.has(node.parent) ? null : nodes.get(node.parent));
  const roots = [...nodes.values()].filter((node) => !rootOf(node)).sort(byOrder);

  const childrenOf = (node) => node.children
    .map((key) => nodes.get(key))
    .filter(Boolean)
    .sort(byOrder);

  const printed = new Set();
  const labelOf = (node) => {
    const head = node.id
      ? `${node.id}${node.name && node.name !== node.id ? ` ${node.name}` : ''}`
      : node.name;
    let text = `${head} [${node.state}]`;
    if (node.born) {
      const gift = node.born.giftZats === null ? 'not declared' : `${formatZats(node.born.giftZats)} TAZ`;
      text += ` (born ${hhmm(node.born.at) || '—'}, gift ${gift})`;
    }
    return text;
  };

  const walk = (node, prefix, last, root) => {
    if (!node || printed.has(node.key)) return;
    printed.add(node.key);
    const connector = root ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    const cls = node.state === 'dead' ? 'err' : (node.state === 'not reachable' ? 'dim' : '');
    push([{ t: `${connector}${labelOf(node)}`, c: cls }]);
    const kids = childrenOf(node);
    const nextPrefix = root ? '' : `${prefix}${last ? '   ' : '│  '}`;
    kids.forEach((kid, index) => walk(kid, nextPrefix, index === kids.length - 1, false));
  };

  roots.forEach((node) => walk(node, '', true, true));

  // cycles or broken links: print whatever is left as a root
  const rest = [...nodes.values()].filter((node) => !printed.has(node.key)).sort(byOrder);
  for (const node of rest) walk(node, '', true, true);

  const tracked = ENTITIES.length;
  if (tracked > MAX_ENTITIES) {
    note(`on screen: ${MAX_ENTITIES} desks · this tree lists all ${tracked} discovered entities.`);
  }
  if (state.untracked.size) {
    note(`${state.untracked.size} further lineage reference${state.untracked.size === 1 ? '' : 's'} beyond the tracking cap: not reachable.`);
  }
  note('states: alive · unborn · dead · not reachable');
}

function cmdWhispers() {
  hdr('PAID WHISPERS AND LETTERS');
  const rows = [];
  for (const item of screenEntities()) {
    const snap = snapshotOf(item.id);
    if (!snap) continue;
    for (const entry of entriesOf(snap)) {
      const type = entryType(entry);
      const d = entry.data && typeof entry.data === 'object' ? entry.data : {};
      if (type === 'whisper') {
        const toId = entityIdOfUrl(d.to);
        rows.push({
          at: entry.ts,
          kind: 'whisper',
          from: item.id,
          to: toId || shortUrl(d.to, 24),
          zats: Number(d.zats),
          bytes: Number(d.bytes),
        });
      } else if (type === 'letter') {
        rows.push({
          at: entry.ts,
          kind: 'letter',
          from: null,
          to: item.id,
          zats: Number(d.zats),
          bytes: Number(d.bytes),
        });
      }
    }
  }
  rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const list = rows.slice(-20);
  if (!list.length) {
    note('no paid whispers or paid letters in the ledgers read so far.');
  } else {
    for (const row of list) {
      const time = hhmm(row.at) || '—';
      const bytes = Number.isFinite(row.bytes) ? `${formatInt(row.bytes)} bytes` : 'bytes not declared';
      if (row.kind === 'whisper') {
        const amount = Number.isFinite(row.zats) ? `${formatZats(row.zats)} TAZ` : 'amount not declared';
        push([
          { t: `${time} `, c: 'dim' },
          { t: `${row.from} → ${row.to} `, c: 'acc' },
          { t: `· ${amount} · ${bytes}` },
        ]);
      } else {
        push([
          { t: `${time} `, c: 'dim' },
          { t: `${row.to} `, c: 'acc' },
          { t: `receives a paid letter · ${bytes}` },
        ]);
      }
    }
  }
  note('words are shielded: only the recipient reads them.');
}

function cmdMissing() {
  hdr('WHAT IS STILL MISSING');
  for (const item of MISSING) push([{ t: '· ' , c: 'dim' }, { t: item }]);
}

function cmdClear() {
  if (outEl) outEl.replaceChildren();
}

function cmdExit() {
  state.chainGen += 1;
  showLogin();
}

/* ------------------------------------------------------------------ */
/* Refresh                                                             */
/* ------------------------------------------------------------------ */

async function readEntity(id, { light = false } = {}) {
  const item = ENTITIES.find((entry) => entry.id === id) || entity(id);
  if (!item.base) return null;
  const data = light ? await fetchLightSnapshot(item.base) : await fetchSnapshot(item.base);
  const modeKnown = Boolean(
    (data.root && data.root.ok)
    || (data.attestation && data.attestation.ok),
  );
  const previous = state.snaps[id];
  const dev = modeKnown
    ? Boolean(
      (data.root && data.root.ok && data.root.data && data.root.data.mode === 'dev')
      || (data.attestation && data.attestation.ok && data.attestation.data && data.attestation.data.mode === 'dev'),
    )
    : Boolean(previous && previous.dev);
  const checks = light
    ? [
      ['/', data.root],
      ['/vitals', data.vitals],
      ['/memorial', data.memorial],
    ]
    : [
      ['/', data.root],
      ['/vitals', data.vitals],
      ['/memory-public', data.memory],
      ['/public-channel', data.channel],
      ['/ledger', data.ledger],
      ['/verify', data.verify],
      ['/attestation', data.attestation],
      ['/memorial', data.memorial],
    ];
  const failures = checks.filter(([path, res]) => !res.ok && !(path === '/memorial' && res.notFound));
  const anyOk = Boolean(
    (data.root && data.root.ok)
    || (data.vitals && data.vitals.ok)
    || (data.memory && data.memory.ok)
    || (data.channel && data.channel.ok)
    || (data.ledger && data.ledger.ok),
  );

  // the shielded address lets another entity's lineage reference match this one
  if (data.root && data.root.ok && data.root.data) {
    const address = addressOf(data.root.data);
    if (address) {
      item.address = address;
      state.byAddress[address] = item.id;
    }
  }

  return { id, data, at: new Date(), stale: failures.length > 0, dev, failures, anyOk };
}

/**
 * Reads every known entity, then follows `lineage` like `peer`: each newly
 * discovered entity gets an id (e3, e4…), a snapshot and, if among the first
 * six, a desk. Discovery is breadth-first and bounded (4 waves, 12 entities).
 */
async function refresh({ announce = false, quiet = false } = {}) {
  if (!ENTITIES[0].base) {
    err('!! no public endpoint');
    return;
  }

  if (announce) note('reading endpoints…');
  const readIds = new Set();
  let pending = ENTITIES.filter((item) => item.base).map((item) => item.id);
  const reads = [];
  let wave = 0;
  while (pending.length && wave < 4) {
    const batch = pending.filter((id) => !readIds.has(id));
    pending = [];
    if (!batch.length) break;
    for (const id of batch) readIds.add(id);
    const results = await Promise.all(batch.map((id) => readEntity(id, { light: !onScreen(id) })));
    if (state.destroyed) return;
    for (const result of results) {
      if (!result) continue;
      state.snaps[result.id] = {
        data: result.data,
        at: result.at,
        stale: result.stale,
        dev: result.dev,
      };
      reads.push(result);
    }
    pending = discoverLineage().filter((id) => !readIds.has(id));
    wave += 1;
  }

  if (!reads.length) {
    err('!! no snapshot could be read');
    return;
  }

  const failures = [];
  for (const read of reads) {
    for (const [path, res] of read.failures) failures.push({ id: read.id, path, res });
  }
  const anyOk = reads.some((read) => read.anyOk);
  state.stale = reads.some((read) => read.stale);
  state.dev = reads.some((read) => read.dev);
  const times = reads.map((read) => read.at.getTime()).filter(Number.isFinite);
  state.fetchedAt = new Date(times.length ? Math.max(...times) : Date.now());

  if (state.room) {
    state.room.ingest(screenSnapshots(), roomMeta());
  }

  if (!quiet) {
    for (const failure of failures) {
      const prefix = failure.id === 'e1' ? '' : `${failure.id} `;
      err(`!! ${prefix}${failure.path}: ${failure.res.error || 'network unreachable'}`);
    }
    if (anyOk) {
      note(`data read at ${clockTime(state.fetchedAt) || '—'}${state.stale ? ' (stale data)' : ''}`);
    } else {
      err('(stale data) the room shows the last known state');
    }
    if (state.dev) err('!! dev mode: this entity is NOT ATTESTED');
  }
}

/* ------------------------------------------------------------------ */
/* Screen transitions                                                  */
/* ------------------------------------------------------------------ */

function makeWipeText() {
  const rows = Math.max(20, Math.ceil(window.innerHeight / 16));
  const cols = Math.max(40, Math.ceil(window.innerWidth / 9));
  const chars = '░▒▓';
  const out = [];
  for (let y = 0; y < rows; y += 1) {
    let line = '';
    for (let x = 0; x < cols; x += 1) line += chars[Math.floor(Math.random() * chars.length)];
    out.push(line);
  }
  return out.join('\n');
}

function screenWipe(apply) {
  if (reduced.matches || !wipeEl) {
    apply();
    return;
  }
  wipeEl.textContent = makeWipeText();
  wipeEl.hidden = false;
  wipeEl.style.opacity = '1';
  window.setTimeout(() => {
    apply();
    wipeEl.style.opacity = '0';
    window.setTimeout(() => {
      wipeEl.hidden = true;
    }, 200);
  }, 160);
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

function init() {
  app = document.getElementById('app');
  wipeEl = el('pre', { class: 'wipe', 'aria-hidden': 'true', hidden: true });

  applyDevBase(ENTITIES, window.location.search);
  applyDevBase2(ENTITIES, window.location.search);
  rebuildIndexes();

  try {
    state.handle = (localStorage.getItem(HANDLE_KEY) || '').trim().slice(0, 40);
  } catch {
    state.handle = '';
  }

  document.body.appendChild(wipeEl);

  window.addEventListener('keydown', () => {
    state.skipType = true;
  });

  window.setInterval(() => {
    if (document.hidden) return;
    if (state.snaps.e1 && state.room) {
      void refresh({ announce: false, quiet: true });
    }
  }, REFRESH_MS);

  window.addEventListener('beforeunload', () => {
    state.destroyed = true;
    if (state.room) state.room.destroy();
  });

  showLogin();
}

init();
