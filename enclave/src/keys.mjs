// Entity keys. Inside a TEE they are derived from the enclave's sealed key (dstack `getKey`), so they are
// reproducible on redeploy of the same image and unknowable outside. Locally (no TEE) they are random and
// persisted to disk, clearly marked as DEV.
import nacl from 'tweetnacl';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export async function loadKeys({ dstack, statePath }) {
  if (dstack) {
    // Deterministic seed sealed to this enclave image + instance.
    const r = await dstack.getKey('entity/identity', 'v1');
    const seed = createHash('sha256').update(Buffer.from(r.key)).digest();
    return fromSeed(new Uint8Array(seed), 'tee');
  }
  mkdirSync(dirname(statePath), { recursive: true });
  if (existsSync(statePath)) return fromSeed(Uint8Array.from(JSON.parse(readFileSync(statePath, 'utf8')).seed), 'dev');
  const seed = nacl.randomBytes(32);
  writeFileSync(statePath, JSON.stringify({ seed: Array.from(seed), warning: 'DEV ONLY: not a TEE key' }));
  return fromSeed(seed, 'dev');
}

function fromSeed(seed, mode) {
  const sign = nacl.sign.keyPair.fromSeed(seed);
  // Box keypair for encrypting private ledger entries at rest: derived from the same seed, different domain.
  const boxSeed = createHash('sha256').update(Buffer.concat([Buffer.from('box'), Buffer.from(seed)])).digest();
  const box = nacl.box.keyPair.fromSecretKey(new Uint8Array(boxSeed));
  return {
    mode,
    signPublicKey: Buffer.from(sign.publicKey).toString('hex'),
    boxPublicKey: Buffer.from(box.publicKey).toString('hex'),
    sign: (msg) => Buffer.from(nacl.sign.detached(Buffer.from(msg), sign.secretKey)).toString('hex'),
    /** Independent 32-byte subkey from the same seed: sha256(label || seed). Same label, same key on redeploy. */
    deriveSubkey: (label) => new Uint8Array(createHash('sha256').update(Buffer.concat([Buffer.from(String(label)), Buffer.from(seed)])).digest()),
    /** Encrypt a private entry to the archive public key (hex, x25519). */
    sealPrivate: (archivePubHex, plaintext) => {
      const nonce = nacl.randomBytes(24);
      const ct = nacl.box(Buffer.from(plaintext), nonce, Buffer.from(archivePubHex, 'hex'), box.secretKey);
      return Buffer.concat([nonce, ct]).toString('base64');
    },
  };
}
