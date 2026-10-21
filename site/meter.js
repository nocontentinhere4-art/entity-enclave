// meter.js — the one driver of the page: scrolling is moving forward in time.
// p = page scroll progress (0..1) → hoursAhead = p × horizon. Everything that carries the concept
// reads from here: the corner meter, the death clocks, the hero hours, --ash on <html>, the relic.
// Nothing here invents a number: hours come from the entities' own balances and rent.

const HOUR = 3600e3;

const state = {
  entities: [],          // [{ id, hoursLeft }] alive entities with a derivable clock
  p: 0,                  // scroll progress
  horizon: 0,            // hours spanned by the whole page
  ahead: 0,              // hours into the future at the current scroll
  listeners: new Set(),
  raf: 0,
  el: null,
  touched: false,
};

/** Hours spanned by the page: 1.35 × the weaker entity's life, so its death lands near the pay section. */
function horizonOf(entities) {
  const hours = entities.map((e) => e.hoursLeft).filter((h) => Number.isFinite(h) && h > 0);
  if (!hours.length) return 0;
  return Math.min(...hours) * 1.35;
}

function progress() {
  const doc = document.documentElement;
  const max = Math.max(1, doc.scrollHeight - window.innerHeight);
  return Math.min(1, Math.max(0, (window.scrollY || 0) / max));
}

function fmtHours(h) {
  if (h < 1) return `+ ${String(Math.round(h * 60)).padStart(2, '0')} min`;
  return `+ ${String(Math.floor(h)).padStart(3, '0')} h`;
}

function fmtWhen(ms) {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  const short = typeof window !== 'undefined' && window.innerWidth < 640;
  return short ? `${d.getUTCDate()} ${mon} ${hh}:${mm}` : `${day} ${d.getUTCDate()} ${mon} ${hh}:${mm} UTC`;
}

function apply() {
  state.raf = 0;
  state.p = progress();
  state.horizon = horizonOf(state.entities);
  state.ahead = state.p * state.horizon;
  const root = document.documentElement;
  root.style.setProperty('--ash', state.p.toFixed(3));
  root.classList.toggle('meter-ahead', state.ahead > 0.02);
  if (state.el) {
    const now = Date.now() + state.ahead * HOUR;
    state.el.querySelector('.meter-h').textContent = state.ahead < 0.02 ? 'NOW' : fmtHours(state.ahead);
    state.el.querySelector('.meter-when').textContent = fmtWhen(now);
    const hint = state.el.querySelector('.meter-hint');
    if (hint) hint.textContent = state.horizon ? (state.ahead < 0.02 ? 'scroll = time' : 'scroll back = now') : 'no clock yet';
  }
  for (const fn of state.listeners) fn(snapshot());
}

export function snapshot() {
  const { p, horizon, ahead } = state;
  const weakest = state.entities.reduce((m, e) => (m === null || e.hoursLeft < m ? e.hoursLeft : m), null);
  return {
    p, horizon, ahead,
    offsetMs: ahead * HOUR,
    /** life of the weaker entity at this moment, 1 → 0 */
    life: weakest ? Math.max(0, Math.min(1, (weakest - ahead) / weakest)) : 1,
    /** how far past the weaker death we are, 0 → 1 (dust) */
    death: weakest && horizon > weakest ? Math.max(0, Math.min(1, (ahead - weakest) / (horizon - weakest))) : 0,
    /** hours remaining for an entity at this moment */
    remaining: (hoursLeft) => Math.max(0, hoursLeft - ahead),
  };
}

function schedule() { if (!state.raf) state.raf = requestAnimationFrame(apply); }

/** Install the corner meter and the scroll → time mapping. */
export function startMeter(host) {
  state.el = host;
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  apply();
  return { onChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); } };
}

/** Called after every data read: the entities' real hours left. */
export function setEntities(list) {
  state.entities = list.filter((e) => Number.isFinite(e.hoursLeft) && e.hoursLeft > 0);
  apply();                                   // data changed: recompute now, not at the next frame
}

/** Back to now: time rewinds as the page scrolls home. */
export function rewind() {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

export { fmtWhen };
