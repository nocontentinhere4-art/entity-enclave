import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signals } from '../src/life/signals.mjs';

const day = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
const at = (d) => new Date(t0 + d * day).toISOString();

test('declining balance: slope and runway come from the history', () => {
  const history = [
    { ts: at(0), zatoshis: 10_000 },
    { ts: at(1), zatoshis: 8_000 },
  ];
  const s = signals(history, 0);
  assert.equal(s.lifeSlopePerDay, -2_000);
  assert.equal(s.daysLeft, 4);
  assert.equal(s.incomeRhythmPerDay, 0);
});

test('rent is a floor on burn even when the observed slope is gentler', () => {
  const history = [
    { ts: at(0), zatoshis: 10_000 },
    { ts: at(1), zatoshis: 8_000 },
  ];
  assert.equal(signals(history, 100).daysLeft, 3.33); // 100 zats/h = 2400/day > 2000/day observed
});

test('income rhythm counts only upward jumps, spread over observed days', () => {
  const history = [
    { ts: at(0), zatoshis: 1_000 },
    { ts: at(1), zatoshis: 3_000 },
    { ts: at(2), zatoshis: 2_000 },
  ];
  const s = signals(history, 0);
  assert.equal(s.incomeRhythmPerDay, 1_000);
  assert.equal(s.lifeSlopePerDay, 500);
  assert.equal(s.daysLeft, Infinity); // growing and no rent: no deadline
});

test('empty history is zeroed; bad rows are ignored; input is not mutated', () => {
  assert.deepEqual(signals([], 50), { daysLeft: 0, lifeSlopePerDay: 0, incomeRhythmPerDay: 0 });
  assert.deepEqual(signals(undefined, 50), { daysLeft: 0, lifeSlopePerDay: 0, incomeRhythmPerDay: 0 });

  const history = [
    { ts: at(1), zatoshis: 5_000 },
    { ts: 'garbage', zatoshis: 999_999 },
    { ts: at(0), zatoshis: 6_000 },
  ];
  const before = JSON.stringify(history);
  const s = signals(history, 0);
  assert.equal(JSON.stringify(history), before);
  assert.equal(s.lifeSlopePerDay, -1_000);
  assert.equal(s.daysLeft, 5);
});

test('a single observation still yields a rent-based runway', () => {
  const s = signals([{ ts: at(0), zatoshis: 1_440 }], 60);
  assert.equal(s.lifeSlopePerDay, 0);
  assert.equal(s.daysLeft, 1);
});
