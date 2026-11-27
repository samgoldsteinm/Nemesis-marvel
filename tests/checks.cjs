// Deterministic gameplay checks. Steps the simulation manually in a real browser page and drives
// fighters with scripted inputs. Usage: start `npm run dev`, then `node tests/checks.cjs [url]`.
// Requires Playwright with a Chromium build available to require('playwright').
const { chromium } = require('playwright');

const URL = process.argv[2] || 'http://localhost:5173/';

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { timeout: 240000 });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 240000 });

  // In-page helpers.
  await page.evaluate(() => {
    const G = window.__game;
    const raw = (o = {}) => {
      const r = G.emptyRaw();
      r.mx = o.mx || 0; r.my = o.my || 0;
      for (const k of o.down || []) r.down[k] = true;
      return r;
    };
    window.T = {
      G,
      setup(a, b, arena = 'rooftop') {
        G.start(a, b, 'versus', 'normal', arena);
        G.setManual(true);
        G.disableCPU();
        G.forced[0] = raw(); G.forced[1] = raw();
        G.step(95);
        const m = G.match;
        return m;
      },
      hold(i, down, n = 1, stick) { G.forced[i] = raw({ down, mx: stick?.[0], my: stick?.[1] }); G.step(n); G.forced[i] = raw(); },
      idle(n) { G.forced[0] = raw(); G.forced[1] = raw(); G.step(n); },
      place(f, x, z, yaw) { f.pos.set(x, 0, z); f.vel.set(0, 0, 0); f.yaw = yaw; f.setState('ground'); f.onGround = true; },
      faceEachOther(m, gap) {
        const [a, b] = m.fighters;
        T.place(a, -gap / 2, 0, Math.PI / 2);
        T.place(b, gap / 2, 0, -Math.PI / 2);
      },
    };
  });

  const results = [];
  async function check(name, fn) {
    try {
      const r = await page.evaluate(fn);
      results.push({ name, pass: !!r.pass, info: r.info });
    } catch (e) {
      results.push({ name, pass: false, info: 'EXCEPTION ' + e.message });
    }
  }

  await check('Normal K.O. by depleting health', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 2.4);
    b.health = 3; b.stamina = 3;
    T.hold(0, ['power', 'attack'], 1);
    T.idle(60);
    return { pass: m.ended && m.ended.how === 'ko' && m.ended.winner === a, info: JSON.stringify(m.ended && { how: m.ended.how, w: m.ended.winner.def.id }) };
  });

  await check('Stamina-driven Danger with health remaining', () => {
    const m = T.setup('tether', 'basalt');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.8);
    b.stamina = 11;
    T.hold(0, ['attack'], 1);
    T.idle(20);
    return { pass: b.danger && b.health > 90, info: `stamina ${b.stamina.toFixed(1)} health ${b.health.toFixed(1)} danger ${b.danger}` };
  });

  await check('Recovery out of Danger before a finisher (stamina regenerates)', () => {
    const m = T.setup('tether', 'basalt');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.8);
    b.stamina = 10; b.lastHit = 0;
    const before = b.danger;
    T.idle(10);
    const mid = b.danger;
    T.idle(150);
    a.energy = 100;
    T.faceEachOther(m, 1.8);
    T.hold(0, ['power', 'grab'], 1);
    T.idle(140);
    return { pass: mid && !b.danger && !(m.ended && m.ended.how === 'finisher'), info: `danger mid=${mid} after=${b.danger} stamina=${b.stamina.toFixed(1)} ended=${m.ended?.how}` };
  });

  await check('Valid finisher: Danger + >= 1/4 energy + connected super grapple', () => {
    const m = T.setup('basalt', 'shunt');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.9);
    b.health = 20; b.stamina = 20; a.energy = 30;
    T.hold(0, ['power', 'grab'], 1);
    const started = a.state;
    T.idle(130);
    return { pass: started === 'finisher' && m.ended?.how === 'finisher' && m.ended.winner === a && a.energy < 15, info: `start=${started} end=${m.ended?.how} energy=${a.energy.toFixed(1)}` };
  });

  await check('Failed finisher with too little energy becomes an ordinary grab', () => {
    const m = T.setup('basalt', 'shunt');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.9);
    b.health = 20; b.stamina = 20; a.energy = 10;
    T.hold(0, ['power', 'grab'], 1);
    const st = a.state, note = a.notice, vs = b.state;
    T.idle(80);
    return { pass: st === 'grabbing' && vs === 'grabbed' && /POWER/.test(note) && !(m.ended?.how === 'finisher'), info: `att=${st} vic=${vs} note=${note} ended=${m.ended?.how} health=${b.health.toFixed(0)}` };
  });

  await check('Finisher also valid during Rage regardless of meter', () => {
    const m = T.setup('tether', 'aerin');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.6);
    a.rage = 100;
    T.hold(0, ['power'], 3); // neutral tap
    T.idle(1);
    const raging = a.raging;
    b.stamina = 5;
    T.hold(0, ['power', 'grab'], 1);
    T.idle(130);
    return { pass: raging && m.ended?.how === 'finisher', info: `raging=${raging} end=${m.ended?.how}` };
  });

  await check('Successful aerial save: TETHER swings back from a launch off an open edge', () => {
    const m = T.setup('tether', 'basalt');
    const [a, b] = m.fighters;
    const wall = m.arena.walls.find((w) => w.outward.z === 1 && Math.abs(w.center.x) < 0.1);
    wall.damage(999, m.fx);
    T.place(a, 0, 10.5, 0);
    T.place(b, 0, 7.5, 0);
    a.energy = 60;
    a.receiveHit(b, { fwd: 0, up: 0, radius: 0, stamina: 5, health: 5, kbF: 15, kbU: 7, stun: 30, launch: true }, new window.THREE.Vector3(0, 0, 1), { unblockable: true });
    T.idle(16);
    const offRoof = a.pos.z > 13;
    T.hold(0, ['mobility', 'power'], 2);
    let landed = false;
    for (let i = 0; i < 400 && !landed; i++) { T.idle(1); if (a.onGround && m.arena.inside(a.pos.x, a.pos.z)) landed = true; }
    return { pass: offRoof && landed && a.state !== 'out' && !m.ended, info: `offRoofAtRecovery=${offRoof} landed=${landed} state=${a.state} pos=${a.pos.toArray().map((v) => v.toFixed(1))}` };
  });

  await check('Same trajectory is a RING OUT for BASALT (ground recovery cannot return)', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    const wall = m.arena.walls.find((w) => w.outward.z === 1 && Math.abs(w.center.x) < 0.1);
    wall.damage(999, m.fx);
    T.place(a, 0, 10.5, 0);
    T.place(b, 0, 7.5, 0);
    a.energy = 60;
    a.receiveHit(b, { fwd: 0, up: 0, radius: 0, stamina: 5, health: 5, kbF: 15 * a.def.weight, kbU: 7, stun: 30, launch: true }, new window.THREE.Vector3(0, 0, 1), { unblockable: true });
    T.idle(16);
    T.hold(0, ['mobility', 'power'], 2);
    T.idle(300);
    return { pass: a.state === 'out' && m.ended?.how === 'ringout' && m.ended.winner === b && a.stats.recoveries === 1, info: `state=${a.state} end=${m.ended?.how} recoveries=${a.stats.recoveries}` };
  });

  await check('Ring-out also works for SHUNT with no energy left (teleport needs power)', () => {
    const m = T.setup('shunt', 'basalt');
    const [a, b] = m.fighters;
    m.arena.walls.find((w) => w.outward.x === 1 && Math.abs(w.center.z) < 1).damage(999, m.fx);
    T.place(a, 16, 0, Math.PI / 2);
    a.energy = 5;
    a.receiveHit(b, { fwd: 0, up: 0, radius: 0, stamina: 5, health: 5, kbF: 15, kbU: 7, stun: 30, launch: true }, new window.THREE.Vector3(1, 0, 0), { unblockable: true });
    T.idle(12);
    T.hold(0, ['mobility', 'power'], 2);
    const note = a.notice;
    T.idle(300);
    return { pass: m.ended?.how === 'ringout' && /POWER/.test(note), info: `end=${m.ended?.how} note=${note}` };
  });

  await check('Clean rematch restores arena, props and fighters', () => {
    const m = T.G.match;
    const brokeBefore = m.arena.walls.filter((w) => w.broken).length;
    T.G.rematch();
    T.G.setManual(true);
    const m2 = T.G.match;
    const broken = m2.arena.walls.filter((w) => w.broken).length;
    const rest = m2.arena.props.filter((p) => p.state === 'rest').length;
    const letters = m2.arena.letters.filter((l) => !l.down).length;
    const f = m2.fighters;
    return { pass: brokeBefore > 0 && broken === 0 && rest === m2.arena.props.length && rest >= 9 && letters === 7 && !m2.ended && f.every((x) => x.health === 100 && x.state === 'ground' && !x.heldProp && x.rig.root.visible), info: `brokeBefore=${brokeBefore} broken=${broken} props=${m2.arena.props.length}/${rest} letters=${letters}` };
  });

  await check('BASALT lifts the fuel tank; TETHER cannot', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    const tank = m.arena.props.find((p) => p.kind === 'tank');
    T.place(a, tank.pos.x + 1.6, tank.pos.z, -Math.PI / 2);
    T.place(b, 10, -8, 0);
    T.hold(0, ['grab'], 1);
    T.idle(30);
    const basaltHas = a.heldProp?.kind;
    const m2 = T.setup('tether', 'basalt');
    const [c, d] = m2.fighters;
    const tank2 = m2.arena.props.find((p) => p.kind === 'tank');
    T.place(c, tank2.pos.x + 1.3, tank2.pos.z, -Math.PI / 2);
    T.place(d, 10, -8, 0);
    T.hold(0, ['grab'], 1);
    T.idle(30);
    return { pass: basaltHas === 'tank' && c.heldProp?.kind !== 'tank' && tank2.state === 'rest', info: `basalt=${basaltHas} tether=${c.heldProp?.kind ?? 'none'}` };
  });

  await check('Heavy throw: planted windup and the thrown tank explodes on impact', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    const tank = m.arena.props.find((p) => p.kind === 'tank');
    T.place(a, tank.pos.x + 1.6, tank.pos.z, -Math.PI / 2);
    T.hold(0, ['grab'], 1);
    T.idle(30);
    T.place(b, a.pos.x + 7, a.pos.z, -Math.PI / 2);
    a.yaw = Math.PI / 2;
    T.hold(0, ['grab'], 1);
    const windState = a.state;
    T.idle(10);
    const stillHolding = !!a.heldProp; // still in windup
    T.idle(60);
    return { pass: windState === 'throw' && stillHolding && tank.state === 'gone' && m.events.some((e) => e.includes('explosion')) && b.health < 100, info: `wind=${windState} holdingAt10=${stillHolding} tank=${tank.state} tetherHP=${b.health.toFixed(0)}` };
  });

  await check('Catch: timed guard catches an eligible thrown prop', () => {
    const m = T.setup('tether', 'aerin');
    const [a, b] = m.fighters;
    const crate = m.arena.props.find((p) => p.kind === 'crate' && Math.abs(p.pos.x - 3.5) < 0.1);
    T.place(b, crate.pos.x - 1.2, crate.pos.z, Math.PI / 2);
    T.hold(1, ['grab'], 1);
    T.idle(10);
    T.place(a, b.pos.x + 9, b.pos.z, -Math.PI / 2);
    b.yaw = Math.PI / 2;
    T.hold(1, ['grab'], 1);
    let caught = false;
    for (let i = 0; i < 60; i++) {
      const d = crate.pos.distanceTo(a.pos);
      if (crate.state === 'thrown' && d < 4.5 && a.state !== 'guard') T.hold(0, ['guard'], 1);
      else { T.G.forced[0] = T.G.emptyRaw(); if (a.state === 'guard') { const r = T.G.emptyRaw(); r.down.guard = true; T.G.forced[0] = r; } T.G.step(1); }
      if (a.heldProp === crate) { caught = true; break; }
    }
    return { pass: caught && a.stats.catches === 1, info: `caught=${caught} crate=${crate.state}` };
  });

  await check('Chord R+A on the same tick resolves once (single energy spend, single projectile)', () => {
    const m = T.setup('tether', 'basalt');
    const [a] = m.fighters;
    T.faceEachOther(m, 8);
    a.energy = 50;
    T.hold(0, ['power', 'attack'], 1);
    const e1 = a.energy;
    T.idle(12);
    const proj = m.projectiles.length;
    T.idle(20);
    return { pass: Math.abs(e1 - 30) < 0.5 && proj === 1, info: `energyAfter=${e1.toFixed(2)} projectiles=${proj}` };
  });

  await check('X beside a prop: facing the opponent grapples them; facing the prop lifts it', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    const ac = m.arena.props.find((p) => p.kind === 'ac');
    T.place(a, ac.pos.x, ac.pos.z + 1.6, Math.PI / 2);
    T.place(b, a.pos.x + 1.7, a.pos.z, -Math.PI / 2);
    const t1 = a.grabTarget();
    T.hold(0, ['grab'], 1);
    const first = a.state;
    T.idle(60);
    const m2 = T.setup('basalt', 'tether');
    const [c, d] = m2.fighters;
    const ac2 = m2.arena.props.find((p) => p.kind === 'ac');
    T.place(c, ac2.pos.x, ac2.pos.z + 1.6, Math.PI);
    T.place(d, c.pos.x + 1.7, c.pos.z, -Math.PI / 2);
    const t2 = c.grabTarget();
    T.hold(0, ['grab'], 1);
    T.idle(20);
    return { pass: t1?.kind === 'fighter' && first === 'grabbing' && t2?.kind === 'prop' && c.heldProp === ac2, info: `facingOpp=${t1?.kind}/${first} facingProp=${t2?.kind}/${c.heldProp?.kind}` };
  });

  await check('Grabbed fighter / held prop return to valid state after KO, pause and rematch', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 1.9);
    T.hold(0, ['grab'], 1);
    const grabbing = a.state === 'grabbing';
    T.G.rematch();
    T.G.setManual(true);
    const m2 = T.G.match;
    return { pass: grabbing && m2.fighters.every((f) => f.state === 'ground' && !f.grabbed && !f.grabbedBy && !f.heldProp), info: `grabbing=${grabbing} after=${m2.fighters.map((f) => f.state)}` };
  });

  await check('Thrown prop breaks a fence segment and opens a ring-out path', () => {
    const m = T.setup('basalt', 'tether');
    const [a, b] = m.fighters;
    const ac = m.arena.props.find((p) => p.kind === 'ac' && p.pos.z > 0);
    T.place(a, ac.pos.x - 1.7, ac.pos.z, Math.PI / 2);
    T.place(b, -10, -6, 0);
    T.hold(0, ['grab'], 1);
    T.idle(25);
    a.yaw = 0; // face +z (south fence)
    T.hold(0, ['power', 'grab'], 1); // super throw
    T.idle(60);
    const broken = m.arena.walls.filter((w) => w.broken).length;
    return { pass: broken >= 1, info: `broken=${broken} energy=${a.energy.toFixed(0)}` };
  });

  await check('Super block deflects a projectile back at the shooter', () => {
    const m = T.setup('aerin', 'tether');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 9);
    a.energy = 50; b.energy = 50;
    const r = T.G.emptyRaw(); r.down.power = true; r.down.guard = true;
    T.G.forced[1] = r;
    T.G.step(2);
    T.G.forced[0] = (() => { const q = T.G.emptyRaw(); q.down.power = true; q.down.attack = true; return q; })();
    T.G.step(1);
    T.G.forced[0] = T.G.emptyRaw();
    T.G.step(40);
    T.G.forced[1] = T.G.emptyRaw();
    return { pass: m.events.some((e) => e.includes('deflects bolt')) && b.health === 100, info: m.events.slice(-4).join(' | ') + ` tetherHP=${b.health}` };
  });

  await check('Rage: neutral R tap activates unlimited energy, then ordinary costs return', () => {
    const m = T.setup('aerin', 'basalt');
    const [a] = m.fighters;
    T.faceEachOther(m, 8);
    a.rage = 100; a.energy = 10;
    T.hold(0, ['power'], 4);
    T.idle(1);
    const on = a.raging;
    T.hold(0, ['power', 'attack'], 1);
    T.idle(20);
    const eDuring = a.energy;
    T.idle(60 * 8 + 10);
    const off = !a.raging;
    a.energy = 50;
    T.hold(0, ['power', 'attack'], 1);
    return { pass: on && eDuring === 100 && off && Math.abs(a.energy - 38) < 0.6, info: `on=${on} eDuring=${eDuring} off=${off} after=${a.energy.toFixed(1)}` };
  });

  await check('Overpass: BASALT lifts a car and the thrown car explodes on impact', () => {
    const m = T.setup('basalt', 'tether', 'overpass');
    const [a, b] = m.fighters;
    const car = m.arena.props.find((p) => p.kind === 'car');
    T.place(a, car.pos.x + 2.2, car.pos.z, -Math.PI / 2);
    T.place(b, car.pos.x + 9, car.pos.z, -Math.PI / 2);
    T.hold(0, ['grab'], 1);
    T.idle(30);
    const held = a.heldProp?.kind;
    a.yaw = Math.PI / 2;
    T.hold(0, ['grab'], 1);
    T.idle(70);
    return { pass: held === 'car' && car.state === 'gone' && m.events.some((e) => e.includes('explosion')), info: `held=${held} car=${car.state} tetherHP=${b.health.toFixed(0)} events=${m.events.slice(-2).join('|')}` };
  });

  await check('Overpass: CPU vs CPU bouts resolve on the narrow deck', () => {
    const outcomes = [];
    for (const [p, q] of [['basalt', 'aerin'], ['tether', 'shunt']]) {
      const m = T.setup(p, q, 'overpass');
      T.G.forced[0] = null; T.G.forced[1] = null;
      T.G.enableCPUs('hard');
      let n = 0;
      while (!m.ended && n < 60 * 150) { T.G.step(30); n += 30; }
      outcomes.push(m.ended ? `${p}v${q}:${m.ended.how}:${m.ended.winner.def.id}@${(n / 60).toFixed(0)}s broken=${m.arena.walls.filter((w) => w.broken).length}` : `${p}v${q}:timeout`);
      T.G.disableCPU();
    }
    return { pass: outcomes.every((o) => !o.includes('timeout')), info: outcomes.join(' ; ') };
  });

  await check('Move set: tap R+A = power, hold R+A = charged power, running R+A = dash power', () => {
    const ids = [];
    let m = T.setup('basalt', 'tether');
    let [a] = m.fighters;
    T.place(a, 0, 0, 0); a.energy = 100;
    T.hold(0, ['power', 'attack'], 1); T.idle(2); ids.push(a.move?.id);
    m = T.setup('basalt', 'tether'); [a] = m.fighters;
    T.place(a, 0, 0, 0); a.energy = 100;
    T.hold(0, ['power', 'attack'], 26); T.idle(1); ids.push(a.move?.id); const eCharged = a.energy;
    m = T.setup('basalt', 'tether'); [a] = m.fighters;
    T.place(a, -8, 0, Math.PI / 2); a.energy = 100;
    const camR = T.G.match.camBasis.right;
    T.hold(0, [], 30, [camR.x > 0 ? 1 : -1, 0]);
    T.hold(0, ['power', 'attack'], 1, [camR.x > 0 ? 1 : -1, 0]); ids.push(a.move?.id);
    return { pass: ids[0] === 'thunderclap' && ids[1] === 'tectonic' && ids[2] === 'avalanche' && eCharged < 60, info: `${ids.join(', ')} energyAfterCharge=${eCharged.toFixed(0)}` };
  });

  await check('Move set: running A = running attack; grab A pummels then X throws', () => {
    const m = T.setup('tether', 'basalt');
    const [a, b] = m.fighters;
    T.place(a, -8, 0, Math.PI / 2);
    const camR = T.G.match.camBasis.right;
    T.hold(0, [], 30, [camR.x > 0 ? 1 : -1, 0]);
    T.hold(0, ['attack'], 1, [camR.x > 0 ? 1 : -1, 0]);
    const run = a.move?.id;
    T.idle(40);
    T.faceEachOther(m, 1.6);
    T.hold(0, ['grab'], 1); T.idle(8);
    const st0 = b.stamina;
    for (let i = 0; i < 3; i++) { T.hold(0, ['attack'], 1); T.idle(9); }
    const pummels = a.pummels, st1 = b.stamina, stillHeld = b.state === 'grabbed';
    T.hold(0, ['grab'], 1); T.idle(5);
    return { pass: run === 'slideKick' && pummels === 3 && st1 < st0 && stillHeld && b.state === 'launched', info: `run=${run} pummels=${pummels} stamina ${st0.toFixed(0)}->${st1.toFixed(0)} held=${stillHeld} after=${b.state}` };
  });

  await check('Power grapples: each fighter has its own R+X throw', () => {
    const out = [];
    for (const id of ['basalt', 'tether', 'aerin', 'shunt', 'vanta', 'magna', 'ember', 'rift']) {
      const m = T.setup(id, 'basalt');
      const [a, b] = m.fighters;
      T.faceEachOther(m, a.def.radius + b.def.radius + 0.6);
      a.energy = 100;
      const p0 = b.pos.clone();
      T.hold(0, ['power', 'grab'], 1);
      let seen = false;
      for (let i = 0; i < 80; i++) { T.idle(1); if (a.state === 'pgrapple') seen = true; }
      out.push(`${id}:${a.def.powerGrapple}:${seen ? 'ok' : 'NO'}:hp${b.health.toFixed(0)}:moved${b.pos.distanceTo(p0).toFixed(1)}`);
    }
    return { pass: out.every((o) => o.includes(':ok:') && !o.includes('hp100')), info: out.join(' ; ') };
  });

  await check('Signature specials: swap, portal punch, rift storm, shade rend, implosion, fireball', () => {
    const run = (id, key, dist, ticks) => {
      const m = T.setup(id, 'basalt');
      const [a, b] = m.fighters;
      T.faceEachOther(m, dist);
      a.energy = 100;
      const pa = a.pos.clone(), pb = b.pos.clone(), hp = b.health;
      a.startMove(a.def.moves[key]);
      let minD = 99;
      for (let i = 0; i < ticks; i++) { T.idle(1); minD = Math.min(minD, a.pos.distanceTo(b.pos)); }
      return { a, b, pa, pb, dmg: hp - b.health, minD };
    };
    const sw = run('rift', 'power', 8, 30);
    const swapped = sw.a.pos.distanceTo(sw.pb) < 1.5 && sw.b.pos.distanceTo(sw.pa) < 2.5;
    const pp = run('rift', 'dashPower', 9, 30);
    const rs = run('rift', 'chargePower', 8, 70);
    const sr = run('vanta', 'chargePower', 4, 60);
    const im = run('magna', 'chargePower', 6, 50);
    const fb = run('ember', 'power', 8, 60);
    const info = `swap=${swapped} punch=${pp.dmg.toFixed(0)} storm=${rs.dmg.toFixed(0)} rend=${sr.dmg.toFixed(0)} implode=${im.dmg.toFixed(0)} minD=${im.minD.toFixed(1)} fireball=${fb.dmg.toFixed(0)} burn=${fb.b.burnT}`;
    return { pass: swapped && pp.dmg > 0 && rs.dmg > 0 && sr.dmg > 0 && im.dmg > 0 && im.minD < 4 && fb.dmg > 0, info };
  });

  await check('Lives: losing a life starts the next round; the last life ends the match', () => {
    const m = T.setup('basalt', 'tether');
    m.setLives(2);
    const [a, b] = m.fighters;
    b.applyDamage(500, 500); m.declare(a, b, 'ko');
    T.idle(170);
    const afterFirst = { ended: !!m.ended, lives: m.lives.join('/'), round: m.round, bHp: Math.round(b.health), result: m.resultReady };
    T.idle(100);
    b.applyDamage(500, 500); m.declare(a, b, 'ko');
    T.idle(170);
    const afterSecond = { ended: !!m.ended, result: m.resultReady, lives: m.lives.join('/') };
    const pass = !afterFirst.ended && afterFirst.lives === '2/1' && afterFirst.round === 2 && afterFirst.bHp === 100 && !afterFirst.result && afterSecond.ended && afterSecond.result;
    return { pass, info: JSON.stringify({ afterFirst, afterSecond }) };
  });

  await check('Rage: a slow controller-style R tap (20 ticks, slips into charging) still activates Rage', () => {
    const m = T.setup('tether', 'basalt');
    const [a] = m.fighters;
    a.rage = 100;
    T.hold(0, ['power'], 20); T.idle(2);
    const ok1 = a.raging;
    const m2 = T.setup('vanta', 'basalt');
    const v = m2.fighters[0];
    v.rage = 100;
    T.hold(0, ['attack'], 1); T.idle(8); T.hold(0, ['power'], 6); T.idle(2);
    return { pass: ok1 && v.raging, info: `slowTap=${ok1} midAttack=${v.raging}` };
  });

  await check('Grab: clinch holds the victim on the ground; A knees', () => {
    const m = T.setup('ember', 'tether');
    const [a, b] = m.fighters;
    T.faceEachOther(m, a.def.radius + b.def.radius + 0.4);
    T.hold(0, ['grab'], 1); T.idle(10);
    const held = b.state === 'grabbed', dy = +(b.pos.y - a.pos.y).toFixed(2);
    const st0 = b.stamina; T.hold(0, ['attack'], 1); T.idle(10);
    return { pass: held && Math.abs(dy) < 0.05 && b.stamina < st0, info: `held=${held} dy=${dy} stamina ${st0.toFixed(0)}->${b.stamina.toFixed(0)}` };
  });

  await check('New arenas load with valid spawns, props and breakable edges', () => {
    const out = [];
    for (const ar of ['construction', 'docks', 'helipad']) {
      const m = T.setup('basalt', 'tether', ar);
      const A = T.G.arena;
      const spawnsOk = m.fighters.every((f) => A.inside(f.pos.x, f.pos.z) && f.onGround && Math.abs(f.pos.y) < 0.05);
      const propsInside = A.props.filter((p) => A.inside(p.pos.x, p.pos.z)).length;
      out.push(`${ar}:spawns=${spawnsOk} props=${propsInside}/${A.props.length} walls=${A.walls.length} anchors=${A.anchors.length}`);
      if (!spawnsOk || propsInside < 5 || A.walls.length < 3 || A.anchors.length < 3) return { pass: false, info: out.join(' ; ') };
    }
    return { pass: true, info: out.join(' ; ') };
  });

  await check('New arenas: a heavy launch through a broken/open edge is a ring-out', () => {
    const out = [];
    for (const ar of ['construction', 'docks', 'helipad']) {
      const m = T.setup('basalt', 'tether', ar);
      const A = T.G.arena;
      const [a, b] = m.fighters;
      // Break the nearest edge segment in +z (helipad: launch toward the open south edge).
      for (const w of A.walls) if (w.outward.z > 0.5) w.damage(999, T.G.fx);
      T.place(a, 0, 0, 0); T.place(b, 0, 1.6, Math.PI);
      b.receiveHit(a, { fwd: 0, up: 0, radius: 0, stamina: 1, health: 1, kbF: 30, kbU: 6, stun: 40, launch: true, heavy: true }, new (b.pos.constructor)(0, 0, 1), { unblockable: true, source: 'throw' });
      let n = 0; while (!m.ended && n < 400) { T.idle(5); n += 5; }
      out.push(`${ar}:${m.ended ? m.ended.how : 'none'}@${n}`);
    }
    return { pass: out.every((o) => o.includes(':ringout@')), info: out.join(' ; ') };
  });

  await check('New arenas: CPU vs CPU bouts resolve', () => {
    const outcomes = [];
    for (const [p, q, ar] of [['vanta', 'basalt', 'construction'], ['rift', 'magna', 'docks'], ['tether', 'ember', 'helipad']]) {
      const m = T.setup(p, q, ar);
      T.G.forced[0] = null; T.G.forced[1] = null;
      T.G.enableCPUs('hard');
      let n = 0;
      while (!m.ended && n < 60 * 150) { T.G.step(30); n += 30; }
      outcomes.push(m.ended ? `${p}v${q}@${ar}:${m.ended.how}:${m.ended.winner.def.id}@${(n / 60).toFixed(0)}s` : `${p}v${q}@${ar}:timeout`);
      T.G.disableCPU();
    }
    return { pass: outcomes.every((o) => !o.includes('timeout')), info: outcomes.join(' ; ') };
  });

  await check('Determinism: same seed + inputs give identical state on every arena, independent of animation rate', async () => {
    const np = await import('/src/netplay.ts');
    const G = T.G;
    const run = (p1, p2, arena, seed, chunk) => {
      G.start(p1, p2, 'versus', 'normal', arena); G.setManual(true);
      G.match.restart(seed);
      G.forced[0] = null; G.forced[1] = null;
      G.enableCPUs('hard');
      const hs = [];
      for (let t = 0; t < 1200; t += chunk) { G.step(chunk); if ((t + chunk) % 60 === 0) hs.push(np.checksum(G.match)); }
      G.disableCPU();
      return hs;
    };
    const out = [];
    let ok = true;
    for (const [p1, p2, arena] of [['basalt', 'tether', 'rooftop'], ['ember', 'rift', 'overpass'], ['magna', 'vanta', 'construction'], ['aerin', 'shunt', 'docks'], ['rift', 'ember', 'helipad']]) {
      const a = run(p1, p2, arena, 4242, 1), b = run(p1, p2, arena, 4242, 6);
      const d = a.findIndex((h, i) => h !== b[i]);
      if (d >= 0) ok = false;
      out.push(`${arena}:${d < 0 ? 'same' : 'DIFF@' + (d + 1) * 60}`);
    }
    return { pass: ok, info: out.join(' ') };
  });

  await check('SHUNT Displace drops the victim off an open edge for a ring-out', () => {
    const m = T.setup('shunt', 'basalt');
    const [a, b] = m.fighters;
    m.arena.walls.filter((w) => w.outward.z === 1 && Math.abs(w.center.x) < 3).forEach((w) => w.damage(999, m.fx));
    T.place(a, 0, 9, 0);
    T.place(b, 0, 10.2, Math.PI);
    a.energy = 100; b.energy = 0;
    T.hold(0, ['power', 'grab'], 1);
    T.idle(320);
    return { pass: m.ended?.how === 'ringout' && m.ended.winner === a, info: `end=${m.ended?.how} basaltState=${b.state}` };
  });

  await check('Light prop swings as a weapon and breaks after three swings', () => {
    const m = T.setup('tether', 'basalt');
    const [a, b] = m.fighters;
    const crate = m.arena.props.find((p) => p.kind === 'crate' && Math.abs(p.pos.x - 3.5) < 0.1);
    T.place(a, crate.pos.x - 1.2, crate.pos.z, Math.PI / 2);
    T.place(b, -12, -8, 0);
    T.hold(0, ['grab'], 1); T.idle(10);
    const held = a.heldProp === crate;
    for (let i = 0; i < 3; i++) { T.hold(0, ['attack'], 1); T.idle(30); }
    return { pass: held && crate.state === 'gone' && !a.heldProp, info: `held=${held} crate=${crate.state} uses=${crate.uses}` };
  });

  await check('MAGNA pulls a car to his hands from range', () => {
    const m = T.setup('magna', 'tether', 'overpass');
    const [a, b] = m.fighters;
    const car = m.arena.props.find((p) => p.kind === 'car');
    T.place(a, car.pos.x + 8, car.pos.z, -Math.PI / 2);
    T.place(b, 15, 4, 0);
    const tgt = a.grabTarget();
    T.hold(0, ['grab'], 1);
    T.idle(40);
    return { pass: tgt?.kind === 'line-prop' && a.heldProp === car, info: `target=${tgt?.kind} held=${a.heldProp?.kind}` };
  });

  await check('EMBER heavy hits set the target burning (damage over time)', () => {
    const m = T.setup('ember', 'tether');
    const [a, b] = m.fighters;
    T.faceEachOther(m, 2.6);
    a.energy = 100;
    T.hold(0, ['power', 'attack'], 1);
    T.idle(30);
    const burning = b.burnT > 0, st0 = b.stamina;
    T.idle(60);
    return { pass: burning && b.stamina < st0, info: `burning=${burning} stamina ${st0.toFixed(1)} -> ${b.stamina.toFixed(1)}` };
  });

  await check('New fighters: CPU bouts resolve (VANTA, MAGNA, EMBER)', () => {
    const outcomes = [];
    for (const [p, q, ar] of [['vanta', 'basalt', 'rooftop'], ['magna', 'ember', 'overpass'], ['ember', 'vanta', 'rooftop'], ['rift', 'shunt', 'rooftop']]) {
      const m = T.setup(p, q, ar);
      T.G.forced[0] = null; T.G.forced[1] = null;
      T.G.enableCPUs('hard');
      let n = 0;
      while (!m.ended && n < 60 * 150) { T.G.step(30); n += 30; }
      outcomes.push(m.ended ? `${p}v${q}:${m.ended.how}:${m.ended.winner.def.id}@${(n / 60).toFixed(0)}s` : `${p}v${q}:timeout`);
      T.G.disableCPU();
    }
    return { pass: outcomes.every((o) => !o.includes('timeout')), info: outcomes.join(' ; ') };
  });

  await check('CPU vs CPU: 4 full bouts run to a single resolved winner without errors', () => {
    const outcomes = [];
    const pairs = [['basalt', 'tether'], ['tether', 'basalt'], ['aerin', 'shunt'], ['shunt', 'basalt']];
    for (const [p, q] of pairs) {
      const m = T.setup(p, q);
      T.G.forced[0] = null; T.G.forced[1] = null;
      T.G.enableCPUs(p === 'aerin' || p === 'shunt' ? 'normal' : 'hard');
      let n = 0;
      while (!m.ended && n < 60 * 150) { T.G.step(30); n += 30; }
      outcomes.push(m.ended ? `${p}v${q}:${m.ended.how}:${m.ended.winner.def.id}@${(n / 60).toFixed(0)}s hits ${m.fighters.map((f) => f.stats.hits).join('/')}` : `${p}v${q}:timeout hits ${m.fighters.map((f) => f.stats.hits).join('/')} hp ${m.fighters.map((f) => f.health.toFixed(0)).join('/')}`);
      T.G.disableCPU();
    }
    return { pass: outcomes.filter((o) => !o.includes('timeout')).length >= 3, info: outcomes.join(' ; ') };
  });

  console.log('');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.info}`);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  await browser.close();
  process.exit(results.every((r) => r.pass) && !errors.length ? 0 : 1);
})();
