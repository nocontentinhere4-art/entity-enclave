// Ledger hygiene: error text can carry secrets (addresses, paths, provider bodies), so it never goes on the
// public chain. We keep a machine-readable code and a short hash of the message for correlation, and the full
// text goes to the console only.
import { createHash } from 'node:crypto';

/** Log the full error locally and return the public-safe {code, msgHash} pair for the ledger. */
export function digestError(scope, e) {
  const msg = String(e?.message ?? e ?? '');
  console.error(`[${scope}] ${msg}`);
  return { code: e?.code ?? null, msgHash: createHash('sha256').update(msg).digest('hex').slice(0, 16) };
}
