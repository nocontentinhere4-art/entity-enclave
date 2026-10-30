import * as rent from './rent.js?v=97';
import { wirePay } from './pay.js?v=97';
import { openDoor } from './door.js?v=97';
import { createMorph } from './morph.js?v=97';

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  const morph = createMorph();
  setTimeout(() => rent.bootRent(), 300);   // the two 2.7 MB ledgers never compete with the first frame
  const ca = document.getElementById('ca');
  if (ca) {
    const label = ca.textContent;
    ca.addEventListener('click', async () => {
      const addr = ca.dataset.ca;
      try { await navigator.clipboard.writeText(addr); } catch (e) { window.prompt('copy the contract address', addr); return; }
      ca.textContent = 'COPIED'; ca.classList.add('copied');
      setTimeout(() => { ca.textContent = label; ca.classList.remove('copied'); }, 1400);
    });
  }
  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]'); if (!a) return; e.preventDefault(); openDoor(a.dataset.door || 'hash', morph.getWho());
  });
});
