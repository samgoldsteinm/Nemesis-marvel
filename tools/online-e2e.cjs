// Two-page online start test: host + guest over ?net=local, optional lag/loss/CPU throttle; measures start timeline.
// usage (dev server running; --port defaults to 5193): node tools/online-e2e.cjs [--lag ms] [--loss p] [--throttle n (guest)] [--skip A|B|none] [--fight s] [--norender 1] [--rtc 1] [--rematch 1] [--port n] [--shot prefix]
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const lag = +arg('lag', 0), loss = +arg('loss', 0), thr = +arg('throttle', 0), skip = arg('skip', 'none'), fightS = +arg('fight', 6);
const port = arg('port', '5193');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: +arg('w', 320), height: +arg('h', 180) } });
  const errs = [], logs = { A: [], B: [] };
  const q = `?nobloom${arg('norender') ? '&norender' : ''}${arg('rtc') ? '&rtc' : ''}&net=local&nettimeout=120000&netdebug${lag ? '&netlag=' + lag : ''}${loss ? '&netloss=' + loss : ''}`;
  const T = Date.now();
  const mk = async (name, extra) => {
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => { const t = m.text(); if (t.startsWith('[net]')) { logs[name].push(t); console.log(`${((Date.now() - T) / 1000).toFixed(1).padStart(6)} ${name} ${t}`); } });
    await p.goto(`http://localhost:${port}/${q}${extra}`, { timeout: 240000 });
    await p.waitForFunction(() => !!window.__game && document.querySelector('[data-act="start"]'), null, { timeout: 240000 });
    return p;
  };
  const A = await mk('A', '');
  const B = await mk('B', '');
  if (thr) { const cdp = await ctx.newCDPSession(B); await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr }); console.log('guest CPU throttled x' + thr); }
  await A.evaluate(() => { window.__game.act('start'); window.__game.act('online'); window.__game.act('online-host'); });
  const code = await A.evaluate(() => window.__game.online.code);
  await B.evaluate((c) => { const G = window.__game; G.act('start'); G.act('online'); document.getElementById('roomCode').value = c; G.act('online-join'); }, code);
  for (const p of [A, B]) await p.waitForFunction(() => window.__game.online.connected && window.__game.screen === 'select', null, { timeout: 120000 });
  await A.evaluate(() => { const G = window.__game; G.act('pick', 'ember'); G.act('confirm'); });
  await B.evaluate(() => { const G = window.__game; G.act('pick', 'vanta'); G.act('confirm'); });
  for (const p of [A, B]) await p.waitForFunction(() => window.__game.screen === 'map', null, { timeout: 120000 });
  const t0 = Date.now();
  console.log('--- host presses FIGHT');
  await A.evaluate(() => window.__game.act('fight'));
  // Skip the intro on one side (a key press), like a player mashing through it.
  if (skip !== 'none') {
    const P = skip === 'A' ? A : B;
    await P.waitForFunction(() => window.__game.online.phase === 'intro' && window.__introT > 0.3, null, { timeout: 120000 });
    await P.keyboard.press('KeyJ');
  }
  const res = {};
  await Promise.all([['A', A], ['B', B]].map(async ([n, p]) => {
    await p.waitForFunction(() => (window.__game.match?.tick ?? 0) > 0 && window.__game.online.phase === 'fight', null, { timeout: 180000 }).catch(() => {});
    res[n] = (Date.now() - t0) / 1000;
  }));
  console.log('--- first tick after FIGHT press: host', res.A, 's, guest', res.B, 's');
  // Fight a few seconds with inputs, then compare ticks.
  const play = async (p, keys) => { for (let i = 0; i < fightS * 2; i++) { const k = keys[i % keys.length]; await p.keyboard.down(k); await p.waitForTimeout(250); await p.keyboard.up(k); await p.waitForTimeout(250); } };
  await Promise.all([play(A, ['KeyD', 'KeyJ', 'KeyW', 'KeyJ']), play(B, ['KeyA', 'KeyJ', 'KeyS', 'KeyL'])]);
  const st = async (p) => p.evaluate(() => ({ phase: window.__game.online.phase, tick: window.__game.match?.tick, ping: window.__game.online.ping, desync: window.__game.online.lock?.desyncs, err: window.__game.online.error, handlers: window.__game.online.link?.handlers?.length, rtx: window.__game.online.link?.retransmits, direct: window.__game.online.direct, overlay: document.getElementById('netwait')?.classList.contains('on') ? document.querySelector('#netwait b').textContent : null }));
  console.log('A', JSON.stringify(await st(A)), '\nB', JSON.stringify(await st(B)));
  if (arg('rematch')) {
    console.log('--- host-only KO (forces a desync; guest must resync from a snapshot), then rematch');
    await A.evaluate(() => { const m = window.__game.match; m.declare(m.fighters[0], m.fighters[1], 'ko'); });
    for (const p of [A, B]) await p.waitForFunction(() => window.__game.screen === 'result', null, { timeout: 120000 });
    console.log('both on results; guest desyncs', await B.evaluate(() => window.__game.online.lock.desyncs));
    const t1 = Date.now();
    await A.evaluate(() => window.__game.act('rematch')); await B.evaluate(() => window.__game.act('rematch'));
    await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__game.online.phase === 'fight' && window.__game.match.tick > 30, null, { timeout: 180000 })));
    console.log('rematch fight running after', (Date.now() - t1) / 1000, 's');
    console.log('A', JSON.stringify(await st(A)), '\nB', JSON.stringify(await st(B)));
    console.log('--- guest leaves');
    await B.evaluate(() => window.__game.act('title'));
    await A.waitForFunction(() => window.__game.screen === 'online', null, { timeout: 30000 }).catch(() => {});
    console.log('host after guest left:', await A.evaluate(() => window.__game.screen + ' / ' + window.__game.online.error));
  }
  if (arg('shot')) { await A.screenshot({ path: arg('shot') + '_A.png' }); await B.screenshot({ path: arg('shot') + '_B.png' }); }
  console.log(errs.join('\n') || 'no page errors');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
