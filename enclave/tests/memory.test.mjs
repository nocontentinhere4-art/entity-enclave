import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, emptyMemory } from '../src/memory/store.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'memory-'));

test('memory roundtrips through an encrypted file', async () => {
  const path = join(dir(), 'memory.bin');
  const store = new MemoryStore({ path, key: randomBytes(32) });
  const m = emptyMemory();
  m.identity = { name: 'Ada-Lovelace-very-secret-name', voice: 'calma', image: '' };
  m.plan = 'sopravvivere senza mentire';
  m.will = { text: 'ciao', transfers: [{ to: 'z1', zats: 5, memo: 'x' }] };
  await store.save(m);

  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes('Ada-Lovelace-very-secret-name'), false);
  assert.equal(raw.includes('sopravvivere senza mentire'), false);
  assert.equal(JSON.parse(raw).alg, 'AES-256-GCM');
  assert.equal(existsSync(`${path}.tmp`), false); // atomic write leaves no temp behind

  assert.deepEqual(await store.load(), m);
});

test('a wrong key cannot read the file', async () => {
  const path = join(dir(), 'memory.bin');
  await new MemoryStore({ path, key: randomBytes(32) }).save(emptyMemory());
  const stranger = new MemoryStore({ path, key: randomBytes(32) });
  await assert.rejects(stranger.load(), (e) => e.code === 'memory_corrupt');
});

test('last valid version survives a torn current file via .bak', async () => {
  const path = join(dir(), 'memory.bin');
  const store = new MemoryStore({ path, key: randomBytes(32) });
  const first = emptyMemory();
  first.identity.name = 'first';
  const second = emptyMemory();
  second.identity.name = 'second';

  await store.save(first);
  await store.save(second);
  assert.equal((await store.load()).identity.name, 'second');
  assert.equal(existsSync(`${path}.bak`), true);

  writeFileSync(path, '{"v":1,"iv":"troncato');
  assert.equal((await store.load()).identity.name, 'first');
});

test('appendEvent keeps only the last 50 events', async () => {
  const path = join(dir(), 'memory.bin');
  const store = new MemoryStore({ path, key: randomBytes(32) });
  for (let i = 0; i < 55; i++) await store.appendEvent({ type: 'test', summary: `e${i}` });
  const m = await store.load();
  assert.equal(m.events.length, 50);
  assert.equal(m.events.at(-1).summary, 'e54');
  assert.equal(m.events[0].summary, 'e5');
  assert.ok(m.events[0].ts);
});

test('wipe shreds current file and backup, then memory is empty', async () => {
  const path = join(dir(), 'memory.bin');
  const store = new MemoryStore({ path, key: randomBytes(32) });
  const m = emptyMemory();
  m.identity.name = 'to be erased';
  await store.save(m);
  await store.save(m); // create .bak too
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(`${path}.bak`), true);

  await store.wipe();
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.bak`), false);
  assert.deepEqual(await store.load(), emptyMemory());
});
