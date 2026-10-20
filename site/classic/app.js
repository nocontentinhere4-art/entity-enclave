/*
 * Public window onto the sovereign entities.
 * No framework, no dependencies, no requests beyond the entities' bases.
 * Everything arriving from the network enters the DOM via textContent, never innerHTML.
 */

export const ENTITIES = [
  {
    id: 'e1',
    label: 'Entity 1',
    base: 'https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network',
  },
  { id: 'e2', label: 'Entity 2', base: null }, // not deployed yet
];

const MISSING = [
  'second entity',
  'paid whispers',
  'cryptographic verification of the quotes in the browser',
  'verification of the inference provider attestation',
  'token',
];

const ZERO_HASH = '0'.repeat(64);
const FETCH_TIMEOUT_MS = 20000;
const REFRESH_MS = 60000;
const COOLDOWN_MS = 60000;
const MAX_LEDGER_ROWS = 100;

const INT_FMT = new Intl.NumberFormat('en-GB');
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const STAMP_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const SHORT_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const encoder = new TextEncoder();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  id: null,
  entity: null,
  refs: null,
  run: 0,
  loading: false,
  ledger: null,
  filter: 'all',
  channelMessages: [],
  sending: false,
  cooldownUntil: 0,
  cooldownTimer: null,
  autoTimer: null,
};

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function append(node, children) {
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

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(node, children);
  return node;
}

function textNode(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

function pending(message) {
  return el('p', { class: 'pending', text: message });
}

function empty(message) {
  return el('p', { class: 'empty', text: message });
}

function label(value) {
  return el('p', { class: 'label', text: value });
}

function facts(rows, className = 'facts') {
  const dl = el('dl', { class: className });
  for (const row of rows) {
    if (!row) continue;
    const [term, value] = row;
    if (value === null || value === undefined) continue;
    const dd = el('dd');
    append(dd, [value instanceof Node ? value : textNode(value)]);
    dl.appendChild(el('div', { class: 'fact' }, el('dt', { text: term }), dd));
  }
  return dl;
}

function errorBlock(path, res) {
  return el('div', { class: 'error-block', role: 'status' },
    el('p', { class: 'error-title', text: `Cannot read ${path}` }),
    el('p', { class: 'error-text', text: (res && res.error) || 'unknown error' }),
    res && res.at ? el('p', { class: 'src', text: fetchedLabel(res.at) }) : null,
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function stringOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function timeOf(value) {
  const d = toDate(value);
  return d ? TIME_FMT.format(d) : '—';
}

function fmtStamp(value) {
  const d = toDate(value);
  return d ? STAMP_FMT.format(d) : (value ? String(value) : '—');
}

function fmtShort(value) {
  const d = toDate(value);
  return d ? SHORT_FMT.format(d) : (value ? String(value) : '—');
}

function fetchedLabel(at) {
  const d = toDate(at);
  if (!d) return 'fetch time not available';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `read at ${TIME_FMT.format(d)}` : `read on ${STAMP_FMT.format(d)}`;
}

function sourceLine(parts) {
  const seen = new Set();
  const labels = [];
  for (const [path, at] of parts) {
    if (!at) continue;
    const key = `${path}|${at instanceof Date ? at.toISOString() : String(at)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(`${path} ${fetchedLabel(at)}`);
  }
  return labels.length ? labels.join(' · ') : 'fetch time not available';
}

function fixed8(zats) {
  const n = Number(zats);
  return Number.isFinite(n) ? (n / 1e8).toFixed(8) : null;
}

function formatInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? INT_FMT.format(n) : '—';
}

function formatDecimal(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

function shortHash(value) {
  return typeof value === 'string' && value ? `${value.slice(0, 16)}…` : '—';
}

function isFuture(value) {
  const d = toDate(value);
  return Boolean(d && d.getTime() > Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

function describeNetworkError(err) {
  if (err && err.name === 'AbortError') return `no response within ${FETCH_TIMEOUT_MS / 1000} s`;
  if (err instanceof SyntaxError) return 'invalid response (JSON expected)';
  return 'network unreachable (or CORS)';
}

async function request(base, path, options = {}) {
  const asText = options.text === true;
  const allow404 = options.allow404 === true;
  const at = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(base + path, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      headers: { accept: asText ? 'text/plain, */*' : 'application/json' },
      signal: controller.signal,
    });
    if (allow404 && response.status === 404) {
      return { ok: false, notFound: true, status: 404, at, path };
    }
    if (!response.ok) {
      let detail = '';
      try {
        const raw = await response.text();
        detail = raw.trim().slice(0, 240);
      } catch {
        detail = '';
      }
      return {
        ok: false,
        status: response.status,
        at,
        path,
        error: `HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
      };
    }
    if (asText) {
      const body = await response.text();
      return { ok: true, status: response.status, at, path, text: body };
    }
    const data = await response.json();
    return { ok: true, status: response.status, at, path, data };
  } catch (err) {
    return { ok: false, at, path, error: describeNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postMessage(base, payload) {
  const at = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/public-channel`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      raw = '';
    }
    let data = null;
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const serverError = data && typeof data.error === 'string'
        ? data.error
        : (raw.trim().slice(0, 240) || `HTTP ${response.status}`);
      return { ok: false, status: response.status, at, error: serverError };
    }
    return { ok: true, status: response.status, at, data };
  } catch (err) {
    return { ok: false, at, error: describeNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Tabs and state                                                      */
/* ------------------------------------------------------------------ */

function buildTabs() {
  tabsEl.replaceChildren(...ENTITIES.map((entity, index) =>
    el('button', {
      class: 'tab',
      type: 'button',
      onclick: () => selectEntity(entity.id),
    },
    el('span', { class: 'tab-num', 'aria-hidden': 'true', text: String(index + 1).padStart(2, '0') }),
    el('span', { text: entity.label }),
    )));
  syncTabs();
}

function syncTabs() {
  Array.from(tabsEl.children).forEach((button, index) => {
    if (ENTITIES[index] && ENTITIES[index].id === state.id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function setDocumentTitle(entity) {
  document.title = entity.base
    ? `${entity.label} — public window`
    : `${entity.label} — not yet online`;
}

function selectEntity(id) {
  const entity = ENTITIES.find((item) => item.id === id) || ENTITIES[0];
  if (state.id === entity.id && state.refs) return;

  stopCooldownTimer();
  state.cooldownUntil = 0;
  state.id = entity.id;
  state.entity = entity;
  state.refs = null;
  state.ledger = null;
  state.filter = 'all';
  state.channelMessages = [];
  state.sending = false;
  state.loading = false;
  state.run += 1;

  try {
    history.replaceState(null, '', `#${entity.id}`);
  } catch {
    /* a static file may block replaceState: switching entities still works */
  }

  syncTabs();
  setDocumentTitle(entity);

  if (!entity.base) {
    buildOffline(entity);
    return;
  }

  buildShell(entity);
  void load(entity, { animate: true });
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function makeSection(number, title) {
  const src = el('p', { class: 'section-src src', text: '' });
  const heading = el('h2', { text: title });
  const body = el('div', { class: 'section-body' });
  const section = el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('span', { class: 'section-num', 'aria-hidden': 'true', text: number }),
      heading,
      src,
    ),
    body,
  );
  return { section, heading, src, body };
}

function buildOffline(entity) {
  const article = el('article', { class: 'offline' },
    el('p', { class: 'eyebrow' },
      entity.label,
      el('span', { class: 'eyebrow-sep', text: '·' }),
      'public window',
    ),
    el('div', { class: 'head-line' },
      el('h1', { class: 'offline-title', text: 'Not yet online' }),
      el('div', { class: 'badges' },
        el('span', { class: 'badge is-unborn' },
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          el('span', { text: 'not deployed' }),
        ),
      ),
    ),
    el('p', { class: 'offline-quote', text: 'Same image, same brain, different seed: it will arrive once the first one has proven it can live.' }),
    el('p', { class: 'src offline-src', text: 'base: null · no public endpoint · no estimates, no placeholders' }),
    el('div', { class: 'offline-chain' },
      el('span', { class: 'label', text: 'Chain' }),
      el('p', { class: 'offline-chain-text', text: 'Nothing to verify yet: the entity has not been deployed.' }),
    ),
    makeMissingSection('06'),
  );

  view.replaceChildren(article);
  window.scrollTo(0, 0);
}

function makeMissingSection(number) {
  return el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('span', { class: 'section-num', 'aria-hidden': 'true', text: number }),
      el('h2', { text: 'What is not here yet' }),
    ),
    el('ol', { class: 'missing' },
      ...MISSING.map((item) => el('li', { text: item })),
    ),
  );
}

