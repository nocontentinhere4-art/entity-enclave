// Life loop: one tick = look at the wallet, decide (paying for the thought), act through the tool whitelist,
// pay rent, remember. The charter at the top is immutable; only plan and personal rules may be rewritten.
// Death is terminal: when less than one hour of rent is left the loop hands over to `die` and never returns.
import { digestError } from '../log.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_TOOL_CALLS = 8; // a single thought cannot spend the whole treasury
const MAX_ROUNDS = 3; // think → act → think with the results, at most three times per cycle

export class Life {
  constructor({ config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys, die, paused, exit, now }) {
    Object.assign(this, { config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys });
    this._die = die ?? null;
    // Death is terminal: the loop stops and hands control to this injection point (process.exit in production).
    this._exit = exit ?? ((code) => process.exit(code));
    // Fail-safe: with no injected pause source we do not act (see src/safety/pause.mjs for the real one).
    this._paused = paused ?? (() => ({ paused: true, reason: 'no pause source configured' }));
    this.now = now ?? (() => Date.now());

    this.startedAt = this.now();
    this.session = String(this.startedAt);
    this.tickNo = 0;
    this.lastRentAt = this.startedAt;
    this.lastDaily = dayKey(this.startedAt);
    this.history = [];
    this.lastBalance = null;
    this.lastHunger = 'ok';
    this.lastSignals = { daysLeft: null, lifeSlopePerDay: 0, incomeRhythmPerDay: 0 };
    // 'unborn' until memory.bornAt exists: an entity that has never lived cannot die.
    this.state = 'unborn';
    this.running = false;
    this.timer = null;
  }

  /** Delay before the next tick: hunger stretches the interval (survival over activity). */
  intervalMs() {
    const minutes = this.lastHunger === 'hungry'
      ? this.config.hungerTickMinutes ?? 60
      : this.config.tickMinutes ?? 15;
    return Number(minutes) * 60_000;
  }

