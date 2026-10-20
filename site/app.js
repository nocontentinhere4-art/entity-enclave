/*
 * Finestra pubblica sulle entità sovrane.
 * Nessun framework, nessuna dipendenza, nessuna richiesta oltre i base delle entità.
 * Tutto il testo che arriva dalla rete entra nel DOM con textContent, mai con innerHTML.
 */

export const ENTITIES = [
  {
    id: 'e1',
    label: 'Entità 1',
    base: 'https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network',
  },
  { id: 'e2', label: 'Entità 2', base: null }, // non ancora distribuita
];

const MISSING = [
  'seconda entità',
  'sussurri a pagamento',
  'verifica crittografica della quote nel browser',
  "verifica dell'attestazione del provider di inferenza",
  'token',
];

const ZERO_HASH = '0'.repeat(64);
const FETCH_TIMEOUT_MS = 20000;
const REFRESH_MS = 60000;
const COOLDOWN_MS = 60000;
const MAX_LEDGER_ROWS = 100;

const INT_FMT = new Intl.NumberFormat('it-IT');
const TIME_FMT = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const STAMP_FMT = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const SHORT_FMT = new Intl.DateTimeFormat('it-IT', {
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
    el('p', { class: 'error-title', text: `Non riesco a leggere ${path}` }),
    el('p', { class: 'error-text', text: (res && res.error) || 'errore sconosciuto' }),
    res && res.at ? el('p', { class: 'src', text: fetchedLabel(res.at) }) : null,
  );
}

