// Promises are the entity's public word: making, keeping and breaking one are ledger entries, so the record
// survives even if memory is lost. The private copy in memory carries the working status.
import { randomUUID } from 'node:crypto';

export class Promises {
  constructor({ ledger, memory }) {
    this.ledger = ledger;
    this.memory = memory;
    if (!Array.isArray(this.memory.promises)) this.memory.promises = [];
  }

  make(to, what, dueIso) {
    const due = Date.parse(dueIso);
    if (!dueIso || Number.isNaN(due)) {
      const e = new Error('a promise needs a valid due date (ISO 8601)');
      e.code = 'promise_without_due';
      throw e;
    }
    const id = randomUUID();
    const dueAt = new Date(due).toISOString();
    this.memory.promises.push({ id, to, what, due: dueAt, madeAt: new Date().toISOString(), status: 'open' });
    this.ledger.append('promise', { id, to, what, due: dueAt });
    return id;
  }

  keep(id) {
    const p = this.#open(id, 'keep');
    p.status = 'kept';
    p.keptAt = new Date().toISOString();
    this.ledger.append('promise_kept', { id, to: p.to, what: p.what, due: p.due, at: p.keptAt });
  }

  break(id, reason) {
    const p = this.#open(id, 'break');
    p.status = 'broken';
    p.brokenAt = new Date().toISOString();
    p.reason = reason;
    this.ledger.append('promise_broken', { id, to: p.to, what: p.what, due: p.due, reason });
  }

  /** Still owed, soonest deadline first. */
  open() {
    return this.memory.promises
      .filter((p) => p.status === 'open')
      .sort((a, b) => a.due.localeCompare(b.due));
  }

  #open(id, action) {
    const p = this.memory.promises.find((x) => x.id === id);
    if (!p) {
      const e = new Error(`unknown promise: ${id}`);
      e.code = 'unknown_promise';
      throw e;
    }
    if (p.status !== 'open') {
      const e = new Error(`cannot ${action} a promise that is already ${p.status}`);
      e.code = 'promise_not_open';
      throw e;
    }
    return p;
  }
}
