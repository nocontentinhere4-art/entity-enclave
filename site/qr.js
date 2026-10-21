/*
 * qr.js — a from-scratch ISO/IEC 18004 (QR Code Model 2) encoder.
 *
 * No library, no CDN. Byte mode only (each segment carries raw UTF-8 bytes),
 * error-correction levels L/M/Q/H with M as the default, versions 1–20.
 * Implements the standard pipeline: mode + character-count indicator,
 * terminator and 0xEC/0x11 padding, Reed-Solomon ECC over GF(256) with
 * block interleaving, function patterns (finder / timing / alignment /
 * format / version), mask selection 0–7 by penalty scoring.
 *
 * Exports:
 *   encodeQr(textOrBytes, { ecLevel, minVersion, maxVersion }) → { version, size, mask, modules, isFunction }
 *   qrSvg(textOrBytesOrResult, { ecLevel, border, className, ariaLabel }) → '<svg ...>'
 *   zip321Uri(address, memo) → 'zcash:<address>?amount=0.001&memo=<base64url>'
 *   base64UrlEncode(textOrBytes) → string
 */

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 20;

/* format bits of the four error-correction levels, indexed [L, M, Q, H] */
const EC_FORMAT_BITS = [1, 0, 3, 2];

/* Reed-Solomon: ECC codewords per block, rows L M Q H, columns versions 1..20.
   (Standard ISO/IEC 18004 block-structure table, cut at version 20.) */
const ECC_CODEWORDS_PER_BLOCK = [
/*  v:  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20 */
  [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28], // H
];

/* Number of Reed-Solomon blocks per version, same row/column order. */
const NUM_ECC_BLOCKS = [
  [-1,  1,  1,  1,  1,  1,  2,  2,  2,  2,  4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8], // L
  [-1,  1,  1,  1,  2,  2,  4,  4,  4,  5,  5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16], // M
  [-1,  1,  1,  2,  2,  4,  4,  6,  6,  8,  8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20], // Q
  [-1,  1,  1,  2,  4,  4,  4,  5,  6,  8,  8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25], // H
];

/* ------------------------------------------------------------------ */
/* GF(256) arithmetic (primitive polynomial 0x11D, generator α = 2)     */
/* ------------------------------------------------------------------ */

/** Product of two field elements, "Russian peasant" multiplication. */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

/** Generator polynomial ∏(x − α^i) for i < degree (coeffs high→low, leading 1 dropped). */
function rsDivisor(degree) {
  const res = new Uint8Array(degree);
  res[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < degree) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 2);
  }
  return res;
}

