// Zcash wallet adapter: drives `zingo-cli` (Zingo Labs light wallet, Orchard) as a subprocess.
// zingo-cli is offline by default. Local commands run `--offline`; sync runs `--online --server …`. The image ships a
// clearnet build (no Nym mixnet: it could not establish an exit from the CVM); pass `nymProxy` to use a mixnet build.
// The wallet is deterministic: on first creation the mnemonic reaches zingo-cli only via the $ZINGO_SEED
// environment variable — never argv, never a log line.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export class ZcashWallet {
  constructor({ bin = 'zingo-cli', dataDir, server, chain = 'testnet', nymProxy, seedMnemonic = null, birthday = 0 }) {
    this.bin = bin; this.dataDir = dataDir; this.server = server; this.chain = chain; this.nymProxy = nymProxy;
    this.seedMnemonic = seedMnemonic;
    // Restoring from a seed requires a birthday height (zingo refuses otherwise); 0 = scan from genesis (slow but safe).
    this.birthdayHeight = Number(birthday) || 0;
  }

  base(online) {
    const a = ['--data-dir', this.dataDir, '--chain', this.chain];
    if (online) { a.push('--online', '--server', this.server); if (this.nymProxy) a.push('--nym-proxy', this.nymProxy); }
    else a.push('--offline');
    return a;
  }

  /** Run one command and parse the JSON object/array in its output. */
  async cmd(command, args = [], { online = false, env, secret, preArgs = false } = {}) {
    // preArgs: global options (e.g. --birthday) must come before the subcommand.
    const argv = preArgs
      ? [...this.base(online), ...(online ? [] : ['--nosync']), ...args, command]
      : [...this.base(online), ...(online ? [] : ['--nosync']), command, ...args];
    const out = await run(this.bin, argv, { env, secret });
    const i = [out.indexOf('{'), out.indexOf('[')].filter((x) => x >= 0).sort((a, b) => a - b)[0];
    if (i === undefined) return { raw: out.trim() };
    const end = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'));
    try { return JSON.parse(out.slice(i, end + 1)); } catch { return { raw: out.trim() }; }
  }

  /** Creates the wallet on first run and returns the unified address. */
  async init() {
    // First run only: when no wallet file exists yet, zingo-cli creates the wallet from $ZINGO_SEED.
    // The seed never goes on the command line (it would leak into ps/history) and is redacted from logs.
    // Creation happens ONLINE with --waitsync: zingo stores "stop syncing once at the tip" in the wallet at
    // creation time, and an offline-created wallet syncs forever (so `--waitsync` never returns). `info` is the
    // network command that carries the creation; it also performs the first scan from the birthday.
    if (this.seedMnemonic && !walletFileExists(this.dataDir)) {
      const seedEnv = { env: { ZINGO_SEED: this.seedMnemonic }, secret: this.seedMnemonic, preArgs: true };
      if (this.server) await this.cmd('info', ['--waitsync', '--birthday', String(this.birthdayHeight)], { online: true, ...seedEnv });
      else await this.cmd('addresses', ['--birthday', String(this.birthdayHeight)], seedEnv); // no indexer configured: offline wallet (tests)
    }
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

/** zingo prints balances as `name: zatoshis` lines with `_` thousands separators (100_000_000); turn them into numbers. */
export function parseBalance(out) {
  const b = {};
  for (const m of out.matchAll(/(\w+_balance):\s*(\d[\d_]*)/g)) b[m[1]] = Number(m[2].replace(/_/g, ''));
  b.total_zatoshis = (b.total_orchard_balance ?? 0) + (b.total_ironwood_balance ?? 0) + (b.total_sapling_balance ?? 0) + (b.total_transparent_balance ?? 0);
  return b;
}

/** A wallet exists if any .dat/.db state file was already written under the data dir (recursively). */
function walletFileExists(dataDir) {
  const walk = (d) => {
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const n of names) {
      if ((n.isFile() || n.isSymbolicLink()) && /\.(dat|db)$/i.test(n.name)) return true;
      if (n.isDirectory() && walk(join(d, n.name))) return true;
    }
    return false;
  };
  return walk(dataDir ?? '');
}

/** Run zingo-cli with a hard timeout: a hung child must never stall the life loop. Online syncs get longer. */
function run(bin, argv, { timeoutMs, env, secret } = {}) {
  if (timeoutMs === undefined) timeoutMs = argv.includes('--online') ? 45 * 60_000 : 60_000;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    let out = '', err = '', done = false;
    // Errors carry a short, content-free `code` (timeout / exit_N / spawn errno) so the public ledger can say
    // what kind of failure happened without exposing the message.
    const fail = (code, msg) => Object.assign(new Error(msg), { code });
    const timer = setTimeout(() => { if (!done) { p.kill('SIGKILL'); reject(fail('timeout', `${bin} ${argv.at(-1)} timed out after ${timeoutMs} ms`)); } }, timeoutMs);
    // Child output also goes to the container log (seed redacted) so a stalled sync can be diagnosed from outside;
    // the public ledger never carries it.
    const echo = (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.error(`[zingo ${argv.at(-1)}] ${redact(l, secret)}`); };
    p.stdout.on('data', (d) => { out += d; echo(d); });
    p.stderr.on('data', (d) => { err += d; echo(d); });
    p.on('close', (code, signal) => { done = true; clearTimeout(timer); code === 0 ? resolve(out) : reject(fail(`exit_${code ?? signal}`, `${bin} ${argv.at(-1)} exit ${code ?? signal}: ${redact((err || out).slice(-500), secret)}`)); });
    p.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
  });
}

/** The seed must never reach a log, an error or a report: scrub it wherever it could echo back. */
function redact(text, secret) {
  return secret ? text.split(secret).join('[redacted]') : text;
}
