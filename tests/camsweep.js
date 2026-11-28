// Camera occlusion sweep, evaluated inside the game page (window.__game + window.THREE).
// For one arena + zoom: puts the fighters through many positions/states/cinematics, settles the camera, and checks
// against the real static geometry (opaque meshes, both faces):
//   inside  - the camera is inside a solid (first hit toward the focus is a back face)
//   hidden  - a fighter on the deck (not out / not fallen below the deck) is hidden behind solid geometry
//   graze   - the near plane is within 0.25 m of a surface (shows building interiors)
// Returns { poses, fails: [{arena, zoom, pose, kind, detail}] }.
// eslint-disable-next-line no-unused-vars
async function camSweep(arenaId, zoom, opts = {}) {
  const G = window.__game, T = window.THREE;
  const limit = opts.limit ?? 1e9;
  if (G.arena.layout !== arenaId || !G.match) G.start('magna', 'vanta', 'cpu', 'normal', arenaId);
  G.vcam.collider = G.arena.camCollider(); // finish the time-sliced build now
  G.disableCPU();
  G.setManual(true);
  const m = G.match, cam = G.vcam, fs = m.fighters;
  m.introT = 0; // no READY banner in screenshots
  cam.userZoom = zoom;
  // Ground-truth occluders: opaque static meshes, double-sided proxies (the game's own materials cull back faces).
  const dbl = new T.MeshBasicMaterial({ side: T.DoubleSide });
  const occ = [];
  G.arena.static.updateMatrixWorld(true);
  // Fadeables (e.g. the rooftop hut) turn see-through when they block the view, so they don't count.
  const faded = new Set();
  for (const f of G.arena.fadeables) f.traverse((o) => faded.add(o));
  G.arena.static.traverse((o) => {
    if (!o.isMesh || !o.visible || faded.has(o)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.transparent || mat.alphaTest > 0 || mat.depthWrite === false) return;
    const p = new T.Mesh(o.geometry, dbl);
    p.matrixAutoUpdate = false; p.matrixWorld.copy(o.matrixWorld);
    occ.push(p);
  });
  const rc = new T.Raycaster();
  const firstHit = (from, to) => {
    const d = to.clone().sub(from), len = d.length();
    rc.set(from, d.normalize()); rc.near = 0; rc.far = len;
    const h = rc.intersectObjects(occ, false)[0];
    return h ? { dist: h.distance, len, back: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(rc.ray.direction) > 0 : false } : null;
  };
  // Does ANY camera position see all these points? Brute force around the focus (only run on a failure): if not,
  // the pose has no clear view at all (e.g. fighters in opposite corners of a hall full of tall bookcases).
  const anyView = (focus, pts) => {
    for (const r of [6, 10, 14, 19, 25]) for (let a = 0; a < 16; a++) for (const y of [2, 5, 8, 12, 16]) {
      const c = new T.Vector3(focus.x + Math.sin(a * Math.PI / 8) * r, y, focus.z + Math.cos(a * Math.PI / 8) * r);
      const h0 = firstHit(c, focus); if (h0) continue;
      if (pts.every((p) => { const h = firstHit(c, p); return !h || h.dist > h.len - 0.35; })) { window.__view = [r, a, y, c.toArray().map((v) => +v.toFixed(1))]; return true; }
    }
    return false;
  };
  const { hw, hd } = opts.bounds ?? G.bounds();
  const circle = opts.circle ?? G.circle();
  // On the deck and not inside a fixed solid (container stacks, huts, masts: fighters can't stand there).
  const solids = G.arena.fixedSolids.filter((q) => q.max.y > 0.5);
  const free = (x, z) => !solids.some((q) => x > q.min.x - 0.5 && x < q.max.x + 0.5 && z > q.min.z - 0.5 && z < q.max.z + 0.5);
  const onDeck = (x, z) => (circle ? Math.hypot(x, z) < circle - 0.6 : Math.abs(x) < hw - 0.6 && Math.abs(z) < hd - 0.6) && free(x, z);
  // Seeded positions so runs are comparable.
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const deckPt = () => { for (;;) { const x = (rnd() * 2 - 1) * hw, z = (rnd() * 2 - 1) * hd; if (onDeck(x, z)) return [x, z]; } };
  const poses = [];
  const gx = [-0.92, -0.5, 0, 0.5, 0.92], gz = [-0.9, 0, 0.9];
  for (const ax of gx) for (const az of gz) {
    const x = ax * hw, z = az * hd; if (!onDeck(x, z)) continue;
    poses.push({ name: `grid ${x.toFixed(1)},${z.toFixed(1)} + close`, a: [x, 0, z], b: [x * 0.8 + Math.sign(-x || 1) * 2.5, 0, z * 0.85] });
    poses.push({ name: `grid ${x.toFixed(1)},${z.toFixed(1)} + edge-mate`, a: [x, 0, z], b: [x, 0, z * 0.4] });
  }
  for (const [sx, sz] of [[1, 1], [1, -1]]) { const a = [-sx * hw * 0.9, 0, -sz * hd * 0.9], b = [sx * hw * 0.9, 0, sz * hd * 0.9]; if (onDeck(a[0], a[2]) && onDeck(b[0], b[2])) poses.push({ name: `far corners ${sx},${sz}`, a, b }); }
  poses.push({ name: 'far ends x', a: [-hw * 0.9, 0, 0], b: [hw * 0.9, 0, 0] });
  poses.push({ name: 'far ends z', a: [0, 0, -hd * 0.85], b: [0, 0, hd * 0.85] });
  for (let i = 0; i < 14; i++) { const [ax, az] = deckPt(), [bx, bz] = deckPt(); poses.push({ name: `random ${i}`, a: [ax, 0, az], b: [bx, 0, bz] }); }
  for (let i = 0; i < 5; i++) { const [ax, az] = deckPt(), [bx, bz] = deckPt(); poses.push({ name: `launched high ${i}`, a: [ax, 0, az], b: [bx, Math.min(9, G.arena.ceiling - 1.5), bz], bState: 'launched' }); }
  // Walled arenas (G.arena.enclosed) have no ring-outs: nobody can fall off them.
  if (!G.arena.enclosed) for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7]]) {
    const r = circle ? circle + 2 : 0;
    const bx = circle ? ex * r : ex * (hw + 2), bz = circle ? ez * r : ez * (hd + 2);
    poses.push({ name: `falling off ${ex},${ez}`, a: [bx * 0.6, 0, bz * 0.6], b: [bx, -6, bz], bState: 'launched', fallB: true });
  }
  for (let i = 0; i < 6; i++) { const [ax, az] = i < 4 ? [[-1, -1], [1, -1], [-1, 1], [1, 1]][i].map((k, j) => k * (j ? hd : hw) * 0.85) : deckPt(); const [bx, bz] = deckPt(); poses.push({ name: `intro shot ${i}`, a: [ax, 0, az], b: [bx, 0, bz], cine: 'intro' }); }
  for (let i = 0; i < 6; i++) { const [ax, az] = i < 4 ? [[-1, 1], [1, 1], [-1, -1], [1, -1]][i].map((k, j) => k * (j ? hd : hw) * 0.85) : deckPt(); poses.push({ name: `finisher cine ${i}`, a: [ax, 0, az], b: [ax + 1.6, 0, az * 0.95], cine: 'finisher' }); }
  // Drop poses that would put a standing fighter somewhere it can't be.
  for (let i = poses.length - 1; i >= 0; i--) {
    const P = poses[i];
    if (!onDeck(P.a[0], P.a[2]) || (!P.fallB && !onDeck(P.b[0], P.b[2]))) poses.splice(i, 1);
  }
  const fails = [], embedded = [], noView = [];
  const V = (a) => new T.Vector3(a[0], a[1], a[2]);
  let n = 0, done = false;
  for (const [pi, P] of poses.entries()) {
    if (opts.only && P.name !== opts.only) continue;
    if (opts.until && done) break;
    if (opts.until && P.name === opts.until) done = true;
    if (opts.every && pi % opts.every !== (opts.offset ?? 0)) continue;
    if (n++ >= limit) break;
    const [A, B] = fs;
    A.pos.copy(V(P.a)); B.pos.copy(V(P.b)); A.vel.set(0, 0, 0); B.vel.set(0, P.bState === 'launched' ? (P.fallB ? -8 : 4) : 0, 0);
    A.setState('ground'); B.setState(P.bState ?? 'ground');
    A.yaw = Math.atan2(B.pos.x - A.pos.x, B.pos.z - A.pos.z); B.yaw = A.yaw + Math.PI;
    cam.cinematic = null;
    if (P.cine === 'intro') cam.cinematic = { focus: () => A.center.add(new T.Vector3(0, 0.25, 0)), yaw: A.yaw - 0.5, dist: 1.5 + A.def.height * 0.6, h: 0.05, t: 0 };
    if (P.cine === 'finisher') m.startCinematic(A, B);
    cam.update(fs, 1 / 60, 0, true);
    for (let f = 0; f < (P.cine ? 50 : 100); f++) {
      cam.update(fs, 1 / 60, 0);
      if (opts.only || opts.until) continue;
      if (f % 25 !== 24) continue;
      const cp = cam.cam.position.clone();
      const tgt = cam.target.clone();
      const h0 = firstHit(cp, tgt);
      if (h0 && h0.back) { fails.push({ arena: arenaId, zoom, pose: P.name, frame: f, kind: 'inside', detail: `cam ${cp.toArray().map((v) => v.toFixed(1))}` }); break; }
      let graze = Infinity;
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const h = firstHit(cp, cp.clone().add(V(d).multiplyScalar(0.6))); if (h) graze = Math.min(graze, h.dist); }
      const fwd = new T.Vector3(); cam.cam.getWorldDirection(fwd);
      { const h = firstHit(cp, cp.clone().addScaledVector(fwd, 0.6)); if (h) graze = Math.min(graze, h.dist); }
      if (graze < 0.25) { fails.push({ arena: arenaId, zoom, pose: P.name, frame: f, kind: 'graze', detail: `${graze.toFixed(2)} m cam ${cp.toArray().map((v) => v.toFixed(1))}` }); break; }
      let bad = '';
      const want = [];
      for (const F of fs) {
        if (F.state === 'out' || F.pos.y < -1.5) continue; // fallen below the deck: framing the edge is fine
        if (P.cine && F !== A) continue; // a cinematic frames its subject
        const pts = [F.pos.clone().setY(F.pos.y + F.def.height * 0.9), F.pos.clone().setY(F.pos.y + F.def.height * 0.5)];
        // A point inside scenery (the first surface looking out from it is a back face) is a fighter clipping into
        // decoration: a map problem, not the camera's; it's counted in `embedded` instead.
        // Also a surface within 0.6 m of the point: the fighter is pressed into / standing inside scenery.
        const inside = (p) => { const h = firstHit(p, cp); return !!h && (h.back || h.dist < 0.6); };
        const live = pts.filter((p) => !inside(p));
        if (!live.length) { embedded.push(`${arenaId} ${P.name} ${F.def.id}@${F.pos.toArray().map((v) => v.toFixed(1))}`); continue; }
        want.push(live[0]);
        const vis = live.some((p) => { const h = firstHit(cp, p); return !h || h.dist > h.len - 0.35; });
        if (!vis) bad += `${F.def.id}@${F.pos.toArray().map((v) => v.toFixed(1))} `;
      }
      if (bad && !anyView(tgt, want)) { noView.push(`${arenaId}@${zoom} ${P.name} ${bad}`); break; }
      if (bad) { fails.push({ arena: arenaId, zoom, pose: P.name, frame: f, kind: 'hidden', detail: `${bad}cam ${cp.toArray().map((v) => v.toFixed(1))}` }); break; }
    }
  }
  cam.cinematic = null;
  return { poses: n, fails, embedded, noView };
}

