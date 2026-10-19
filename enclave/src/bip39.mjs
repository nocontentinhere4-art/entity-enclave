// BIP39 mnemonic encoding: entropy bytes → seed phrase. Used to seed the Zcash wallet deterministically
// from an enclave subkey, so the same wallet is reborn on a restart or redeploy of the same image.
// Standard: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The wordlist is read once at module load: 2048 words, index === rank.
const WORDLIST = readFileSync(new URL('./bip39-english.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);
if (WORDLIST.length !== 2048) throw new Error(`bip39-english.txt must have 2048 words, found ${WORDLIST.length}`);

/** Encode entropy (16/20/24/28/32 bytes per BIP39, the enclave uses 32) to its mnemonic phrase. */
export function entropyToMnemonic(entropy) {
  const len = entropy?.length;
  if (!(entropy instanceof Uint8Array) || ![16, 20, 24, 28, 32].includes(len)) {
    throw new Error('entropy must be a Uint8Array of 16/20/24/28/32 bytes');
  }
  const toBits = (arr) => Array.from(arr, (b) => b.toString(2).padStart(8, '0')).join('');
  // Checksum = the first ENT/32 bits of sha256(entropy); for 256-bit entropy that is 8 bits → 24 words.
  const checksumBits = toBits(createHash('sha256').update(entropy).digest()).slice(0, (len * 8) / 32);
  const bits = toBits(entropy) + checksumBits;
  const words = [];
  for (let i = 0; i < bits.length; i += 11) words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
  return words.join(' ');
}
