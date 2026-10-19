#!/usr/bin/env node
// Public verifier: anyone can run this against an entity's /ledger URL (or a saved file) and confirm the chain
// is intact — every entry's hash matches its content and links to the previous one. No dependencies.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) { console.error('usage: verify-ledger.mjs <url|file>'); process.exit(2); }
const text = /^https?:/.test(src) ? await (await fetch(src)).text() : readFileSync(src, 'utf8');
let prev = '0'.repeat(64), n = 0, byType = {};
for (const line of text.split('\n').filter(Boolean)) {
  const e = JSON.parse(line);
  const { hash, ...rest } = e;
  const recomputed = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  if (hash !== recomputed) { console.error(`BROKEN at seq ${e.seq}: hash mismatch`); process.exit(1); }
  if (e.prev !== prev) { console.error(`BROKEN at seq ${e.seq}: prev link mismatch`); process.exit(1); }
  prev = hash; n++; byType[e.type] = (byType[e.type] ?? 0) + 1;
}
console.log(`OK: ${n} entries, head ${prev}`);
console.log(byType);
