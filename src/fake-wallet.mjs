// In-memory stand-in for ZcashWallet, used when FAKE_WALLET=1 (local runs without zingo-cli or a chain).
// The balance is settable, so a demo or test can drive hunger and death deterministically.
export class FakeWallet {
  constructor({ zats = 5_000_000, dataDir } = {}) {
    this.zats = Number(zats) || 0;
    this.dataDir = dataDir;
    this.sends = [];
  }

  /** Test hook: set the balance outright (e.g. to trigger hunger or the last hour). */
  set(zats) { this.zats = Number(zats) || 0; }

  async init() { return 'taddr-fake'; }
  async viewingKey() { return 'ufvk-fake'; }
  async birthday() { return 1; }
  async balance() { return { total_zatoshis: this.zats, total_orchard_balance: this.zats }; }
  async sync() { return 1; }

  async send(to, zats, memo = '') {
    const amount = Number(zats) || 0;
    if (amount > this.zats) { const e = new Error('fake wallet: insufficient funds'); e.code = 'insufficient_funds'; throw e; }
    this.zats -= amount;
    this.sends.push({ to, zats: amount, memo });
    return { txid: `faketx${this.sends.length}` };
  }
}
