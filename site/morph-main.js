import * as rent from './rent.js?v=80';
import { wirePay } from './pay.js?v=80';
import { openDoor } from './door.js?v=80';
import { createMorph } from './morph.js?v=80';

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  const morph = createMorph();
  setTimeout(() => rent.bootRent(), 300);   // the two 2.7 MB ledgers never compete with the first frame
  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]'); if (!a) return; e.preventDefault(); openDoor(a.dataset.door || 'hash', morph.getWho());
  });
});
