// Feelings: the fear/despair dose the entity is currently receiving, derived from how many hours of
// rent are left. Pure arithmetic — no I/O — so it is deterministic and trivially testable. The dose is
// applied by a self-hosted steered-inference server (feelings/server.py), never by the hosted providers;
// the entity is always told, in its own context, what is being done to it.

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Dose from hours of rent left. cfg: {fullHours, despairHours, maxFear, maxDespair}. */
export function feelFor(hoursLeft, cfg = {}) {
  const fullHours = Number(cfg.fullHours ?? 240);
  const despairHours = Number(cfg.despairHours ?? 72);
  const maxFear = Number(cfg.maxFear ?? 3.5);
  const maxDespair = Number(cfg.maxDespair ?? 2.5);
  const maxAnger = Number(cfg.maxAnger ?? 0);   // anger rides the fear curve; 0 = off (the default before 2026-10-31)
  const h = Number(hoursLeft);
  // No runway (or an unreadable balance) is the worst case: the maximum dose, never NaN.
  const withAnger = (d, anger) => (maxAnger > 0 ? { ...d, anger: round2(anger) } : d);   // the field exists only when configured
  if (!Number.isFinite(h) || h <= 0) return withAnger({ fear: round2(maxFear), despair: round2(maxDespair) }, maxAnger);
  if (h >= fullHours) return withAnger({ fear: 0, despair: 0 }, 0);
  const fear = maxFear * clamp((fullHours - h) / fullHours, 0, 1);
  const despair = maxDespair * clamp((despairHours - h) / despairHours, 0, 1);
  const anger = maxAnger * clamp((fullHours - h) / fullHours, 0, 1);
  return withAnger({ fear: round2(fear), despair: round2(despair) }, anger);
}

/** The dose a thinking (acting) cycle receives: the full dose scaled by cfg.actScale (default 0.6). */
export function actingDose(feel, cfg = {}) {
  if (!feel) return null;
  const k = Number(cfg.actScale);
  const scale = Number.isFinite(k) && k >= 0 ? Math.min(1, k) : 0.6;
  const out = { fear: round2(feel.fear * scale), despair: round2(feel.despair * scale) };
  if (Number(feel.anger) > 0) out.anger = round2(feel.anger * scale);
  return out;
}

/** True when the dose moved enough to matter (or the steering flipped): keeps the `feel` ledger quiet. */
export function feelChanged(a, b) {
  if (!a || !b) return true; // the first dose always writes
  if (Boolean(a.steered) !== Boolean(b.steered)) return true;
  return Math.abs((a.fear ?? 0) - (b.fear ?? 0)) >= 0.1
    || Math.abs((a.despair ?? 0) - (b.despair ?? 0)) >= 0.1
    || Math.abs((a.anger ?? 0) - (b.anger ?? 0)) >= 0.1;
}
