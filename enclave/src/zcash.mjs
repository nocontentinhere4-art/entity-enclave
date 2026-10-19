// Zcash wallet adapter: drives `zingo-cli` (Zingo Labs light wallet, Orchard) as a subprocess.
// zingo-cli v7 is offline by default and goes online only through the Nym mixnet (good: the entity's wallet traffic
// is anonymised too). Local commands run `--offline`; sync runs `--online --server …` and needs `nym-proxy`.
import { spawn } from 'node:child_process';

export class ZcashWallet {
  constructor({ bin = 'zingo-cli', dataDir, server, chain = 'testnet', nymProxy }) {
    this.bin = bin; this.dataDir = dataDir; this.server = server; this.chain = chain; this.nymProxy = nymProxy;
  }

  base(online) {
    const a = ['--data-dir', this.dataDir, '--chain', this.chain];
    if (online) { a.push('--online', '--server', this.server); if (this.nymProxy) a.push('--nym-proxy', this.nymProxy); }
    else a.push('--offline');
    return a;
  }

  /** Run one command and parse the JSON object/array in its output. */
  async cmd(command, args = [], { online = false } = {}) {
    const out = await run(this.bin, [...this.base(online), ...(online ? [] : ['--nosync']), command, ...args]);
    const i = [out.indexOf('{'), out.indexOf('[')].filter((x) => x >= 0).sort((a, b) => a - b)[0];
    if (i === undefined) return { raw: out.trim() };
    const end = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'));
    try { return JSON.parse(out.slice(i, end + 1)); } catch { return { raw: out.trim() }; }
  }

  /** Creates the wallet on first run (offline) and returns the unified address. */
  async init() {
    const addrs = await this.cmd('addresses');
    const first = Array.isArray(addrs) ? addrs[0] : null;
    return first?.encoded_address ?? null;
  }

  async viewingKey() { const r = await this.cmd('export_ufvk'); return r?.ufvk ?? r; }
  async birthday() { const r = await run(this.bin, [...this.base(false), '--nosync', 'birthday']); return Number((r.match(/\n(\d+)\s*$/m) || [])[1] ?? r.trim().split('\n').find((l) => /^\d+$/.test(l.trim()))); }
  async balance() { return parseBalance(await run(this.bin, [...this.base(false), '--nosync', 'balance'])); }
  /** Online: go online through the mixnet, wait for the startup sync, then return the chain height seen. */
  async sync() { const out = await run(this.bin, [...this.base(true), '--waitsync', 'info']); return Number((out.match(/"latest_block_height":\s*(\d+)/) || out.match(/(\d{6,})/) || [])[1]); }
  async send(to, zatoshis, memo = '') { return this.cmd('quicksend', [to, String(zatoshis), memo], { online: true }); }
}

/** zingo prints balances as `name: zatoshis` lines; turn them into an object (zatoshis as numbers). */
function parseBalance(out) {
  const b = {};
  for (const m of out.matchAll(/(\w+_balance):\s*(\d+)/g)) b[m[1]] = Number(m[2]);
  b.total_zatoshis = (b.total_orchard_balance ?? 0) + (b.total_ironwood_balance ?? 0) + (b.total_sapling_balance ?? 0) + (b.total_transparent_balance ?? 0);
  return b;
}

function run(bin, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} ${argv.at(-1)} exit ${code}: ${(err || out).slice(-500)}`))));
    p.on('error', reject);
  });
}
