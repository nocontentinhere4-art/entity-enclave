import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { die } from '../src/economy/death.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'death-'));
  const ledger = { entries: [], append(type, data) { this.entries.push({ type, data }); } };
  const memory = {
    will: { text: 'goodbye', transfers: [] },
    bornAt: '2026-01-01T00:00:00.000Z',
    wiped: false,
    async wipe() { this.wiped = true; },
  };
  return { dir, ledger, memory };
}

test('death removes exactly the walletPaths it is given, never a guessed dataDir', async () => {
  const { dir, ledger, memory } = setup();
  const walletPath = join(dir, 'zcash');
  mkdirSync(walletPath, { recursive: true });
  writeFileSync(join(walletPath, 'wallet.dat'), 'secret');
  const unrelated = join(dir, 'do-not-touch');
  mkdirSync(unrelated, { recursive: true });

  const wallet = { dataDir: unrelated, async send() { return { txid: 'tx1' }; } };
  await die({ ledger, memory, wallet, keys: { sign: () => 'sig' }, reason: 'last hour', walletPaths: [walletPath] });

  assert.equal(existsSync(walletPath), false);
  assert.equal(existsSync(unrelated), true); // wallet.dataDir is never assumed
  assert.equal(memory.wiped, true);
  assert.equal(ledger.entries.filter((e) => e.type === 'death').length, 1);
});

test('a fake wallet passes []: no wallet files are removed', async () => {
  const { dir, ledger, memory } = setup();
  const wallet = { dataDir: join(dir, 'fake'), async send() {} };
  mkdirSync(wallet.dataDir, { recursive: true });

  await die({ ledger, memory, wallet, keys: { sign: () => 'sig' }, reason: 'last hour', walletPaths: [] });

  assert.equal(existsSync(wallet.dataDir), true);
  assert.equal(memory.wiped, true);
});

test('a failing bequest is recorded by code + hash, never the raw message', async () => {
  const { ledger, memory } = setup();
  memory.will.transfers = [{ to: 'z1', zats: 5, memo: 'x' }];
  const wallet = { async send() { throw new Error('raw wallet secret 42'); } };

  await die({ ledger, memory, wallet, keys: { sign: () => 'sig' }, reason: 'last hour', walletPaths: [] });

  const death = ledger.entries.find((e) => e.type === 'death');
  const t = death.data.transfers[0];
  assert.equal(t.ok, false);
  assert.equal(t.msgHash.length, 16);
  assert.equal('error' in t, false);
  assert.equal(JSON.stringify(ledger.entries).includes('raw wallet secret 42'), false);
});

test('death is refused before birth: code not_born, nothing written, memory intact', async () => {
  const { ledger, memory } = setup();
  delete memory.bornAt;
  const wallet = { async send() { throw new Error('must not be called'); } };

  await assert.rejects(
    die({ ledger, memory, wallet, keys: { sign: () => 'sig' }, reason: 'last hour', walletPaths: [] }),
    (e) => e.code === 'not_born',
  );

  assert.equal(ledger.entries.length, 0); // no last_words, no death certificate
  assert.equal(memory.wiped, false);
});

test('death is allowed once born', async () => {
  const { ledger, memory } = setup(); // setup() sets bornAt

  await die({ ledger, memory, wallet: { async send() {} }, keys: { sign: () => 'sig' }, reason: 'last hour', walletPaths: [] });

  assert.equal(memory.wiped, true);
  assert.equal(ledger.entries.filter((e) => e.type === 'death').length, 1);
});
