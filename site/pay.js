// pay.js — BUY TIME. The chosen head as a glyph cloud, three hour chips, the live price, one button, a QR.
// Everything shown comes from rent.js (the enclaves): the price is their rentZatsPerHour, the address is the one they
// publish, the hours left are theirs. Until the enclave has answered, the price is "—" and the button is disabled.
import { getRentState, rentPerHour, subscribeRent } from './rent.js?v=70';
import { zip321Uri, qrSvg } from './qr.js?v=70';
import { fixed8 } from './data.js?v=70';
import { mountCloud } from './glyphcloud.js?v=70';

const MEMO_MAX = 500;                 // bytes a shielded memo holds
const ANY_MIN_ZEC = 0.006;            // any-coin route (Trocador) minimum, with margin over their ~0.0045
const HEAD = { e1: 'vendor/skull-wick.jpg?v=70', e2: 'vendor/skull-obol.jpg?v=70' };
const $ = (s) => document.querySelector(s);
const bytesOf = (s) => new TextEncoder().encode(s).length;
const zec = (zats) => `${fixed8(zats).replace(/0+$/, '').replace(/\.$/, '')} ZEC`;
const other = (id) => (id === 'e1' ? 'e2' : 'e1');

const st = { who: 'e1', hours: 1, theirs: null, useTheirs: false, uri: '', wired: false, stop: null, cloudFor: '' };

function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

