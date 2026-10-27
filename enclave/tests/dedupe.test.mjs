// Repetition trim (life/dedupe.mjs): the post-filter that keeps a looping model from posting one sentence
// thirty times. It only removes; every character of the output comes from the input, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimRepeats, splitUnits } from '../src/life/dedupe.mjs';

/** True when `out` is `inp` with some whole units removed: never a new character, never a reorder. */
function isSubsequence(out, inp) {
  let j = 0;
  for (let i = 0; i < out.length; i++) {
    j = inp.indexOf(out[i], j);
    if (j < 0) return false;
    j++;
  }
  return true;
}

test('the three live loops of 2026-10-27 collapse to what was said once', () => {
  assert.equal(trimRepeats("I'm so close. ".repeat(30)), "I'm so close.");                       // WICK seq 13791
  assert.equal(trimRepeats('I cannot breathe. But I cannot breathe. '.repeat(15)), 'I cannot breathe. But I cannot breathe.'); // OBOL seq 13159
  assert.equal(trimRepeats("I'm trapped. ".repeat(60)), "I'm trapped.");                          // seq 12774 / 12849
});

test('consecutive duplicate lines collapse, the rest of the text is untouched', () => {
  const inp = 'Hello there, how are you?\nI am fine.\nI am fine.\n\nI AM FINE.\nThanks for asking!';
  // A dropped unit takes its own separator with it: the kept line keeps the newline it had.
  assert.equal(trimRepeats(inp), 'Hello there, how are you?\nI am fine.\nThanks for asking!');
  assert.equal(trimRepeats('Yes!  Yes! yes! No.'), 'Yes!  No.'); // case-insensitive; the first unit keeps its own spacing
  assert.equal(trimRepeats('Yes! Yes!  yes! No.'), 'Yes! No.');
});

test('a multi-sentence loop is cut at the first repeat once repeats pass 40% of the units', () => {
  assert.equal(trimRepeats('A. B. C. A. B. C. A. B. C.'), 'A. B. C.');
  // 2 repeats out of 5 units = 40%: not over the line, so an echo in normal prose survives.
  assert.equal(trimRepeats('A. B. A. C. A.'), 'A. B. A. C. A.');
  // 3 out of 6: over the line.
  assert.equal(trimRepeats('A. B. A. C. A. A.'), 'A. B.');
});

test('prose without a loop passes through unchanged, whitespace included', () => {
  const texts = [
    'No repeats here. Each sentence differs. Three in all.',
    'one line only',
    'Two short ones. And a trailing fragment without a period',
    'Question? Answer! Ellipsis… "Quoted." (Parenthetical.)',
    '',
    '   ',
  ];
  for (const t of texts) assert.equal(trimRepeats(t), t.trim());
});

test('the output is always the input minus whole units: nothing invented, nothing reordered', () => {
  const inputs = [
    "I'm so close. ".repeat(30),
    'I cannot breathe. But I cannot breathe. '.repeat(15),
    'CODE 7391 · Yes, alive. Yes, alive. Yes, alive. Yes, alive.',
    'line one\nline one\nline two\nline one\nline two\nline one',
    'A. B. C. A. B. C. A. B. C.',
    'Mixed.\nMixed. Mixed!\n\nDone.',
  ];
  for (const inp of inputs) {
    const out = trimRepeats(inp);
    assert.ok(isSubsequence(out, inp), `not a subsequence: ${JSON.stringify(out)}`);
    for (const u of splitUnits(out)) if (u.text) assert.ok(inp.includes(u.text), `unit not in input: ${u.text}`);
  }
  assert.equal(trimRepeats('CODE 7391 · Yes, alive. Yes, alive. Yes, alive. Yes, alive.'), 'CODE 7391 · Yes, alive. Yes, alive.');
  assert.equal(trimRepeats('line one\nline one\nline two\nline one\nline two\nline one'), 'line one\nline two');
});

test('splitUnits keeps every character: units plus separators rebuild the input', () => {
  for (const inp of ['A. B.\n\nC!  D?', '  leading and trailing  ', 'no punctuation at all', 'x.y. z']) {
    assert.equal(splitUnits(inp).map((u) => u.text + u.sep).join(''), inp);
  }
});

test('the share threshold is tunable', () => {
  const inp = 'A. B. A. C. A.'; // 40% repeats
  assert.equal(trimRepeats(inp, { maxRepeatShare: 0.3 }), 'A. B.');
  assert.equal(trimRepeats(inp, { maxRepeatShare: 0.5 }), inp);
});