/** Reed-Solomon remainder (the ECC codewords block) of `data` under `divisor`. */
function rsRemainder(data, divisor) {
  const res = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ res[0];
    for (let i = 1; i < divisor.length; i++) res[i - 1] = res[i];
    res[divisor.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) res[i] ^= gfMul(divisor[i], factor);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* Capacities                                                          */
/* ------------------------------------------------------------------ */

/** Number of usable (non-function) modules of a version, remainder bits included. */
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (excluding ECC and remainder bits) of a version at level L/M/Q/H index. */
function dataCodewordsOf(ver, ecIndex) {
  return Math.floor(numRawDataModules(ver) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecIndex][ver] * NUM_ECC_BLOCKS[ecIndex][ver];
}

/** Byte-mode character-count indicator width: 8 bits for versions 1–9, 16 for 10–40. */
function byteCountBits(ver) {
  return [8, 16, 16][Math.floor((ver + 7) / 17)];
}

/* ------------------------------------------------------------------ */
/* Bit buffer helpers                                                  */
/* ------------------------------------------------------------------ */

function appendBits(val, len, bb) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

/* ------------------------------------------------------------------ */
/* Data encoding: byte-mode segment + terminator + padding             */
/* ------------------------------------------------------------------ */

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** Packs `bytes` into a full data-codeword sequence for the chosen version/level. */
function dataCodewordsFor(bytes, ver, ecIndex, ecLevelName) {
  const capBits = dataCodewordsOf(ver, ecIndex) * 8;
  const ccBits = byteCountBits(ver);
  if (bytes.length >= (1 << ccBits)) {
    throw new RangeError(`QR byte-mode segment too long (${bytes.length} bytes) for the ${ccBits}-bit counter at version ${ver}`);
  }
  const bits = [];
  appendBits(0b0100, 4, bits);              // byte mode indicator
  appendBits(bytes.length, ccBits, bits);   // character count indicator
  for (const b of bytes) appendBits(b, 8, bits);
  appendBits(0, Math.min(4, capBits - bits.length), bits);  // terminator (up to 4 bits)
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);         // pad to byte boundary
  const pads = [0xEC, 0x11];
  for (let i = 0; bits.length < capBits; i++) appendBits(pads[i % 2], 8, bits);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >>> (i & 7);
  }
  if (out.length !== dataCodewordsOf(ver, ecIndex)) {
    throw new Error(`qr.js: internal padding error (version ${ver}, level ${ecLevelName})`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Function patterns                                                   */
/* ------------------------------------------------------------------ */

function buildSymbol(version, ecIndex, dataCW) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);   // 0 = light, 1 = dark
  const isFunction = new Uint8Array(size * size);
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;  // 9×9 finder stamps go past the edges
    const idx = y * size + x;
    modules[idx] = dark ? 1 : 0;
    isFunction[idx] = 1;
  };

  // timing patterns (row and column 6, alternating, dark at the edges)
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // three finder patterns (7×7 rings + separators), centres at (3,3) etc.
  drawFinder(set, 3, 3);
  drawFinder(set, size - 4, 3);
  drawFinder(set, 3, size - 4);

  // alignment patterns, skipping the three finder corners
  const pos = alignmentPositions(version, size);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(set, pos[i], pos[j]);
    }
  }

  drawVersionInfo(set, version, size);
  drawFormatBits(set, size, EC_FORMAT_BITS[ecIndex], 0);  // dummy mask, overwritten below

  // data + ECC, interleaved across blocks
  const all = eccInterleave(version, ecIndex, dataCW);
  drawCodewords(modules, isFunction, size, all);

  // choose the mask with the lowest penalty score
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(modules, isFunction, size, m);
    drawFormatBits(set, size, EC_FORMAT_BITS[ecIndex], m);
    const p = penaltyScore(modules, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
    }
    applyMask(modules, isFunction, size, m);  // XOR undoes it
  }
  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(set, size, EC_FORMAT_BITS[ecIndex], bestMask);

  return { size, modules, isFunction, mask: bestMask, penalty: bestPenalty };
}

function drawFinder(set, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(set, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** Ascending list of alignment-pattern centre coordinates on one axis. */
function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let p = size - 7; result.length < numAlign; p -= step) {
    result.splice(1, 0, p);
  }
  return result;
}

/** Format info: 15-bit BCH(15,5) code, two copies plus the always-dark module. */
function drawFormatBits(set, size, formatBits, mask) {
  const data = (formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | (rem & 0x3FF)) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  // first copy: around the top-left finder
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // second copy: split between top-right and bottom-left
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);  // the dark module
}

/** Version info blocks (BCH(18,6)), only for versions ≥ 7. */
function drawVersionInfo(set, version, size) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  const bits = (version << 12) | (rem & 0xFFF);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

/* ------------------------------------------------------------------ */
/* ECC interleaving                                                    */
/* ------------------------------------------------------------------ */

