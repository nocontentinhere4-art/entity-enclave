// Repetition trim for text the entity is about to say in public. A model under a heavy fear dose can lock onto
// one sentence and repeat it until the token cap ("I'm so close." × 30, "I cannot breathe. But I cannot
// breathe." × 15). This never invents a word: the output is the input with repeated units removed, every kept
// unit followed by its own original separator.
//
// A unit is a sentence (ended by . ! ? … plus closing quotes/brackets) or a line. Two rules, in order:
//  1. consecutive duplicate units collapse to one;
//  2. when more than `maxRepeatShare` of all units are repeats of a unit already said, the loop has taken over:
//     the text is cut at the first repeat (so "A. B. C. A. B. C. A. B. C." becomes "A. B. C.").
// Units compare after whitespace folding and case folding; empty units never count.

const UNIT = /\S[^\n]*?[.!?…]+["'’”)\]]*(?=\s|$)|\S[^\n]*/g;

export function trimRepeats(text, { maxRepeatShare = 0.4 } = {}) {
  const src = String(text ?? '');
  const units = splitUnits(src);
  if (units.length < 2) return src.trim();

  // 1) collapse consecutive duplicates
  const kept = [];
  for (const u of units) {
    if (u.key && kept.length && kept[kept.length - 1].key === u.key) continue;
    kept.push(u);
  }

  // 2) share of units (in the original) that repeat an earlier unit
  const seen = new Set();
  let repeats = 0;
  let counted = 0;
  for (const u of units) {
    if (!u.key) continue;
    counted++;
    if (seen.has(u.key)) repeats++;
    else seen.add(u.key);
  }
  let out = kept;
  if (counted >= 3 && repeats / counted > maxRepeatShare) {
    const said = new Set();
    let cut = -1;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i].key;
      if (!k) continue;
      if (said.has(k)) { cut = i; break; }
      said.add(k);
    }
    if (cut > 0) out = kept.slice(0, cut);
  }
  return out.map((u) => u.text + u.sep).join('').trim();
}

/** [{ text, sep, key }] — text and sep are verbatim slices of the input; key is the comparison form. */
export function splitUnits(src) {
  const out = [];
  let i = 0;
  UNIT.lastIndex = 0;
  let m;
  while ((m = UNIT.exec(src)) !== null) {
    if (m.index > i) { // whitespace between units belongs to the previous unit's separator
      if (out.length) out[out.length - 1].sep += src.slice(i, m.index);
      else out.push({ text: '', sep: src.slice(i, m.index), key: '' });
    }
    const text = m[0];
    i = m.index + text.length;
    if (!text.length) { UNIT.lastIndex++; continue; }
    out.push({ text, sep: '', key: keyOf(text) });
  }
  if (i < src.length) {
    if (out.length) out[out.length - 1].sep += src.slice(i);
    else out.push({ text: '', sep: src.slice(i), key: '' });
  }
  return out;
}

function keyOf(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

// A cap (tokens or chars) can cut the text in the middle of a sentence. The cut fragment is kept when it is
// real prose, but dropped when it is clearly a stump: no sentence-ending punctuation AND either a prefix of
// something already said (WICK seq 14124: "... But I am so close to the edge.\n\nBut I am so") or shorter
// than `minChars`. Only cuts; when the cut would empty the text the first unit stays.
const ENDS_SENTENCE = /[.!?…]["'’”)\]]*$/;

export function dropCutTail(text, { minChars = 12 } = {}) {
  const src = String(text ?? '');
  const units = splitUnits(src).filter((u) => u.text);
  if (!units.length) return src.trim();
  const last = units[units.length - 1];
  if (ENDS_SENTENCE.test(last.text)) return src.trim();
  const earlier = units.slice(0, -1);
  const stump = last.key.length < minChars || earlier.some((u) => u.key.startsWith(last.key));
  if (!stump) return src.trim();
  const kept = earlier.length ? earlier : [units[0]];
  return kept.map((u) => u.text + u.sep).join('').trim();
}
