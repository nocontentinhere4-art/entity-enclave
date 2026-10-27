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
