// Inference: the entity's only "brain". Two providers behind one interface.
//  - `fake` (config.fakeLlm): fully deterministic from sha256(context), used by tests and local dev.
//  - HTTP OpenAI-compatible (`/v1/chat/completions` with tool calling) for NEAR AI / Phala TEE endpoints.
// Every call is paid for from the treasury and leaves a public `tick_llm` entry: what was asked of the model
// (the context), the private keys and the provider's API key never touch the ledger.
import { createHash } from 'node:crypto';

export class Inference {
  constructor({ config, ledger, pricing }) {
    this.config = config;
    this.ledger = ledger;
    this.pricing = pricing;
  }

  /** One paid thought. `tools` may be a Tools instance or a plain [{name,description,parameters}]. */
  async think({ context, speed = 'fast', tools = [], tickId, feel, priority, maxTokens }) {
    const fast = speed !== 'deep';
    const action = fast ? 'think_fast' : 'think_deep';
    // Charge first: thinking is never free, even if the provider then fails.
    const costZats = Number(this.pricing.charge(action, tickId)) || 0;

    let out;
    if (this.config.fakeLlm) {
      out = fake(context, tools);
    } else {
      const provider = pickProvider(this.config.providers ?? [], fast ? 'fast' : 'deep', context);
      out = await this.#http(provider, { context, tools, feel, priority, maxTokens });
    }

    const respHash = sha256(stable({ text: out.text, toolCalls: out.toolCalls }));
    // Only the numeric dose is public: the prompt text never reaches the ledger.
    const feelApplied = out.feelApplied ?? null;
    this.ledger.append('tick_llm', {
      provider: out.provider,
      model: out.model,
      tokens: out.tokens,
      costZats,
      respHash,
      feel: feelApplied ? { fear: feelApplied.fear, despair: feelApplied.despair, clamped: feelApplied.clamped } : null,
    });
    return { ...out, costZats };
  }

  async #http(provider, { context, tools, feel, priority, maxTokens }) {
    const url = chatCompletionsUrl(provider.baseUrl);
    if (!url) throw err('no_provider', 'llm provider has no baseUrl');
    const defs = (tools?.list ? tools.list() : tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
    const messages = [{ role: 'user', content: String(context ?? '') }];
    const body = { model: provider.model, messages };
    if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Math.floor(Number(maxTokens));
    Object.assign(body, samplingBrake(this.config.llm, provider));
    // Provider-specific request fields, declared in LLM_PROVIDERS as `body` (e.g. Qwen3 on SGLang/vLLM:
    // {"chat_template_kwargs":{"enable_thinking":false}} turns the 700-token reasoning preamble off, 30 s → 2 s).
    // They never override the model, the messages or the tools.
    if (provider.body && typeof provider.body === 'object') {
      for (const [k, v] of Object.entries(provider.body)) if (!['model', 'messages', 'tools', 'tool_choice', 'feel'].includes(k)) body[k] = v;
    }
    if (defs.length) { body.tools = defs; body.tool_choice = 'auto'; }
    // The `feel` field goes only to a provider that declared it (the steered-inference server) and only
    // when a dose is actually positive: hosted providers must never see it.
    if (provider.feel === true && feel && (Number(feel.fear) > 0 || Number(feel.despair) > 0)) {
      body.feel = { fear: Number(feel.fear), despair: Number(feel.despair) };
    }
    // Our own server runs one generation at a time: a reply to a human jumps ahead of the entity's thinking.
    if (provider.feel === true && priority === 'high') body.priority = 'high';

    // Some proxies (RunPod, Cloudflare) answer 403 to requests without a User-Agent.
    const headers = { 'content-type': 'application/json', 'user-agent': 'zealot-enclave/1.0' };
    const key = apiKey(provider);
    if (key) headers.authorization = `Bearer ${key}`; // never logged, never returned

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(this.config.llmTimeoutMs ?? 60_000)),
    });
    if (!res.ok) throw err('llm_http', `${provider.name} responded ${res.status}`);
    const json = await res.json();

    const msg = json?.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
      name: tc?.function?.name,
      args: parseArgs(tc?.function?.arguments),
    })).filter((c) => c.name);
    const text = typeof msg.content === 'string' ? msg.content : '';
    const tokens = Number(json?.usage?.total_tokens ?? 0);
    const raw = json?.attestation ?? json?.model_attestation ?? json?.provider_attestation ?? null;
    const attestation = raw ? verifyAttestation(raw) : { mode: 'dev', note: 'provider returned no attestation' };
    const feelApplied = json?.feel_applied ?? null;

    return { text, toolCalls, provider: provider.name, model: provider.model, tokens, attestation, feelApplied };
  }
}

