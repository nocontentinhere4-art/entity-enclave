// Inbox helpers: pure functions used by the letter reader in index.mjs (kept apart so tests need no enclave).
/** zingo prints `2026-10-20 02:47:30 UTC`; tests pass ISO strings. Unknown shapes return null and are treated as new. */
export function transferTime(dt) {
  const n = Date.parse(String(dt ?? '').trim().replace(/ UTC$/, 'Z').replace(' ', 'T'));
  return Number.isFinite(n) ? n : null;
}