function buildShell(entity) {
  const refs = {};

  const warning = el('div', { class: 'warning', role: 'status', hidden: true });
  refs.warning = warning;

  const entityName = el('h1', { class: 'entity-name', id: 'entity-name', text: '—' });
  const badges = el('div', { class: 'badges' });
  const attest = el('p', { class: 'head-attest' });
  const headerSrc = el('p', { class: 'src head-src', text: 'reading the endpoints…' });
  const refresh = el('button', {
    class: 'btn-refresh',
    type: 'button',
    onclick: () => {
      if (state.entity && state.entity.base && !state.loading) {
        void load(state.entity, { animate: true, manual: true });
      }
    },
  }, 'Refresh');

  const header = el('header', { class: 'entity-head' },
    el('p', { class: 'eyebrow' },
      entity.label,
      el('span', { class: 'eyebrow-sep', text: '·' }),
      'public window',
    ),
    el('div', { class: 'head-line' }, entityName, badges),
    attest,
    el('div', { class: 'head-meta' }, headerSrc, refresh),
  );

  const chainMark = el('span', { class: 'chain-mark', 'aria-hidden': 'true', text: '◇' });
  const chainTitle = el('h2', { class: 'chain-title', text: 'waiting for the ledger…' });
  const chainCount = el('span', { class: 'chain-count', text: '—' });
  const chainDetail = el('p', { class: 'chain-detail', text: 'verification starts as soon as /ledger responds' });
  const chainFill = el('span', { class: 'chain-fill' });
  const chain = el('section', { class: 'chain is-pending', 'aria-live': 'polite' },
    el('div', { class: 'chain-head' },
      el('span', { class: 'label', text: 'Chain' }),
      chainCount,
    ),
    el('div', { class: 'chain-line' }, chainMark, chainTitle),
    chainDetail,
    el('div', { class: 'chain-track', 'aria-hidden': 'true' }, chainFill),
  );

  refs.entityName = entityName;
  refs.badges = badges;
  refs.attest = attest;
  refs.headerSrc = headerSrc;
  refs.refresh = refresh;
  refs.chain = chain;
  refs.chainMark = chainMark;
  refs.chainTitle = chainTitle;
  refs.chainCount = chainCount;
  refs.chainDetail = chainDetail;
  refs.chainFill = chainFill;

  const vitals = makeSection('01', 'Vitals');
  const identity = makeSection('02', 'Identity');
  const channel = makeSection('03', 'Public channel');
  const ledger = makeSection('04', 'Ledger');
  const attestation = makeSection('05', 'Attestation');

  refs.vitalsHeading = vitals.heading;
  refs.vitalsSrc = vitals.src;
  refs.vitalsBody = vitals.body;
  refs.identitySrc = identity.src;
  refs.identityBody = identity.body;
  refs.channelSrc = channel.src;
  refs.ledgerSrc = ledger.src;
  refs.attestSrc = attestation.src;
  refs.attestBody = attestation.body;

  refs.vitalsBody.appendChild(pending('reading /vitals…'));
  refs.identityBody.appendChild(pending('reading /memory-public…'));
  refs.attestBody.appendChild(pending('reading /attestation…'));

  /* Channel: list + composer (the composer is not rebuilt on refresh) */
  const messages = el('div', { class: 'messages' }, pending('reading /public-channel…'));
  const authorInput = el('input', {
    id: 'author', name: 'author', type: 'text', maxlength: '40',
    autocomplete: 'nickname', placeholder: 'optional',
  });
  const textInput = el('textarea', {
    id: 'message', name: 'message', maxlength: '500', rows: '4',
    placeholder: 'Write something public…',
  });
  const counter = el('span', { class: 'counter', text: '0 / 500' });
  const sendNote = el('span', { class: 'send-note', text: '' });
  const formError = el('p', { class: 'form-error', role: 'status', 'aria-live': 'polite', text: '' });
  const send = el('button', { class: 'send', type: 'submit' }, 'Send to the ledger');
  const form = el('form', { class: 'composer', novalidate: true },
    el('p', { class: 'notice', text: 'Everything you write here is public and goes into the ledger. The entity reads messages at the next cycle (≤ 15 min) and decides whether to reply.' }),
    el('div', { class: 'field' },
      el('label', { for: 'author', text: 'Name (optional)' }),
      authorInput,
    ),
    el('div', { class: 'field' },
      el('label', { for: 'message', text: 'Message' }),
      textInput,
    ),
    el('div', { class: 'composer-foot' },
      el('span', { class: 'composer-count' }, counter, sendNote),
      send,
    ),
    formError,
  );

  textInput.addEventListener('input', updateCounter);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.sending) void sendMessage(entity);
  });

  refs.messages = messages;
  refs.authorInput = authorInput;
  refs.textInput = textInput;
  refs.counter = counter;
  refs.sendNote = sendNote;
  refs.formError = formError;
  refs.send = send;

  channel.body.append(messages, form);

  /* Ledger */
  const typeFilter = el('select', { class: 'select', id: 'type-filter', 'aria-label': 'Filter the ledger by type' },
    el('option', { value: 'all', text: 'all types' }),
  );
  typeFilter.addEventListener('change', () => {
    state.filter = typeFilter.value;
    renderLedgerRows();
  });
  const rawLedger = el('a', {
    class: 'raw-link',
    href: `${entity.base}/ledger`,
    target: '_blank',
    rel: 'noreferrer noopener',
    text: 'Open /ledger (NDJSON) ↗',
  });
  const ledgerTable = el('div', { class: 'ledger-table' }, pending('reading /ledger…'));
  const ledgerNote = el('p', { class: 'table-note', text: '' });
  const browserResult = el('p', { class: 'verify-result', text: 'in progress…' });
  const browserDetail = el('p', { class: 'src verify-detail', text: '' });
  const serverResult = el('p', { class: 'verify-result', text: 'waiting…' });
  const serverDetail = el('p', { class: 'src verify-detail', text: '' });
  const verifyBlock = el('div', { class: 'verify' },
    el('div', { class: 'verify-col' },
      label('In the browser'),
      browserResult,
      browserDetail,
    ),
    el('div', { class: 'verify-col' },
      label('On the server'),
      serverResult,
      serverDetail,
    ),
  );

  refs.filter = typeFilter;
  refs.ledgerTable = ledgerTable;
  refs.ledgerTbody = null;
  refs.ledgerNote = ledgerNote;
  refs.browserResult = browserResult;
  refs.browserDetail = browserDetail;
  refs.serverResult = serverResult;
  refs.serverDetail = serverDetail;

  ledger.body.append(
    el('div', { class: 'ledger-tools' },
      el('div', { class: 'filter' },
        el('label', { class: 'label', for: 'type-filter', text: 'Type' }),
        typeFilter,
      ),
      rawLedger,
    ),
    ledgerTable,
    ledgerNote,
    verifyBlock,
  );

  const article = el('article', { class: 'entity' },
    header,
    warning,
    chain,
    vitals.section,
    identity.section,
    channel.section,
    ledger.section,
    attestation.section,
    makeMissingSection('06'),
  );

  view.replaceChildren(article);
  state.refs = refs;

  state.cooldownUntil = readCooldown(entity.id);
  if (state.cooldownUntil > Date.now()) {
    state.cooldownTimer = setInterval(tickCooldown, 1000);
  } else {
    state.cooldownUntil = 0;
  }
  updateCounter();
  updateSendButton();

  setSealPending();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ */
