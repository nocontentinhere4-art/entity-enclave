import * as rent from './rent.js?v=57';
import { wirePay } from './term.js?v=57';
import { openDoor } from './door.js?v=57';
import { createMorph } from './morph.js?v=57';

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  createMorph();
  setTimeout(() => rent.bootRent(), 300);   // the two 2.7 MB ledgers never compete with the first frame
  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]'); if (!a) return; e.preventDefault(); openDoor('hash', 'e1');
  });
});
