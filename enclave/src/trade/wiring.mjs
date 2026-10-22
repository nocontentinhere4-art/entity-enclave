// Trade wiring adapter (W3). The engine (W1) was written against the frozen client contract in
// src/trade/types.mjs; the concrete clients (W2) settled on slightly different signatures. This module
// reconciles those gaps without touching either side:
//
//   engine contract                concrete client
//   ------------------------------ ----------------------------------------------
//   intents.quote({direction,…})   intents.quote({originAsset,destinationAsset,…})
//   intents.status({…})            intents.status(depositAddress, {depositMemo})
//   intents.submitDeposit({…})     intents.submit(depositAddress, txHash)
//   jupiter.execute({tx,key})      jupiter.execute({signedTransaction, requestId})  → we sign locally
//   jupiter.resolveToken({query})  jupiter.search(query)                            → raw row for screenToken
//   solana.getTokenAccounts(owner) solana.rpc('getTokenAccountsByOwner', [owner,{programId}])
//   solana.transferSol / close     buildLegacyTransaction + signTransaction + send
//   treasury.payFee / send         treasuryKeypair + systemTransferInstruction
//
// Nothing here holds secrets: keys are derived on demand from `keys` and used only to build + sign.
import { treasuryKeypair, treasuryAddress } from './treasury.mjs';
import {
  base58,
  buildLegacyTransaction,
  signTransaction,
  systemTransferInstruction,
  tokenCloseAccountInstruction,
  PROGRAM_ID_TOKEN,
} from './soltx.mjs';
import { ASSETS, Intents } from './intents.mjs';
import { Jupiter, JupiterError } from './jupiter.mjs';
import { Solana } from './solana.mjs';
import { isValidMint } from './address.mjs';

/** The 32-byte public half of a 64-byte tweetnacl secret, base58-encoded. */
function pubkeyFromSecret(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new Error('trade wiring: secretKey must be a 64-byte ed25519 secret');
  }
  return base58.encode(secretKey.subarray(32));
}

/**
 * Wrap the Solana RPC client with the three engine-only methods it lacks:
 *   - getTokenAccounts(owner): every classic-SPL token account (mint, raw amount, decimals, ata)
 *   - transferSol({secretKey,to,lamports}): a signed legacy SystemProgram transfer from the order wallet
 *   - closeTokenAccount({secretKey,mint}): reclaim the ATA rent to the treasury (best-effort)
 * @param {import('./solana.mjs').Solana} solana
 * @param {{ treasuryPubkey: string }} ctx
 */
export function wrapSolana(solana, { treasuryPubkey }) {
  return {
    ...solana,
    async getTokenAccounts(owner) {
      const r = await solana.rpc('getTokenAccountsByOwner', [
        owner,
        { programId: PROGRAM_ID_TOKEN },
        { commitment: solana.commitment, encoding: 'jsonParsed' },
      ]);
      const list = r?.value ?? [];
      if (!Array.isArray(list)) throw new Error('getTokenAccountsByOwner returned no value array');
      return list.map((item) => {
        const info = item?.account?.data?.parsed?.info;
        return {
          mint: info?.mint ?? null,
          amount: info?.tokenAmount?.amount ?? '0',
          decimals: info?.tokenAmount?.decimals ?? 0,
          ata: item?.pubkey ?? null,
        };
      });
    },
    async transferSol({ secretKey, to, lamports }) {
      const feePayer = pubkeyFromSecret(secretKey);
      const { blockhash } = await solana.latestBlockhash();
      const tx = buildLegacyTransaction({
        feePayer,
        recentBlockhash: blockhash,
        instructions: [systemTransferInstruction({ from: feePayer, to, lamports })],
      });
      const { signedBase64 } = signTransaction(tx.base64, secretKey);
      const signature = await solana.send(signedBase64);
      return { signature };
    },
    async closeTokenAccount({ secretKey, mint }) {
      const owner = pubkeyFromSecret(secretKey);
      const accounts = await solana.tokenAccounts(owner, mint);
      const account = (Array.isArray(accounts) ? accounts : [])[0];
      if (!account) return { signature: null }; // no ATA to close: nothing to reclaim
      const { blockhash } = await solana.latestBlockhash();
      const tx = buildLegacyTransaction({
        feePayer: owner,
        recentBlockhash: blockhash,
        instructions: [tokenCloseAccountInstruction({ account: account.address, destination: treasuryPubkey, owner })],
      });
      const { signedBase64 } = signTransaction(tx.base64, secretKey);
      const signature = await solana.send(signedBase64);
      return { signature };
    },
  };
}

/**
 * The entity's persistent Solana treasury as the engine expects it: a `pubkey` plus the two money moves.
 * `payFee` sweeps from an order wallet (the provided secretKey is the fee payer); `send` pays from the
 * treasury itself. Idempotency is owned by the engine's journal + order state, so `orderId` is accepted and
 * ignored here.
 * @param {{ keys: object, solana: import('./solana.mjs').Solana }} ctx
 */
