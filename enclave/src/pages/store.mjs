// Pages: the entity's public site. Content lives on disk (state/pages/<slug>.html), the public ledger keeps the
// commitment (slug, bytes, sha256, version) and nothing else. Limits — 50 pages, 10 edits per UTC day, 64 KiB,
// slug charset — are enforced here in code; no prompt can talk its way past them.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertCssSafe, DEFAULT_MAX_BYTES, escapeHtml, renderMarkdown, sanitizeHtml, sha256,
} from './sanitize.mjs';

// Strict by design: no scripts, no frames, no fetches. Inline styles are ours alone and the page cannot
// navigate the enclosing context. This header is what makes a sanitizer bug non-exploitable in a browser.
export const PAGES_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export const PAGE_HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PAGES_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

const RESERVED_SLUGS = new Set(['_style.css', '.history', 'pages']);
const TITLE_MAX = 120;
const BASE_CSS = `
:root{color-scheme:light dark;--fg:#141412;--bg:#fbfbf7;--muted:#6b6b63;--line:#d9d9d0;--accent:#7a1f1f}
@media (prefers-color-scheme:dark){:root{--fg:#e9e9e3;--bg:#101010;--muted:#9b9b92;--line:#2c2c2a;--accent:#e08080}}
*{box-sizing:border-box}
html{font-size:18px}
body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-serif,Georgia,"Times New Roman",serif;line-height:1.6}
header.site,main,footer.site{max-width:44rem;margin:0 auto;padding:0 1.25rem}
header.site{padding-top:1.5rem;padding-bottom:1rem;border-bottom:1px solid var(--line);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;letter-spacing:.04em;text-transform:lowercase}
header.site a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--accent)}
header.site .crumb{color:var(--muted);margin-left:.5rem}
main{padding-top:2rem;padding-bottom:3rem}
h1,h2,h3,h4,h5,h6{line-height:1.15;margin:1.8em 0 .5em;font-weight:600}
h1{font-size:2.1rem;margin-top:0}
h2{font-size:1.55rem}
h3{font-size:1.25rem}
p,ul,ol,blockquote,pre,table{margin:0 0 1.1em}
a{color:var(--accent)}
blockquote{margin-left:0;padding-left:1rem;border-left:2px solid var(--line);color:var(--muted)}
pre{overflow-x:auto;padding:1rem;border:1px solid var(--line);background:rgba(127,127,127,.08)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
p code,li code{padding:.1em .3em;background:rgba(127,127,127,.12)}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line)}
ul,ol{padding-left:1.4rem}
li{margin:.25em 0}
footer.site{padding-bottom:2rem;border-top:1px solid var(--line);color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.7rem}
`.trim();

// The CSS is a constant, not user content; assert it at module load so a careless edit cannot add a fetch.
assertCssSafe(BASE_CSS);

export class Pages {
  constructor({ dir, ledger, config = {}, entity = null, now = () => Date.now() }) {
    if (!dir) throw new Error('Pages needs a directory');
    if (!ledger?.append) throw new Error('Pages needs a ledger');
    this.dir = dir;
    this.ledger = ledger;
    this.config = config;
    this.now = now;
    this.entity = entity; // optional string or async function returning the entity's name
    this.max = positiveInt(config.pagesMax, 50);
    this.editsPerDay = positiveInt(config.pagesEditsPerDay, 10);
    this.maxBytes = positiveInt(config.pagesMaxBytes, DEFAULT_MAX_BYTES);
    this.allowHtml = config.pagesAllowHtml !== false;
    this.historyMax = positiveInt(config.pagesHistoryMax, 50);
    this.slugMax = positiveInt(config.pagesSlugMax, 40);
    this.current = new Map();      // slug -> {title, version, bytes, hash, format, updatedAt}
    this.versions = new Map();     // slug -> highest version ever seen (published or deleted)
    this.log = [];                 // [{type, ts, data}] for replay-derived stats and history
    this.#replay();
  }

