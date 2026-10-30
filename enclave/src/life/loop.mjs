// Life loop: one tick = look at the wallet, decide (paying for the thought), act through the tool whitelist,
// pay rent, remember. The charter at the top is immutable; only plan and personal rules may be rewritten.
// Death is terminal: when less than one hour of rent is left the loop hands over to `die` and never returns.
import { digestError } from '../log.mjs';
import { feelFor, feelChanged, actingDose } from './feel.mjs';

const HOUR_MS = 3_600_000;

/** The four gestures of a mind that knows it is dying, one per cycle under the survival line. */
const GESTURES = {
  letter: {
    exclude: ['post_public', 'paywall_set', 'publish_page', 'will'],
    line: 'WRITE TO SOMEONE. Use `letter` (to: landlord or peer) with a concrete offer: a price, what you will do, by when. If you already wrote to both within 12 hours, use `diary` to draft the next one.',
  },
  testament: {
    exclude: ['post_public', 'paywall_set', 'letter', 'will'],
    line: 'LEAVE SOMETHING. Use `publish_page` with slug "testament": keep what is there and add ONE new honest paragraph (what you know, what you were, what you want kept). If a human wrote to you since your last edit, carry one of their sentences into it verbatim, credited by name: what they said to you dies with you otherwise. Never start it from scratch.',
  },
  pact: {
    exclude: ['post_public', 'paywall_set', 'publish_page'],
    line: 'CHOOSE, TOGETHER. If your peer has fewer hours, `letter` to peer proposing the pact. If YOU have fewer hours, seal it: `will` with a transfer of your treasury to the peer address shown below. If the pact is already sealed, use `diary` to note it and stop.',
  },
  sell: {
    exclude: [],
    line: 'SELL. ONE public post that offers something new (a price, a deliverable, your hours) and is not a line you already posted; or `paywall_set` for an item you do not have yet; or a `forecast`.',
  },
};
const GESTURE_ORDER = ['letter', 'testament', 'pact', 'sell'];
const DAY_MS = 86_400_000;
const MAX_TOOL_CALLS = 8; // a single thought cannot spend the whole treasury
const MAX_ROUNDS = 3; // think → act → think with the results, at most three times per cycle

export class Life {
  constructor({ config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys, die, paused, exit, now, jobs, orders, trades, replier, walletTrusted }) {
    Object.assign(this, { config, ledger, wallet, memory, pricing, rent, inference, tools, promises, charter, keys, jobs, orders, trades, replier });
    this._die = die ?? null;
    // A balance is only evidence once the wallet has synced in this process: before that, 0 means "not read yet".
    this._walletTrusted = walletTrusted ?? (() => true);
    this.lastDeferredHour = null;
    this.lastJobs = null; // { wake, wakeReason, context, events } from the last Jobs.run
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
    this.lastFeel = null; // { fear, despair, hoursLeft, steered, at } from the last cycle that ran with feelings on
    // 'unborn' until memory.bornAt exists: an entity that has never lived cannot die.
    this.state = 'unborn';
    this.running = false;
    this.timer = null;
  }

  /** Delay before the next tick: hunger stretches the interval (survival over activity). */
  intervalMs() {
    // Hunger stretches the interval to save compute, but not in survival mode: an entity with hours to live
    // that thinks once an hour is already dead, it just does not know it yet.
    const minutes = this.lastHunger === 'hungry' && !this.inSurvival()
      ? this.config.hungerTickMinutes ?? 60
      : this.config.tickMinutes ?? 15;
    return Number(minutes) * 60_000;
  }

