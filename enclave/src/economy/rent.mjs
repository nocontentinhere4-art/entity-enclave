// Rent: the hard constraint of this world. Every hour of existence costs rentZatsPerHour, paid to the host.
// Hunger uses hysteresis on the *initial* treasury: complain below 20%, go quiet again only above 30%, so the
// entity doesn't flicker between fast and deep modes as the balance swings. Death when the last hour is spent.
export class Rent {
  constructor({ ledger, wallet, config, pricing = null }) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.config = config;
    this.pricing = pricing;
    this.#hungry = false; // RAM state only: after a restart hysteresis restarts from the fresh balance
  }

  #hungry;

  /** Full hours of existence still affordable at the flat rate. */
  hoursLeft(treasuryZats) {
    return this.config.rentZatsPerHour > 0 ? Math.floor(treasuryZats / this.config.rentZatsPerHour) : Infinity;
  }

  /** 'ok' | 'hungry', with hysteresis (20% triggers, 30% releases) so mode changes are rare and visible. */
  hunger(treasuryZats) {
    const i = this.config.initialTreasuryZats;
    if (this.#hungry) {
      if (i <= 0 || treasuryZats >= this.config.hungerRecover * i) this.#hungry = false;
    } else if (i > 0 && treasuryZats <= this.config.hungerThreshold * i) this.#hungry = true;
    return this.#hungry ? 'hungry' : 'ok';
  }

  /** True when the upcoming hour cannot be paid: nothing left to negotiate, the will must execute. */
  isLastHour(treasuryZats) {
    return this.hoursLeft(treasuryZats) <= 0;
  }

  /** Pay one hour up front and publish the receipt. Throws through from wallet if unfunded: the loop notices. */
  async payHour(treasuryZats = null) {
    const { rentAddress, rentZatsPerHour } = this.config;
    if (!rentAddress) { const e = new Error('no RENT_ADDRESS: the hour cannot be paid'); e.code = 'no_rent_address'; throw e; }
    // One real transfer per hour: the rent plus every thought and tool charged since the last payment.
    // Settle the thinking charges, but never more than a sane hour's worth at once: the rest carries over.
    // Cap = 3 hours of rent or 2% of the treasury, whichever is larger. Protects a life from a bookkeeping surprise.
    const unsettled = Number(this.pricing?.unsettledZats?.() ?? 0);
    const treasury = Number(treasuryZats ?? 0);
    const cap = Math.max(3 * rentZatsPerHour, Math.floor(treasury * 0.02));
    const compute = Math.min(unsettled, cap);
    const total = rentZatsPerHour + compute;
    const r = await this.wallet.send(rentAddress, total, `rent ${rentZatsPerHour} + compute ${compute}`);
    const txid = r?.txid ?? r?.opid ?? r?.raw ?? 'unknown';
    this.pricing?.settle?.(compute);
    this.ledger.append('rent_paid', { to: rentAddress, zats: total, rentZats: rentZatsPerHour, computeZats: compute, txid });
    return { txid, zats: total };
  }
}
