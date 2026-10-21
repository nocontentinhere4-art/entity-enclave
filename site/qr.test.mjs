/*
 * qr.test.mjs — verification of the hand-written ISO 18004 encoder.
 *
 * Run with: node --test qr.test.mjs
 * Checks the contract's two required vectors (HELLO WORLD → 21×21 or 25×25
 * with finder patterns at the three corners; ZIP-321 URI round-trip) plus
 * internal consistency: format info decodes back to EC M + a legal mask, the
 * Reed-Solomon blocks re-verify over GF(256), timing patterns and the dark
 * module are in place, and over-long data fails cleanly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, qrSvg, zip321Uri, base64UrlEncode } from './qr.js';

/* ------------------------------------------------------------------ */
/* Helpers written from the standard, independent of qr.js internals   */
/* ------------------------------------------------------------------ */

/** True when the 7×7 block with top-left (ox, oy) is a legal finder pattern. */
function hasFinder(qr, ox, oy) {
  const { size, modules } = qr;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      const dark = ring !== 2;  // outer ring + 3×3 core dark, middle ring light
      assert.equal(modules[(oy + y) * size + (ox + x)] === 1, dark,
        `finder module (${ox + x},${oy + y})`);
    }
  }
}

/** Format bits as they must appear, computed here, not in qr.js. */
function expectedFormatBits(mask) {
  const data = (0 << 3) | mask;  // 0 = format bits of EC level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3FF)) ^ 0x5412;
}

/** Reads the 15 format modules of the top-left copy in the standard's order. */
function readFormatCopy1(qr) {
  const { size, modules } = qr;
  const cell = (x, y) => modules[y * size + x];
  const bits = [];
  for (let i = 0; i <= 5; i++) bits.push(cell(8, i));          // format bits 0–5
  bits.push(cell(8, 7), cell(8, 8), cell(7, 8));               // format bits 6–8
  for (let i = 9; i < 15; i++) bits.push(cell(14 - i, 8));     // format bits 9–14
  return bits.reduce((acc, b, i) => acc | (b << i), 0);
}

/** Reed-Solomon remainder over GF(256), computed here for cross-checking. */
function rsRemainderReference(data, eccLen) {
  const divisor = new Uint8Array(eccLen).fill(0);
  divisor[eccLen - 1] = 1;
  let root = 1;
  for (let i = 0; i < eccLen; i++) {
    for (let j = 0; j < eccLen; j++) {
      divisor[j] = gfMul(divisor[j], root);
      if (j + 1 < eccLen) divisor[j] ^= divisor[j + 1];
    }
    root = gfMul(root, 2);
  }
  const res = new Uint8Array(eccLen);
  for (const b of data) {
    const factor = b ^ res[0];
    for (let j = 1; j < eccLen; j++) res[j - 1] = res[j];
    res[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j++) res[j] ^= gfMul(divisor[j], factor);
  }
  return res;

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
}