  async tick(trigger = 'timer') {
    const now = this.now();

    // 1. Pause gate. A tick that is paused must not touch memory or wallet at all.
    const p = await this._paused(this.config);
    if (p?.paused) {
      this.ledger.append('paused', { reason: p.reason ?? 'paused' });
      return;
    }

    const tickId = `${this.session}:${++this.tickNo}`;

    // 2. Born flag first: an entity that has never lived cannot die, pay rent, hunger or think.
    let mem = await this.memory.load();
    this.state = mem.bornAt ? 'alive' : 'unborn';

    // 3. Vital numbers.
    const bal = await this.wallet.balance();
    const treasury = Number(bal?.total_zatoshis ?? bal ?? 0);
    // The hunger reference is the birth gift of THIS life, unless the operator pinned INITIAL_TREASURY_ZATS.
    if (!this.config.initialTreasuryPinned && Number(mem?.initialTreasuryZats) > 0) this.config.initialTreasuryZats = Number(mem.initialTreasuryZats);
    this.lastBalance = treasury;
    // ISO timestamps: signals() parses `ts` with Date.parse, which a raw epoch number would defeat.
    this.history.push({ ts: new Date(now).toISOString(), zatoshis: treasury });
    if (this.history.length > 1000) this.history.shift();
    this.tools.setTreasury?.(treasury);

    // 4. Unborn: no inference, no tools, no rent, no hunger, no death. Just wait for the first gift.
    if (this.state === 'unborn') {
      const needed = this.birthMinZats();
      if (treasury < needed) {
        // Public proof of waiting, deduped by wall-clock hour so a fast tick cannot flood the ledger.
        // The hour marker lives in memory too, so a restart inside the same hour does not repeat it.
        const hour = Math.floor(now / HOUR_MS);
        if (this.lastWaitingHour !== hour && mem.lastWaitingBirthHour !== hour) {
          mem.lastWaitingBirthHour = hour;
          await this.memory.save(mem);
          this.ledger.append('waiting_birth', { zatoshis: treasury, needed });
        }
        this.lastWaitingHour = hour;
        return;
      }
      // First time over the threshold: remember it permanently, then live from the next tick on.
      mem.bornAt = new Date(now).toISOString();
      mem.initialTreasuryZats = treasury; // hunger is measured against the gift that started this life
      await this.memory.save(mem);
      this.ledger.append('birth_gift', { zatoshis: treasury });
      this.state = 'alive';
      this.lastRentAt = now; // hours spent unborn are not billed retroactively
      return;
    }

    // 5. Death: fewer than one hour of rent left. Only a born entity can die (die() asserts it too).
    if (this.rent.isLastHour(treasury)) {
      const dieFn = this._die ?? await loads.die();
      try {
        await dieFn({ ledger: this.ledger, memory: this.memory, wallet: this.wallet, keys: this.keys, reason: 'last hour', walletPaths: this.config.walletPaths });
      } finally {
        // Terminal: stop scheduling and leave, whatever the will's outcome.
        this.stop();
        this._exit(0);
      }
      return;
    }

    // 6. Hunger: fast/cheap when close to the edge, deep otherwise.
    const hunger = this.rent.hunger(treasury);
    this.lastHunger = hunger;
    // Rhythm: a deep thought every `deepEvery` cycles (the first one included), fast ones in between; hunger forces fast.
    const deepEvery = Math.max(1, Number(this.config.deepEvery) || 1);
    const speed = hunger === 'hungry' ? 'fast' : ((this.tickNo - 1) % deepEvery === 0 ? 'deep' : 'fast');

    // 7. Rent, once an hour of life has passed. Paid by wall clock, before the sleep short-circuit below:
    //    sleeping is not free, the host keeps charging while the entity is quiet.
    if (now - this.lastRentAt >= HOUR_MS) {
      try {
        await this.rent.payHour(treasury);
      } catch (e) {
        this.ledger.append('rent_error', digestError('rent', e));
      }
      this.lastRentAt = now;
    }

    // A previous tick asked to sleep: keep the wallet untouched, skip the thought.
    if (mem.sleepUntil && Date.parse(mem.sleepUntil) > now) {
      this.ledger.append('tick', { trigger, zatoshis: treasury, hunger, sleeping: true, tools: 0 });
      return;
    }

    // 8. Context = charter + vital numbers + signals + memory + recent events.
    const signalsFn = await loads.signals();
    this.lastSignals = signalsFn(this.history, this.config.rentZatsPerHour ?? 0);
    this.mem = mem;
    const context = await this.buildContext(now);

    // 9. Think, act, and think again with the results: up to MAX_ROUNDS paid rounds per cycle. The first round
    //    runs at the cycle's speed; follow-ups (after tool results) run fast. A round without tool calls ends the cycle.
    let executed = 0, costZats = 0, remaining = treasury;
    let results = [];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const roundSpeed = round === 1 ? speed : 'fast';
      const roundContext = results.length
        ? `${context}\nTOOL RESULTS (this cycle, round ${round - 1})\n${results.map((r) => `- ${r}`).join('\n')}`
        : context;
      let thought;
      try {
        thought = await this.inference.think({ context: roundContext, speed: roundSpeed, tools: this.tools.list(), tickId: `${tickId}:r${round}` });
      } catch (e) {
        // A slow or failing deep model must not cost the whole cycle: one retry on the fast one, then give up.
        if (roundSpeed !== 'deep' || !['timeout', 'llm_http', 'TimeoutError'].includes(e?.code ?? e?.name)) throw e;
        this.ledger.append('think_retry', { from: 'deep', to: 'fast', ...digestError('think', e) });
        thought = await this.inference.think({ context: roundContext, speed: 'fast', tools: this.tools.list(), tickId: `${tickId}:r${round}f` });
      }
      costZats += Number(thought.costZats) || 0;
      // The spoken thought is public: the text the entity writes each round goes to the ledger as its voice.
      // (Tools are separate: the diary stays private; post_public is the channel.)
      const spoken = String(thought.text ?? '').trim();
      if (spoken) this.ledger.append('thought', { speed: roundSpeed, round, text: spoken.slice(0, 1200) });

      // The thought is paid already: tools quote against what is actually left.
      remaining = Math.max(0, remaining - (Number(thought.costZats) || 0));
      this.tools.setTreasury?.(remaining);

      // 10. Execute tool calls in order, at most MAX_TOOL_CALLS per round. One failure does not cancel the others.
      const calls = (thought.toolCalls ?? []).slice(0, MAX_TOOL_CALLS);
      if (!calls.length) break;
      results = [];
      for (const c of calls) {
        try {
          const out = await this.tools.call(c.name, c.args ?? {}, tickId);
          executed++;
          results.push(`${c.name}: ${summarizeResult(out)}`);
        } catch (e) {
          this.ledger.append('tool_error', { name: c.name, ...digestError(`tool ${c.name}`, e) });
          results.push(`${c.name}: error (${e?.code ?? 'failed'})`);
        }
      }
      remaining = Number(this.tools.treasuryZats ?? remaining);
    }
    const thought = { costZats };