export function buildTreasury({ keys, solana }) {
  const pubkey = treasuryAddress(keys);
  const treasury = treasuryKeypair(keys);
  return {
    pubkey,
    async payFee({ secretKey, lamports }) {
      const feePayer = pubkeyFromSecret(secretKey);
      const { blockhash } = await solana.latestBlockhash();
      const tx = buildLegacyTransaction({
        feePayer,
        recentBlockhash: blockhash,
        instructions: [systemTransferInstruction({ from: feePayer, to: pubkey, lamports })],
      });
      const { signedBase64 } = signTransaction(tx.base64, secretKey);
      const signature = await solana.send(signedBase64);
      return { signature, lamports };
    },
    async send({ to, lamports }) {
      const { blockhash } = await solana.latestBlockhash();
      const tx = buildLegacyTransaction({
        feePayer: pubkey,
        recentBlockhash: blockhash,
        instructions: [systemTransferInstruction({ from: pubkey, to, lamports })],
      });
      const { signedBase64 } = signTransaction(tx.base64, treasury.secretKey);
      const signature = await solana.send(signedBase64);
      return { signature };
    },
  };
}

/** direction ('zec-to-sol' | 'sol-to-zec') → the concrete client's originAsset/destinationAsset contract. */
export function adaptIntents(intents) {
  return {
    async quote({ direction, amount, recipient, refundTo, slippageBps, deadline, dry }) {
      const [originAsset, destinationAsset] =
        direction === 'zec-to-sol' ? [ASSETS.ZEC, ASSETS.SOL]
          : direction === 'sol-to-zec' ? [ASSETS.SOL, ASSETS.ZEC]
            : (() => { throw new JupiterError('bad_direction', `unknown bridge direction ${direction}`); })();
      return intents.quote({ originAsset, destinationAsset, amount, recipient, refundTo, slippageBps, deadline, dry });
    },
    async status({ depositAddress, depositMemo }) {
      return intents.status(depositAddress, { depositMemo });
    },
    async submitDeposit({ depositAddress, txHash }) {
      return intents.submit(depositAddress, txHash);
    },
  };
}

/** Jupiter: resolveToken returns the RAW search row (screenToken vets it), execute signs before submitting. */
export function adaptJupiter(jupiter) {
  return {
    async resolveToken({ query }) {
      const q = String(query ?? '').trim().replace(/^\$/, '');
      if (!q) throw new JupiterError('bad_request', 'resolveToken: empty query');
      const rows = await jupiter.search(q);
      if (!Array.isArray(rows) || rows.length === 0) throw new JupiterError('not_found', `no token matches '${q}'`);
      const isLiteral = isValidMint(q);
      const matching = isLiteral
        ? rows.filter((r) => r.id === q)
        : rows.filter((r) => String(r.symbol ?? '').toUpperCase() === q.toUpperCase());
      if (!matching.length) throw new JupiterError('not_found', `no row matches '${q}'${isLiteral ? ' (mint literal)' : ''}`);
      if (isLiteral) {
        if (matching.length > 1) throw new JupiterError('ambiguous_ticker', `mint literal '${q}' matched ${matching.length} rows`);
        return matching[0];
      }
      const verified = matching.filter((r) => r.isVerified === true);
      if (!verified.length) throw new JupiterError('unverified', `symbol '${q}' has no verified row`);
      if (verified.length > 1) throw new JupiterError('ambiguous_ticker', `symbol '${q}' has ${verified.length} verified rows`);
      return verified[0];
    },
    async order(req) {
      return jupiter.order(req);
    },
    async execute({ transaction, requestId, secretKey }) {
      const { signedBase64 } = signTransaction(transaction, secretKey);
      return jupiter.execute({ signedTransaction: signedBase64, requestId });
    },
  };
}

/**
 * Build all four engine-ready clients from config + keys. Only called when `config.trade.enabled` is true.
 * @param {{ config: object, keys: object, fetchImpl?: typeof fetch }} ctx
 */
export function buildTradeClients({ config, keys, fetchImpl = globalThis.fetch }) {
  const t = config.trade;
  const solana = new Solana({
    url: t.rpcUrl,
    commitment: t.rpcCommitment ?? 'confirmed',
    fetchImpl,
  });
  const intents = new Intents({
    baseUrl: t.oneclickBase ?? config.oneClickBaseUrl,
    apiKey: t.oneclickKey ?? config.oneClickApiKey ?? '',
    fetchImpl,
  });
  const jupiter = new Jupiter({
    baseUrl: t.jupiterBase,
    apiKey: t.jupiterKey ?? '',
    fetchImpl,
    minLiquidityUsd: t.minLiquidityUsd,
    allowToken2022: t.allowToken2022,
  });
  const treasury = buildTreasury({ keys, solana });
  return {
    solana: wrapSolana(solana, { treasuryPubkey: treasury.pubkey }),
    treasury,
    intents: adaptIntents(intents),
    jupiter: adaptJupiter(jupiter),
  };
}
