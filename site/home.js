import { initHero } from './hero.js?v=50';
import { wirePay } from './term.js?v=50';
import { mountHands } from './hands.js?v=50';
import { bootRent } from './rent.js?v=50';

function boot() {
  initHero();
  wirePay();
  mountHands();
  bootRent();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
