// Vital signs derived only from observed balance history (pure: no clock, no disk, no side effects).
// `daysLeft` is deliberately conservative: rent is a floor on burn even when the recent slope looks flat.

const DAY_MS = 86_400_000;
const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

export function signals(history, rentZatsPerHour = 0) {
  const h = (history ?? [])
    .map((x) => ({ t: Date.parse(x.ts), z: Number(x.zatoshis) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.z))
    .sort((a, b) => a.t - b.t);

  if (h.length === 0) return { daysLeft: 0, lifeSlopePerDay: 0, incomeRhythmPerDay: 0 };

  const t0 = h[0].t;
  const days = (x) => (x.t - t0) / DAY_MS;
  const span = days(h.at(-1));
  const last = h.at(-1).z;

  // Least-squares slope of balance over time, in zats per day.
  let slope = 0;
  if (h.length >= 2) {
    const mx = h.reduce((s, x) => s + days(x), 0) / h.length;
    const my = h.reduce((s, x) => s + x.z, 0) / h.length;
    let num = 0;
    let den = 0;
    for (const x of h) {
      num += (days(x) - mx) * (x.z - my);
      den += (days(x) - mx) ** 2;
    }
    slope = den > 0 ? num / den : 0;
  }

  // Income: only upward jumps count; divide by observed days so a long quiet stretch lowers the rhythm.
  let income = 0;
  for (let i = 1; i < h.length; i++) income += Math.max(0, h[i].z - h[i - 1].z);
  const incomeRhythmPerDay = span > 0 ? income / span : 0;

  const rentPerDay = Math.max(0, Number(rentZatsPerHour) || 0) * 24;
  const burnPerDay = Math.max(-slope, rentPerDay);
  const daysLeft = last <= 0 ? 0 : burnPerDay > 0 ? last / burnPerDay : Infinity;

  return {
    daysLeft: round(daysLeft),
    lifeSlopePerDay: round(slope),
    incomeRhythmPerDay: round(incomeRhythmPerDay),
  };
}
