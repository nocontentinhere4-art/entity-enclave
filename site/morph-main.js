import * as rent from './rent.js?v=56';
import { wirePay } from './term.js?v=56';
import { openDoor } from './door.js?v=56';
import { createMorph } from './morph.js?v=56';

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  createMorph();
  setTimeout(() => rent.bootRent(), 300);   // the two 2.7 MB ledgers never compete with the first frame
  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]'); if (!a) return; e.preventDefault(); openDoor('hash', 'e1');
  });
});
