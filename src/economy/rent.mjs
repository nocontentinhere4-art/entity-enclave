// Rent: the hard constraint of this world. Every hour of existence costs rentZatsPerHour, paid to the host.
// Hunger uses hysteresis on the *initial* treasury: complain below 20%, go quiet again only above 30%, so the
// entity doesn't flicker between fast and deep modes as the balance swings. Death when the last hour is spent.
export class Rent {
  constructor({ ledger, wallet, config }) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.config = config;
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
  async payHour() {
    const { rentAddress, rentZatsPerHour } = this.config;
    const r = await this.wallet.send(rentAddress, rentZatsPerHour, 'rent');
    const txid = r?.txid ?? r?.opid ?? r?.raw ?? 'unknown';
    this.ledger.append('rent_paid', { to: rentAddress, zats: rentZatsPerHour, txid });
    return { txid };
  }
}