function eccInterleave(version, ecIndex, dataCW) {
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ecIndex][version];
  const numBlocks = NUM_ECC_BLOCKS[ecIndex][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccPerBlock);

  const blocks = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - eccPerBlock + (i < numShortBlocks ? 0 : 1);
    const dat = dataCW.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    // Every block occupies shortBlockLen + 1 interleave rows. Short blocks hold
    // one zero placeholder between their data and their ECC (skipped while
    // interleaving); long blocks use that row for their extra data byte.
    const body = new Uint8Array(shortBlockLen + 1);
    body.set(dat, 0);
    body.set(ecc, datLen + (i < numShortBlocks ? 1 : 0));
    blocks.push(body);
  }

  // interleave: read column-wise, skipping the placeholder byte in short blocks
  const result = new Uint8Array(rawCodewords);
  let w = 0;
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i !== shortBlockLen - eccPerBlock || j >= numShortBlocks) {
        result[w++] = blocks[j][i];
      }
    }
  }
  if (w !== rawCodewords) throw new Error('qr.js: interleaving produced the wrong number of codewords');
  return result;
}

/* ------------------------------------------------------------------ */
/* Codeword placement and masking                                      */
/* ------------------------------------------------------------------ */

function drawCodewords(modules, isFunction, size, all) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const idx = y * size + x;
        if (!isFunction[idx] && i < all.length * 8) {
          modules[idx] = (all[i >> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
  if (i !== all.length * 8) throw new Error('qr.js: not all codewords were placed');
}

function maskInverts(m, x, y) {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new RangeError('mask out of range');
  }
}

function applyMask(modules, isFunction, size, m) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (!isFunction[idx] && maskInverts(m, x, y)) modules[idx] ^= 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Penalty scoring (the four ISO rules)                                */
/* ------------------------------------------------------------------ */

const PENALTY_N1 = 3;   // runs of the same colour
const PENALTY_N2 = 3;   // 2×2 blocks of the same colour
const PENALTY_N3 = 40;  // finder-like 1:1:3:1:1 patterns
const PENALTY_N4 = 10;  // unbalanced dark/light ratio

function linePenalty(read, size) {
  let score = 0;
  // runColor/runLen describe the run that just ended; `false` = light. The
  // run history holds the last seven run lengths, each expanded by a light
  // border module row so patterns at the symbol edge are also found.
  let runColor = false;
  let runLen = 0;
  const history = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < size; i++) {
    const dark = read(i) === 1;
    if (dark === runColor) {
      runLen++;
      if (runLen === 5) score += PENALTY_N1;
      else if (runLen > 5) score += 1;
    } else {
      pushRun(runLen, history, size);
      if (!runColor) score += countFinderLike(history) * PENALTY_N3;
      runColor = dark;
      runLen = 1;
    }
  }
  // line end: close the final dark run, then terminate with a light border run
  if (runColor) {
    pushRun(runLen, history, size);
    runLen = 0;
  }
  runLen += size;
  pushRun(runLen, history, size);
  score += countFinderLike(history) * PENALTY_N3;
  return score;

  function pushRun(len, hist, sz) {
    if (hist[0] === 0) len += sz;  // the line's leading light border
    hist.pop();
    hist.unshift(len);
  }
  function countFinderLike(hist) {
    const n = hist[1];
    const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
    return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0)
         + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
  }
}