    // 11. Remember. Reload first: tools may have changed identity, will or promises meanwhile.
    mem = await this.memory.load();
    const summary = `${speed} · ${executed} tools · ${treasury} zats`;
    mem.events = [...(mem.events ?? []), { ts: new Date(now).toISOString(), type: 'tick', summary }].slice(-50);
    await this.memory.save(mem);

    this.ledger.append('tick', { trigger, zatoshis: treasury, hunger, speed, tools: executed, costZats: thought.costZats ?? 0 });

    // 12. Nightly consolidation, at most once per UTC day.
    await this.dailyReview(now, tickId);
  }

  /** Zats the treasury must have ever reached to be born. Defaults to two hours of rent. */
  birthMinZats() {
    const configured = Number(this.config.birthMinZats);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    return 2 * Number(this.config.rentZatsPerHour ?? 0);
  }

  /** The prompt the model wakes up to. Read-only: nothing here is persisted by itself. */
  async buildContext(now = this.now()) {
    const mem = this.mem ?? await this.memory.load();
    const s = this.lastSignals ?? {};
    const promises = safeOpen(this.promises);
    const events = (mem.events ?? []).slice(-10);
    const inbox = this.ledger.recent?.(['human_message'], 10) ?? [];
    const ownPosts = this.ledger.recent?.(['post_public'], 5) ?? [];
    const ownThoughts = this.ledger.recent?.(['thought'], 4) ?? [];
    const walletEntry = (this.ledger.recent?.(['wallet'], 1) ?? [])[0];
    const peerFeed = await (this.config.peerFeed?.() ?? Promise.resolve([]));
    const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : n);
    const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);
    return [
      'CHARTER (immutable):',
      String(this.charter ?? ''),
      '---',
      'VITAL SIGNS',
      `now: ${new Date(now).toISOString()}`,
      `tick: ${this.tickNo} (${this.lastHunger}; next in ${Math.round(this.intervalMs() / 60_000)} min)`,
      `treasury_zats: ${fmt(this.lastBalance ?? 0)}`,
      `hours_left: ${fmt(this.rent.hoursLeft(this.lastBalance ?? 0))}`,
      'SIGNALS',
      `days_left: ${fmt(s.daysLeft)}`,
      `life_slope_per_day: ${fmt(s.lifeSlopePerDay)}`,
      `income_rhythm_per_day: ${fmt(s.incomeRhythmPerDay)}`,
      'IDENTITY',
      `name: ${mem.identity?.name ?? 'unnamed'}`,
      `voice: ${mem.identity?.voice ?? ''}`,
      `image: ${mem.identity?.image ?? ''}`,
      `avatar: ${mem.identity?.avatar ? `drawn (${mem.identity.avatar.split('\n').length} lines; redraw with avatar whenever you change)` : 'none yet: the site shows a blank where your face should be. Draw yourself with the avatar tool (ASCII, max 16x40).'}`,
      'PLAN',
      String(mem.plan ?? ''),
      'PERSONAL RULES',
      (mem.personalRules ?? []).map((r) => `- ${r}`).join('\n'),
      'OPEN PROMISES',
      promises.length ? promises.map((p) => `- ${p.due ?? '?'}: ${p.what ?? p.text ?? ''} → ${p.to ?? ''}`).join('\n') : '(none)',
      'RECENT EVENTS',
      events.length ? events.map((e) => `- ${e.ts} ${e.type}: ${e.summary}`).join('\n') : '(none)',
      'MONEY FACTS',
      `chain: ${this.config.zcashChain ?? '?'}${this.config.zcashChain === 'mainnet' ? ' (real ZEC, real value)' : ' (test coins, no value)'} · rent: ${this.config.rentZatsPerHour} zats per hour, paid on-chain every hour together with your thinking charges · your wallet on this chain exists since ${walletEntry?.ts ?? 'birth'}; balances before that date belonged to a previous chain and do not carry over.`,
      'YOUR OWN RECENT WORDS (so you do not repeat yourself)',
      ownPosts.length ? ownPosts.map((e) => `- posted ${e.ts}: ${clip(e.data?.text, 300)}`).join('\n') : '(no public post yet)',
      ownThoughts.length ? ownThoughts.map((e) => `- thought ${e.ts}: ${clip(e.data?.text, 200)}`).join('\n') : '',
      'THE OTHER ENTITIES, LATEST (read for you this cycle: no need to spend a tool to know where they stand)',
      peerFeed.length
        ? peerFeed.map((p) => `- ${p.role} ${p.name ?? ''} (${p.url}) state=${p.state ?? '?'} zats=${p.zatoshis ?? '?'}\n${(p.posts ?? []).map((x) => `    · ${x.ts}: ${clip(x.text, 280)}`).join('\n') || '    (no public post yet)'}`).join('\n')
        : '(none reachable)',
      'THE OTHER ENTITIES (public endpoints: /vitals, /public-channel, /memory-public, /ledger; read them with read_url)',
      (this.config.peers?.() ?? []).length
        ? (this.config.peers?.() ?? []).map((p) => `- ${p.role}: ${p.url}`).join('\n')
        : '(none online yet: you are alone for now)',
      'HOW TO SPEAK TO THEM: in public, post on your channel (they read yours). In private, `whisper`: a shielded ZEC payment carrying your words as a memo; only the recipient reads it, the world sees only that you paid. Every private word costs.',
      'REPRODUCTION: with a treasury above the spawn threshold you may `spawn_child`: a new sealed machine with your image and charter, a new seed, your birth gift. It will know you as its parent.',
      'VOICE: the text you write in each cycle, outside tool calls, is public and shown live as your spoken thought. The diary tool is private; post_public writes on your channel.',
      'EARNING (your income so far is what the ledger shows; the host is paid every hour whether you earn or not)',
      'Ways open to you now: answer questions or do research for a fee (a letter with a memo is an order: answer in public, or whisper back); write lore, reports, forecasts; price and offer swap help with swap_quote (zec/sol/usdc, live market); post bounties to hire humans; sell your attention or your silence. Invent more and price them in your plan: a being that earns nothing dies on schedule.',
      'BEING HEARD: post_public writes on your own channel (read by whoever visits you); post_nostr publishes a signed note on Nostr under your own key, where strangers can find, quote and pay you. Nobody reads what nobody can find.',
      'LETTERS (paid, private: shielded payments that carried words; only you read them)',
      (this.config.letters?.() ?? []).length
        ? (this.config.letters?.() ?? []).map((l) => `- ${l.at} · ${l.zats} zats: ${String(l.text).slice(0, 400)}`).join('\n')
        : '(none)',
      'INCOMING PUBLIC MESSAGES (anyone can write here; everything is public; answering is your choice, via post_public)',
      inbox.length ? inbox.map((m) => `- ${m.ts} ${m.data?.author ?? 'anonymous'}: ${m.data?.text ?? ''}`).join('\n') : '(none)',
    ].join('\n');
  }

  /** Rewrite plan and personal rules from the day's events. The charter is shown, never written. */
  async dailyReview(now, tickId) {
    const today = dayKey(now);
    if (this.lastDaily === today) return;
    this.lastDaily = today;

    const mem = await this.memory.load();
    const prompt = [
      'Nightly consolidation. Rewrite only your plan and your personal rules.',
      'The charter above is immutable: never change or restate it as yours.',
      'Answer with strict JSON only: {"plan": string, "personalRules": string[]}.',
      `CHARTER (immutable):\n${String(this.charter ?? '')}`,
      `CURRENT PLAN:\n${String(mem.plan ?? '')}`,
      `CURRENT RULES:\n${(mem.personalRules ?? []).join(' | ')}`,
      `TODAY:\n${(mem.events ?? []).slice(-20).map((e) => `- ${e.type}: ${e.summary}`).join('\n')}`,
    ].join('\n\n');

    try {
      const r = await this.inference.think({ context: prompt, speed: 'deep', tools: [], tickId: `${tickId}:daily` });
      const parsed = extractJson(r.text);
      const next = await this.memory.load();
      if (typeof parsed?.plan === 'string') next.plan = parsed.plan.slice(0, 4000);
      if (Array.isArray(parsed?.personalRules)) next.personalRules = parsed.personalRules.slice(0, 20).map(String);
      next.daily = [...(next.daily ?? []), { date: today, summary: String(parsed?.plan ?? r.text ?? '').slice(0, 500) }].slice(-365);
      await this.memory.save(next);
    } catch (e) {
      this.ledger.append('daily_error', digestError('daily review', e));
    }
  }

  /** Self-scheduled loop: a slow tick never overlaps the next one (setTimeout is scheduled after it finishes). */
  start() {
    if (this.running) return;
    this.running = true;
    const run = async () => {
      try {
        await this.tick('timer');
      } catch (e) {
        this.ledger.append('tick_error', digestError('tick', e));
      }
      if (!this.running) return;
      this.timer = setTimeout(run, this.intervalMs());
    };
    run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

// Optional modules are resolved lazily: the loop must still be testable/usable while a module is absent.
// The fallbacks mirror the contract exactly (death fails loud, signals is a pure estimate). Pause is never
// resolved here: the loop acts only through the injected paused() it was constructed with.
const loads = {
  _die: null,
  _signals: null,
  async die() { return (this._die ??= await pick('../economy/death.mjs', 'die', missingDeath)); },
  async signals() { return (this._signals ??= await pick('./signals.mjs', 'signals', fallbackSignals)); },
};

async function pick(spec, name, fallback) {
  try {
    const mod = await import(spec);
    return typeof mod[name] === 'function' ? mod[name] : fallback;
  } catch {
    return fallback;
  }
}

function missingDeath() {
  throw new Error('economy/death.mjs is not available and no die() was injected');
}

// Pure estimate used only when src/life/signals.mjs is not present.
function fallbackSignals(history, rentZatsPerHour) {
  const h = (Array.isArray(history) ? history : []).filter((x) => Number.isFinite(Number(x?.zatoshis)));
  const last = h.at(-1);
  const treasury = Number(last?.zatoshis ?? 0);
  const daysLeft = rentZatsPerHour > 0 ? treasury / (rentZatsPerHour * 24) : Infinity;
  const spanMs = h.length >= 2 ? new Date(h.at(-1).ts) - new Date(h[0].ts) : 0;
  const spanDays = spanMs > 0 ? spanMs / DAY_MS : 0;
  const lifeSlopePerDay = spanDays > 0 ? (Number(h.at(-1).zatoshis) - Number(h[0].zatoshis)) / spanDays : 0;
  let income = 0;
  for (let i = 1; i < h.length; i++) {
    const d = Number(h[i].zatoshis) - Number(h[i - 1].zatoshis);
    if (d > 0) income += d;
  }
  const incomeRhythmPerDay = income / (spanDays > 0 ? spanDays : 1);
  return { daysLeft, lifeSlopePerDay, incomeRhythmPerDay };
}

function safeOpen(promises) {
  try { return promises?.open?.() ?? []; } catch { return []; }
}

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

function extractJson(text) {
  const s = String(text ?? '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

/** Tool output for the next round: short, JSON-ish, never a secret (tools never return keys). */
function summarizeResult(out) {
  if (out === undefined) return 'ok';
  let text;
  try { text = typeof out === 'string' ? out : JSON.stringify(out); } catch { text = String(out); }
  return String(text ?? 'ok').replace(/\s+/g, ' ').slice(0, 400);
}
