// Regenerates public/previews/<arena>.jpg (the arena-select thumbnails) by letting the game capture them at
// runtime once, then saving the images. Run after changing an arena's look:
//   npm run dev &   node tools/arena-previews.cjs [http://localhost:5173/]
// The game shows these static files instead of rendering every arena on the arena screen (that compiled each
// arena's shaders on the main thread: multi-second freezes right when the match starts, worst online).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const URL = process.argv[2] || 'http://localhost:5173/';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await p.goto(URL + (URL.includes('?') ? '&' : '?') + 'livepreviews', { timeout: 300000 });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 300000 });
  await p.evaluate(() => { const G = window.__game; G.act('start'); G.act('mode', 'cpu'); G.act('confirm'); G.act('confirm'); });
  await p.waitForFunction(() => window.__game.screen === 'map', null, { timeout: 60000 });
  const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('img[data-prev]')].map((i) => i.dataset.prev))]);
  await p.waitForFunction((n) => [...document.querySelectorAll('img[data-prev]')].filter((i) => i.src.startsWith('data:image/jpeg')).length >= n, ids.length, { timeout: 600000, polling: 1000 });
  const urls = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('img[data-prev]')].map((i) => [i.dataset.prev, i.src])));
  const out = path.join(__dirname, '..', 'public', 'previews');
  fs.mkdirSync(out, { recursive: true });
  for (const [id, u] of Object.entries(urls)) { fs.writeFileSync(path.join(out, id + '.jpg'), Buffer.from(u.split(',')[1], 'base64')); console.log('wrote', id); }
  await b.close();
})();
