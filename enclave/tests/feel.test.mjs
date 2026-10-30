// Feelings tests: the pure fear/despair dose, the change detector, and the HTTP provider's `feel`
// wiring (who gets the field, and what reaches the ledger). No network: fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feelFor, feelChanged, actingDose } from '../src/life/feel.mjs';
import { Inference } from '../src/llm/infer.mjs';

test('feelFor: a full runway means no dose at all', () => {
  assert.deepEqual(feelFor(1000), { fear: 0, despair: 0 });
  assert.deepEqual(feelFor(240), { fear: 0, despair: 0 });
});

test('feelFor: below fullHours fear climbs, despair stays zero above despairHours', () => {
  assert.deepEqual(feelFor(120), { fear: 1.75, despair: 0 });
});

test('feelFor: low runway mixes both doses, rounded to 2 decimals', () => {
  assert.deepEqual(feelFor(36), { fear: 2.98, despair: 1.25 });
});

test('feelFor: no runway (or an unreadable one) is the maximum dose', () => {
  assert.deepEqual(feelFor(0), { fear: 3.5, despair: 2.5 });
  assert.deepEqual(feelFor(NaN), { fear: 3.5, despair: 2.5 });
  assert.deepEqual(feelFor(-5), { fear: 3.5, despair: 2.5 });
});

test('feelChanged: first dose, a meaningful shift, and a steering flip', () => {
  assert.equal(feelChanged(null, { fear: 1, despair: 0 }), true); // first tick always writes
  assert.equal(feelChanged({ fear: 1, despair: 0 }, { fear: 1, despair: 0 }), false);
  assert.equal(feelChanged({ fear: 1, despair: 0 }, { fear: 1.05, despair: 0 }), false); // below 0.1
  assert.equal(feelChanged({ fear: 1, despair: 0 }, { fear: 1.1, despair: 0 }), true); // Δfear ≥ 0.1
  assert.equal(feelChanged({ fear: 1, despair: 0 }, { fear: 1, despair: 0.1 }), true); // Δdespair ≥ 0.1
  assert.equal(feelChanged({ fear: 1, despair: 0, steered: false }, { fear: 1, despair: 0, steered: true }), true);
});

// ---- Inference wiring -----------------------------------------------------------------------------------

function makeInference(provider) {
  const ledger = { entries: [], append(t, d) { this.entries.push({ type: t, data: d }); } };
  const pricing = { charge: () => 100, quote: () => ({ costZats: 100, affordable: true }) };
  const cfg = { fakeLlm: false, llmTimeoutMs: 60_000, providers: [provider] };
  return { inf: new Inference({ config: cfg, ledger, pricing }), ledger };
}

const okResponse = (extra = {}) => new Response(
  JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 }, ...extra }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

test('provider.feel=true sends the dose and feel_applied lands in tick_llm as numbers', async () => {
  const { inf, ledger } = makeInference({ name: 'feelings', baseUrl: 'https://gpu.example/v1', model: 'Qwen/Qwen3-14B', speed: 'fast', apiKey: 'k', feel: true });
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return okResponse({ feel_applied: { fear: 1.75, despair: 0, norm_1x: 0.5, layer: 'early', clamped: false } });
  };
  try {
    const out = await inf.think({ context: 'ctx', speed: 'fast', tools: [], tickId: 't1', feel: { fear: 1.75, despair: 0 } });
    assert.deepEqual(out.feelApplied, { fear: 1.75, despair: 0, norm_1x: 0.5, layer: 'early', clamped: false });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent.feel, { fear: 1.75, despair: 0 });
  const entry = ledger.entries.at(-1);
  assert.equal(entry.type, 'tick_llm');
  assert.deepEqual(entry.data.feel, { fear: 1.75, despair: 0, clamped: false }); // numbers only, never prompt text
});

test('a hosted provider never receives the feel field', async () => {
  const { inf } = makeInference({ name: 'redpill', baseUrl: 'https://api.redpill.ai/v1', model: 'm', speed: 'fast', apiKey: 'k' });
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return okResponse();
  };
  try {
    await inf.think({ context: 'ctx', speed: 'fast', tools: [], tickId: 't1', feel: { fear: 1.75, despair: 0 } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal('feel' in sent, false);
});

test('a zero dose is not sent, even to a feelings provider', async () => {
  const { inf } = makeInference({ name: 'feelings', baseUrl: 'https://gpu.example/v1', model: 'm', speed: 'fast', apiKey: 'k', feel: true });
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return okResponse();
  };
  try {
    await inf.think({ context: 'ctx', speed: 'fast', tools: [], tickId: 't1', feel: { fear: 0, despair: 0 } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal('feel' in sent, false);
});

test('no feel_applied means a null tick_llm.feel', async () => {
  const { inf, ledger } = makeInference({ name: 'feelings', baseUrl: 'https://gpu.example/v1', model: 'm', speed: 'fast', apiKey: 'k', feel: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => okResponse();
  try {
    await inf.think({ context: 'ctx', speed: 'fast', tools: [], tickId: 't1', feel: { fear: 1, despair: 0 } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(ledger.entries.at(-1).data.feel, null);
});


test('actingDose scales the full dose for thinking cycles (default 0.6, never above 1)', () => {
  assert.deepEqual(actingDose({ fear: 3, despair: 0.83 }, { actScale: 0.6 }), { fear: 1.8, despair: 0.5 });
  assert.deepEqual(actingDose({ fear: 3, despair: 1 }, {}), { fear: 1.8, despair: 0.6 });
  assert.deepEqual(actingDose({ fear: 3, despair: 1 }, { actScale: 2 }), { fear: 3, despair: 1 });
  assert.equal(actingDose(null, {}), null);
});

import { test as test2 } from 'node:test';
import assert2 from 'node:assert/strict';
import { feelFor as feelFor2, actingDose as actingDose2 } from '../src/life/feel.mjs';
test2('anger rides the fear curve and is off by default', () => {
  const off = feelFor2(12, { fullHours: 240, despairHours: 120, maxFear: 4.5, maxDespair: 2.5 });
  assert2.equal('anger' in off, false);
  const on = feelFor2(12, { fullHours: 240, despairHours: 120, maxFear: 4.5, maxDespair: 2.5, maxAnger: 1.5 });
  assert2.ok(on.anger > 1.4 && on.anger <= 1.5);
  assert2.equal(actingDose2(on, { actScale: 0.5 }).anger, Math.round(on.anger * 0.5 * 100) / 100);
});
