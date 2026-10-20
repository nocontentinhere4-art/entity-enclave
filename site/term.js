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
  COOLDOWN_MS,
  REFRESH_MS,
  applyDevBase,
  fetchSnapshot,
  postMessage,
  request,
  entryType,
  summarize,
  verifyChain,
  formatInt,
  formatDecimal,
  fixed8,
  fmtStamp,
  fetchedLabel,
  clockTime,
  hhmm,
  stringOf,
  isFuture,
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
  snap: null,
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
};

let app = null;
let wipeEl = null;
let outEl = null;
let promptInput = null;
let promptPrefix = null;

function entity(id = state.selected) {
  return ENTITIES.find((item) => item.id === id) || ENTITIES[0];
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

    const status = el('p', { class: 'login-status', text: 'mystic-like: 2 nodes · entities online: 1/2 · network: …' });

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
    void (async () => {
      const base = ENTITIES[0].base;
      if (!base) return;
      const res = await request(base, '/');
      if (state.destroyed) return;
      let chain = '—';
      let online = '—';
      if (res.ok && res.data) {
        chain = stringOf(res.data.zcash && res.data.zcash.chain) || 'not declared';
        online = '1/2';
      }
      status.textContent = `mystic-like: ${ENTITIES.length} nodes · entities online: ${online} · network: ${chain}`;
    })();
  });
}

/* ------------------------------------------------------------------ */
/* Main screen                                                         */
/* ------------------------------------------------------------------ */

function promptText() {
  const handle = state.handle || 'anonymous';
  const host = entity().base ? `entity-1` : `dim`;
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
    state.snap = null;
    state.fetchedAt = null;

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
    state.room.ingest(null, { stale: true, dev: false, lastRead: null });

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
  return narrow ? { cols: 48, rows: 30, lines: 15, amplitude: 8 } : { cols: 72, rows: 40, lines: 20, amplitude: 11 };
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
    note('Entity 2: not yet online · no face to show (nothing is invented).');
    return;
  }
  const snap = state.snap || {};
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
    case '1': cmdSelect('e1'); break;
    case '2': cmdSelect('e2'); break;
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
    ['1 / 2', 'select entity (2 = not yet online)'],
    ['who', 'identity: name, voice, image'],
    ['status', 'vitals, wallet, brain, attestation'],
    ['treasury', 'TAZ/ZEC, zatoshi, rent/hour, hours left'],
    ['thoughts', 'latest public posts from the entity'],
    ['channel', 'last 20 messages of the public channel'],
    ['say <text>', 'write to the public channel (public!)'],
    ['ledger [n]', 'last n ledger entries (default 15)'],
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
  if (id === 'e2') {
    state.selected = 'e2';
    updatePrompt();
    push([{ t: 'Entity 2: not yet online', c: 'dim' }]);
    note('no endpoint, no estimate, no placeholder. Nothing is simulated.');
    return;
  }
  state.selected = 'e1';
  updatePrompt();
  push([{ t: 'Entity 1 selected', c: 'hi' }]);
}

function offlineOrData() {
  if (state.selected === 'e2') {
    push([{ t: 'Entity 2: not yet online', c: 'dim' }]);
    return null;
  }
  const snap = state.snap;
  if (!snap) {
    err('!! no data read yet · use refresh');
    return null;
  }
  return snap;
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

function cmdThoughts() {
  const snap = offlineOrData();
  if (!snap) return;
  hdr('THOUGHTS (public posts)');
  const list = channelOf(snap).filter((m) => m && m.from === 'entity').slice(-10);
  if (!list.length) {
    note('no public posts.');
  } else {
    for (const m of list) {
      push([{ t: `${hhmm(m.ts) || '—'} `, c: 'dim' }, { t: stringOf(m.text) }]);
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
      const who = fromEntity ? 'e1' : (stringOf(m.author).trim() || 'human');
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
  if (state.selected === 'e2') {
    push([{ t: 'Entity 2: not yet online', c: 'dim' }]);
    return;
  }
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
    if (entry.private === true) {
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

async function refresh({ announce = false, quiet = false } = {}) {
  const e = ENTITIES[0]; // the room always shows the entity with an endpoint
  if (state.selected === 'e2') {
    push([{ t: 'Entity 2: not yet online', c: 'dim' }]);
    return;
  }
  if (!e.base) {
    err('!! no public endpoint');
    return;
  }

  if (announce) note('reading endpoints…');
  const snap = await fetchSnapshot(e.base);
  if (state.destroyed) return;

  const modeKnown = snap.root.ok || snap.attestation.ok;
  const dev = modeKnown
    ? Boolean(
      (snap.root.ok && snap.root.data && snap.root.data.mode === 'dev')
      || (snap.attestation.ok && snap.attestation.data && snap.attestation.data.mode === 'dev'),
    )
    : state.dev;
  const checks = [
    ['/', snap.root],
    ['/vitals', snap.vitals],
    ['/memory-public', snap.memory],
    ['/public-channel', snap.channel],
    ['/ledger', snap.ledger],
    ['/verify', snap.verify],
    ['/attestation', snap.attestation],
    ['/memorial', snap.memorial],
  ];
  const failures = checks.filter(([path, res]) => !res.ok && !(path === '/memorial' && res.notFound));
  const anyOk = snap.root.ok || snap.vitals.ok || snap.memory.ok || snap.channel.ok || snap.ledger.ok;
  state.stale = failures.length > 0;
  state.dev = dev;
  state.snap = snap;
  state.fetchedAt = new Date();

  if (state.room) {
    state.room.ingest(snap, { stale: state.stale, dev, lastRead: state.fetchedAt });
  }

  if (!quiet) {
    for (const [path, res] of failures) {
      err(`!! ${path}: ${res.error || 'network unreachable'}`);
    }
    if (anyOk) {
      note(`data read at ${clockTime(state.fetchedAt) || '—'}${state.stale ? ' (stale data)' : ''}`);
    } else {
      err('(stale data) the room shows the last known state');
    }
    if (dev) err('!! dev mode: this entity is NOT ATTESTED');
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
    if (state.selected === 'e2') return;
    if (state.snap && state.room) {
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
