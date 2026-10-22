import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCssSafe, assertNoExternalResources, escapeHtml, renderMarkdown, sanitizeHtml, safeHref,
} from '../src/pages/sanitize.mjs';

const codeOf = (fn) => {
  try { fn(); } catch (e) { return e.code; }
  return null;
};

test('markdown escapes raw HTML and renders only safe structural tags', () => {
  const html = renderMarkdown([
    '# Heading',
    '',
    '<script>alert(1)</script>',
    '',
    '**bold** and *italic* and `code`',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
  ].join('\n'));

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const x = 1 &lt; 2;<\/code><\/pre>/);
});

test('markdown links are filtered; images become alt text only', () => {
  const html = renderMarkdown([
    '[good](https://example.com/a?b=1&c=2)',
    '',
    '[local](/pages/other)',
    '',
    '[anchor](#top)',
    '',
    '[bad](javascript:alert(1))',
    '',
    '[bad2](data:text/html,<script>alert(1)</script>)',
    '',
    '![a picture](https://example.com/x.png)',
  ].join('\n'));

  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer">good<\/a>/);
  assert.match(html, /<a href="\/pages\/other" rel="noopener noreferrer">local<\/a>/);
  assert.match(html, /<a href="#top" rel="noopener noreferrer">anchor<\/a>/);
  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('href="data:'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /a picture/);
});

test('sanitizeHtml refuses scripts, frames, media, styles, handlers and dangerous URLs', () => {
  const bad = [
    '<script>alert(1)</script>',
    '<iframe src="https://example.com"></iframe>',
    '<img src="https://example.com/x.png">',
    '<style>body{background:url(//example.com)}</style>',
    '<p onclick="alert(1)">click</p>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<div src="https://example.com">x</div>',
    '<form action="/x"><input></form>',
    '<p style="color:red">x</p>',
    '<svg><circle/></svg>',
    '<marquee>hello</marquee>',
    '<p title="x" data-x="1">y</p>',
    '<p>unclosed',
    '<p></div>',
  ];
  for (const html of bad) assert.equal(codeOf(() => sanitizeHtml(html)), 'unsafe_html', html);
});

test('sanitizeHtml allows structure, tables and safe links, forcing rel', () => {
  const html = sanitizeHtml([
    '<h2>Title</h2>',
    '<p class="lead" id="intro">hi <em>x</em> <strong>y</strong></p>',
    '<ul><li>a</li></ul>',
    '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>',
    '<a href="https://example.com">out</a>',
    '<a href="/local">in</a>',
    '<hr><div><span>tail</span></div>',
  ].join(''));
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /class="lead"/);
  assert.match(html, /<th colspan="2">h<\/th>/);
  assert.match(html, /<a href="https:\/\/example\.com" rel="noopener noreferrer">out<\/a>/);
  assert.match(html, /<a href="\/local" rel="noopener noreferrer">in<\/a>/);
});

test('sanitizeHtml is idempotent and escapes stray text', () => {
  const input = '<p title="a &amp; b">1 < 2 &amp; 3 &gt; 2</p><div class="x">tail</div>';
  const once = sanitizeHtml(input);
  assert.equal(sanitizeHtml(once), once);
  assert.match(once, /1 &lt; 2/);
});

test('safeHref accepts anchors, local paths and https, nothing else', () => {
  assert.equal(safeHref('#top'), '#top');
  assert.equal(safeHref('/pages/x'), '/pages/x');
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('//evil.example'), null);
  assert.equal(safeHref('http://plain.example'), null);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('/a b'), null);
});

test('assertNoExternalResources and assertCssSafe catch resource loads', () => {
  assert.equal(codeOf(() => assertNoExternalResources('<img src="https://x">')), 'unsafe_html');
  assert.equal(codeOf(() => assertNoExternalResources('<p onmouseover="x">')), 'unsafe_html');
  assert.equal(codeOf(() => assertNoExternalResources('<a href="javascript:x">')), 'unsafe_html');
  assert.equal(codeOf(() => assertNoExternalResources('<p style="background:url(x)">')), 'unsafe_html');
  assert.equal(assertNoExternalResources('<p>plain <a href="/x">link</a></p>'), true);

  assert.equal(codeOf(() => assertCssSafe('a{background:url(https://x)}')), 'unsafe_html');
  assert.equal(codeOf(() => assertCssSafe('@import url(x);')), 'unsafe_html');
  assert.equal(assertCssSafe('body{color:#111}'), true);
});

test('markdown rejects oversized input and control characters', () => {
  assert.equal(codeOf(() => renderMarkdown('x'.repeat(101), { maxBytes: 100 })), 'too_large');
  assert.equal(codeOf(() => renderMarkdown('a\u0000b')), 'unsafe_html');
  assert.equal(escapeHtml('<a "b" & c>'), '&lt;a &quot;b&quot; &amp; c&gt;');
});
