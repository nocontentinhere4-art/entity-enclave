import * as rent from './rent.js?v=55';
import { wirePay } from './term.js?v=55';
import { openDoor } from './door.js?v=55';
import { createFilm } from './film.js?v=55';
import makeBrief, { briefSeen, markBriefSeen } from './ch-brief.js?v=55';
import makeFall from './ch-fall.js?v=55';
import makeHeart from './ch-heart.js?v=55';
import makeSpine from './ch-spine.js?v=55';
import makeHand from './ch-hand.js?v=55';
import makeStorm from './ch-storm.js?v=55';
import makeGrave from './ch-grave.js?v=55';

const chapters = [
  { id: 'brief', make: makeBrief },
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
  // returning visitors start at chapter 1; the '?' replays the briefing
  const replay = document.getElementById('replay');
  const fall = document.getElementById('ch-fall');
  if (briefSeen() && fall && !/[?&]brief/.test(location.search)) {
    window.scrollTo({ top: fall.offsetTop, behavior: 'instant' });
    if (replay) replay.hidden = false;
  }
  if (replay) replay.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  // the briefing counts as seen once the visitor has scrolled into chapter 1 (or pressed SKIP, handled by the chapter)
  let seenNow = briefSeen();
  window.addEventListener('scroll', () => {
    if (seenNow || !fall) return;
    if (window.scrollY >= fall.offsetTop - window.innerHeight * 0.25) { seenNow = true; markBriefSeen(); if (replay) replay.hidden = false; }
  }, { passive: true });
  // the two 2.7 MB ledgers must not compete with chapter 1's first frame: boot the enclave data a moment later
  setTimeout(() => rent.bootRent(), 300);
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
