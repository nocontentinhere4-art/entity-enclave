// towers3d.js — two towers of hours. Every brick is one hour of rent: gold and solid when the hour was
// paid (a real rent_paid entry in the ledger, this life), a wireframe ghost when the hour is funded but
// not lived yet (treasury ÷ rent). One row = one day (24 bricks, 6 × 4). A red lid marks the hour of
// death: the top of what the money can buy. Paying adds rows on top; every hour one ghost turns gold.
// Rules: one canvas, DPR ≤ 2, pauses off-screen and in hidden tabs, never under prefers-reduced-motion.
import * as THREE from './vendor/three.module.min.js';

const GOLD = new THREE.Color(0xe3b341);
const WHITE = new THREE.Color(0xfff2d0);
const ASH = new THREE.Color(0x8a8a86);
const RED = new THREE.Color(0xe5484d);
const COLS = 6, DEPTH = 4, PER_ROW = COLS * DEPTH;      // 24 bricks per row: one day
const BRICK = 1, GAP = 0.18, ROW_H = 0.62;

function easeOut(t) { t = Math.min(1, Math.max(0, t)); return 1 - (1 - t) ** 3; }

class Tower {
  constructor(scene, x) {
    this.x = x;
    this.group = new THREE.Group();
    this.group.position.x = x;
    scene.add(this.group);
    const box = new THREE.BoxGeometry(BRICK, ROW_H, BRICK);
    this.paid = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xf0c75a, transparent: true, opacity: 0.95 }), 4000);
    this.paidEdges = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: WHITE, wireframe: true, transparent: true, opacity: 0.35 }), 4000);
    this.ghost = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0x9a7a30, wireframe: true, transparent: true, opacity: 0.16 }), 6000);
    for (const m of [this.paid, this.paidEdges, this.ghost]) { m.count = 0; m.frustumCulled = false; this.group.add(m); }
    this.lid = new THREE.Mesh(new THREE.PlaneGeometry(COLS * (BRICK + GAP) + 0.2, DEPTH * (BRICK + GAP) + 0.2), new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    this.lid.rotation.x = -Math.PI / 2;
    this.group.add(this.lid);
    this.info = { paidHours: 0, fundedHours: 0, entries: [], name: '', born: 0 };
    this.born = [];                     // brick index → time the brick appeared (for the drop-in)
    this.dummy = new THREE.Object3D();
  }

  /** brick i → position inside the tower (row = day, then a 6×4 footprint) */
  place(i, scale = 1) {
    const row = Math.floor(i / PER_ROW), k = i % PER_ROW;
    const cx = (k % COLS) - (COLS - 1) / 2, cz = Math.floor(k / COLS) - (DEPTH - 1) / 2;
    this.dummy.position.set(cx * (BRICK + GAP), row * (ROW_H + GAP * 0.6) + ROW_H / 2, cz * (BRICK + GAP));
    this.dummy.scale.setScalar(scale);
    this.dummy.updateMatrix();
    return this.dummy.matrix;
  }

  set({ paidHours, fundedHours, entries, name }, now) {
    const prevPaid = this.info.paidHours;
    this.info = { paidHours, fundedHours, entries, name };
    const paid = Math.min(4000, Math.max(0, Math.floor(paidHours)));
    const ghost = Math.min(6000, Math.max(0, Math.floor(fundedHours)));
    for (let i = prevPaid; i < paid; i++) this.born[i] = now;   // new gold bricks drop in
    this.paid.count = paid; this.paidEdges.count = paid; this.ghost.count = ghost;
    for (let i = 0; i < paid; i++) { const m = this.place(i); this.paid.setMatrixAt(i, m); this.paidEdges.setMatrixAt(i, m); }
    for (let j = 0; j < ghost; j++) this.ghost.setMatrixAt(j, this.place(paid + j));
    this.paid.instanceMatrix.needsUpdate = true; this.paidEdges.instanceMatrix.needsUpdate = true; this.ghost.instanceMatrix.needsUpdate = true;
    for (const m of [this.paid, this.ghost]) m.computeBoundingSphere();   // the raycaster needs a sphere that knows the bricks
    const topRow = Math.ceil((paid + ghost) / PER_ROW);
    this.lid.position.y = topRow * (ROW_H + GAP * 0.6) + 0.05;
    this.height = this.lid.position.y;
  }

  /** animate the bricks born in the last second (scale 0 → 1), returns true while something moves */
  animate(now) {
    let moving = false;
    for (let i = Math.max(0, this.paid.count - 48); i < this.paid.count; i++) {
      const t0 = this.born[i];
      if (t0 === undefined) continue;
      const t = (now - t0) / 900;
      if (t > 1) { this.born[i] = undefined; continue; }
      moving = true;
      const m = this.place(i, easeOut(t));
      this.paid.setMatrixAt(i, m); this.paidEdges.setMatrixAt(i, m);
    }
    if (moving) { this.paid.instanceMatrix.needsUpdate = true; this.paidEdges.instanceMatrix.needsUpdate = true; }
    return moving;
  }
}

