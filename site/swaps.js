import { SWAP_API_BASE, SWAP_LAUNCH_ENABLED } from './swap-config.js?v=2';
const form = document.getElementById('swap-form');
const result = document.getElementById('swap-result');
const status = document.getElementById('swap-status');
const submit = document.getElementById('swap-quote');
let receipt = null, polling = null;
const errors = { reserve_insufficient: 'The project reserve is not funded enough. No deposit was accepted.', swaps_disabled: 'Sponsored swaps are not live yet.', sponsorship_limit: 'This route costs more than the project can cover. No deposit was accepted.', unbounded_quote: 'No guaranteed route is available. No deposit was accepted.', swap_size: 'Use an amount worth $1–$100.', quote_rate_limit: 'Too many quote requests. Wait a minute.', invalid_address: 'Check both addresses. ZEC requires a shielded u1… or zs1… address.' };
const pretty = (units, decimals) => { const v=BigInt(units); return `${v/10n**BigInt(decimals)}.${String(v%10n**BigInt(decimals)).padStart(decimals,'0')}`; };
async function api(path, body) {
  if (!SWAP_API_BASE) throw new Error('Sponsored swaps are not live yet. The separate reserve and service must be connected first.');
  const r = await fetch(`${SWAP_API_BASE}${path}`, { method: body ? 'POST' : 'GET', headers: body ? {'content-type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000), cache:'no-store' });
  const j = await r.json(); if (!r.ok) throw new Error(errors[j.error] ?? j.error ?? 'Swap service unavailable.'); return j;
}
function updateLabels() {
  const zec = form.elements.direction.value === 'zec-to-sol';
  document.getElementById('swap-amount-label').textContent = `You send · ${zec?'ZEC':'SOL'}`;
  document.getElementById('swap-recipient-label').textContent = `Receive address · ${zec?'SOL':'shielded ZEC'}`;
  document.getElementById('swap-refund-label').textContent = `Refund address · ${zec?'shielded ZEC':'SOL'}`;
  document.getElementById('swap-output-label').textContent = `You receive · ${zec?'SOL':'ZEC'}`;
  form.elements.recipient.placeholder = zec ? 'Solana address' : 'u1…';
  form.elements.refundTo.placeholder = zec ? 'u1…' : 'Solana address';
}
function render(q) {
  result.replaceChildren(); const zec = q.direction === 'zec-to-sol';
  const payable = q.state === 'awaiting_deposit' && Date.parse(q.deadline) > Date.now();
  for (const [label,value] of [
    ['Status',q.state], ['Send exactly',`${pretty(q.amount,zec?8:9)} ${zec?'ZEC':'SOL'}`],
    ['Receive at least',`${pretty(q.minAmountOut,zec?9:8)} ${zec?'SOL':'ZEC'}`],
    ['Project reimbursement',`${pretty(q.sponsorLamports,9)} SOL after settlement`],
    ['Reimbursement goes to',q.reimbursementTo], ['Deposit address',payable ? q.depositAddress : 'DO NOT SEND — expired or already processing'],
    ...(payable && q.depositMemo?[['Required deposit memo',q.depositMemo]]:[]),
    ['Deposit deadline',q.deadline], ...(q.reimbursementSignature?[['Reimbursement transaction',q.reimbursementSignature]]:[]),
  ]) { const row=document.createElement('p'), title=document.createElement('strong'), valueEl=document.createElement('code'); title.textContent=`${label}: `;valueEl.textContent=value;row.append(title,valueEl);result.append(row); }
  const notice=document.createElement('p'); notice.textContent=q.notice; result.append(notice); result.hidden=false;
}
async function refresh() {
  if (!receipt) return;
  try { const q=await api('/swaps/status',{id:receipt.id,token:receipt.token}); render(q); if (['complete','failed','refunded'].includes(q.state)) clearInterval(polling); }
  catch(e) { status.textContent=`Status unavailable: ${e.message} Your receipt is preserved; do not send again.`; }
}
async function availability() {
  updateLabels(); submit.disabled=true;
  if (!SWAP_LAUNCH_ENABLED) { status.textContent='Not live yet. Deposits are disabled until the project activates swaps.'; submit.textContent='Swaps opening soon'; return; }
  try { const s=await api('/swaps');const funded=BigInt(s.availableLamports)>=2010000n;
    submit.disabled=Boolean(receipt)||!s.enabled||!funded;
    submit.textContent='Get covered quote';
    status.textContent=s.enabled&&funded?'View your exact quote and coverage before sending.':'Swaps paused. No deposits are being accepted.';
    document.getElementById('swap-restore').hidden=false;
  } catch(e) {status.textContent='Swaps temporarily unavailable. No deposits are being accepted.';}
}
form.elements.direction.addEventListener('change',updateLabels);
form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(!SWAP_LAUNCH_ENABLED) return;
  submit.disabled=true;status.textContent='Reserving project coverage…';
  try {
    if(receipt) throw new Error('An active receipt already exists. Follow its status before requesting another.');
    const d=form.elements.direction.value, decimals=d==='zec-to-sol'?8:9;
    const raw=form.elements.amount.value.trim(), m=raw.match(/^(\d+)(?:\.(\d+))?$/);
    if(!m || (m[2]?.length??0)>decimals) throw new Error('Enter an exact positive amount.');
    const amount=String(BigInt(m[1])*10n**BigInt(decimals)+BigInt((m[2]??'').padEnd(decimals,'0')));
    receipt=await api('/swaps/quote',{direction:d,amount,recipient:form.elements.recipient.value.trim(),refundTo:form.elements.refundTo.value.trim()});
    sessionStorage.setItem('zealot-swap-receipt',JSON.stringify(receipt));render(receipt);
    status.textContent='Coverage reserved. Save the receipt, then send only the exact quoted amount before its deadline. Reimbursement is in SOL.';
    document.getElementById('swap-save').hidden=false; polling=setInterval(refresh,15000);
  } catch(e){status.textContent=e.message;submit.disabled=Boolean(receipt)||!SWAP_LAUNCH_ENABLED;}
});
document.getElementById('swap-save').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`zealot-swap-${receipt.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
try {const saved=JSON.parse(sessionStorage.getItem('zealot-swap-receipt'));if(saved?.id&&saved?.token){receipt=saved;render(saved);document.getElementById('swap-save').hidden=false;if(SWAP_LAUNCH_ENABLED)polling=setInterval(refresh,15000);}}catch{}

 document.getElementById('swap-load').addEventListener('change',async e=>{
   try { const file=e.target.files[0];if(!file||file.size>16384)throw new Error('Invalid receipt file.');
     const saved=JSON.parse(await file.text());if(!/^[a-f0-9]{32}$/.test(saved.id)||!/^[a-f0-9]{64}$/.test(saved.token))throw new Error('Invalid receipt.');
     const q=await api('/swaps/status',{id:saved.id,token:saved.token});receipt={...q,token:saved.token};sessionStorage.setItem('zealot-swap-receipt',JSON.stringify(receipt));render(q);
     document.getElementById('swap-save').hidden=false;clearInterval(polling);polling=setInterval(refresh,15000);status.textContent='Receipt restored. Do not repeat a deposit already sent.';
   } catch(err){status.textContent=err.message;}
 });

availability();