// Real bouts: CPU vs CPU (hard) on one arena, the camera updated every tick like the frame loop, checked every
// 20 ticks with the same ground-truth tests (states, specials, Rage, grapples, finisher cinematics all occur).
// eslint-disable-next-line no-unused-vars
async function camBout(arenaId, zoom, pairs, ticks = 2400) {
  const G = window.__game, T = window.THREE;
  const fails = [], embedded = [], noView = [];
  let checks = 0;
  for (const [p1, p2] of pairs) {
    G.start(p1, p2, 'cpu', 'hard', arenaId);
    G.vcam.collider = G.arena.camCollider();
    G.setManual(true);
    G.match.restart(4242); // seeded: the same bout every run, failures can be replayed
    G.enableCPUs('hard');
    const m = G.match, cam = G.vcam;
    cam.userZoom = zoom;
    m.introT = 0;
    const dbl = new T.MeshBasicMaterial({ side: T.DoubleSide });
    const occ = [];
    const faded = new Set();
    for (const f of G.arena.fadeables) f.traverse((o) => faded.add(o));
    G.arena.static.updateMatrixWorld(true);
    G.arena.static.traverse((o) => {
      if (!o.isMesh || !o.visible || faded.has(o)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat || mat.transparent || mat.alphaTest > 0 || mat.depthWrite === false) return;
      const p = new T.Mesh(o.geometry, dbl); p.matrixAutoUpdate = false; p.matrixWorld.copy(o.matrixWorld); occ.push(p);
    });
    const rc = new T.Raycaster();
    const firstHit = (from, to) => { const d = to.clone().sub(from), len = d.length(); rc.set(from, d.normalize()); rc.near = 0; rc.far = len; const h = rc.intersectObjects(occ, false)[0]; return h ? { dist: h.distance, len, back: h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(rc.ray.direction) > 0 } : null; };
    for (let t = 0; t < ticks && !(m.ended && m.tick - m.ended.tick > 200); t++) {
      G.step(1);
      cam.update(m.fighters, 1 / 60, 0);
      if (t % 20 !== 19) continue;
      checks++;
      const cp = cam.cam.position.clone();
      const h0 = firstHit(cp, cam.target.clone());
      let why = '';
      if (h0 && h0.back) why = 'inside';
      else {
        for (const F of m.fighters) {
          if (F.state === 'out' || F.pos.y < -1.5) continue;
          if (cam.cinematic) continue;
          const pts = [F.pos.clone().setY(F.pos.y + F.def.height * 0.9), F.pos.clone().setY(F.pos.y + F.def.height * 0.5)];
          const live = pts.filter((p) => { const h = firstHit(p, cp); return !(h && (h.back || h.dist < 0.6)); });
          if (!live.length) { embedded.push(`${arenaId} ${p1}v${p2} t${m.tick} ${F.def.id}@${F.pos.toArray().map((v) => v.toFixed(1))}`); continue; }
          if (!live.some((p) => { const h = firstHit(cp, p); return !h || h.dist > h.len - 0.35; })) why = `hidden ${F.def.id} ${F.state}@${F.pos.toArray().map((v) => v.toFixed(1))}`;
        }
      }
      if (why.startsWith('hidden')) {
        // Only a camera failure if some position would have seen everyone.
        const want = m.fighters.filter((F) => F.state !== 'out' && F.pos.y > -1.5).map((F) => F.pos.clone().setY(F.pos.y + F.def.height * 0.9));
        let any = false;
        const tg = cam.target.clone();
        for (const r of [6, 10, 14, 19]) { for (let a = 0; a < 16 && !any; a++) for (const y of [2, 5, 8, 12]) { const c = new T.Vector3(tg.x + Math.sin(a * Math.PI / 8) * r, y, tg.z + Math.cos(a * Math.PI / 8) * r); if (firstHit(c, tg)) continue; if (want.every((p) => { const h = firstHit(c, p); return !h || h.dist > h.len - 0.35; })) { any = true; break; } } if (any) break; }
        if (!any) { noView.push(`${arenaId} ${p1}v${p2} t${m.tick} ${why}`); continue; }
      }
      if (why) fails.push({ arena: arenaId, zoom, pose: `${p1}v${p2} t${m.tick}`, kind: why.split(' ')[0], detail: `${why} cam ${cp.toArray().map((v) => v.toFixed(1))}${cam.cinematic ? ' (cine)' : ''}` });
    }
  }
  G.disableCPU();
  return { checks, fails, embedded, noView };
}