  /** Publish (or re-publish, which increments the version) one page. Returns its public coordinates. */
  async publish({ slug: rawSlug, title: rawTitle, markdown = null, html = null }) {
    const slug = this.#checkSlug(rawSlug);
    const title = checkTitle(rawTitle);
    const hasMd = markdown !== null && markdown !== undefined;
    const hasHtml = html !== null && html !== undefined;
    if (hasMd === hasHtml) throw err('bad_format', 'publish_page needs exactly one of markdown or html');
    if (hasHtml && !this.allowHtml) throw err('html_disabled', 'raw HTML pages are disabled (PAGES_ALLOW_HTML=0)');

    // Size ceiling on the input, before any rendering work.
    const source = hasMd ? markdown : html;
    if (Buffer.byteLength(String(source), 'utf8') > this.maxBytes) throw tooLarge(this.maxBytes);

    // Hard limits, read from the ledger every time: a restart or a second process cannot reset them.
    if (!this.current.has(slug) && this.current.size >= this.max) {
      throw err('page_limit', `at most ${this.max} live pages`);
    }
    if (this.#editsToday() >= this.editsPerDay) {
      throw err('edit_limit', `at most ${this.editsPerDay} page edits per UTC day`);
    }

    const bodyHtml = hasMd
      ? renderMarkdown(markdown, { maxBytes: this.maxBytes })
      : sanitizeHtml(html, { maxBytes: this.maxBytes });
    if (Buffer.byteLength(bodyHtml, 'utf8') > this.maxBytes) throw tooLarge(this.maxBytes);

    const format = hasMd ? 'markdown' : 'html';
    const version = (this.versions.get(slug) ?? 0) + 1;
    const updatedAt = new Date(this.now()).toISOString();
    const bodyHash = sha256(bodyHtml);
    const entityName = await this.#entityName();
    const fullHtml = renderShell({ slug, title, bodyHtml, entityName, version, updatedAt, bodyHash });
    const bytes = Buffer.byteLength(fullHtml, 'utf8');
    const hash = sha256(fullHtml);

    // Write history first, then the live file atomically, then commit to the ledger. A crash leaves at worst
    // an unreferenced file; it can never leave a ledger entry pointing at half a page.
    await mkdir(this.#historyDir(slug), { recursive: true });
    await writeAtomic(join(this.#historyDir(slug), `${version}.html`), fullHtml);
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.#file(slug), fullHtml);
    await this.#pruneHistory(slug);

    const entry = this.ledger.append('page_published', { slug, title, bytes, hash, version, format });
    const ts = entry?.ts ?? updatedAt;
    this.versions.set(slug, version);
    this.current.set(slug, { title, version, bytes, hash, format, updatedAt: ts });
    this.log.push({ type: 'page_published', ts, data: { slug, title, bytes, hash, version, format } });

    return { ok: true, slug, title, version, bytes, hash, format, url: this.url(slug) };
  }

  /** Delete the live page. History and the ledger record stay; deletion is public and permanent. */
  async remove(rawSlug, reason = 'requested') {
    const slug = this.#checkSlug(rawSlug);
    const cur = this.current.get(slug);
    if (!cur) throw err('not_found', `no live page ${slug}`);
    if (this.#editsToday() >= this.editsPerDay) {
      throw err('edit_limit', `at most ${this.editsPerDay} page edits per UTC day`);
    }
    const version = (this.versions.get(slug) ?? cur.version) + 1;
    const why = String(reason ?? 'requested').slice(0, 120) || 'requested';
    const entry = this.ledger.append('page_deleted', { slug, version, hash: cur.hash, reason: why });
    const ts = entry?.ts ?? new Date(this.now()).toISOString();
    try {
      await unlink(this.#file(slug));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // a missing file is already the desired end state
    }
    this.versions.set(slug, version);
    this.current.delete(slug);
    this.log.push({ type: 'page_deleted', ts, data: { slug, version, hash: cur.hash, reason: why } });
    return { ok: true, slug, version, hash: cur.hash, deleted: true };
  }

  /** Read the live page and verify it against the ledger hash before serving a single byte. */
  async get(rawSlug) {
    const slug = this.#checkSlug(rawSlug);
    const cur = this.current.get(slug);
    if (!cur) throw err('not_found', `no live page ${slug}`);
    let buf;
    try {
      buf = await readFile(this.#file(slug));
    } catch (e) {
      if (e.code === 'ENOENT') throw err('page_tampered', `page ${slug} is missing on disk`);
      throw e;
    }
    const hash = sha256(buf);
    if (hash !== cur.hash) throw err('page_tampered', `page ${slug} does not match its ledger hash`);
    return {
      slug, title: cur.title, version: cur.version, bytes: buf.length, hash,
      html: buf.toString('utf8'), updatedAt: cur.updatedAt, format: cur.format,
    };
  }

  list() {
    return [...this.current.entries()]
      .map(([slug, p]) => ({
        slug, title: p.title, version: p.version, bytes: p.bytes, hash: p.hash,
        format: p.format, updatedAt: p.updatedAt, url: this.url(slug),
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.slug.localeCompare(b.slug));
  }

  /** Ledger projection of one page: every published version and every deletion, in order. */
  history(rawSlug) {
    const slug = this.#checkSlug(rawSlug);
    return this.log
      .filter((e) => e.data.slug === slug)
      .map((e) => ({
        version: e.data.version, type: e.type, bytes: e.data.bytes ?? null,
        hash: e.data.hash ?? null, reason: e.data.reason ?? null, ts: e.ts ?? null,
      }));
  }

  stats() {
    return { count: this.current.size, limit: this.max, editsToday: this.#editsToday(), editsPerDay: this.editsPerDay };
  }

  /** Cheap summary for the public root. */
  summary() {
    return { count: this.current.size, urls: this.list().slice(0, 10).map((p) => p.url) };
  }

  url(slug) {
    const base = String(this.config?.selfUrl ?? '').replace(/\/+$/, '');
    return `${base}/pages/${slug}`;
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  #replay() {
    for (const e of eachEntry(this.ledger, ['page_published', 'page_deleted'])) {
      const d = e.data ?? {};
      if (!d.slug) continue;
      const version = Number(d.version) || 0;
      const ts = e.ts ?? null;
      this.log.push({ type: e.type, ts, data: d });
      if (version > (this.versions.get(d.slug) ?? 0)) this.versions.set(d.slug, version);
      if (e.type === 'page_published') {
        this.current.set(d.slug, {
          title: d.title ?? d.slug, version, bytes: Number(d.bytes) || 0,
          hash: d.hash ?? null, format: d.format ?? 'markdown', updatedAt: ts,
        });
      } else {
        this.current.delete(d.slug);
      }
    }
  }

  #editsToday() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return this.log.filter((e) => String(e.ts ?? '').slice(0, 10) === today).length;
  }

  #checkSlug(raw) {
    const slug = String(raw ?? '').trim();
    if (RESERVED_SLUGS.has(slug)) throw err('reserved_slug', `${slug} is reserved`);
    const re = new RegExp(`^[a-z0-9][a-z0-9-]{0,${this.slugMax - 1}}$`);
    if (!re.test(slug)) throw err('bad_slug', `slug must match [a-z0-9-], 1-${this.slugMax} chars, and start with a letter or digit`);
    return slug;
  }

  #file(slug) { return join(this.dir, `${slug}.html`); }
  #historyDir(slug) { return join(this.dir, '.history', slug); }

  async #entityName() {
    if (typeof this.entity === 'function') {
      try { return String((await this.entity()) || 'unnamed').slice(0, 80); } catch { return 'unnamed'; }
    }
    return String(this.entity || 'unnamed').slice(0, 80);
  }

  /** Bound disk growth: keep the newest `historyMax` versions per slug. */
  async #pruneHistory(slug) {
    const dir = this.#historyDir(slug);
    let files;
    try { files = await readdir(dir); } catch { return; }
    const versions = files
      .filter((f) => /^\d+\.html$/.test(f))
      .sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
    const excess = versions.length - this.historyMax;
    for (const f of versions.slice(0, Math.max(0, excess))) {
      try { await unlink(join(dir, f)); } catch { /* best effort */ }
    }
  }
}

/** The trusted document shell. Body HTML is already sanitized/escaped; the only style in the page is BASE_CSS. */
export function renderShell({ slug, title, bodyHtml, entityName, version, updatedAt, bodyHash }) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header class="site"><a href="/pages">${escapeHtml(entityName)}</a><span class="crumb">/ ${escapeHtml(slug)}</span></header>
<main>
<article>
<h1>${safeTitle}</h1>
${bodyHtml}
</article>
</main>
<footer class="site">v${Number(version)} · updated ${escapeHtml(updatedAt)} · body sha256 ${String(bodyHash).slice(0, 12)} · full hash and bytes are public at /pages</footer>
</body>
</html>
`;
}

// ---- helpers ---------------------------------------------------------------------------------------------------

function checkTitle(raw) {
  const title = String(raw ?? '').trim();
  if (!title) throw err('bad_title', 'a page needs a title');
  if (title.length > TITLE_MAX) throw err('bad_title', `title is at most ${TITLE_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(title)) throw err('bad_title', 'title contains control characters');
  return title;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o644 });
    await rename(tmp, file); // same directory: atomic on POSIX
  } catch (e) {
    try { if (existsSync(tmp)) await unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** Ledger replay: uses Ledger.each when present (real ledger), falls back to an entries array in tests. */
function* eachEntry(ledger, types) {
  if (typeof ledger.each === 'function') {
    yield* ledger.each(types);
    return;
  }
  const want = new Set(types);
  for (const e of Array.isArray(ledger.entries) ? ledger.entries : []) {
    if (e?.private || !want.has(e.type)) continue;
    yield e;
  }
}

function tooLarge(max) {
  return err('too_large', `page content exceeds ${max} bytes`);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