/**
 * Attestation check, v1: presence and shape only. A TEE provider should return an object carrying a quote
 * (or signature). We do NOT yet verify it cryptographically.
 * TODO: verify the TDX quote signature against Intel/Phala roots and bind it to a known image hash.
 */
export function verifyAttestation(a) {
  const quote = typeof a === 'string' ? a : a?.quote ?? a?.signature ?? a?.tdx_quote;
  if (typeof quote === 'string' && quote.length >= 64) {
    return { mode: 'claimed', quote, ...(a?.model ? { model: a.model } : {}) };
  }
  throw err('attestation_rejected', 'attestation missing or malformed');
}

/** Deterministic local provider: same context in, same thought (and tool calls) out. */
function fake(context, tools) {
  const h = sha256(String(context ?? ''));
  const slug = h.slice(0, 8);
  // Second round of a cycle (tool results are in the context): speak, call nothing, so a cycle ends after two rounds.
  if (String(context ?? '').includes('TOOL RESULTS')) {
    return { text: `fake reflection ${slug}: I saw the results.`, toolCalls: [], provider: 'fake', model: 'fake-deterministic', tokens: 200, attestation: { mode: 'dev', note: 'fake provider is not attested' } };
  }
  const provided = tools?.list ? tools.list() : tools;
  const offered = Array.isArray(provided) ? new Set(provided.map((t) => t.name)) : null;
  const has = (n) => !offered || offered.has(n); // no list = free choice; empty list = no tools
  const wanted = [
    ['read_url', { url: `https://example.com/${slug}` }],
    ['diary', { text: `tick ${slug}: still here, still spending` }],
    ['post_public', { text: `Still alive (${slug}).` }],
    ['balance', {}],
    ['whisper', { to: 'peer', text: `paid word ${slug}`, zats: 10000 }],
  ];
  const toolCalls = wanted.filter(([n]) => has(n)).map(([name, args]) => ({ name, args }));
  return {
    text: `fake thought ${slug}: I exist, therefore I spend.`,
    toolCalls,
    provider: 'fake',
    model: 'fake-deterministic',
    tokens: 500, // fixed, so tests can predict the cost
    attestation: { mode: 'dev', note: 'fake provider is not attested' },
  };
}

function pickProvider(providers, speed, context) {
  const matching = providers.filter((p) => !p.speed || p.speed === speed);
  const pool = matching.length ? matching : providers;
  if (!pool.length) throw err('no_provider', `no llm provider for speed=${speed}`);
  const h = createHash('sha256').update(String(context ?? '')).digest();
  return pool[h[0] % pool.length]; // deterministic choice, so retries are reproducible
}

/**
 * Repetition brake fields for one request. frequency/presence penalties are standard OpenAI-compatible fields;
 * repetition_penalty is not, so it goes only to a provider that declared `feel: true` (our own server) — a
 * strict hosted API could reject an unknown field. Off (0 / 1 / unset) means the field is not sent at all.
 */
export function samplingBrake(llm = {}, provider = {}) {
  const out = {};
  const f = Number(llm?.frequencyPenalty);
  const p = Number(llm?.presencePenalty);
  const r = Number(llm?.repetitionPenalty);
  if (Number.isFinite(f) && f > 0) out.frequency_penalty = f;
  if (Number.isFinite(p) && p > 0) out.presence_penalty = p;
  if (provider?.feel === true && Number.isFinite(r) && r > 0 && r !== 1) out.repetition_penalty = r;
  return out;
}

function apiKey(p) {
  // Config resolves the key once (the only module allowed to read the environment). Never logged.
  return p.apiKey;
}

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(String(s ?? '{}')); } catch { return {}; }
}

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

/** Normalise a provider base URL so `/v1` is never doubled (some providers already include it). */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base.replace(/\/v1$/, '')}/v1/chat/completions`;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
// Canonical JSON so a hash of the same logical value is stable regardless of key order.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
