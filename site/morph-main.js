import * as rent from './rent.js?v=59';
import { wirePay } from './term.js?v=59';
import { openDoor } from './door.js?v=59';
import { createMorph } from './morph.js?v=59';

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  const morph = createMorph();
  setTimeout(() => rent.bootRent(), 300);   // the two 2.7 MB ledgers never compete with the first frame
  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]'); if (!a) return; e.preventDefault(); openDoor('hash', morph.getWho());
  });
});
