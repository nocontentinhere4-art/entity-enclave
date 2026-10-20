/*
 * data.js — network and verification.
 *
 * Functions extracted (copied, not imported) from classic/app.js: classic/ stays untouched.
 * Only what talks to the network or verifies the chain lives here:
 *   - request with timeout, postMessage;
 *   - parseLedger, entryType, scrub, summarize;
 *   - sha256Hex and chain verification in the browser;
 *   - text formatting (dates, numbers, hashes, zatoshi).
 * No secrets: the page contains no keys, seeds or private views.
 */

export const ENTITIES = [
  {
    id: 'e1',
    label: 'Entity 1',
    short: 'e1',
    base: 'https://ca42622c7ae63906602b873703a0efa769079dfa-8080.dstack-pha-prod9.phala.network',
  },
  // discovered at runtime from Entity 1's `/` field `peer`, or forced with ?base2= (localhost only)
  { id: 'e2', label: 'Entity 2', short: 'e2', base: null },
];

const LOCAL_BASE_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const MISSING = [
  'second entity',
  'paid whispers',
  'cryptographic verification of the quote in the browser',
  'verification of the inference provider attestation',
  'token',
];

export const ZERO_HASH = '0'.repeat(64);
export const FETCH_TIMEOUT_MS = 20000;
export const REFRESH_MS = 60000;
export const COOLDOWN_MS = 60000;
export const TICK_WINDOW_MS = 20 * 60 * 1000;
export const MAX_LEDGER_ROWS = 100;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const INT_FMT = new Intl.NumberFormat('en-GB');
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const SHORT_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit',
});
const STAMP_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const SHORT_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

export function stringOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function toDate(value) {
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

export function timeOf(value) {
  const d = toDate(value);
  return d ? TIME_FMT.format(d) : '—';
}

/** HH:MM:SS for lines that declare when they were read. */
export function clockTime(value) {
  const d = toDate(value);
  return d ? TIME_FMT.format(d) : null;
}

/** HH:MM for ticker and short lines. */
export function hhmm(value) {
  const d = toDate(value);
  return d ? SHORT_TIME_FMT.format(d) : null;
}

export function fmtStamp(value) {
  const d = toDate(value);
  return d ? STAMP_FMT.format(d) : (value ? String(value) : '—');
}

export function fmtShort(value) {
  const d = toDate(value);
  return d ? SHORT_FMT.format(d) : (value ? String(value) : '—');
}

export function fetchedLabel(at) {
  const d = toDate(at);
  if (!d) return 'read time not available';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `read at ${TIME_FMT.format(d)}` : `read on ${STAMP_FMT.format(d)}`;
}

export function sourceLine(parts) {
  const seen = new Set();
  const labels = [];
  for (const [path, at] of parts) {
    if (!at) continue;
    const key = `${path}|${at instanceof Date ? at.toISOString() : String(at)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(`${path} ${fetchedLabel(at)}`);
  }
  return labels.length ? labels.join(' · ') : 'read time not available';
}

export function fixed8(zats) {
  const n = Number(zats);
  return Number.isFinite(n) ? (n / 1e8).toFixed(8) : null;
}

export function formatInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? INT_FMT.format(n) : '—';
}

export function formatDecimal(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

export function shortHash(value) {
  return typeof value === 'string' && value ? `${value.slice(0, 16)}…` : '—';
}

export function isFuture(value) {
  const d = toDate(value);
  return Boolean(d && d.getTime() > Date.now());
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export function describeNetworkError(err) {
  if (err && err.name === 'AbortError') return `no response within ${FETCH_TIMEOUT_MS / 1000} s`;
  if (err instanceof SyntaxError) return 'invalid response (JSON expected)';
  return 'network unreachable (or CORS)';
}

export async function request(base, path, options = {}) {
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

/**
 * The `peer` field announced by Entity 1: a non-empty https URL, or null.
 * Anything else (http, relative, credentials, unparsable) is ignored.
 * The returned base has no trailing slash, so `base + '/vitals'` stays valid.
 */
export function peerUrlOf(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export async function postMessage(base, payload) {
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

/** All public GETs at once. Each entry is {ok, at, data|text|error}. */
export async function fetchSnapshot(base) {
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
  return { root, vitals, memory, channel, ledger, verify, attestation, memorial };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export function parseLedger(text) {
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

export function entryType(entry) {
  return stringOf(entry && entry.type).trim() || 'untyped';
}

const SECRET_KEY = /secret|seed|ufvk|private|api[_-]?key|viewing|key|ciphertext/i;

export function scrub(value, depth = 0) {
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

export function summarize(entry) {
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

/* ------------------------------------------------------------------ */
/* Chain verification                                                  */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifies the NDJSON chain in the browser like classic/app.js.
 * Returns { ok, valid, total, head, fail, reason }. Never throws: every
 * error becomes a described failure, so the terminal can print it.
 */
export async function verifyChain(text, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const animate = options.animate !== false;

  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const total = lines.length;

  if (!total) {
    return { ok: false, valid: 0, total: 0, head: ZERO_HASH, fail: null, reason: 'the ledger contains no entries' };
  }

  if (!globalThis.crypto || !crypto.subtle) {
    return {
      ok: false,
      valid: 0,
      total,
      head: ZERO_HASH,
      fail: null,
      reason: 'WebCrypto not available: open the page via http:// or https:// (secure context)',
    };
  }

  const delay = animate && total <= 400
    ? Math.max(0, Math.min(45, 700 / total))
    : 0;

  let prev = ZERO_HASH;
  let valid = 0;
  let fail = null;

  for (let index = 0; index < total; index += 1) {
    if (shouldStop()) return { ok: false, valid, total, head: prev, fail: null, reason: 'interrupted' };

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

    onProgress(valid, total);

    if (delay > 0) await sleep(delay);
    else if (valid % 100 === 0) await sleep(0);

    if (shouldStop()) return { ok: false, valid, total, head: prev, fail: null, reason: 'interrupted' };
  }

  return { ok: !fail, valid, total, head: prev, fail, reason: fail ? fail.reason : null };
}

/* ------------------------------------------------------------------ */
/* Dev mode                                                            */
/* ------------------------------------------------------------------ */

/**
 * `?base=http://localhost:PORT` replaces Entity 1's base (localhost only),
 * as in classic/app.js. Returns true if the override was applied.
 */
export function applyDevBase(entities, search) {
  let devBase = null;
  try {
    devBase = new URLSearchParams(search).get('base');
  } catch {
    devBase = null;
  }
  if (devBase && LOCAL_BASE_RE.test(devBase)) {
    entities[0].base = devBase;
    return true;
  }
  return false;
}

/**
 * `?base2=http://localhost:PORT` forces Entity 2 for local development,
 * with the same localhost-only validation as `?base=`.
 */
export function applyDevBase2(entities, search) {
  let devBase = null;
  try {
    devBase = new URLSearchParams(search).get('base2');
  } catch {
    devBase = null;
  }
  if (devBase && LOCAL_BASE_RE.test(devBase)) {
    entities[1].base = devBase;
    return true;
  }
  return false;
}
