import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Promises } from '../src/life/promises.mjs';

function setup() {
  const ledger = { entries: [], append(type, data) { this.entries.push({ type, data }); } };
  const memory = { promises: [] };
  return { ledger, memory, promises: new Promises({ ledger, memory }) };
}

test('a promise without a due date is rejected and leaves no trace', () => {
  const { ledger, promises } = setup();
  assert.throws(() => promises.make('archive', 'restare viva'), (e) => e.code === 'promise_without_due');
  assert.throws(() => promises.make('archive', 'restare viva', 'not-a-date'), (e) => e.code === 'promise_without_due');
  assert.equal(ledger.entries.length, 0);
  assert.equal(promises.open().length, 0);
});

test('make / keep are public entries and the promise leaves the open list', () => {
  const { ledger, memory, promises } = setup();
  const id = promises.make('archive', 'pubblicare il diario', '2026-11-01T00:00:00Z');
  assert.equal(typeof id, 'string');
  assert.equal(ledger.entries[0].type, 'promise');
  assert.deepEqual(ledger.entries[0].data, { id, to: 'archive', what: 'pubblicare il diario', due: '2026-11-01T00:00:00.000Z' });
  assert.equal(memory.promises.length, 1);
  assert.equal(promises.open().length, 1);

  promises.keep(id);
  assert.equal(ledger.entries[1].type, 'promise_kept');
  assert.equal(promises.open().length, 0);
  assert.equal(memory.promises[0].status, 'kept');
  assert.throws(() => promises.keep(id), (e) => e.code === 'promise_not_open');
});

test('break records the reason publicly; open() returns soonest deadline first', () => {
  const { ledger, memory, promises } = setup();
  const late = promises.make('archive', 'tardi', '2027-01-01T00:00:00Z');
  const soon = promises.make('reader', 'presto', '2026-10-20T00:00:00Z');
  assert.deepEqual(promises.open().map((p) => p.id), [soon, late]);

  promises.break(soon, 'non avevo i soldi');
  assert.equal(ledger.entries.at(-1).type, 'promise_broken');
  assert.equal(ledger.entries.at(-1).data.reason, 'non avevo i soldi');
  assert.equal(memory.promises.find((p) => p.id === soon).status, 'broken');
  assert.deepEqual(promises.open().map((p) => p.id), [late]);

  assert.throws(() => promises.keep('missing'), (e) => e.code === 'unknown_promise');
});