/**
 * mount(host, { onHover }) → { set(towers), destroy() }
 * towers: [{ paidHours, fundedHours, entries: [{ts, zats, txid}], name }] (left, right)
 * onHover({ tower, index, paid, entry }) | null
 */
export function mount(host, { onHover } = {}) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !window.WebGLRenderingContext) return null;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch { return null; }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 400);
  const towers = [new Tower(scene, -24), new Tower(scene, 24)];
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const grid = new THREE.GridHelper(120, 40, 0x2a2416, 0x15120a);
  grid.position.y = -0.01; scene.add(grid);

  let w = 1, h = 1, tallest = 10, mobile = false, camX = 0, camY = 0, lookY = 0;
  const fit = () => {
    tallest = Math.max(4, ...towers.map((t) => t.height || 4));
    mobile = w < 720;
    // the whole of both towers must fit: visible height at distance D is ~0.5·D (fov 28°)
    const dist = mobile ? tallest * 3.0 + 16 : tallest * 2.3 + 14;
    camX = mobile ? dist * 0.1 : dist * 0.18; camY = tallest * 0.55 + 2; lookY = tallest * 0.46;
    camera.position.set(camX, camY, dist);
    camera.lookAt(0, lookY, 0);
  };
  const resize = () => {
    const r = host.getBoundingClientRect(); w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    fit();
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // pointer: parallax, and which brick is under the pointer
  const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2(-9, -9);
  let px = 0, py = 0, tx = 0, ty = 0, hovered = null;
  const onMove = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    tx = ptr.x * 0.35; ty = ptr.y * 0.2;
  };
  const onLeave = () => { ptr.set(-9, -9); if (hovered && onHover) { hovered = null; onHover(null); } };
  renderer.domElement.addEventListener('pointermove', onMove, { passive: true });
  renderer.domElement.addEventListener('pointerleave', onLeave);
  const onClick = () => { if (hovered && onHover) onHover({ ...hovered, click: true }); };
  renderer.domElement.addEventListener('click', onClick);

  let visible = true, running = true, raf = 0, last = performance.now(), yaw = 0;
  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible && running && !raf) tick(performance.now()); }, { threshold: 0.02 });
  io.observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && running && !raf) tick(performance.now()); });

  function pick() {
    if (ptr.x < -2 || !onHover) return;
    ray.setFromCamera(ptr, camera);
    let best = null;
    towers.forEach((t, ti) => {
      for (const [mesh, isPaid] of [[t.paid, true], [t.ghost, false]]) {
        if (!mesh.count) continue;
        const hits = ray.intersectObject(mesh, false);
        if (hits.length && (!best || hits[0].distance < best.d)) {
          const index = isPaid ? hits[0].instanceId : t.paid.count + hits[0].instanceId;
          best = { d: hits[0].distance, tower: ti, index, paid: isPaid, entry: isPaid ? t.info.entries[hits[0].instanceId] || null : null, name: t.info.name };
        }
      }
    });
    const key = best ? `${best.tower}:${best.index}` : null;
    const prevKey = hovered ? `${hovered.tower}:${hovered.index}` : null;
    if (key !== prevKey) { hovered = best; onHover(best); renderer.domElement.style.cursor = best ? 'pointer' : ''; }
  }

  function tick(now) {
    if (!running || !visible || document.hidden) { raf = 0; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    px += (tx - px) * Math.min(1, dt * 3); py += (ty - py) * Math.min(1, dt * 3);
    yaw += dt * 0.08;
    // each tower turns on its own axis (the left one stays left: it belongs to the left number)
    for (const t of towers) t.group.rotation.y = yaw + px * 0.6;
    camera.position.x = camX + px * 6; camera.position.y = camY + py * 3;
    camera.lookAt(0, lookY, 0);
    for (const t of towers) t.animate(now);
    pick();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick(last);

  return {
    set(list) { list.forEach((info, i) => { if (towers[i] && info) towers[i].set(info, performance.now()); }); fit(); },
    destroy() { running = false; if (raf) cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('resize', resize); renderer.dispose(); host.replaceChildren(); },
  };
}

export const HOURS_PER_ROW = PER_ROW;