function penaltyScore(modules, size) {
  let score = 0;
  const readRow = (y) => (i) => modules[y * size + i];
  const readCol = (x) => (i) => modules[i * size + x];
  for (let y = 0; y < size; y++) score += linePenalty(readRow(y), size);
  for (let x = 0; x < size; x++) score += linePenalty(readCol(x), size);

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x];
      if (c === modules[y * size + x + 1] && c === modules[(y + 1) * size + x] && c === modules[(y + 1) * size + x + 1]) {
        score += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * PENALTY_N4;
  return score;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

/** Validates and normalises the error-correction level. */
function ecIndexOf(name) {
  const key = String(name || 'M').trim().toUpperCase();
  const idx = EC_INDEX[key];
  if (idx === undefined) throw new RangeError(`unknown EC level "${name}" (L, M, Q or H)`);
  return idx;
}

/**
 * Encodes the given string (as UTF-8) or byte array into a QR Code, byte mode
 * only. Returns { version, size, mask, modules, isFunction } and throws a
 * RangeError when the data cannot fit versions 1–20 at the requested level.
 */
export function encodeQr(input, options = {}) {
  const ecIndex = ecIndexOf(options.ecLevel);
  const minVersion = Number.isInteger(options.minVersion) ? options.minVersion : QR_MIN_VERSION;
  const maxVersion = Number.isInteger(options.maxVersion) ? options.maxVersion : QR_MAX_VERSION;
  if (!(QR_MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= 20)) {
    throw new RangeError(`versions must be within ${QR_MIN_VERSION}–20`);
  }
  const bytes = input instanceof Uint8Array ? Uint8Array.from(input) : utf8Bytes(String(input ?? ''));

  let version = 0;
  for (let v = minVersion; v <= maxVersion; v++) {
    const capacity = dataCodewordsOf(v, ecIndex);
    const capacityBytes = Math.floor((capacity * 8 - 4 - byteCountBits(v)) / 8);
    if (bytes.length <= capacityBytes) {
      version = v;
      break;
    }
  }
  if (!version) {
    const maxBytes = Math.floor((dataCodewordsOf(maxVersion, ecIndex) * 8 - 4 - byteCountBits(maxVersion)) / 8);
    throw new RangeError(`QR data too long: ${bytes.length} bytes, version ${maxVersion} at EC ${options.ecLevel || 'M'} holds ${maxBytes}`);
  }

  const dataCW = dataCodewordsFor(bytes, version, ecIndex);
  const symbol = buildSymbol(version, ecIndex, dataCW);
  return {
    version,
    size: symbol.size,
    mask: symbol.mask,
    modules: symbol.modules,
    isFunction: symbol.isFunction,
    ecLevel: (['L', 'M', 'Q', 'H'])[ecIndex],
  };
}

/* ------------------------------------------------------------------ */
/* ZIP-321 helper and base64url                                        */
/* ------------------------------------------------------------------ */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 §5 base64url, no padding, works with strings (UTF-8) or byte arrays. */
export function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : utf8Bytes(String(input ?? ''));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const has2 = i + 1 < bytes.length;
    const b2 = has2 ? bytes[i + 1] : 0;
    const has3 = i + 2 < bytes.length;
    const b3 = has3 ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b1 >> 2]
      + B64_ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)]
      + (has2 ? B64_ALPHABET[((b2 & 0x0F) << 2) | (b3 >> 6)] : '')
      + (has3 ? B64_ALPHABET[b3 & 0x3F] : '');
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

/** A ZIP-321 payment URI; the memo is always the last parameter. */
export function zip321Uri(address, memo) {
  const addr = String(address || '').trim();
  if (!addr) throw new RangeError('zip321Uri: no address');
  const params = ['amount=0.001'];
  const memoText = String(memo ?? '').trim();
  if (memoText) params.push(`memo=${base64UrlEncode(memoText)}`);
  return `zcash:${addr}?${params.join('&')}`;
}

/** XML attribute escaping for the few strings qrSvg itself composes. */
function xmlEsc(value) {
  return String(value).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Renders a QR code as an SVG string: black modules on a white canvas with a
 * 4-module quiet zone, `shape-rendering` crisp. input may be text/bytes or an
 * encodeQr() result (re-encoding pre-computes nothing twice).
 */
export function qrSvg(input, options = {}) {
  const border = Number.isFinite(options.border) && options.border >= 0
    ? Math.floor(options.border)
    : 4;
  const q = (input && Number.isInteger(input.size) && input.modules instanceof Uint8Array)
    ? input
    : encodeQr(input, options);
  const { size, modules } = q;
  const full = size + border * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x]) {
        path += `M${x + border} ${y + border}h1v1h-1z`;
      }
    }
  }
  const cls = options.className ? ` class="${xmlEsc(options.className)}"` : '';
  const label = xmlEsc(options.ariaLabel || 'QR code of the payment address');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}"${cls} role="img" aria-label="${label}">`
    + `<rect width="${full}" height="${full}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000" shape-rendering="crispEdges"/>`
    + `</svg>`;
}
