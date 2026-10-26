import * as rent from './rent.js?v=52';
import { wirePay } from './term.js?v=52';
import { openDoor } from './door.js?v=52';
import { createFilm } from './film.js?v=52';
import makeFall from './ch-fall.js?v=52';
import makeHeart from './ch-heart.js?v=52';
import makeSpine from './ch-spine.js?v=52';
import makeHand from './ch-hand.js?v=52';
import makeStorm from './ch-storm.js?v=52';
import makeGrave from './ch-grave.js?v=52';

const chapters = [
  { id: 'fall', make: makeFall },
  { id: 'heart', make: makeHeart },
  { id: 'spine', make: makeSpine },
  { id: 'hand', make: makeHand },
  { id: 'storm', make: makeStorm },
  { id: 'grave', make: makeGrave },
];

document.addEventListener('DOMContentLoaded', () => {
  wirePay();
  const film = createFilm({ chapters, rent });
  film.start();
  // the two 2.7 MB ledgers must not compete with chapter 1's first frame: boot the enclave data a moment later
  setTimeout(() => rent.bootRent(), 1200);
  if (/[?&]debug/.test(location.search)) window.__film = film;

  const soundBtn = document.getElementById('sound');
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      const s = film.sound;
      s.on = !s.on;
      soundBtn.textContent = s.on ? 'SOUND ON' : 'SOUND OFF';
      soundBtn.setAttribute('aria-pressed', String(s.on));
      if (s.on) s.wind(0);
    });
  }

  document.querySelector('.grave-links')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-door]');
    if (!a) return;
    e.preventDefault();
    openDoor('hash', 'e1');
  });
});