/* ------------------------------------------------------------------ */
/* Formattazione                                                       */
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
  if (!d) return 'ora di lettura non disponibile';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `letto alle ${TIME_FMT.format(d)}` : `letto il ${STAMP_FMT.format(d)}`;
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
  return labels.length ? labels.join(' · ') : 'ora di lettura non disponibile';
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
  return new Intl.NumberFormat('it-IT', {
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
/* Rete                                                                */
/* ------------------------------------------------------------------ */

function describeNetworkError(err) {
  if (err && err.name === 'AbortError') return `nessuna risposta entro ${FETCH_TIMEOUT_MS / 1000} s`;
  if (err instanceof SyntaxError) return 'risposta non valida (JSON atteso)';
  return 'rete non raggiungibile (o CORS)';
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
/* Tab e stato                                                         */
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
    ? `${entity.label} — finestra pubblica`
    : `${entity.label} — non ancora online`;
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
    /* un file statico può impedire replaceState: il cambio entità funziona comunque */
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
      'finestra pubblica',
    ),
    el('div', { class: 'head-line' },
      el('h1', { class: 'offline-title', text: 'Non ancora online' }),
      el('div', { class: 'badges' },
        el('span', { class: 'badge is-unborn' },
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          el('span', { text: 'non distribuita' }),
        ),
      ),
    ),
    el('p', { class: 'offline-quote', text: 'Stessa immagine, stesso cervello, seme diverso: arriverà quando la prima avrà dimostrato di vivere.' }),
    el('p', { class: 'src offline-src', text: 'base: null · nessun endpoint pubblico · nessuna stima, nessun segnaposto' }),
    el('div', { class: 'offline-chain' },
      el('span', { class: 'label', text: 'Catena' }),
      el('p', { class: 'offline-chain-text', text: "Nessun registro da verificare: l'entità non è ancora stata distribuita." }),
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
      el('h2', { text: "Cosa non c'è ancora" }),
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
  const headerSrc = el('p', { class: 'src head-src', text: 'lettura degli endpoint…' });
  const refresh = el('button', {
    class: 'btn-refresh',
    type: 'button',
    onclick: () => {
      if (state.entity && state.entity.base && !state.loading) {
        void load(state.entity, { animate: true, manual: true });
      }
    },
  }, 'Aggiorna');

  const header = el('header', { class: 'entity-head' },
    el('p', { class: 'eyebrow' },
      entity.label,
      el('span', { class: 'eyebrow-sep', text: '·' }),
      'finestra pubblica',
    ),
    el('div', { class: 'head-line' }, entityName, badges),
    attest,
    el('div', { class: 'head-meta' }, headerSrc, refresh),
  );

  const chainMark = el('span', { class: 'chain-mark', 'aria-hidden': 'true', text: '◇' });
  const chainTitle = el('h2', { class: 'chain-title', text: 'in attesa del registro…' });
  const chainCount = el('span', { class: 'chain-count', text: '—' });
  const chainDetail = el('p', { class: 'chain-detail', text: 'la verifica parte appena /ledger risponde' });
  const chainFill = el('span', { class: 'chain-fill' });
  const chain = el('section', { class: 'chain is-pending', 'aria-live': 'polite' },
    el('div', { class: 'chain-head' },
      el('span', { class: 'label', text: 'Catena' }),
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

  const vitals = makeSection('01', 'Vitali');
  const identity = makeSection('02', 'Identità');
  const channel = makeSection('03', 'Canale pubblico');
  const ledger = makeSection('04', 'Registro');
  const attestation = makeSection('05', 'Attestazione');

  refs.vitalsHeading = vitals.heading;
  refs.vitalsSrc = vitals.src;
  refs.vitalsBody = vitals.body;
  refs.identitySrc = identity.src;
  refs.identityBody = identity.body;
  refs.channelSrc = channel.src;
  refs.ledgerSrc = ledger.src;
  refs.attestSrc = attestation.src;
  refs.attestBody = attestation.body;

  refs.vitalsBody.appendChild(pending('lettura di /vitals…'));
  refs.identityBody.appendChild(pending('lettura di /memory-public…'));
  refs.attestBody.appendChild(pending('lettura di /attestation…'));

  /* Canale: lista + composer (il composer non viene ricostruito ai refresh) */
  const messages = el('div', { class: 'messages' }, pending('lettura di /public-channel…'));
  const authorInput = el('input', {
    id: 'author', name: 'author', type: 'text', maxlength: '40',
    autocomplete: 'nickname', placeholder: 'facoltativo',
  });
  const textInput = el('textarea', {
    id: 'message', name: 'message', maxlength: '500', rows: '4',
    placeholder: 'Scrivi qualcosa di pubblico…',
  });
  const counter = el('span', { class: 'counter', text: '0 / 500' });
  const sendNote = el('span', { class: 'send-note', text: '' });
  const formError = el('p', { class: 'form-error', role: 'status', 'aria-live': 'polite', text: '' });
  const send = el('button', { class: 'send', type: 'submit' }, 'Invia al registro');
  const form = el('form', { class: 'composer', novalidate: true },
    el('p', { class: 'notice', text: 'Tutto quello che scrivi qui è pubblico e finisce nel registro. Lei legge i messaggi al prossimo ciclo (≤ 15 min) e decide se rispondere.' }),
    el('div', { class: 'field' },
      el('label', { for: 'author', text: 'Nome (facoltativo)' }),
      authorInput,
    ),
    el('div', { class: 'field' },
      el('label', { for: 'message', text: 'Messaggio' }),
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

  /* Registro */
  const typeFilter = el('select', { class: 'select', id: 'type-filter', 'aria-label': 'Filtra il registro per tipo' },
    el('option', { value: 'all', text: 'tutti i tipi' }),
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
    text: 'Apri /ledger (NDJSON) ↗',
  });
  const ledgerTable = el('div', { class: 'ledger-table' }, pending('lettura di /ledger…'));
  const ledgerNote = el('p', { class: 'table-note', text: '' });
  const browserResult = el('p', { class: 'verify-result', text: 'in corso…' });
  const browserDetail = el('p', { class: 'src verify-detail', text: '' });
  const serverResult = el('p', { class: 'verify-result', text: 'in attesa…' });
  const serverDetail = el('p', { class: 'src verify-detail', text: '' });
  const verifyBlock = el('div', { class: 'verify' },
    el('div', { class: 'verify-col' },
      label('Nel browser'),
      browserResult,
      browserDetail,
    ),
    el('div', { class: 'verify-col' },
      label('Sul server'),
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
        el('label', { class: 'label', for: 'type-filter', text: 'Tipo' }),
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
    state.refs.headerSrc.textContent = options.manual ? 'aggiornamento richiesto…' : 'aggiornamento in corso…';
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
  refs.refresh.textContent = busy ? 'Aggiorno…' : 'Aggiorna';
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
      el('strong', { text: 'Modalità dev.' }),
      textNode(' Questa entità NON è attestata: i dati non provengono da un TEE verificato.'),
    );
  } else {
    refs.warning.hidden = true;
    refs.warning.replaceChildren();
  }
}

function renderHeader({ root, vitals, memory, memorial, memorialAt, attestation }) {
  const refs = state.refs;
  if (!refs) return;

  let name = 'senza nome';
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

  let stateLabel = 'stato non disponibile';
  let stateKind = 'unknown';
  if (memorial) {
    stateLabel = 'morta';
    stateKind = 'dead';
  } else if (vitals.ok && vitals.data) {
    const v = vitals.data;
    if (v.state === 'unborn') {
      stateLabel = 'non nata';
      stateKind = 'unborn';
    } else if (v.state === 'alive') {
      if (isFuture(v.sleepUntil)) {
        stateLabel = 'in pausa';
        stateKind = 'paused';
      } else {
        stateLabel = 'viva';
        stateKind = 'alive';
      }
    } else if (v.state === 'dead') {
      stateLabel = 'morta';
      stateKind = 'dead';
    } else if (v.state === 'paused') {
      stateLabel = 'in pausa';
      stateKind = 'paused';
    }
  } else if (vitals.error) {
    stateLabel = 'stato non disponibile';
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

  let attText = 'attestazione non disponibile';
  let attClass = 'is-unknown';
  if (attMode === 'tee') {
    attText = 'attestazione TDX presente, non verificata nel browser';
    attClass = 'is-tee';
  } else if (attMode === 'dev') {
    attText = 'NON attestata';
    attClass = 'is-dev';
  }

  refs.attest.className = 'head-attest';
  refs.attest.replaceChildren(
    el('span', { class: `attest-badge ${attClass}` },
      el('span', { class: 'attest-label', text: 'Attestazione' }),
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
    read.length ? sourceLine(read) : 'nessuna lettura',
    failures.length ? `non letto: ${failures.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ */
/* Vitali                                                              */
/* ------------------------------------------------------------------ */

function renderVitals({ vitals, root, memorial, memorialAt }) {
  const refs = state.refs;
  if (!refs) return;

  if (memorial) {
    refs.vitalsHeading.textContent = 'Memoriale';
    refs.vitalsSrc.textContent = `/memorial · ${fetchedLabel(memorialAt)}`;
    refs.vitalsBody.replaceChildren(
      el('div', { class: 'memorial' },
        el('p', { class: 'label', text: 'Memoriale pubblico' }),
        el('p', { class: 'memorial-note', text: "L'entità è morta. Al posto dei vitali, il memoriale servito da /memorial." }),
        el('pre', { class: 'raw', text: safeJSON(memorial) }),
      ),
    );
    return;
  }

  refs.vitalsHeading.textContent = 'Vitali';
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
    : 'non dichiarata';

  const hunger = v.hunger === 'hungry'
    ? 'affamata'
    : (v.hunger === 'ok' ? 'sazia' : 'non dichiarata');

  const wallet = v.wallet && typeof v.wallet === 'object'
    ? (v.wallet.ok === false
      ? `errore${v.wallet.fault ? ` · ${stringOf(v.wallet.fault)}` : ''}`
      : (v.wallet.sync
        ? (v.wallet.sync.ok === false
          ? `sincronizzazione non riuscita${v.wallet.sync.at ? ` · ${fmtStamp(v.wallet.sync.at)}` : ''}`
          : `altezza ${formatInt(v.wallet.sync.height)} · ${fmtStamp(v.wallet.sync.at)}`)
        : 'sincronizzazione non dichiarata'))
    : 'non dichiarato';

  const treasury = el('div', { class: 'treasury' },
    el('p', { class: 'treasury-amount' },
      el('span', { class: 'amount', text: amount === null ? '—' : amount }),
      amount === null ? null : textNode(' '),
      el('span', { class: 'unit', text: amount === null ? '' : unit }),
    ),
    el('p', { class: 'treasury-raw', text: Number.isFinite(rawZats) ? `${formatInt(rawZats)} zatoshi` : 'zatoshi non dichiarati' }),
  );

  const rows = [
    ['Ore rimaste', Number.isFinite(Number(v.hoursLeft)) ? `${formatDecimal(v.hoursLeft, 2)} h` : 'non dichiarate'],
    ['Fame', hunger],
    ['Giorni di vita', Number.isFinite(Number(v.daysAlive)) ? `${formatDecimal(v.daysAlive, 2)} giorni` : 'non dichiarati'],
    ['Nata il', fmtStamp(v.bornAt)],
    ['Wallet', wallet],
    ['Rete', network],
  ];

  if (v.sleepUntil) {
    rows.push(['In pausa fino a', fmtStamp(v.sleepUntil)]);
  }
  if (root.ok && root.data && root.data.zcash && root.data.zcash.error) {
    rows.push(['Errore wallet (/)', el('span', { class: 'danger-text', text: stringOf(root.data.zcash.error) })]);
  }

  const nodes = [treasury, facts(rows)];

  const brain = Array.isArray(v.brain) ? v.brain : [];
  const brainBox = el('div', { class: 'brain' },
    label('Provider di inferenza'),
    brain.length
      ? el('ul', { class: 'roster' }, ...brain.map((provider) => {
        const p = provider && typeof provider === 'object' ? provider : {};
        const keyConfigured = p.keyConfigured === true;
        return el('li', {},
          el('span', { class: 'roster-name', text: stringOf(p.name) || 'senza nome' }),
          el('span', { class: 'roster-model', text: stringOf(p.model) || 'modello non dichiarato' }),
          el('span', { class: 'roster-speed', text: stringOf(p.speed) || '—' }),
          el('span', { class: `roster-key${keyConfigured ? '' : ' is-missing'}`, text: keyConfigured ? 'chiave configurata' : 'chiave assente' }),
        );
      }))
      : empty('nessun provider dichiarato.'),
  );
  nodes.push(brainBox);

  refs.vitalsBody.replaceChildren(...nodes);
}

function safeJSON(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'memoriale non serializzabile';
  }
}

/* ------------------------------------------------------------------ */
/* Identità                                                            */
/* ------------------------------------------------------------------ */

function promiseText(promise) {
  if (typeof promise === 'string') return promise;
  if (promise && typeof promise === 'object') {
    const what = promise.what ?? promise.text ?? promise.description ?? promise.promise;
    const to = promise.to ? `a ${stringOf(promise.to)}` : '';
    const due = promise.due ? `entro ${fmtStamp(promise.due)}` : '';
    const parts = [what, to, due].filter(Boolean).map(stringOf);
    if (parts.length) return parts.join(' · ');
    try {
      return JSON.stringify(promise);
    } catch {
      return 'promessa non leggibile';
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
    nodes.push(empty('non si è ancora data un nome.'));
  } else {
    nodes.push(facts([
      ['Nome', stringOf(identity.name).trim() || 'senza nome'],
      ['Voce', stringOf(identity.voice).trim() || 'non dichiarata'],
      ['Immagine', stringOf(identity.image).trim() || 'non dichiarata'],
    ], 'facts identity-facts'));
  }

  nodes.push(el('div', { class: 'plan-block' },
    label('Piano'),
    m.plan
      ? el('p', { class: 'plan', text: stringOf(m.plan) })
      : empty('nessun piano pubblicato.'),
  ));

  const promises = Array.isArray(m.promises) ? m.promises : [];
  nodes.push(el('div', { class: 'promises-block' },
    label('Promesse aperte'),
    promises.length
      ? el('ol', { class: 'promises' },
        ...promises.map((promise) => el('li', { text: promiseText(promise) })),
      )
      : empty('nessuna promessa aperta.'),
  ));

  refs.identityBody.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ */
/* Canale pubblico                                                     */
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
      el('p', { class: 'error-title', text: 'Il canale ha risposto in un formato inatteso' }),
      el('p', { class: 'error-text', text: 'Attesa una lista di messaggi.' }),
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
    refs.messages.replaceChildren(empty('Nessun messaggio pubblico. Il canale è aperto.'));
    return;
  }

  refs.messages.replaceChildren(...messages.map((message) => {
    const m = message && typeof message === 'object' ? message : {};
    const fromEntity = m.from === 'entity';
    const who = fromEntity
      ? 'lei'
      : (stringOf(m.author).trim() || 'umano');
    const meta = el('p', { class: 'message-meta' },
      el('span', { class: 'who', text: who }),
      el('span', { class: 'meta-sep', text: '·' }),
      el('time', { datetime: stringOf(m.ts) || undefined, text: fmtStamp(m.ts) }),
      m.seq !== null && m.seq !== undefined ? el('span', { class: 'meta-sep', text: '·' }) : null,
      m.seq !== null && m.seq !== undefined ? el('span', { text: `voce ${m.seq}` }) : null,
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
    /* storage può essere negato: il limite resta solo in memoria */
  }
  return 0;
}

function writeCooldown(entityId, until) {
  try {
    if (until > Date.now()) localStorage.setItem(cooldownKey(entityId), String(until));
    else localStorage.removeItem(cooldownKey(entityId));
  } catch {
    /* nessun problema: il pulsante resta comunque disabilitato in memoria */
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
    refs.send.textContent = 'Invio…';
    refs.sendNote.textContent = '';
    return;
  }
  if (left > 0) {
    refs.send.disabled = true;
    refs.send.textContent = 'Invia al registro';
    refs.sendNote.textContent = `puoi scrivere di nuovo tra ${Math.ceil(left / 1000)} s`;
    return;
  }
  refs.send.disabled = false;
  refs.send.textContent = 'Invia al registro';
  refs.sendNote.textContent = '';
}

async function sendMessage(entity) {
  const refs = state.refs;
  if (!refs || state.sending) return;

  const text = refs.textInput.value.trim();
  const author = refs.authorInput.value.trim();

  if (!text) {
    showFormError('Scrivi un messaggio prima di inviare.');
    refs.textInput.focus();
    return;
  }
  if (text.length > 500) {
    showFormError('Il messaggio supera i 500 caratteri.');
    return;
  }
  if (author.length > 40) {
    showFormError('Il nome supera i 40 caratteri.');
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
    showFormError(result.error || `Invio non riuscito${result.status ? ` (HTTP ${result.status})` : ''}.`);
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
    showFormError(`Messaggio inviato. Rilettura del canale non riuscita: ${res.error || 'formato inatteso'}.`);
  }
}

/* ------------------------------------------------------------------ */
/* Registro                                                            */
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
  return stringOf(entry && entry.type).trim() || 'senza tipo';
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
      ? `voce privata, cifrata, ${formatInt(size)} byte`
      : 'voce privata, cifrata, dimensione non dichiarata';
  }
  try {
    const compact = JSON.stringify(scrub(e.data));
    if (!compact) return '—';
    return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
  } catch {
    return 'dati non serializzabili';
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
    refs.filter.replaceChildren(el('option', { value: 'all', text: 'tutti i tipi' }));
    refs.filter.value = 'all';
    refs.filter.disabled = true;
    return;
  }

  const parsed = parseLedger(ledger.text);
  state.ledger = parsed;

  const tbody = el('tbody');
  refs.ledgerTbody = tbody;
  const table = el('table', { class: 'ledger' },
    el('caption', { class: 'sr-only', text: 'Ultime 100 voci del registro pubblico' }),
    el('thead', {},
      el('tr', {},
        el('th', { scope: 'col', text: 'Seq' }),
        el('th', { scope: 'col', text: 'Ora' }),
        el('th', { scope: 'col', text: 'Tipo' }),
        el('th', { scope: 'col', text: 'Dati' }),
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
  const types = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'it'));

  if (state.filter !== 'all' && !counts.has(state.filter)) state.filter = 'all';

  refs.filter.replaceChildren(
    el('option', { value: 'all', text: `tutti i tipi (${entries.length})` }),
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
      el('tr', {}, el('td', { class: 'table-empty', colspan: '4', text: 'Nessuna voce da mostrare.' })),
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

  const filterNote = state.filter !== 'all' ? ` · filtro: ${state.filter}` : '';
  const errorNote = state.ledger.parseErrors
    ? ` · ${state.ledger.parseErrors} righe non leggibili`
    : '';
  refs.ledgerNote.textContent = `${entries.length} voci mostrate (massimo ${MAX_LEDGER_ROWS})${filterNote}${errorNote}`;
  if (state.ledger.parseErrors) refs.ledgerNote.classList.add('danger-text');
  else refs.ledgerNote.classList.remove('danger-text');
}

/* ------------------------------------------------------------------ */
/* Verifica della catena                                               */
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
    'in attesa del registro…',
    'la verifica parte appena /ledger risponde',
    0,
    '—',
  );
}

function setSealRunning(done, total) {
  setSeal(
    'running',
    `verifica ${done}/${total}…`,
    'sha256 di ogni riga · controllo del collegamento prev',
    total ? (done / total) * 100 : 0,
    `${done} / ${total}`,
  );
}

function setSealOk(count, head) {
  setSeal(
    'ok',
    'catena verificata nel browser',
    `${formatInt(count)} voci · head ${shortHash(head)}`,
    100,
    '100 %',
  );
}

function setSealBad(title, reason, progress, count) {
  setSeal('bad', title, reason, progress, count);
}

function setBrowserPending() {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-pending';
  refs.browserResult.textContent = 'in corso nel browser…';
  refs.browserDetail.textContent = 'sha256 riga per riga, poi il collegamento prev';
}

function setBrowserOk(count, head) {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-ok';
  refs.browserResult.textContent = `catena verificata nel browser: ${formatInt(count)} voci, head ${shortHash(head)}`;
  refs.browserDetail.textContent = `head ${head}`;
}

function setBrowserBad(fail, validCount, head) {
  const refs = state.refs;
  if (!refs) return;
  const where = fail.seq !== null && fail.seq !== undefined ? `voce ${fail.seq}` : `riga ${fail.index}`;
  refs.browserResult.className = 'verify-result is-bad';
  refs.browserResult.textContent = `catena interrotta alla ${where}: ${fail.reason}`;
  refs.browserDetail.textContent = `${formatInt(validCount)} voci valide · ultimo hash valido ${head}`;
}

function setBrowserUnavailable(reason) {
  const refs = state.refs;
  if (!refs) return;
  refs.browserResult.className = 'verify-result is-bad';
  refs.browserResult.textContent = 'verifica non disponibile nel browser';
  refs.browserDetail.textContent = reason;
}

function renderServerResult(verify) {
  const refs = state.refs;
  if (!refs) return;

  if (!verify || !verify.ok) {
    refs.serverResult.className = 'verify-result is-bad';
    refs.serverResult.textContent = 'non disponibile';
    refs.serverDetail.textContent = `${verify && verify.error ? verify.error : 'errore'}${verify && verify.at ? ` · ${fetchedLabel(verify.at)}` : ''}`;
    return;
  }

  const data = verify.data && typeof verify.data === 'object' ? verify.data : {};
  const ok = data.ok === true;
  refs.serverResult.className = `verify-result ${ok ? 'is-ok' : 'is-bad'}`;
  refs.serverResult.textContent = `${ok ? 'ok' : 'NON ok'} · ${formatInt(data.entries)} voci · head ${shortHash(data.head)}`;
  refs.serverDetail.textContent = `head ${stringOf(data.head) || '—'} · /verify · ${fetchedLabel(verify.at)}`;
}

async function verifyLedger(ledger, { animate, run, verifyRes }) {
  const refs = state.refs;
  if (!refs) return;

  if (!ledger.ok) {
    setSealBad('registro non disponibile', ledger.error || 'impossibile leggere /ledger', 0, '—');
    setBrowserUnavailable(ledger.error || 'impossibile leggere /ledger');
    renderServerResult(verifyRes);
    return;
  }

  const lines = String(ledger.text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const total = lines.length;

  if (!total) {
    setSealBad('registro vuoto', 'nessuna voce da verificare in /ledger', 0, '0 / 0');
    setBrowserUnavailable('il registro non contiene voci');
    renderServerResult(verifyRes);
    return;
  }

  if (!globalThis.crypto || !crypto.subtle) {
    const reason = 'WebCrypto non disponibile: apri la pagina via http:// o https:// (contesto sicuro).';
    setSealBad('verifica non disponibile nel browser', reason, 0, `0 / ${total}`);
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
      fail = { index: index + 1, seq: null, reason: 'riga non leggibile (JSON non valido)' };
      break;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail = { index: index + 1, seq: null, reason: 'voce non valida' };
      break;
    }

    const seq = entry.seq !== null && entry.seq !== undefined ? entry.seq : index + 1;

    if (typeof entry.prev !== 'string') {
      fail = { index: index + 1, seq, reason: 'campo prev assente' };
      break;
    }
    if (entry.prev !== prev) {
      fail = { index: index + 1, seq, reason: 'prev non collegato alla voce precedente' };
      break;
    }
    if (typeof entry.hash !== 'string') {
      fail = { index: index + 1, seq, reason: 'campo hash assente' };
      break;
    }

    const expected = entry.hash;
    let body;
    try {
      const copy = { ...entry };
      delete copy.hash;
      body = JSON.stringify(copy);
    } catch {
      fail = { index: index + 1, seq, reason: 'voce non serializzabile' };
      break;
    }

    let actual;
    try {
      actual = await sha256Hex(body);
    } catch {
      fail = { index: index + 1, seq, reason: 'calcolo sha256 non riuscito' };
      break;
    }

    if (actual !== expected) {
      fail = {
        index: index + 1,
        seq,
        reason: `hash non corrispondente (atteso ${shortHash(expected)}, calcolato ${shortHash(actual)})`,
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
      /* anche un registro lungo deve lasciare respirare il rendering */
      await sleep(0);
      if (run !== state.run) return;
    }
  }

  if (run !== state.run) return;

  if (fail) {
    const progress = total ? (valid / total) * 100 : 0;
    const where = fail.seq !== null && fail.seq !== undefined ? fail.seq : fail.index;
    setSealBad(`catena interrotta alla voce ${where}`, fail.reason, progress, `${valid} / ${total}`);
    setBrowserBad(fail, valid, prev);
  } else {
    setSealOk(valid, prev);
    setBrowserOk(valid, prev);
  }

  renderServerResult(verifyRes);
}

/* ------------------------------------------------------------------ */
/* Attestazione                                                        */
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
      ['Modalità', mode === 'tee' ? 'tee · TDX' : (mode === 'dev' ? 'dev · NON attestata' : 'non dichiarata')],
      ['App', stringOf(data.app).trim() || 'non dichiarato'],
      ['Compose', stringOf(data.compose).trim() || 'non dichiarato'],
      ['Quote', quote ? el('code', { class: 'inline-code', text: `${quote.slice(0, 16)}…` }) : 'non presente'],
      ['Lunghezza quote', quote ? `${formatInt(quote.length)} caratteri` : '—'],
    ], 'facts attest-facts'));

    if (attestation.ok) {
      nodes.push(el('p', { class: 'raw-links' },
        el('a', {
          href: `${state.entity.base}/attestation`,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: 'Apri /attestation',
        }),
        el('span', { class: 'meta-sep', text: '·' }),
        el('a', {
          href: `${state.entity.base}/verify`,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: 'Apri /verify',
        }),
      ));
    } else {
      nodes.push(el('p', { class: 'src', text: '/attestation non disponibile: mostro solo i metadati presenti in /.' }));
    }

    if (mode === 'dev') {
      nodes.push(el('p', { class: 'warn-note', text: 'Questa entità gira in modalità dev: NON è attestata.' }));
    }

    nodes.push(el('p', { class: 'commitment' },
      "L'impronta dell'immagine è fissata nel repository pubblico ",
      el('a', {
        href: 'https://github.com/nocontentinhere4-art/entity-enclave',
        target: '_blank',
        rel: 'noreferrer noopener',
        text: 'github.com/nocontentinhere4-art/entity-enclave',
      }),
      ' (',
      el('code', { class: 'inline-code', text: 'deploy/docker-compose.phala.yml' }),
      '). La quote non è verificata crittograficamente nel browser.',
    ));
  }

  refs.attestBody.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ */
/* Avvio                                                               */
/* ------------------------------------------------------------------ */

function init() {
  // Dev only: `?base=http://localhost:8080` points Entità 1 at a local enclave (fake modes) to test the UI.
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