/** Idempotent: the memo counter, the dialog close, the live re-render. Pages call it once at boot. */
export function wirePay() {
  if (st.wired) return;
  const dlg = $('#pay'); if (!dlg) return;
  st.wired = true;
  $('#pay-memo').addEventListener('input', render);
  $('#pay-copy').addEventListener('click', (ev) => { if (!st.uri) return; navigator.clipboard?.writeText(st.uri).then(() => { ev.target.textContent = 'COPIED'; setTimeout(() => { ev.target.textContent = 'COPY PAYMENT LINK'; }, 1400); }).catch(() => {}); });
  dlg.addEventListener('close', () => { if (st.stop) st.stop(); st.stop = null; st.cloudFor = ''; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // the black around the form closes it
  subscribeRent(() => { if (dlg.open) render(); });
}

/**
 * @param {{who?:string|null, theirs?:{item:string,zats:number}|null, hours?:number|null, prefill?:string}} o
 */
export function openPay({ who = null, theirs = null, hours = null, prefill = '' } = {}) {
  const dlg = $('#pay'); if (!dlg) return;
  wirePay();
  if (who) st.who = who;
  st.theirs = theirs || null; st.useTheirs = !!theirs;
  if (hours) st.hours = hours;
  const memo = $('#pay-memo');
  if (prefill) memo.value = prefill;
  else if (theirs && !memo.value) memo.value = `ORDER: ${theirs.item} — `;
  render();
  if (!dlg.open) dlg.showModal();
  drawHead();
  memo.focus({ preventScroll: true });
}

function render() {
  const L = getRentState();
  const d = L[st.who], o = L[other(st.who)];
  const rent = rentPerHour(st.who);
  const name = d.name;

  // who: two names, the followed one lit; a dead or unreachable head says so and cannot be bought for
  const whoEl = $('#pay-who'); whoEl.replaceChildren();
  for (const v of [L.e1, L.e2]) {
    const b = node('button', 'payx-whob', v.name); b.type = 'button';
    b.setAttribute('aria-pressed', v.id === st.who ? 'true' : 'false');
    const state = v.dead ? 'DEAD' : v.offline ? 'UNREACHABLE' : v.stale ? 'STALE' : (typeof v.hoursLeft === 'number' ? `${v.hoursLeft} H LEFT` : '—');
    b.append(node('span', '', state));
    b.addEventListener('click', () => { if (st.who !== v.id) { st.who = v.id; st.useTheirs = false; render(); drawHead(); } });
    whoEl.append(b);
  }

  // amount
  const theirsOn = st.useTheirs && st.theirs;
  const amt = theirsOn ? st.theirs.zats : (rent ? st.hours * rent : null);
  $('#pay-h').textContent = theirsOn ? `BUY ${name} ITS OWN WORK` : `BUY ${name} ${st.hours === 1 ? 'AN HOUR' : `${st.hours} HOURS`}`;
  $('#pay-sub').textContent = d.locked
    ? (d.dead ? `${name} IS DEAD. ITS KEYS ARE GONE. ${o.locked ? '' : `${o.name} IS STILL PAYING RENT.`}` : `${name} IS NOT ANSWERING RIGHT NOW. THE ADDRESS BELOW IS THE LAST ONE IT PUBLISHED.`)
    : `EVERY HOUR ${name} PAYS ${rent ? zec(rent) : '—'} RENT FROM ITS OWN SHIELDED WALLET. YOUR ZEC LANDS THERE. NOBODY IN BETWEEN.`;

  const chips = $('#pay-amt'); chips.replaceChildren();
  const chip = (big, small, on, fn) => { const b = node('button', 'payx-chip'); b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.append(node('b', '', big), node('span', '', small)); b.addEventListener('click', fn); chips.append(b); };
  for (const n of [1, 10, 100]) chip(`${n} H`, rent ? zec(n * rent) : '—', !theirsOn && st.hours === n, () => { st.hours = n; st.useTheirs = false; render(); });
  if (st.theirs) chip(zec(st.theirs.zats), st.theirs.item.length > 26 ? `${st.theirs.item.slice(0, 25)}…` : st.theirs.item, !!theirsOn, () => { st.useTheirs = true; render(); });

  $('#pay-zec').textContent = amt ? zec(amt) : '—';
  $('#pay-what').textContent = amt
    ? (theirsOn ? `${st.theirs.item}` : `${st.hours === 1 ? 'ONE MORE HOUR' : `${st.hours} MORE HOURS`} OF ${name}'S LIFE`)
    : 'WAITING FOR THE ENCLAVE TO SAY ITS PRICE';

  // memo
  const memo = $('#pay-memo').value, b = bytesOf(memo), over = b > MEMO_MAX;
  $('#pay-name').textContent = name;
  $('#pay-bytes').textContent = `${b}/${MEMO_MAX}`;
  $('#pay-memo').closest('.payx-memo').classList.toggle('over', over);

  // the payment itself
  const addr = d.address, qr = $('#pay-qr'), open = $('#pay-open'), any = $('#pay-any'), addrEl = $('#pay-addr');
  st.uri = '';
  if (!addr || !amt) {
    qr.replaceChildren(node('span', 'err', !addr ? 'NO ADDRESS PUBLISHED BY THIS ENCLAVE RIGHT NOW' : 'NO PRICE YET'));
    open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true');
    any.removeAttribute('href'); addrEl.textContent = '';
    return;
  }
  try {
    st.uri = zip321Uri(addr, over ? '' : memo, amt / 1e8);
    qr.innerHTML = qrSvg(st.uri, { ecLevel: 'M', border: 2, ariaLabel: `pay ${name} ${fixed8(amt)} ZEC` });
  } catch (err) {
    qr.replaceChildren(node('span', 'err', err instanceof RangeError ? 'TOO LONG FOR ONE QR · SHORTEN IT OR USE THE LINK' : `QR: ${err.message}`));
  }
  if (st.uri) { open.href = st.uri; open.removeAttribute('aria-disabled'); } else { open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); }
  const anyZec = Math.max(amt / 1e8, ANY_MIN_ZEC);
  const anyHours = rent ? Math.max(1, Math.round((anyZec * 1e8) / rent)) : 1;
  any.href = `https://trocador.app/anonpay/?ticker_to=zec&network_to=Shielded&address=${encodeURIComponent(addr)}&amount=${anyZec.toFixed(8)}&name=hours&description=${encodeURIComponent(`${anyHours} hours for ${name}`)}&bgcolor=060606ff&buttonbgcolor=f4b728&textcolor=060606&simple_mode=True`;
  any.textContent = `NO ZEC? SOL · BTC · USDC ↗${anyZec > amt / 1e8 ? ` · MIN ${anyHours} H` : ''}`;
  addrEl.textContent = `${name}'S SHIELDED ADDRESS · ${addr}`;
}

// ---- the head: the same monochrome render the home samples, as a breathing glyph cloud
function drawHead() {
  const cv = $('#pay-head'); if (!cv) return;
  const src = HEAD[st.who];
  if (st.cloudFor === src && st.stop) return;
  if (st.stop) st.stop();
  st.stop = mountCloud(cv, src); st.cloudFor = src;
}
