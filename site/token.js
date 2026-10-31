// $ZEALOT on StonkFun. scripts/launch-token.mjs fills TOKEN_CA the minute it launches; empty means not launched.
// Holder rewards are read live from StonkFun's public API (v1 sends CORS, so a static page can read it).
export const TOKEN_CA = '8hVLvWFu3WAku7itGMGppFsud549DixBHbtQAU3FqjCH';
export const TOKEN_TAX = 3;
const API = 'https://www.stonkfun.xyz/api/public/v1/tokens/';

export async function holderRewards(ca = TOKEN_CA) {
  if (!ca) return null;
  try {
    const r = await fetch(`${API}${ca}/rewards`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = (await r.json()).data;
    if (!d || d.mode !== 'reward' || !d.rewards) return null;
    return {
      paid: d.rewards.distributedTokens ?? 0,
      pending: d.rewards.undistributedTokens ?? 0,
      holders: d.rewards.holderCount ?? 0,
      symbol: d.quote?.symbol || 'ZEC',
      last: d.rewards.lastPayoutAt || null
    };
  } catch { return null; }
}

export function rewardsLine(r) {
  if (!r) return 'StonkFun not reachable right now · nothing invented';
  if (!r.paid) return `no payout yet · ${fmt(r.pending)} ${r.symbol} waiting for the next reward cycle`;
  return `${fmt(r.paid)} ${r.symbol} paid to ${r.holders.toLocaleString('en-US')} holders · last payout ${ago(r.last)}`;
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 }); }
function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
