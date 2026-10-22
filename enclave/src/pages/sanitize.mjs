// Page content: a tiny markdown renderer and an allowlist HTML sanitizer. No DOM in Node, no dependencies.
// Two input paths, one guarantee: every page is escaped text plus a fixed set of structural tags. Anything
// outside the allowlist is refused loudly (`unsafe_html`), never silently rewritten into something else.
// The HTTP layer adds CSP `default-src 'none'` as a second line of defence, so even a sanitizer miss cannot
// load or execute anything from a visitor's browser.
import { createHash } from 'node:crypto';

export const DEFAULT_MAX_BYTES = 65_536;

// Structure only. No script, style, media, form, frame, svg/math, link/meta/base: those are refused outright.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'dl', 'dt', 'dd',
  'small', 'sub', 'sup',
]);
const VOID_TAGS = new Set(['br', 'hr']);
// Named explicitly so the error message says why; anything not in ALLOWED_TAGS is refused anyway.
const BANNED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button',
  'svg', 'math', 'img', 'video', 'audio', 'source', 'canvas', 'template', 'noscript', 'frame',
  'frameset', 'applet', 'marquee', 'picture', 'track', 'map', 'area',
]);

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Safe markdown → body HTML. Raw HTML in the source is escaped first, so `<script>` stays text. */
export function renderMarkdown(md, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const raw = assertSafeText(md, maxBytes);
  const src = escapeMd(raw).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code: content is already escaped and is rendered verbatim.
    const fence = line.match(/^\s*(```|~~~)\s*([a-z0-9-]*)\s*$/i);
    if (fence) {
      const body = [];
      i++;
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // closing fence
      out.push(`<pre><code>${body.map((l) => l.replace(/>/g, '&gt;')).join('\n')}</code></pre>`);
      continue;
    }

    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (isRule(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${paragraph(buf)}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { i++; continue; } // defensive: never loop forever on an unclassified line
    out.push(paragraph(buf));
  }

  return out.join('\n');
}

/**
 * Allowlist HTML → body HTML. Throws `unsafe_html` for anything not explicitly allowed, so a page is never
 * published with content the model did not ask for (or that it did ask for and must not have).
 */
export function sanitizeHtml(html, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const src = assertSafeText(html, maxBytes);
  let out = '';
  let last = 0;
  const stack = [];

  for (const m of src.matchAll(TAG_RE)) {
    out += escapeText(src.slice(last, m.index));
    last = m.index + m[0].length;
    const raw = m[0];

    if (raw.startsWith('<!--')) continue; // comments carry no content: dropped

    const name = m[1].toLowerCase();
    const closing = raw.startsWith('</');
    let attrRaw = m[2] ?? '';

    if (BANNED_TAGS.has(name)) throw unsafe(`<${name}> is not allowed on a page`);
    if (!ALLOWED_TAGS.has(name)) throw unsafe(`unknown tag <${name}>`);

    if (closing) {
      if (attrRaw.trim()) throw unsafe(`closing </${name}> carries attributes`);
      if (stack.pop() !== name) throw unsafe(`mismatched closing tag </${name}>`);
      out += `</${name}>`;
      continue;
    }

    const selfClosing = /\/\s*$/.test(attrRaw);
    if (selfClosing) attrRaw = attrRaw.replace(/\/\s*$/, '');
    if (selfClosing && !VOID_TAGS.has(name)) throw unsafe(`self-closing <${name}/> is not allowed`);
    if (VOID_TAGS.has(name)) {
      const attrs = formatAttrs(name, attrRaw);
      out += `<${name}${attrs}>`;
      continue;
    }

    stack.push(name);
    out += `<${name}${formatAttrs(name, attrRaw)}>`;
  }

  out += escapeText(src.slice(last));
  if (stack.length) throw unsafe(`unclosed <${stack.at(-1)}>`);
  return out;
}

/** Defence in depth: scan a finished fragment for resource loads, handlers or dangerous URL schemes. */
export function assertNoExternalResources(html) {
  const s = String(html ?? '');
  const checks = [
    [/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|svg|math|img|video|audio|source|canvas|template|frame|frameset)\b/i, 'embedded resource or executable element'],
    [/\son[a-z]+\s*=/i, 'event handler attribute'],
    [/\s(?:src|srcset|formaction|poster|data|style)\s*=/i, 'resource-loading or style attribute'],
    [/=\s*["']?\s*(?:javascript|vbscript|data|file)\s*:/i, 'dangerous URL scheme'],
  ];
  for (const [re, why] of checks) if (re.test(s)) throw unsafe(why);
  return true;
}

/** CSS is only ever emitted by us; this keeps that promise testable. */
export function assertCssSafe(css) {
  const s = String(css ?? '');
  if (/@import/i.test(s)) throw unsafe('CSS @import is not allowed');
  if (/url\s*\(/i.test(s)) throw unsafe('CSS url() is not allowed');
  return true;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// ---- internals -------------------------------------------------------------------------------------------------

function assertSafeText(value, maxBytes) {
  const s = value == null ? '' : String(value);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes > maxBytes) throw err('too_large', `page content is ${bytes} bytes (max ${maxBytes})`);
  // Control characters are never meaningful in this content and make tokenizers lie.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw unsafe('content contains control characters');
  return s;
}

function escapeText(s) {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Markdown needs `<` neutralised before rendering, but not `>`: it starts blockquotes. A bare `>` in text is
// inert in HTML, so leaving it is safe.
function escapeMd(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Attribute values are always double-quoted: escaping `"`, `<`, `>` is enough to keep them inside the quotes.
function attrEscape(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Only these link targets: same-page anchors, same-origin paths, and https links. No fetchable attributes. */
export function safeHref(raw) {
  const u = String(raw ?? '').trim();
  if (!u || /\s/.test(u)) return null;
  if (u.startsWith('#')) return u;
  if (u.startsWith('/') && !u.startsWith('//') && !u.startsWith('/\\')) return u;
  if (/^https:\/\/[^\s]+$/i.test(u)) return u;
  return null;
}

function formatAttrs(tag, raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (/\s/.test(raw[i])) { i++; continue; }
    ATTR_RE.lastIndex = i;
    const m = ATTR_RE.exec(raw);
    if (!m || m.index !== i) throw unsafe(`malformed attribute in <${tag}>`);
    i = ATTR_RE.lastIndex;

    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined) throw unsafe(`attribute ${name} has no value`);
    if (name.startsWith('on')) throw unsafe('event handler attribute');
    if (name === 'style') throw unsafe('inline style is not allowed');

    if (name === 'href') {
      if (tag !== 'a') throw unsafe('href is only allowed on <a>');
      const u = safeHref(value);
      if (!u) throw unsafe('link target is not allowed (use #, /path or https://)');
      out += ` href="${attrEscape(u)}" rel="noopener noreferrer"`;
      continue;
    }
    if (name === 'colspan' || name === 'rowspan') {
      if (tag !== 'td' && tag !== 'th') throw unsafe(`${name} is only allowed on table cells`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw unsafe(`${name} must be an integer 1-100`);
      out += ` ${name}="${n}"`;
      continue;
    }
    if (name === 'class' || name === 'id') {
      if (!/^[a-zA-Z0-9 _-]{0,200}$/.test(value)) throw unsafe(`${name} has unsupported characters`);
      out += ` ${name}="${attrEscape(value)}"`;
      continue;
    }
    if (name === 'title') {
      if (value.length > 200) throw unsafe('title is too long');
      out += ` title="${attrEscape(value)}"`;
      continue;
    }
    throw unsafe(`attribute ${name} is not allowed on <${tag}>`);
  }
  return out;
}

function paragraph(lines) {
  return `<p>${lines.map((l) => inline(l)).join('<br>')}</p>`;
}

function isRule(line) {
  return /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}

function isBlockStart(line) {
  return /^\s*(```|~~~)/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || isRule(line);
}

/** Inline markdown on already-escaped text. Code spans are protected before emphasis/link processing. */
function inline(text) {
  const code = [];
  // `>` was kept raw so blockquotes survive block parsing; it is inert in text but escaping it keeps the
  // rendered output consistently entity-encoded (and makes the markdown→sanitize round-trip stable).
  let s = String(text).replace(/>/g, '&gt;').replace(/`([^`]+)`/g, (_, body) => `\u0000${code.push(`<code>${body}</code>`) - 1}\u0000`);

  // Images never load: only their alt text survives.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, alt) => alt);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const u = safeHref(href);
    return u ? `<a href="${attrEscape(u)}" rel="noopener noreferrer">${label}</a>` : label;
  });

  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => code[Number(n)]);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function unsafe(why) {
  return err('unsafe_html', `unsafe html: ${why}`);
}