/** Un-masks `qr` (independently of qr.js) and returns the raw codewords. */
function extractCodewords(qr) {
  const { size, modules, isFunction, mask } = qr;
  const invert = (m, x, y) => (
    (m === 0 && (x + y) % 2 === 0)
    || (m === 1 && y % 2 === 0)
    || (m === 2 && x % 3 === 0)
    || (m === 3 && (x + y) % 3 === 0)
    || (m === 4 && (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0)
    || (m === 5 && (x * y) % 2 + (x * y) % 3 === 0)
    || (m === 6 && ((x * y) % 2 + (x * y) % 3) % 2 === 0)
    || (m === 7 && ((x + y) % 2 + (x * y) % 3) % 2 === 0)
  );
  const nonFunctionCount = dataModuleCount(size);
  const raw = Math.floor(nonFunctionCount / 8);
  const out = new Uint8Array(raw);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const x = right - j;
        const idx = y * size + x;
        if (!isFunction[idx] && i < raw * 8) {
          const bit = invert(mask, x, y) ? modules[idx] ^ 1 : modules[idx];
          out[i >> 3] |= bit << (7 - (i & 7));
          i++;
        }
      }
    }
  }
  assert.equal(i, raw * 8, 'un-masking placed every raw bit');
  return out;

  /* number of non-function modules of a version, standard formula */
  function dataModuleCount(sz) {
    const ver = (sz - 17) / 4;
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Test 1 (contract): HELLO WORLD → 21×21 or 25×25, finders at corners */
/* ------------------------------------------------------------------ */

test('HELLO WORLD encodes as a small square with finder patterns at the three corners', () => {
  const qr = encodeQr('HELLO WORLD', { ecLevel: 'M' });
  const size = qr.size;
  assert.ok(size === 21 || size === 25,
    `expected 21 or 25 modules, got ${size} (version ${qr.version})`);
  assert.ok(qr.mask >= 0 && qr.mask <= 7, `mask ${qr.mask} in range 0–7`);
  assert.equal(qr.modules.length, size * size);
  hasFinder(qr, 0, 0);
  hasFinder(qr, size - 7, 0);
  hasFinder(qr, 0, size - 7);

  // a separator cell just outside each finder stays light
  assert.equal(qr.modules[7 * size + 7], 0, 'separator (7,7)');
  assert.equal(qr.modules[7 * size + (size - 1)], 0, 'separator right');
  assert.equal(qr.modules[(size - 1) * size + 8 - 1], 0, 'separator bottom');

  // timing patterns alternate dark/light starting dark, between the finders
  for (let i = 8; i <= size - 9; i++) {
    const expect = i % 2 === 0 ? 1 : 0;
    assert.equal(qr.modules[6 * size + i], expect, `timing row ${i}`);
    assert.equal(qr.modules[i * size + 6], expect, `timing col ${i}`);
  }
  // the always-dark module
  assert.equal(qr.modules[(size - 8) * size + 8], 1, 'dark module');
});

/* ------------------------------------------------------------------ */
/* Test 2 (contract): ZIP-321 URI round-trips through the encoder      */
/* ------------------------------------------------------------------ */

test('ZIP-321 URI round-trips: base64url memo decodes and the URI encodes without throwing', () => {
  const address = 'u1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxy';
  const memo = 'your question here';
  const uri = zip321Uri(address, memo);
  assert.ok(uri.startsWith(`zcash:${address}?amount=0.001&memo=`), `uri: ${uri}`);

  const memoField = uri.split('&memo=')[1];
  assert.ok(!/[+/=]/.test(memoField), 'memo must be base64url without padding');
  assert.equal(Buffer.from(memoField, 'base64url').toString('utf8'), memo);

  // the exact call the page makes: the URI into the encoder at EC level M
  let qr;
  assert.doesNotThrow(() => { qr = encodeQr(uri, { ecLevel: 'M' }); });
  assert.ok(qr.size >= 21 && qr.size <= 97, `size ${qr.size} in QR range`);
  assert.ok(qr.version >= 1 && qr.version <= 20, `version ${qr.version} in range`);
  hasFinder(qr, 0, 0);
  hasFinder(qr, qr.size - 7, 0);
  hasFinder(qr, 0, qr.size - 7);
});

/* ------------------------------------------------------------------ */
/* Extra self-checks (same standard, no library)                       */
/* ------------------------------------------------------------------ */

test('format info carries EC level M and the chosen mask, consistently in both copies', () => {
  const qr = encodeQr('Hello, sovereign entities.', { ecLevel: 'M' });
  const expected = expectedFormatBits(qr.mask);
  assert.equal(readFormatCopy1(qr), expected,
    `format copy 1 must be the BCH(15,5) code of M + mask${qr.mask}`);
  // second copy: bits 0–7 on row 8 right of the top-right finder, bits 8–14 on
  // column 8 above the bottom-left corner
  const { size, modules } = qr;
  for (let i = 0; i < 8; i++) {
    assert.equal(modules[8 * size + (size - 1 - i)] === 1 ? 1 : 0, (expected >>> i) & 1,
      `format copy 2 bit ${i} (row strip)`);
  }
  for (let i = 8; i < 15; i++) {
    assert.equal(modules[(size - 15 + i) * size + 8] === 1 ? 1 : 0, (expected >>> i) & 1,
      `format copy 2 bit ${i} (column strip)`);
  }
});

test('every Reed-Solomon block re-verifies after un-masking the drawn matrix', () => {
  // EC-M tables of the standard, restated here for the cross-check
  const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
  const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

  for (const version of [1, 4, 8, 11, 16, 20]) {
    const bytes = Uint8Array.from(Array.from({ length: 10 }, (_, k) => 0x41 + k));
    const qr = encodeQr(bytes, { ecLevel: 'M', minVersion: version, maxVersion: version });
    assert.equal(qr.version, version);

    const all = extractCodewords(qr);
    const eccPerBlock = ECC[version];
    const numBlocks = BLOCKS[version];
    const rawCodewords = all.length;
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    // rebuild each block body by replaying the standard interleave order
    const bodies = Array.from({ length: numBlocks }, () => new Uint8Array(shortBlockLen + 1));
    let p = 0;
    for (let i = 0; i < shortBlockLen + 1; i++) {
      for (let j = 0; j < numBlocks; j++) {
        if (i !== shortBlockLen - eccPerBlock || j >= numShortBlocks) {
          bodies[j][i] = all[p++];
        }
      }
    }
    assert.equal(p, rawCodewords, 'all raw codewords consumed');

    for (let b = 0; b < numBlocks; b++) {
      const datLen = shortBlockLen - eccPerBlock + (b < numShortBlocks ? 0 : 1);
      const dat = bodies[b].slice(0, datLen);
      const eccStart = datLen + (b < numShortBlocks ? 1 : 0);  // placeholder row in short blocks
      const ecc = bodies[b].slice(eccStart, eccStart + eccPerBlock);
      assert.deepEqual(Array.from(ecc), Array.from(rsRemainderReference(dat, eccPerBlock)),
        `version ${version} block ${b}: ECC codewords must match a reference re-encoding`);
    }
  }
});

test('data too long for versions 1-20 fails cleanly with a RangeError', () => {
  assert.throws(() => encodeQr('x'.repeat(700), { ecLevel: 'M' }), RangeError);
  assert.throws(() => encodeQr('x', { ecLevel: 'M', minVersion: 1, maxVersion: 40 }), RangeError);
  assert.throws(() => encodeQr('x', { ecLevel: 'Z' }), RangeError);
  assert.throws(() => zip321Uri('', 'memo'), RangeError);
});

test('qrSvg renders a crisp SVG with a 4-module quiet zone on white', () => {
  const svg = qrSvg('HELLO WORLD', { ecLevel: 'M' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('viewBox="0 0 29 29"'), '21 modules + 8 quiet-zone modules');
  assert.ok(svg.includes('fill="#ffffff"'), 'white background');
  assert.ok(svg.includes('M4 4h1v1h-1z'), 'top-left dark finder module drawn');
  assert.ok(svg.endsWith('</svg>'));
});
