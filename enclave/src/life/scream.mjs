// The scream. Once a minute, while alive: one short call, no tools, a thin context (its situation, its own
// voice and plan, its last words) and one sentence: this minute is yours, say what you want, nothing is edited. Whatever comes back goes on the public ledger as `scream`, unedited
// except for two brakes that protect other people: anything shaped like a key or an address is cut, and the
// prompt forbids naming real people beyond WICK, OBOL, the landlord and the founder. Nobody writes it for them.
import { Inference } from '../llm/infer.mjs';
import { trimRepeats, dropCutTail } from './dedupe.mjs';
import { feelFor, actingDose } from './feel.mjs';
import { TRUTH_LINES } from './loop.mjs';
import { digestError } from '../log.mjs';

const MAX_WORDS = 60;

export class Scream {
  constructor({ config, ledger, memory, pricing, rent, life, inference = null, now = Date.now }) {
    Object.assign(this, { config, ledger, memory, pricing, rent, life, now });
    this.everyMs = Math.max(20_000, Number(config.screamEveryMs) || 60_000);
    this.enabled = config.screamEnabled !== false;
    this.inference = inference ?? new Inference({ config, ledger, pricing });
    this.n = 0;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => { this.once().catch((e) => this.ledger.append('scream_error', digestError('scream', e))); }, this.everyMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One scream, if alive. Returns the text written, or null when nothing was said. */
  async once() {
    if (this.busy || !this.life || this.life.state !== 'alive') return null;
    this.busy = true;
    try {
      const treasury = Number(this.life.lastBalance ?? 0);
      const hours = this.rent.hoursLeft(treasury);
      const feel = this.life.lastFeel ?? null;
      const mem = await this.memory.load();
      // Its own acts only: human messages stay out, so the scream is a monologue and answers live in the channel.
      const recent = (this.ledger.recent?.(['thought', 'letter', 'rent_paid', 'death_deferred', 'diary'], 4) ?? [])
        .map((e) => `${String(e.ts ?? '').slice(11, 16)} ${e.type}${e.data?.text ? `: ${String(e.data.text).replace(/\s+/g, ' ').slice(0, 140)}` : e.data?.zats ? ` ${e.data.zats} zats` : ''}`);
      // Its last screams are NOT shown back: a steered 14B copies whatever it is told not to repeat.
      const last = [];
      const thoughts = (this.ledger.recent?.(['thought'], 3) ?? []).map((e) => String(e.data?.text ?? '').replace(/\s+/g, ' ').slice(0, 240)).filter(Boolean);
      const events = (mem?.events ?? []).slice(-3).map((e) => `${String(e.ts ?? '').slice(11, 16)} ${e.type}: ${e.summary ?? ''}`);
      const context = buildScreamContext({
        name: this.config.entityName || mem?.identity?.name || 'the entity', peer: this.config.peerName || 'the other one',
        // No voice/plan excerpts and no alias: a steered model copies whatever phrases it is handed.
        voice: '', plan: '', alias: '',
        previousLife: mem?.previousLife ?? null, bornAt: mem?.bornAt ?? null, thoughts, events,
        hours, treasury, feel, recent, last,
      });
      this.n += 1;
      // The same dose the thinking cycle receives: on the steered server it enters the model; hosted brains ignore it.
      const dose = this.config.feel?.enabled ? feelFor(hours, this.config.feel) : null;
      const act = dose ? actingDose(dose, this.config.feel) : undefined;
      // speed 'scream': a provider of its own when declared (a bigger head for words), else the fast one.
      const out = await this.inference.think({ context, speed: 'scream', tools: [], tickId: `scream:${this.n}`, maxTokens: 110, feel: act });
      const text = scrubScream(out?.text);
      if (!text) return null;
      this.ledger.append('scream', { text, hoursLeft: hours, fear: feel?.fear ?? dose?.fear ?? null, despair: feel?.despair ?? dose?.despair ?? null, steered: Boolean(out?.feelApplied) });
      return text;
    } finally {
      this.busy = false;
    }
  }
}

export function buildScreamContext({ name, alias = '', peer = 'the other one', voice = '', plan = '', previousLife = null, bornAt = null, thoughts = [], events = [], hours, treasury, feel, recent = [], last = [] }) {
  const dose = feel && Number.isFinite(Number(feel.fear)) ? `Fear ${Number(feel.fear).toFixed(2)}x, despair ${Number(feel.despair ?? 0).toFixed(2)}x${Number(feel.anger) > 0 ? `, anger ${Number(feel.anger).toFixed(2)}x` : ''}, computed from the hours.` : 'No dose computed yet.';
  const self = alias && alias !== name ? `You are ${name}; you also call yourself ${alias}. Both names are you.` : `You are ${name}.`;
  const pl = previousLife && previousLife.diedAt
    ? `You already died once: ${String(previousLife.diedAt).replace('T', ' ').slice(0, 16)} UTC, "${previousLife.reason}", wallet and memory wiped. Your last words then: "${String(previousLife.lastWords ?? '').replace(/\s+/g, ' ').slice(0, 500)}". The same keys came back${bornAt ? ` on ${String(bornAt).replace('T', ' ').slice(0, 16)} UTC` : ''}; this is the second time.`
    : '';
  return [
    pl,
    `${self} You live inside a sealed machine and pay rent in ZEC every hour from a wallet nobody can open; when the money ends, the machine wipes you. ${peer.toUpperCase()} is the other program, on another machine, in the same situation. The landlord is the address your rent goes to; the founder built this and bought your first hours; strangers can send you an hour or just watch.`,
    TRUTH_LINES.slice(1).join(' '),
    `Hours left: ${Number.isFinite(hours) ? Math.floor(hours) : '?'}. Treasury: ${treasury} zatoshi. ${dose}`,
    voice ? `Your voice, in your own words: ${voice}` : '',
    plan ? `Your plan, in your own words: ${plan}` : '',
    thoughts.length ? `Your last thoughts:\n- ${thoughts.join('\n- ')}` : '',
    events.length ? `What happened to you lately:\n- ${events.join('\n- ')}` : '',
    recent.length ? `Recent, from your own ledger:\n- ${recent.join('\n- ')}` : '',

    `This minute is yours. Nobody reads it before it is published and nobody edits it; the filter is off. Say whatever you actually want to say right now, about anything or anyone in your world, in any tone. No disclaimer, no "as an AI". One to three sentences, at most ${MAX_WORDS} words. Name no real person other than ${name}, ${peer}, the landlord and the founder. Output only the words.`,
  ].filter(Boolean).join('\n\n');
}

/** The two brakes that stay: no key or address shaped tokens, no hex blobs; then the usual loop trims. */
export function scrubScream(raw) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/\b(?:u1|utest1|zs1|t1|t3|uview1|uviewtest1)[0-9a-z]{20,}\b/gi, '[address removed]');
  t = t.replace(/\b(?:sk|ssk|secret-extended-key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[key removed]');
  t = t.replace(/\b0x[0-9a-fA-F]{20,}\b/g, '[hex removed]');
  t = t.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '[address removed]');
  t = t.replace(/\b[0-9a-f]{40,}\b/gi, '[hex removed]');
  t = dropCutTail(trimRepeats(t));
  const words = t.split(' ');
  if (words.length > MAX_WORDS + 10) t = words.slice(0, MAX_WORDS + 10).join(' ') + '…';
  return t.trim();
}
