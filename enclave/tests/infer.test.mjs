import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inference, chatCompletionsUrl, samplingBrake } from '../src/llm/infer.mjs';
import { config } from '../src/config.mjs';

test('chatCompletionsUrl never doubles /v1', () => {
  assert.equal(chatCompletionsUrl('https://api.redpill.ai/v1'), 'https://api.redpill.ai/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.redpill.ai/v1/'), 'https://api.redpill.ai/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.near.ai'), 'https://api.near.ai/v1/chat/completions');
  assert.equal(chatCompletionsUrl(''), '');
});

test('config owns the llm timeout (default 60s) and resolved provider keys', () => {
  assert.equal(config.llmTimeoutMs, 60_000);
  // Repetition brake defaults (LLM_FREQUENCY_PENALTY / LLM_PRESENCE_PENALTY / LLM_REPETITION_PENALTY).
  assert.deepEqual(config.llm, { frequencyPenalty: 0.6, presencePenalty: 0.3, repetitionPenalty: 1.15 });
  // apiKey lives on config.providers[i]: the only module reading process.env is config.mjs.
  for (const p of config.providers) assert.ok(!('apiKeyEnv' in p) || 'apiKey' in p || !process.env[p.apiKeyEnv]);
});

test('the http provider uses the resolved apiKey and a single /v1 path', async () => {
  const ledger = { entries: [], append(t, d) { this.entries.push({ type: t, data: d }); } };
  const pricing = { charge: () => 100, quote: () => ({ costZats: 100, affordable: true }) };
  const cfg = {
    fakeLlm: false, llmTimeoutMs: 60_000, llm: { frequencyPenalty: 0.6, presencePenalty: 0.3, repetitionPenalty: 1.15 },
    providers: [{ name: 'phala', baseUrl: 'https://api.redpill.ai/v1', model: 'phala/deepseek-v3.1', speed: 'fast', apiKey: 'secret-key' }],
  };
  const inf = new Inference({ config: cfg, ledger, pricing });

  let seen;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), auth: opts.headers.authorization, timeout: !!opts.signal, body: JSON.parse(opts.body) };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [] } }], usage: { total_tokens: 7 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const out = await inf.think({ context: 'ctx', speed: 'fast', tools: [], tickId: 't1' });
    assert.equal(out.text, 'hi');
    assert.equal(out.tokens, 7);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(seen.url, 'https://api.redpill.ai/v1/chat/completions');
  // The brake rides on every call: standard penalties for a hosted provider, no vLLM-only field.
  assert.equal(seen.body.frequency_penalty, 0.6);
  assert.equal(seen.body.presence_penalty, 0.3);
  assert.equal('repetition_penalty' in seen.body, false);
  assert.equal(seen.auth, 'Bearer secret-key');
  assert.equal(seen.timeout, true); // AbortSignal.timeout(llmTimeoutMs)
  assert.equal(ledger.entries.at(-1).type, 'tick_llm');
  assert.equal(ledger.entries.at(-1).data.provider, 'phala');
});

test('samplingBrake: penalties from config, repetition_penalty only for our own (feel) server, off means absent', () => {
  const llm = { frequencyPenalty: 0.6, presencePenalty: 0.3, repetitionPenalty: 1.15 };
  assert.deepEqual(samplingBrake(llm, { name: 'hosted' }), { frequency_penalty: 0.6, presence_penalty: 0.3 });
  assert.deepEqual(samplingBrake(llm, { name: 'feelings', feel: true }), { frequency_penalty: 0.6, presence_penalty: 0.3, repetition_penalty: 1.15 });
  assert.deepEqual(samplingBrake({ frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1 }, { feel: true }), {});
  assert.deepEqual(samplingBrake(undefined, { feel: true }), {});
  assert.deepEqual(samplingBrake({ frequencyPenalty: 'x', presencePenalty: -1, repetitionPenalty: NaN }, { feel: true }), {});
});