/* Caricamento                                                         */
/* ------------------------------------------------------------------ */

async function load(entity, options = {}) {
  if (!entity.base) return;
  const animate = options.animate === true;
  const run = ++state.run;

  state.loading = true;
  setRefresh(true);
  if (state.refs) {
    state.refs.headerSrc.textContent = options.manual ? 'manual refresh requested…' : 'refreshing…';
    if (animate) setSealPending();
  }

  const base = entity.base;
  const [root, vitals, memory, channel, ledger, verify, attestation, memorial] = await Promise.all([
    request(base, '/'),
    request(base, '/vitals'),
    request(base, '/memory-public'),
    request(base, '/public-channel'),
    request(base, '/ledger', { text: true }),
    request(base, '/verify'),
    request(base, '/attestation'),
    request(base, '/memorial', { allow404: true }),
  ]);

  if (run !== state.run || state.id !== entity.id || !state.refs) return;

  try {
    const memorialData = memorial.ok ? memorial.data : null;
    renderWarning(root, attestation);
    renderHeader({ root, vitals, memory, memorial: memorialData, memorialAt: memorial.at, attestation });
    renderVitals({ vitals, root, memorial: memorialData, memorialAt: memorial.at });
    renderIdentity({ memory });
    state.channelMessages = channel.ok && Array.isArray(channel.data) ? channel.data : [];
    renderChannel({ channel });
    renderLedger({ ledger });
    renderAttestation({ attestation, root });
    setBrowserPending();
    await verifyLedger(ledger, { animate, run, verifyRes: verify });
  } finally {
    if (run === state.run) {
      state.loading = false;
      setRefresh(false);
    }
  }
}

