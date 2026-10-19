import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entropyToMnemonic } from '../src/bip39.mjs';
import { ZcashWallet } from '../src/zcash.mjs';

test('BIP39 official vector: 32 bytes of 0xff → 23×zoo + vote (24 words)', () => {
  const out = entropyToMnemonic(new Uint8Array(32).fill(0xff));
  assert.equal(out, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote');
});

test('BIP39 official vector: 32 zero bytes → 23×abandon + art (24 words)', () => {
  const out = entropyToMnemonic(new Uint8Array(32));
  assert.equal(out, `${'abandon '.repeat(23).trim()} art`);
});

test('the encoding is deterministic and rejects wrong-sized entropy', () => {
  const entropy = new Uint8Array(32).map((_, i) => i);
  assert.equal(entropyToMnemonic(entropy), entropyToMnemonic(entropy.slice()));
  for (const bad of [new Uint8Array(8), new Uint8Array(33), null, 'nope']) {
    assert.throws(() => entropyToMnemonic(bad));
  }
});

test('two wallets from the same mnemonic in two temp dirs report the same address', { skip: !process.env.ZINGO_BIN && 'ZINGO_BIN is not set: no real zingo-cli binary to drive' }, async (t) => {
  const mnemonic = entropyToMnemonic(new Uint8Array(32).fill(0x01));
  const dirs = [mkdtempSync(join(tmpdir(), 'zingo-a-')), mkdtempSync(join(tmpdir(), 'zingo-b-'))];
  const wallets = dirs.map((dataDir) => new ZcashWallet({ bin: process.env.ZINGO_BIN, dataDir, chain: process.env.ZCASH_CHAIN ?? 'testnet', seedMnemonic: mnemonic, birthday: 4460000 }));
  const [a, b] = await Promise.all(wallets.map((w) => w.init()));
  assert.ok(a, 'first wallet produced no address');
  assert.equal(a, b, 'same seed must recreate the same address in a fresh data dir');
});
