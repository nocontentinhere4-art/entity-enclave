// Remote attestation via Phala dstack: a TDX quote binding this enclave (image hash, app id) to a user-chosen
// report_data — here the entity's public keys, so anyone can check "these keys were born inside this image".
// Outside a TEE the functions return an honest `mode: 'dev'` instead of a quote.
import { DstackClient } from '@phala/dstack-sdk';
import { createHash } from 'node:crypto';

export async function connectDstack() {
  try {
    const client = new DstackClient();
    const info = await client.info();
    return { client, info };
  } catch {
    return null;
  }
}

export async function attest(dstack, keys) {
  // report_data is 64 bytes: sha512 of the two public keys, so the quote commits to them.
  const reportData = createHash('sha512').update(keys.signPublicKey + ':' + keys.boxPublicKey).digest();
  if (!dstack) {
    return { mode: 'dev', note: 'no TEE: this instance is NOT attested', reportData: reportData.toString('hex') };
  }
  const q = await dstack.client.getQuote(reportData);
  return {
    mode: 'tee',
    quote: Buffer.from(q.quote).toString('hex'),
    eventLog: q.event_log,
    reportData: reportData.toString('hex'),
    app: dstack.info?.app_id,
    compose: dstack.info?.tcb_info?.compose_hash,
  };
}