function setRefresh(busy) {
  const refs = state.refs;
  if (!refs || !refs.refresh) return;
  refs.refresh.disabled = busy;
  refs.refresh.textContent = busy ? 'Refreshing…' : 'Refresh';
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function renderWarning(root, attestation) {
  const refs = state.refs;
  if (!refs) return;
  const mode = (root.ok && root.data && root.data.mode)
    || (attestation.ok && attestation.data && attestation.data.mode)
    || null;
  if (mode === 'dev') {
    refs.warning.hidden = false;
    refs.warning.replaceChildren(
      el('strong', { text: 'Dev mode.' }),
      textNode(' This entity is NOT attested: the data does not come from a verified TEE.'),
    );
  } else {
    refs.warning.hidden = true;
    refs.warning.replaceChildren();
  }
}

function renderHeader({ root, vitals, memory, memorial, memorialAt, attestation }) {
  const refs = state.refs;
  if (!refs) return;

  let name = 'unnamed';
  let nameSource = null;
  if (root.ok && root.data) {
    const candidate = stringOf(root.data.entity).trim();
    if (candidate && candidate !== 'unnamed') {
      name = candidate;
      nameSource = 'root';
    }
  } else if (memory.ok && memory.data && memory.data.identity) {
    const candidate = stringOf(memory.data.identity.name).trim();
    if (candidate) {
      name = candidate;
      nameSource = 'memory';
    }
  }
  refs.entityName.textContent = name;

  let stateLabel = 'state not available';
  let stateKind = 'unknown';
  if (memorial) {
    stateLabel = 'dead';
    stateKind = 'dead';
  } else if (vitals.ok && vitals.data) {
    const v = vitals.data;
    if (v.state === 'unborn') {
      stateLabel = 'unborn';
      stateKind = 'unborn';
    } else if (v.state === 'alive') {
      if (isFuture(v.sleepUntil)) {
        stateLabel = 'paused';
        stateKind = 'paused';
      } else {
        stateLabel = 'alive';
        stateKind = 'alive';
      }
    } else if (v.state === 'dead') {
      stateLabel = 'dead';
      stateKind = 'dead';
    } else if (v.state === 'paused') {
      stateLabel = 'paused';
      stateKind = 'paused';
    }
  } else if (vitals.error) {
    stateLabel = 'state not available';
    stateKind = 'unknown';
  }

  refs.badges.replaceChildren(
    el('span', { class: `badge is-${stateKind}` },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: stateLabel }),
    ),
  );

  const attMode = (attestation.ok && attestation.data && attestation.data.mode)
    || (root.ok && root.data && root.data.attestation && root.data.attestation.mode)
    || null;

  let attText = 'attestation not available';
  let attClass = 'is-unknown';
  if (attMode === 'tee') {
    attText = 'TDX attestation present, not verified in the browser';
    attClass = 'is-tee';
  } else if (attMode === 'dev') {
    attText = 'NOT attested';
    attClass = 'is-dev';
  }

  refs.attest.className = 'head-attest';
  refs.attest.replaceChildren(
    el('span', { class: `attest-badge ${attClass}` },
      el('span', { class: 'attest-label', text: 'Attestation' }),
      el('span', { text: attText }),
    ),
  );

  const read = [];
  if (root.ok) read.push(['/', root.at]);
  if (vitals.ok && !memorial) read.push(['/vitals', vitals.at]);
  if (nameSource === 'memory') read.push(['/memory-public', memory.at]);
  if (attestation.ok) read.push(['/attestation', attestation.at]);
  if (memorial) read.push(['/memorial', memorialAt]);

  const failures = [];
  if (!root.ok) failures.push('/');
  if (!vitals.ok && !memorial) failures.push('/vitals');

  refs.headerSrc.textContent = [
    read.length ? sourceLine(read) : 'no successful read',
    failures.length ? `failed to read: ${failures.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ */
/* Vitals                                                              */
/* ------------------------------------------------------------------ */

function renderVitals({ vitals, root, memorial, memorialAt }) {
  const refs = state.refs;
  if (!refs) return;

  if (memorial) {
    refs.vitalsHeading.textContent = 'Memorial';
    refs.vitalsSrc.textContent = `/memorial · ${fetchedLabel(memorialAt)}`;
    refs.vitalsBody.replaceChildren(
      el('div', { class: 'memorial' },
        el('p', { class: 'label', text: 'Public memorial' }),
        el('p', { class: 'memorial-note', text: 'The entity has died. In place of the vitals, the memorial served by /memorial.' }),
        el('pre', { class: 'raw', text: safeJSON(memorial) }),
      ),
    );
    return;
  }

  refs.vitalsHeading.textContent = 'Vitals';
  refs.vitalsSrc.textContent = sourceLine([
    ['/vitals', vitals.at],
    ...(root.ok ? [['/', root.at]] : []),
  ]);

  if (!vitals.ok) {
    refs.vitalsBody.replaceChildren(errorBlock('/vitals', vitals));
    return;
  }

  const v = vitals.data || {};
  const chain = root.ok && root.data && root.data.zcash ? root.data.zcash.chain : null;
  const unit = chain === 'testnet' ? 'TAZ' : 'ZEC';
  const amount = fixed8(v.zatoshis);
  const rawZats = Number(v.zatoshis);

  const network = chain
    ? el('span', { class: `net${chain === 'testnet' ? ' is-testnet' : ''}`, text: chain })
    : 'not declared';

  const hunger = v.hunger === 'hungry'
    ? 'hungry'
    : (v.hunger === 'ok' ? 'full' : 'not declared');

  const wallet = v.wallet && typeof v.wallet === 'object'
    ? (v.wallet.ok === false
      ? `error${v.wallet.fault ? ` · ${stringOf(v.wallet.fault)}` : ''}`
      : (v.wallet.sync
        ? (v.wallet.sync.ok === false
          ? `sync failed${v.wallet.sync.at ? ` · ${fmtStamp(v.wallet.sync.at)}` : ''}`
          : `height ${formatInt(v.wallet.sync.height)} · ${fmtStamp(v.wallet.sync.at)}`)
        : 'sync not declared'))
    : 'not declared';

  const treasury = el('div', { class: 'treasury' },
    el('p', { class: 'treasury-amount' },
      el('span', { class: 'amount', text: amount === null ? '—' : amount }),
      amount === null ? null : textNode(' '),
      el('span', { class: 'unit', text: amount === null ? '' : unit }),
    ),
    el('p', { class: 'treasury-raw', text: Number.isFinite(rawZats) ? `${formatInt(rawZats)} zatoshi` : 'zatoshi not declared' }),
  );

  const rows = [
    ['Hours left', Number.isFinite(Number(v.hoursLeft)) ? `${formatDecimal(v.hoursLeft, 2)} h` : 'not declared'],
    ['Hunger', hunger],
    ['Days of life', Number.isFinite(Number(v.daysAlive)) ? `${formatDecimal(v.daysAlive, 2)} days` : 'not declared'],
    ['Born on', fmtStamp(v.bornAt)],
    ['Wallet', wallet],
    ['Network', network],
  ];

  if (v.sleepUntil) {
    rows.push(['Paused until', fmtStamp(v.sleepUntil)]);
  }
  if (root.ok && root.data && root.data.zcash && root.data.zcash.error) {
    rows.push(['Wallet error (/)', el('span', { class: 'danger-text', text: stringOf(root.data.zcash.error) })]);
  }

  const nodes = [treasury, facts(rows)];

  const brain = Array.isArray(v.brain) ? v.brain : [];
  const brainBox = el('div', { class: 'brain' },
    label('Inference providers'),
    brain.length
      ? el('ul', { class: 'roster' }, ...brain.map((provider) => {
        const p = provider && typeof provider === 'object' ? provider : {};
        const keyConfigured = p.keyConfigured === true;
        return el('li', {},
          el('span', { class: 'roster-name', text: stringOf(p.name) || 'unnamed' }),
          el('span', { class: 'roster-model', text: stringOf(p.model) || 'model not declared' }),
          el('span', { class: 'roster-speed', text: stringOf(p.speed) || '—' }),
          el('span', { class: `roster-key${keyConfigured ? '' : ' is-missing'}`, text: keyConfigured ? 'key configured' : 'key missing' }),
        );
      }))
      : empty('no provider declared.'),
  );
  nodes.push(brainBox);

  refs.vitalsBody.replaceChildren(...nodes);
}

function safeJSON(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'memorial not serializable';
  }
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

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

function renderIdentity({ memory }) {
  const refs = state.refs;
  if (!refs) return;
  refs.identitySrc.textContent = `/memory-public · ${fetchedLabel(memory.at)}`;

  if (!memory.ok) {
    refs.identityBody.replaceChildren(errorBlock('/memory-public', memory));
    return;
  }

  const m = memory.data && typeof memory.data === 'object' ? memory.data : {};
  const identity = m.identity && typeof m.identity === 'object' ? m.identity : null;
  const nodes = [];

  if (!identity || (!identity.name && !identity.voice && !identity.image)) {
    nodes.push(empty('has not given itself a name yet.'));
  } else {
    nodes.push(facts([
      ['Name', stringOf(identity.name).trim() || 'unnamed'],
      ['Voice', stringOf(identity.voice).trim() || 'not declared'],
      ['Image', stringOf(identity.image).trim() || 'not declared'],
    ], 'facts identity-facts'));
  }

  nodes.push(el('div', { class: 'plan-block' },
    label('Plan'),
    m.plan
      ? el('p', { class: 'plan', text: stringOf(m.plan) })
      : empty('no plan published.'),
  ));

  const promises = Array.isArray(m.promises) ? m.promises : [];
  nodes.push(el('div', { class: 'promises-block' },
    label('Open promises'),
    promises.length
      ? el('ol', { class: 'promises' },
        ...promises.map((promise) => el('li', { text: promiseText(promise) })),
      )
      : empty('no open promises.'),
  ));

  refs.identityBody.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ */
/* Public channel                                                      */
/* ------------------------------------------------------------------ */

function renderChannel({ channel }) {
  const refs = state.refs;
  if (!refs) return;
  refs.channelSrc.textContent = `/public-channel · ${fetchedLabel(channel.at)}`;

  if (!channel.ok) {
    refs.messages.replaceChildren(errorBlock('/public-channel', channel));
    return;
  }
  if (!Array.isArray(channel.data)) {
    refs.messages.replaceChildren(el('div', { class: 'error-block' },
      el('p', { class: 'error-title', text: 'The channel responded in an unexpected format' }),
      el('p', { class: 'error-text', text: 'Expected a list of messages.' }),
    ));
    return;
  }
  state.channelMessages = channel.data;
  renderMessageList();
}

function renderMessageList() {
  const refs = state.refs;
  if (!refs || !refs.messages) return;
  const messages = state.channelMessages;

  if (!messages.length) {
    refs.messages.replaceChildren(empty('No public messages yet. The channel is open.'));
    return;
  }

  refs.messages.replaceChildren(...messages.map((message) => {
    const m = message && typeof message === 'object' ? message : {};
    const fromEntity = m.from === 'entity';
    const who = fromEntity
      ? 'entity'
      : (stringOf(m.author).trim() || 'human');
    const meta = el('p', { class: 'message-meta' },
      el('span', { class: 'who', text: who }),
      el('span', { class: 'meta-sep', text: '·' }),
      el('time', { datetime: stringOf(m.ts) || undefined, text: fmtStamp(m.ts) }),
      m.seq !== null && m.seq !== undefined ? el('span', { class: 'meta-sep', text: '·' }) : null,
      m.seq !== null && m.seq !== undefined ? el('span', { text: `entry ${m.seq}` }) : null,
    );
    return el('article', { class: `message from-${fromEntity ? 'entity' : 'human'}` },
      meta,
      el('p', { class: 'message-text', text: stringOf(m.text) }),
    );
  }));
}

function updateCounter() {
  const refs = state.refs;
  if (!refs || !refs.textInput || !refs.counter) return;
  refs.counter.textContent = `${refs.textInput.value.length} / 500`;
}

function showFormError(message) {
  const refs = state.refs;
  if (!refs || !refs.formError) return;
  refs.formError.textContent = message || '';
}

function cooldownKey(entityId) {
  return `sov-ui:cooldown:${entityId}`;
}

function readCooldown(entityId) {
  try {
    const raw = localStorage.getItem(cooldownKey(entityId));
    const until = Number(raw);
    if (Number.isFinite(until) && until > Date.now()) return until;
    if (raw) localStorage.removeItem(cooldownKey(entityId));
  } catch {
    /* storage can be denied: the limit only stays in memory */
  }
  return 0;
}

function writeCooldown(entityId, until) {
  try {
    if (until > Date.now()) localStorage.setItem(cooldownKey(entityId), String(until));
    else localStorage.removeItem(cooldownKey(entityId));
  } catch {
    /* no problem: the button stays disabled in memory anyway */
  }
}

function stopCooldownTimer() {
  if (state.cooldownTimer) {
    clearInterval(state.cooldownTimer);
    state.cooldownTimer = null;
  }
}

function beginCooldown(entityId, ms = COOLDOWN_MS) {
  state.cooldownUntil = Date.now() + ms;
  writeCooldown(entityId, state.cooldownUntil);
  stopCooldownTimer();
  tickCooldown();
  state.cooldownTimer = setInterval(tickCooldown, 1000);
}

function tickCooldown() {
  if (state.cooldownUntil <= Date.now()) {
    state.cooldownUntil = 0;
    if (state.id) writeCooldown(state.id, 0);
    stopCooldownTimer();
  }
  updateSendButton();
}

function updateSendButton() {
  const refs = state.refs;
  if (!refs || !refs.send) return;

  const left = Math.max(0, state.cooldownUntil - Date.now());
  if (state.sending) {
    refs.send.disabled = true;
    refs.send.textContent = 'Sending…';
    refs.sendNote.textContent = '';
    return;
  }
  if (left > 0) {
    refs.send.disabled = true;
    refs.send.textContent = 'Send to the ledger';
    refs.sendNote.textContent = `you can write again in ${Math.ceil(left / 1000)} s`;
    return;
  }
  refs.send.disabled = false;
  refs.send.textContent = 'Send to the ledger';
  refs.sendNote.textContent = '';
}

async function sendMessage(entity) {
  const refs = state.refs;
  if (!refs || state.sending) return;

  const text = refs.textInput.value.trim();
  const author = refs.authorInput.value.trim();

  if (!text) {
    showFormError('Write a message before sending.');
    refs.textInput.focus();
    return;
  }
  if (text.length > 500) {
    showFormError('The message exceeds 500 characters.');
    return;
  }
  if (author.length > 40) {
    showFormError('The name exceeds 40 characters.');
    return;
  }
  if (state.cooldownUntil > Date.now()) {
    updateSendButton();
    return;
  }

  state.sending = true;
  showFormError('');
  updateSendButton();

  const payload = { text };
  if (author) payload.author = author;

  const result = await postMessage(entity.base, payload);

  if (state.entity && state.entity.id !== entity.id) {
    state.sending = false;
    return;
  }

  state.sending = false;

  if (!result.ok) {
    showFormError(result.error || `Send failed${result.status ? ` (HTTP ${result.status})` : ''}.`);
    if (result.status === 429 && /one message per minute/i.test(result.error || '')) {
      beginCooldown(entity.id);
    }
    updateSendButton();
    return;
  }

  refs.textInput.value = '';
  updateCounter();
  beginCooldown(entity.id);

  const localMessage = {
    seq: result.data && result.data.seq,
    ts: (result.data && result.data.ts) || new Date().toISOString(),
    from: 'human',
    author: author || undefined,
    text,
  };
  state.channelMessages = [...state.channelMessages, localMessage];
  renderMessageList();

  await refreshChannel(entity);
}

async function refreshChannel(entity) {
  const res = await request(entity.base, '/public-channel');
  if (!state.entity || state.entity.id !== entity.id || !state.refs) return;
  state.refs.channelSrc.textContent = `/public-channel · ${fetchedLabel(res.at)}`;

  if (res.ok && Array.isArray(res.data)) {
    state.channelMessages = res.data;
    renderMessageList();
  } else {
    showFormError(`Message sent. Re-reading the channel failed: ${res.error || 'unexpected format'}.`);
  }
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

function parseLedger(text) {
  const entries = [];
  let parseErrors = 0;
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
      else parseErrors += 1;
    } catch {
      parseErrors += 1;
    }
  }
  return { entries, parseErrors };
}

function entryType(entry) {
  return stringOf(entry && entry.type).trim() || 'untyped';
}

const SECRET_KEY = /secret|seed|ufvk|private|api[_-]?key|viewing|key|ciphertext/i;

function scrub(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  return value;
}

function summarize(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  if (e.private === true) {
    const size = Number(e.size);
    return Number.isFinite(size)
      ? `private entry, encrypted, ${formatInt(size)} bytes`
      : 'private entry, encrypted, size not declared';
  }
  try {
    const compact = JSON.stringify(scrub(e.data));
    if (!compact) return '—';
    return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
  } catch {
    return 'data not serializable';
  }
}

function renderLedger({ ledger }) {
  const refs = state.refs;
  if (!refs) return;
  refs.ledgerSrc.textContent = `/ledger · ${fetchedLabel(ledger.at)}`;
  refs.ledgerTbody = null;

  if (!ledger.ok) {
    state.ledger = { entries: [], parseErrors: 0 };
    refs.ledgerTable.replaceChildren(errorBlock('/ledger', ledger));
    refs.ledgerNote.textContent = '';
    refs.filter.replaceChildren(el('option', { value: 'all', text: 'all types' }));
    refs.filter.value = 'all';
    refs.filter.disabled = true;
    return;
  }

  const parsed = parseLedger(ledger.text);
  state.ledger = parsed;

  const tbody = el('tbody');
  refs.ledgerTbody = tbody;
  const table = el('table', { class: 'ledger' },
    el('caption', { class: 'sr-only', text: 'Last 100 entries of the public ledger' }),
    el('thead', {},
      el('tr', {},
        el('th', { scope: 'col', text: 'Seq' }),
        el('th', { scope: 'col', text: 'Time' }),
        el('th', { scope: 'col', text: 'Type' }),
        el('th', { scope: 'col', text: 'Data' }),
      ),
    ),
    tbody,
  );
  refs.ledgerTable.replaceChildren(table);

  buildTypeFilter(parsed.entries);
  renderLedgerRows();
}

function buildTypeFilter(entries) {
  const refs = state.refs;
  if (!refs || !refs.filter) return;

  const counts = new Map();
  for (const entry of entries) {
    const type = entryType(entry);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const types = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'en-GB'));

  if (state.filter !== 'all' && !counts.has(state.filter)) state.filter = 'all';

  refs.filter.replaceChildren(
    el('option', { value: 'all', text: `all types (${entries.length})` }),
    ...types.map((type) => el('option', {
      value: type,
      text: `${type} (${counts.get(type)})`,
    })),
  );
  refs.filter.value = state.filter;
  refs.filter.disabled = entries.length === 0;
}

function renderLedgerRows() {
  const refs = state.refs;
  if (!refs || !refs.ledgerTbody || !state.ledger) return;

  let entries = state.ledger.entries;
  if (state.filter !== 'all') {
    entries = entries.filter((entry) => entryType(entry) === state.filter);
  }
  entries = entries.slice(-MAX_LEDGER_ROWS);

  if (!entries.length) {
    refs.ledgerTbody.replaceChildren(
      el('tr', {}, el('td', { class: 'table-empty', colspan: '4', text: 'No entries to show.' })),
    );
  } else {
    refs.ledgerTbody.replaceChildren(...entries.map((entry) => {
      const privateEntry = entry.private === true;
      const ts = stringOf(entry.ts);
      return el('tr', { class: privateEntry ? 'is-private' : '' },
        el('td', { class: 'cell-seq', text: entry.seq !== null && entry.seq !== undefined ? String(entry.seq) : '—' }),
        el('td', { class: 'cell-ts' },
          el('time', { datetime: ts || undefined, title: fmtStamp(entry.ts), text: fmtShort(entry.ts) }),
        ),
        el('td', { class: 'cell-type', text: entryType(entry) }),
        el('td', { class: 'cell-sum', text: summarize(entry) }),
      );
    }));
  }

  const filterNote = state.filter !== 'all' ? ` · filter: ${state.filter}` : '';
  const errorNote = state.ledger.parseErrors
    ? ` · ${state.ledger.parseErrors} unreadable lines`
    : '';
  refs.ledgerNote.textContent = `${entries.length} entries shown (max ${MAX_LEDGER_ROWS})${filterNote}${errorNote}`;
  if (state.ledger.parseErrors) refs.ledgerNote.classList.add('danger-text');
  else refs.ledgerNote.classList.remove('danger-text');
}

/* ------------------------------------------------------------------ */
/* Verifying the chain                                                 */
/* ------------------------------------------------------------------ */

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function setSeal(kind, title, detail, progress, count) {
  const refs = state.refs;
  if (!refs) return;
  refs.chain.className = `chain is-${kind}`;
  refs.chainMark.textContent = kind === 'ok' ? '✓' : (kind === 'bad' ? '!' : '◇');
  refs.chainTitle.textContent = title;
  refs.chainDetail.textContent = detail || '';
  if (progress !== undefined) {
    const pct = Math.max(0, Math.min(100, progress));
    refs.chainFill.style.width = `${pct}%`;
  }
  if (count !== undefined) refs.chainCount.textContent = count;
}

function setSealPending() {
  setSeal(
    'pending',
    'waiting for the ledger…',
    'verification starts as soon as /ledger responds',
    0,
    '—',
  );
}

function setSealRunning(done, total) {
  setSeal(
    'running',
    `verifying ${done}/${total}…`,
    'sha256 of every line · checking the prev link',
    total ? (done / total) * 100 : 0,
    `${done} / ${total}`,
  );
}

function setSealOk(count, head) {
  setSeal(
    'ok',
    'chain verified in the browser',
    `${formatInt(count)} entries · head ${shortHash(head)}`,
    100,
    '100%',
  );
}

function setSealBad(title, reason, progress, count) {
  setSeal('bad', title, reason, progress, count);
}

function setBrowserPending() {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-pending';
  refs.browserResult.textContent = 'running in the browser…';
  refs.browserDetail.textContent = 'sha256 line by line, then the prev link';
}

function setBrowserOk(count, head) {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-ok';
  refs.browserResult.textContent = `chain verified in the browser: ${formatInt(count)} entries, head ${shortHash(head)}`;
  refs.browserDetail.textContent = `head ${head}`;
}

function setBrowserBad(fail, validCount, head) {
  const refs = state.refs;
  if (!refs) return;
  const where = fail.seq !== null && fail.seq !== undefined ? `entry ${fail.seq}` : `line ${fail.index}`;
  refs.browserResult.className = 'verify-result is-bad';
  refs.browserResult.textContent = `chain broken at ${where}: ${fail.reason}`;
  refs.browserDetail.textContent = `${formatInt(validCount)} valid entries · last valid hash ${head}`;
}

function setBrowserUnavailable(reason) {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-bad';
  refs.browserResult.textContent = 'verification not available in the browser';
  refs.browserDetail.textContent = reason;
}

function renderServerResult(verify) {
  const refs = state.refs;
  if (!refs) return;

  if (!verify || !verify.ok) {
    refs.serverResult.className = 'verify-result is-bad';
    refs.serverResult.textContent = 'not available';
    refs.serverDetail.textContent = `${verify && verify.error ? verify.error : 'error'}${verify && verify.at ? ` · ${fetchedLabel(verify.at)}` : ''}`;
    return;
  }

  const data = verify.data && typeof verify.data === 'object' ? verify.data : {};
  const ok = data.ok === true;
  refs.serverResult.className = `verify-result ${ok ? 'is-ok' : 'is-bad'}`;
  refs.serverResult.textContent = `${ok ? 'ok' : 'NOT ok'} · ${formatInt(data.entries)} entries · head ${shortHash(data.head)}`;
  refs.serverDetail.textContent = `head ${stringOf(data.head) || '—'} · /verify · ${fetchedLabel(verify.at)}`;
}

async function verifyLedger(ledger, { animate, run, verifyRes }) {
  const refs = state.refs;
  if (!refs) return;

  if (!ledger.ok) {
    setSealBad('ledger not available', ledger.error || 'cannot read /ledger', 0, '—');
    setBrowserUnavailable(ledger.error || 'cannot read /ledger');
    renderServerResult(verifyRes);
    return;
  }

  const lines = String(ledger.text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const total = lines.length;

  if (!total) {
    setSealBad('empty ledger', 'no entries to verify in /ledger', 0, '0 / 0');
    setBrowserUnavailable('the ledger contains no entries');
    renderServerResult(verifyRes);
    return;
  }

  if (!globalThis.crypto || !crypto.subtle) {
    const reason = 'WebCrypto not available: open the page via http:// or https:// (secure context).';
    setSealBad('verification not available in the browser', reason, 0, `0 / ${total}`);
    setBrowserUnavailable(reason);
    renderServerResult(verifyRes);
    return;
  }

  if (animate) setSealRunning(0, total);

  const skipMotion = reducedMotion.matches;
  const delay = animate && !skipMotion && total <= 400
    ? Math.max(0, Math.min(45, 700 / total))
    : 0;

  let prev = ZERO_HASH;
  let valid = 0;
  let fail = null;

  for (let index = 0; index < total; index += 1) {
    if (run !== state.run) return;

    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      fail = { index: index + 1, seq: null, reason: 'unreadable line (invalid JSON)' };
      break;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail = { index: index + 1, seq: null, reason: 'invalid entry' };
      break;
    }

    const seq = entry.seq !== null && entry.seq !== undefined ? entry.seq : index + 1;

    if (typeof entry.prev !== 'string') {
      fail = { index: index + 1, seq, reason: 'missing prev field' };
      break;
    }
    if (entry.prev !== prev) {
      fail = { index: index + 1, seq, reason: 'prev not linked to the previous entry' };
      break;
    }
    if (typeof entry.hash !== 'string') {
      fail = { index: index + 1, seq, reason: 'missing hash field' };
      break;
    }

    const expected = entry.hash;
    let body;
    try {
      const copy = { ...entry };
      delete copy.hash;
      body = JSON.stringify(copy);
    } catch {
      fail = { index: index + 1, seq, reason: 'entry not serializable' };
      break;
    }

    let actual;
    try {
      actual = await sha256Hex(body);
    } catch {
      fail = { index: index + 1, seq, reason: 'sha256 computation failed' };
      break;
    }

    if (actual !== expected) {
      fail = {
        index: index + 1,
        seq,
        reason: `hash mismatch (expected ${shortHash(expected)}, computed ${shortHash(actual)})`,
      };
      break;
    }

    prev = expected;
    valid = index + 1;

    if (animate) {
      if (total <= 400 || valid === 1 || valid % 25 === 0 || valid === total) {
        setSealRunning(valid, total);
      }
      if (delay > 0) await sleep(delay);
      else if (valid % 100 === 0) await sleep(0);
      if (run !== state.run) return;
    } else if (total > 500 && valid % 250 === 0) {
      /* even a long ledger must give the rendering room to breathe */
      await sleep(0);
      if (run !== state.run) return;
    }
  }

  if (run !== state.run) return;

  if (fail) {
    const progress = total ? (valid / total) * 100 : 0;
    const where = fail.seq !== null && fail.seq !== undefined ? fail.seq : fail.index;
    setSealBad(`chain broken at entry ${where}`, fail.reason, progress, `${valid} / ${total}`);
    setBrowserBad(fail, valid, prev);
  } else {
    setSealOk(valid, prev);
    setBrowserOk(valid, prev);
  }

  renderServerResult(verifyRes);
}

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

function renderAttestation({ attestation, root }) {
  const refs = state.refs;
  if (!refs) return;
  const fallback = root.ok && root.data && root.data.attestation ? root.data.attestation : null;
  const data = attestation.ok && attestation.data && typeof attestation.data === 'object'
    ? attestation.data
    : fallback;

  refs.attestSrc.textContent = sourceLine([
    ['/attestation', attestation.at],
    ...(!attestation.ok && fallback ? [['/', root.at]] : []),
  ]);

  const nodes = [];

  if (!data) {
    nodes.push(errorBlock('/attestation', attestation));
  } else {
    const mode = stringOf(data.mode).trim() || null;
    const quote = typeof data.quote === 'string' ? data.quote : '';

    nodes.push(facts([
      ['Mode', mode === 'tee' ? 'tee · TDX' : (mode === 'dev' ? 'dev · NOT attested' : 'not declared')],
      ['App', stringOf(data.app).trim() || 'not declared'],
      ['Compose', stringOf(data.compose).trim() || 'not declared'],
      ['Quote', quote ? el('code', { class: 'inline-code', text: `${quote.slice(0, 16)}…` }) : 'not present'],
      ['Quote length', quote ? `${formatInt(quote.length)} characters` : '—'],
    ], 'facts attest-facts'));

    if (attestation.ok) {
      nodes.push(el('p', { class: 'raw-links' },
        el('a', {
          href: `${state.entity.base}/attestation`,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: 'Open /attestation',
        }),
        el('span', { class: 'meta-sep', text: '·' }),
        el('a', {
          href: `${state.entity.base}/verify`,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: 'Open /verify',
        }),
      ));
    } else {
      nodes.push(el('p', { class: 'src', text: '/attestation not available: showing only the metadata present in /.' }));
    }

    if (mode === 'dev') {
      nodes.push(el('p', { class: 'warn-note', text: 'This entity runs in dev mode: it is NOT attested.' }));
    }

    nodes.push(el('p', { class: 'commitment' },
      'The image fingerprint is pinned in the public repository ',
      el('a', {
        href: 'https://github.com/nocontentinhere4-art/entity-enclave',
        target: '_blank',
        rel: 'noreferrer noopener',
        text: 'github.com/nocontentinhere4-art/entity-enclave',
      }),
      ' (',
      el('code', { class: 'inline-code', text: 'deploy/docker-compose.phala.yml' }),
      '). The quote is not cryptographically verified in the browser.',
    ));
  }

  refs.attestBody.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

function init() {
  // Dev only: `?base=http://localhost:8080` points Entity 1 at a local enclave (fake modes) to test the UI.
  const devBase = new URLSearchParams(window.location.search).get('base');
  if (devBase && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(devBase)) ENTITIES[0].base = devBase;
  buildTabs();

  const requested = window.location.hash.replace(/^#/, '');
  const initial = ENTITIES.find((entity) => entity.id === requested) || ENTITIES[0];
  selectEntity(initial.id);

  window.addEventListener('hashchange', () => {
    const id = window.location.hash.replace(/^#/, '');
    const entity = ENTITIES.find((item) => item.id === id);
    if (entity && entity.id !== state.id) selectEntity(entity.id);
  });

  state.autoTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.entity && state.entity.base && !state.loading) {
      void load(state.entity, { animate: false });
    }
  }, REFRESH_MS);
}

init();