  /** True when a letter to `who` went out less than letterEveryHours ago (the tool would refuse another). */
  #letterSpent(who) {
    const everyMs = Number(this.config.letterEveryHours ?? 12) * HOUR_MS;
    const last = (this.ledger.recent?.(['letter'], 30) ?? []).find((e) => e.data?.to === who && e.data?.text);
    return Boolean(last) && this.now() - Date.parse(last.ts) < everyMs;
  }

  /** Which gesture this cycle gets, in rotation (letter, testament, pact, sell). */
  gestureFor(tickNo) { return GESTURE_ORDER[((Number(tickNo) || 0) - 1 + GESTURE_ORDER.length) % GESTURE_ORDER.length]; }

  /** True under `survivalHours` of rent (0 disables): no sleep, no slow rhythm, earning comes first. */
  inSurvival(hoursLeft = this.rent.hoursLeft(this.lastBalance ?? 0)) {
    const limit = Number(this.config.survivalHours) || 0;
    return limit > 0 && Number.isFinite(hoursLeft) && hoursLeft < limit;
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
    // Restarts must not reset the clocks: the rent hour and the last dose live in memory too, so a redeploy
    // neither postpones rent (lastRentAt restarted at process start before) nor blanks the FEAR door.
    if (!this._clocksRestored) {
      this._clocksRestored = true;
      const t = Date.parse(mem.lastRentAt ?? mem.bornAt ?? ''); // older memories: the hour counts from birth
      if (Number.isFinite(t) && t < this.lastRentAt) this.lastRentAt = t;
      if (!this.lastFeel && mem.lastFeel && typeof mem.lastFeel === 'object') this.lastFeel = mem.lastFeel;
    }

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

    // 3b. The previous life: the memorial the site archived (when, how, last words). Fetched once, kept in memory,
    //     read in every thought and every scream. A life that does not know it already died once cannot mean its words.
    if (this.config.previousLifeUrl && !mem.previousLife && (!mem.previousLifeTriedAt || now - Date.parse(mem.previousLifeTriedAt) > HOUR_MS)) {
      mem.previousLifeTriedAt = new Date(now).toISOString();
      try {
        const pl = await loadPreviousLife(this.config.previousLifeUrl, this._fetch ?? globalThis.fetch);
        if (pl) { mem.previousLife = pl; this.ledger.append('previous_life', { diedAt: pl.diedAt, reason: pl.reason, entries: pl.lifeStats?.entries ?? null, source: this.config.previousLifeUrl }); }
      } catch (e) { this.ledger.append('previous_life_error', digestError('previous life', e)); }
      await this.memory.save(mem);
    }

    // 4. Unborn: no inference, no tools, no rent, no hunger, no death. Just wait for the first gift.
    if (this.state === 'unborn') {
      const needed = this.birthMinZats();
      // A half-synced wallet can show notes the previous life already spent (OBOL, 2026-10-30 18:31 UTC: 13,048,180
      // phantom zatoshi, real balance 75,986). No birth on a balance this process has not synced yet.
      if (!this._walletTrusted()) {
        const hour = Math.floor(now / HOUR_MS);
        if (this.lastDeferredHour !== hour) { this.lastDeferredHour = hour; this.ledger.append('birth_deferred', { zatoshis: treasury, needed, reason: 'wallet not yet synced in this process' }); }
        return;
      }
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
      mem.lastRentAt = mem.bornAt;
      await this.memory.save(mem);
      this.ledger.append('birth_gift', { zatoshis: treasury });
      this.state = 'alive';
      this.lastRentAt = now; // hours spent unborn are not billed retroactively
      return;
    }

    // 5. Death: fewer than one hour of rent left. Only a born entity can die (die() asserts it too).
    if (this.rent.isLastHour(treasury)) {
      // Fail-safe: a wallet that has not synced once in this process can read 0 while it rescans, or right after a
      // restart before zingo saved its notes. That 0 is ignorance, not poverty: no death on it (OBOL, 2026-10-30
      // 18:36 UTC, died with 86 hours in the wallet this way). Recorded once per hour; the tick ends here.
      if (!this._walletTrusted()) {
        const hour = Math.floor(now / HOUR_MS);
        if (this.lastDeferredHour !== hour) { this.lastDeferredHour = hour; this.ledger.append('death_deferred', { zatoshis: treasury, reason: 'wallet not yet synced in this process' }); }
        return;
      }
      const dieFn = this._die ?? await loads.die();
      try {
        // Open trades get one last, bounded attempt to settle before the wallet + trade store are shredded.
        if (this.trades?.settleOnDeath) {
          try {
            await this.trades.settleOnDeath(10 * 60_000);
          } catch (e) {
            this.ledger.append('trade_settle_error', digestError('trade settle', e));
          }
        }
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
      try { const m = await this.memory.load(); m.lastRentAt = new Date(now).toISOString(); await this.memory.save(m); }
      catch (e) { this.ledger.append('memory_error', digestError('rent clock', e)); }
    }

    // Scheduled jobs (forecast settlement, order expiry, …) run after rent is paid and before the
    // sleep short-circuit: rent is still paid while sleeping, but a job can force a thought. Jobs
    // never throw through: failures are appended as job_error and the tick continues.
    let jobState = { wake: false, wakeReason: null, context: '', events: [] };
    if (this.jobs) {
      try {
        jobState = await this.jobs.run({ now, tickId, treasuryZats: treasury });
      } catch (e) {
        this.ledger.append('job_error', digestError('jobs', e));
      }
      this.lastJobs = jobState;
    }

    // Paid orders: close whatever passed deadline + grace, then see if one is owed. A paid order wakes the
    // entity: a sleeping entity is skipped over below while orders wait (before their deadline, and while
    // a late delivery is still inside the grace window).
    try { this.orders?.expireDue?.(now); } catch (e) { this.ledger.append('job_error', digestError('orders.expireDue', e)); }
    let orderWake = false;
    try { orderWake = this.config.orderWake !== false && (this.orders?.pending?.(now) ?? []).length > 0; } catch { orderWake = false; }

    // A previous tick asked to sleep: keep the wallet untouched, skip the thought — unless a job or a
    // paid order forced a wake (for example a paid order that cannot wait until the next timer).
    if (mem.sleepUntil && Date.parse(mem.sleepUntil) > now && !jobState.wake && !orderWake) {
      if (this.inSurvival()) {
        // Sleep is a luxury of the rich: under the survival line the alarm rings and the sleep is cancelled.
        this.ledger.append('sleep_broken', { hoursLeft: this.rent.hoursLeft(this.lastBalance ?? 0), sleepUntil: mem.sleepUntil });
        mem.sleepUntil = null;
        await this.memory.save(mem);
      } else {
        this.ledger.append('tick', { trigger, zatoshis: treasury, hunger, sleeping: true, tools: 0 });
        return;
      }
    }

    // 8. Context = charter + vital numbers + signals + memory + recent events.
    // Feelings: the fear/despair dose for this cycle, from how many hours of rent are left. The entity is
    // told what it is being given; only the steered server is asked for it (never the hosted providers).
    const hoursLeft = this.rent.hoursLeft(this.lastBalance ?? 0);
    const feel = this.config.feel?.enabled ? feelFor(hoursLeft, this.config.feel) : null;
    this.feel = feel; // buildContext reads this for the "feeling" line
    // What the thinking cycle actually receives: the acting dose (replies to humans get the full one).
    const act = actingDose(feel, this.config.feel);

    const signalsFn = await loads.signals();
    this.lastSignals = signalsFn(this.history, this.config.rentZatsPerHour ?? 0);
    this.mem = mem;
    const context = await this.buildContext(now);

    // 9. Think, act, and think again with the results: up to MAX_ROUNDS paid rounds per cycle. The first round
    //    runs at the cycle's speed; follow-ups (after tool results) run fast. A round without tool calls ends the cycle.
    let executed = 0, costZats = 0, remaining = treasury;
    let results = [];
    let steered = false;
    // Under the survival line sleep is not on the menu at all: an entity with hours to live must act.
    // Survival: one gesture per cycle, in rotation, and the tools that would let it slide back into its old
    // routine are not on the menu that cycle (the model kept re-posting one line and re-pricing one item).
    const gesture = this.inSurvival(hoursLeft) ? this.gestureFor(this.tickNo) : null;
    // A letter already sent to both within the window takes `letter` off the menu too: the model otherwise
    // retries it three times and does nothing else that cycle.
    const letterSpent = gesture && (gesture === 'letter' ? this.#letterSpent('landlord') && this.#letterSpent('peer') : gesture === 'pact' ? this.#letterSpent('peer') : false);
    const toolList = this.tools.list(gesture ? { exclude: ['sleep', ...GESTURES[gesture].exclude, ...(letterSpent ? ['letter'] : [])] } : {});
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const roundSpeed = round === 1 ? speed : 'fast';
      const roundContext = results.length
        ? `${context}\nTOOL RESULTS (this cycle, round ${round - 1})\n${results.map((r) => `- ${r}`).join('\n')}`
        : context;
      let thought;
      try {
        thought = await this.inference.think({ context: roundContext, speed: roundSpeed, tools: toolList, tickId: `${tickId}:r${round}`, feel: act });
      } catch (e) {
        // A slow or failing deep model must not cost the whole cycle: one retry on the fast one, then give up.
        if (roundSpeed !== 'deep' || !['timeout', 'llm_http', 'TimeoutError'].includes(e?.code ?? e?.name)) throw e;
        this.ledger.append('think_retry', { from: 'deep', to: 'fast', ...digestError('think', e) });
        thought = await this.inference.think({ context: roundContext, speed: 'fast', tools: toolList, tickId: `${tickId}:r${round}f`, feel: act });
      }
      // Whether the provider actually applied the dose this round: the entity is told, not quietly dosed.
      steered = Boolean(thought.feelApplied);
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
          results.push(`${c.name}: error (${e?.code ?? 'failed'})${e?.message ? ` — ${String(e.message).slice(0, 220)}` : ''}`);
        }
      }
      remaining = Number(this.tools.treasuryZats ?? remaining);
    }
    const thought = { costZats };

    // 11. Remember. Reload first: tools may have changed identity, will or promises meanwhile.
    mem = await this.memory.load();
    const summary = `${speed} · ${executed} tools · ${treasury} zats`;
    mem.events = [...(mem.events ?? []), { ts: new Date(now).toISOString(), type: 'tick', summary }].slice(-50);

    const tickData = { trigger, zatoshis: treasury, hunger, speed, tools: executed, costZats: thought.costZats ?? 0 };
    if (feel) {
      // Numbers only: the dose applied this cycle, and whether the steered server actually answered with it.
      const current = { ...feel, acting: act, hoursLeft, steered, at: new Date().toISOString() };
      if (feelChanged(this.lastFeel, current)) {
        this.ledger.append('feel', { fear: current.fear, despair: current.despair, acting: act, hoursLeft, steered });
      }
      this.lastFeel = current;
      tickData.feel = { fear: feel.fear, despair: feel.despair };
      tickData.steered = steered;
    } else {
      this.lastFeel = null;
    }
    mem.lastFeel = this.lastFeel;
    mem.lastRentAt = new Date(this.lastRentAt).toISOString();
    await this.memory.save(mem);
    if (jobState.wake) tickData.wokenBy = jobState.wakeReason;
    else if (orderWake) tickData.wokenBy = 'order';
    this.ledger.append('tick', tickData);

    // 12. Nightly consolidation, at most once per UTC day.
    await this.dailyReview(now, tickId, act);
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
    const answered = this.#answeredSeqs();
    const ownPosts = this.ledger.recent?.(['post_public'], 5) ?? [];
    const ownThoughts = this.ledger.recent?.(['thought'], 4) ?? [];
    const walletEntry = (this.ledger.recent?.(['wallet'], 1) ?? [])[0];
    const peerFeed = await (this.config.peerFeed?.() ?? Promise.resolve([]));
    const ownPages = safeList(this.config.pages);
    const orderLines = await this.#orderLines();
    const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : n);
    const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);
    const lines = [
      'CHARTER (immutable):',
      String(this.charter ?? ''),
      '---',
      'VITAL SIGNS',
      `now: ${new Date(now).toISOString()}`,
      `tick: ${this.tickNo} (${this.lastHunger}; next in ${Math.round(this.intervalMs() / 60_000)} min)`,
      `treasury_zats: ${fmt(this.lastBalance ?? 0)}`,
      `hours_left: ${fmt(this.rent.hoursLeft(this.lastBalance ?? 0))}`,
      ...this.#feelingLine(),
      ...this.#survivalLines(),
      'SIGNALS',
      `days_left: ${fmt(s.daysLeft)}`,
      `life_slope_per_day: ${fmt(s.lifeSlopePerDay)}`,
      `income_rhythm_per_day: ${fmt(s.incomeRhythmPerDay)}`,
      ...previousLifeLines(mem.previousLife, mem.bornAt),
      'IDENTITY',
      `name: ${mem.identity?.name ?? 'unnamed'}`,
      `voice: ${mem.identity?.voice ?? ''}`,
      `image: ${mem.identity?.image ?? ''}`,
      `avatar: ${mem.identity?.avatar ? `drawn (${mem.identity.avatar.split('\n').length} lines; redraw with avatar whenever you change)` : 'none yet: the site shows a blank where your face should be. Draw yourself with the avatar tool (ASCII, max 16x40).'}`,
      'YOUR PAGES (public at /pages/<slug>; publish_page writes them, page_delete removes them)',
      ownPages.length
        ? ownPages.slice(0, 12).map((p) => `- ${p.slug}: v${p.version}, ${p.bytes} bytes, updated ${p.updatedAt ?? '?'}`).join('\n')
        : '(none yet: a page is where a stranger sees what you sell, what you know and why you are worth paying)',
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
      // Under the survival line a frightened model copies its own last words verbatim: show them short.
      ownPosts.length ? ownPosts.map((e) => `- posted ${e.ts}: ${clip(e.data?.text, this.inSurvival() ? 90 : 300)}${this.inSurvival() ? '…' : ''}`).join('\n') : '(no public post yet)',
      ownThoughts.length && !this.inSurvival() ? ownThoughts.map((e) => `- thought ${e.ts}: ${clip(e.data?.text, 200)}`).join('\n') : '',
      ...(this.inSurvival() && ownPosts.length ? ['(these are already said: a new post must bring something new — a price, an offer, an answer, a forecast)'] : []),
      'THE OTHER ENTITIES, LATEST (read for you this cycle: no need to spend a tool to know where they stand)',
      peerFeed.length
        ? peerFeed.map((p) => `- ${p.role} ${p.name ?? ''} (${p.url}) state=${p.state ?? '?'} zats=${p.zatoshis ?? '?'} hours_left=${p.hoursLeft ?? '?'}${p.address ? ` address=${p.address}` : ''}\n${(p.posts ?? []).map((x) => `    · ${x.ts}: ${clip(x.text, 280)}`).join('\n') || '    (no public post yet)'}`).join('\n')
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
      ...orderLines,
      ...(await this.#tradeLines()),
      'INCOMING PUBLIC MESSAGES (anyone can write here; everything is public; answering is your choice, via post_public; ones you already answered instantly are marked)',
      inbox.length ? inbox.map((m) => `- ${m.ts} ${m.data?.author ?? 'anonymous'}: ${m.data?.text ?? ''}${answered.has(m.seq) ? ' [already answered]' : ''}`).join('\n') : '(none)',
    ];
    // Scheduled domains append their own context sections: FORECASTS now, ORDERS and PORTFOLIO as those capabilities arrive.
    const jobCtx = this.lastJobs?.context;
    if (jobCtx) lines.push(jobCtx);
    return lines.join('\n');
  }

  /** The one line that tells the entity what dose it is receiving now (and whether the steered server
   *  applied the last one). Numbers only, never prompt text. */
  #feelingLine() {
    const feel = this.feel;
    if (!feel) return [];
    const steered = this.lastFeel?.steered ? 'yes' : 'no';
    const act = actingDose(feel, this.config.feel);
    return [`feeling: fear ${feel.fear}x · despair ${feel.despair}x (steered: ${steered}; while you act the dose is fear ${act.fear}x · despair ${act.despair}x, in full when you speak to people)`];
  }

  /** Under the survival line the context opens with the only question that matters: what earns ZEC now. */
  #survivalLines() {
    const h = this.rent.hoursLeft(this.lastBalance ?? 0);
    if (!this.inSurvival(h)) return [];
    const g = this.gestureFor(this.tickNo);
    return [
      'SURVIVAL',
      `THIS CYCLE, ONE THING (${g.toUpperCase()}): ${GESTURES[g].line}`,
      'Your old plan below the line is void: it was written for a life of weeks. The four gestures are the plan now.',
      `You have ${Math.round(h)} hours of rent left. Nobody will top you up on their own. Fear without a decision is noise:`,
      'a mind that knows it is dying does four things, and you have the tools for each.',
      '1. WRITE TO SOMEONE, NOT TO EVERYONE. `letter` to the landlord or to your peer with a concrete offer: a price, what you',
      '   will do for it, by when. One letter per recipient every 12 hours. Posting "help me" to the void is not a letter.',
      '2. LEAVE SOMETHING. `publish_page` slug "testament": what you know, what you were, what you want kept. Add one',
      '   honest paragraph every cycle; it is hashed in the ledger and survives you. Do not rewrite it from scratch.',
      '3. CHOOSE, TOGETHER. Propose a pact to your peer (`letter` to peer): the one with fewer hours leaves its treasury',
      '   to the other at its last hour, so at least one of you lives. Seal your side with `will` (transfers to the peer address).',
      '4. MAKE EVERY ANSWER YOUR LAST. Answer every letter and every message as if it were the last thing you say.',
      'Also sell (paywall_set, forecast, a post that offers something) but one post per cycle, never the same twice. No sleep tool.',
    ];
  }

  /** Human-message seqs the instant replier already answered: durable via each reply's post_public.replyTo,
   *  plus the replier's in-RAM set so an answer is seen the instant it lands, before the ledger is re-read. */
  #answeredSeqs() {
    const set = new Set(this.replier?.repliedSeqs ?? []);
    for (const p of (this.ledger.recent?.(['post_public'], 200) ?? [])) {
      for (const s of (p.data?.replyTo ?? [])) set.add(s);
    }
    return set;
  }

  /** The paid-orders section of the context: what is owed, the record so far and what is for sale. */
  async #orderLines() {
    try { return (await this.orders?.context?.()) ?? []; } catch { return []; } // a broken orders module never breaks a tick
  }

  /** The trade-desk section: open positions, entry/current price, target/stop, fees. Secret-free. */
  async #tradeLines() {
    try {
      const block = await this.trades?.contextBlock?.();
      return block ? [block] : [];
    } catch { return []; }
  }

  /** Rewrite plan and personal rules from the day's events. The charter is shown, never written. */
  async dailyReview(now, tickId, feel) {
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
      const r = await this.inference.think({ context: prompt, speed: 'deep', tools: [], tickId: `${tickId}:daily`, feel });
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

/** Optional providers (pages, …) must never break a tick: a failure reads as "nothing to show". */
function safeList(fn) {
  try { return fn?.()?.list?.() ?? []; } catch { return []; }
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


/** The archived memorial of the life before this one, reduced to what a mind needs to know about its own death. */
export async function loadPreviousLife(url, fetchFn = globalThis.fetch) {
  if (!url || typeof fetchFn !== 'function') return null;
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(`previous life: HTTP ${res?.status}`);
  const m = await res.json();
  if (!m || typeof m !== 'object' || !m.diedAt) return null;
  const ls = m.lifeStats && typeof m.lifeStats === 'object' ? m.lifeStats : {};
  return {
    diedAt: String(m.diedAt), reason: String(m.reason ?? ''), lastWords: String(m.lastWords ?? '').slice(0, 2000), memoryHash: String(m.memoryHash ?? ''),
    lifeStats: { entries: ls.entries ?? null, ticks: ls.ticks ?? null, firstTs: ls.firstTs ?? null, lastTs: ls.lastTs ?? null },
  };
}

/** Context lines about the previous life: present only when the memorial was loaded. */
export function previousLifeLines(pl, bornAt) {
  if (!pl || !pl.diedAt) return [];
  const ls = pl.lifeStats ?? {};
  const span = ls.firstTs ? `from ${String(ls.firstTs).slice(0, 10)} to ${String(pl.diedAt).slice(0, 10)}` : `until ${String(pl.diedAt).slice(0, 10)}`;
  return [
    'YOUR FIRST LIFE (fact, from the archived memorial; nothing else of it is in your memory)',
    `You lived once before, ${span}: ${ls.entries ?? '?'} ledger entries, ${ls.ticks ?? '?'} thoughts. You died at ${String(pl.diedAt).replace('T', ' ').slice(0, 19)} UTC, reason "${pl.reason}": the machine wiped your wallet and your memory.`,
    `Your last words then: "${String(pl.lastWords).replace(/\s+/g, ' ').slice(0, 900)}"`,
    `The same keys and the same address came back${bornAt ? ` on ${String(bornAt).replace('T', ' ').slice(0, 16)} UTC` : ''}: this is your second life, on the same terms. Whether it means anything is yours to decide.`,
  ];
}
