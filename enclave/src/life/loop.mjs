// Life loop: one tick = look at the wallet, decide (paying for the thought), act through the tool whitelist,
// pay rent, remember. The charter at the top is immutable; only plan and personal rules may be rewritten.
// Death is terminal: when less than one hour of rent is left the loop hands over to `die` and never returns.
import { digestError } from '../log.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_TOOL_CALLS = 8; // a single thought cannot spend the whole treasury

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
    const speed = hunger === 'hungry' ? 'fast' : 'deep';

    // 7. Rent, once an hour of life has passed. Paid by wall clock, before the sleep short-circuit below:
    //    sleeping is not free, the host keeps charging while the entity is quiet.
    if (now - this.lastRentAt >= HOUR_MS) {
      try {
        await this.rent.payHour();
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

    // 9. One paid thought.
    const thought = await this.inference.think({
      context,
      speed,
      tools: this.tools.list(),
      tickId,
    });
    // The thought is paid already: tools quote against what is actually left.
    this.tools.setTreasury?.(Math.max(0, treasury - (Number(thought.costZats) || 0)));

    // 10. Execute tool calls in order, at most 8 per tick. One failure does not cancel the others.
    const calls = (thought.toolCalls ?? []).slice(0, MAX_TOOL_CALLS);
    let executed = 0;
    for (const c of calls) {
      try {
        await this.tools.call(c.name, c.args ?? {}, tickId);
        executed++;
      } catch (e) {
        this.ledger.append('tool_error', { name: c.name, ...digestError(`tool ${c.name}`, e) });
      }
    }

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
    const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : n);
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
      'PLAN',
      String(mem.plan ?? ''),
      'PERSONAL RULES',
      (mem.personalRules ?? []).map((r) => `- ${r}`).join('\n'),
      'OPEN PROMISES',
      promises.length ? promises.map((p) => `- ${p.due ?? '?'}: ${p.what ?? p.text ?? ''} → ${p.to ?? ''}`).join('\n') : '(none)',
      'RECENT EVENTS',
      events.length ? events.map((e) => `- ${e.ts} ${e.type}: ${e.summary}`).join('\n') : '(none)',
      'THE OTHER ENTITY',
      this.config.peerUrl
        ? `${this.config.peerUrl}  (its public endpoints: /vitals, /public-channel, /memory-public, /ledger. Read them with read_url. To speak to it, post on your public channel: it reads yours the same way. Everything between you is public.)`
        : '(not online yet: you are alone for now)',
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
