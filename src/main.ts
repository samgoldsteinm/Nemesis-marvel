import * as THREE from 'three';
import { Arena, LAYOUTS, LayoutId } from './arena';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FX } from './fx';
import { VersusCamera } from './camera';
import { Match } from './match';
import { HUD } from './hud';
import { CPU, Difficulty } from './ai';
import { ROSTER, CharacterDef, charById } from './characters';
import { EdgeTracker, installKeyboard, installTouch, readDevices, readGamepad, emptyRaw, RawState, DeviceBinding, connectedPads, isTouchActive, keyDown, endInputRead } from './input';
import { initAudio, sfx, startMusic, stopMusic, setMuted, muted } from './audio';
import { TUNING } from './fighter';

// ============================================================ renderer & scene
const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
function skyTexture(stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
{
  // Dusk sky: deep violet overhead to a burnt-orange horizon. Warm rooftop light, cool fill.
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#120a24');
  grad.addColorStop(0.45, '#3a1c48');
  grad.addColorStop(0.7, '#a0405a');
  grad.addColorStop(0.85, '#ff9a5a');
  grad.addColorStop(1, '#2a1622');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.fog = new THREE.Fog(0x4a2a48, 70, 230);
}
const hemi = new THREE.HemisphereLight(0x9a86c8, 0x2a1e30, 0.75);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffb27a, 2.6);
sun.position.set(-28, 22, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -24; sc.right = 24; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 80;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x6c7cff, 0.9);
rim.position.set(25, 12, -20);
scene.add(rim);
// Soft key light that follows the camera so silhouettes stay readable from any framing.
const keyLight = new THREE.DirectionalLight(0xfff0e0, 0.9);
scene.add(keyLight, keyLight.target);

// Per-venue palette: each arena has its own hour and light.
const PALETTES: Record<LayoutId, { sky: [number, string][]; fog: number; fogNear: number; fogFar: number; hemi: [number, number, number]; sun: [number, number]; sunPos: [number, number, number]; rim: [number, number] }> = {
  rooftop: { sky: [[0, '#120a24'], [0.45, '#3a1c48'], [0.7, '#a0405a'], [0.85, '#ff9a5a'], [1, '#2a1622']], fog: 0x4a2a48, fogNear: 70, fogFar: 230, hemi: [0x9a86c8, 0x2a1e30, 0.75], sun: [0xffb27a, 2.6], sunPos: [-28, 22, 14], rim: [0x6c7cff, 0.9] },
  overpass: { sky: [[0, '#03060c'], [0.5, '#0a1c28'], [0.78, '#1d4a58'], [0.9, '#3a7a84'], [1, '#081014']], fog: 0x173842, fogNear: 45, fogFar: 170, hemi: [0x6a9ab0, 0x0c1418, 0.85], sun: [0xa8dcff, 1.5], sunPos: [18, 30, -12], rim: [0xffa040, 1.3] },
};
function applyPalette(id: LayoutId) {
  const p = PALETTES[id];
  scene.background = skyTexture(p.sky);
  scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);
  hemi.color.setHex(p.hemi[0]); hemi.groundColor.setHex(p.hemi[1]); hemi.intensity = p.hemi[2];
  sun.color.setHex(p.sun[0]); sun.intensity = p.sun[1]; sun.position.set(...p.sunPos);
  rim.color.setHex(p.rim[0]); rim.intensity = p.rim[1];
}

const fx = new FX(scene);
const arena = new Arena(scene, fx);
const vcam = new VersusCamera(window.innerWidth / window.innerHeight);
// Bloom: hazy highlights on lamps, sparks, explosions and power effects. First thing dropped when slow.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, vcam.cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.45, 0.8);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let bloomOn = !new URLSearchParams(location.search).has('nobloom');
// Full-screen Rage wash.
const tint = document.createElement('div');
tint.id = 'tint';
document.body.insertBefore(tint, document.getElementById('hud'));
const hud = new HUD(document.getElementById('hud')!);
hud.show(false);
const keysHint = document.createElement('div');
keysHint.className = 'keys';
document.getElementById('hud')!.appendChild(keysHint);
const perfEl = document.createElement('div');
perfEl.id = 'perf';
perfEl.style.display = new URLSearchParams(location.search).has('perf') ? '' : 'none';
document.getElementById('hud')!.appendChild(perfEl);

installKeyboard();
const touchRoot = document.getElementById('touch')!;
installTouch(touchRoot);

// Grab-target markers: show what X will pick up or grapple right now.
const markers = [0x3aa0ff, 0xff4a4a].map((c) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 4), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  scene.add(m);
  return m;
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  vcam.cam.aspect = window.innerWidth / window.innerHeight;
  vcam.cam.updateProjectionMatrix();
});

// ============================================================ app state
type Mode = 'cpu' | 'versus';
interface Setup { mode: Mode; p1: string; p2: string; diff: Difficulty; p1Human: boolean; arena: LayoutId }
const setup: Setup = { mode: 'cpu', p1: 'tether', p2: 'basalt', diff: 'normal', p1Human: true, arena: 'rooftop' };
let match: Match | null = null;
let cpus: (CPU | null)[] = [null, null];
const trackers = [new EdgeTracker(), new EdgeTracker()];
let paused = false;
type Screen = 'title' | 'mode' | 'select' | 'result' | 'pause' | 'moves' | 'none';
let screen: Screen = 'title' as Screen;
/** Test/automation override: when set, replaces a player's raw input each tick. */
const forced: (RawState | null)[] = [null, null];
let simSpeed = 1;
let manualStep = false;

function bindings(): DeviceBinding[] {
  if (setup.mode === 'cpu') return [{ keyboard: [0, 1], gamepad: 0, touch: true }, { keyboard: [], gamepad: null, touch: false }];
  return [{ keyboard: [0], gamepad: 0, touch: true }, { keyboard: [1], gamepad: 1, touch: false }];
}

function startMatch() {
  if (match) match.dispose();
  const d: [CharacterDef, CharacterDef] = [charById(setup.p1), charById(setup.p2)];
  if (arena.layout !== setup.arena) arena.setLayout(setup.arena);
  applyPalette(setup.arena);
  match = new Match(scene, arena, fx, vcam, d);
  cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null];
  trackers.forEach((t) => t.reset());
  hud.setNames(match, setup.mode === 'cpu' ? ['YOU', `CPU · ${setup.diff}`] : ['PAD 1 / WASD', 'PAD 2 / ARROWS']);
  hud.show(true);
  keysHint.innerHTML = 'Move <b>WASD</b> · A attack <b>J</b> · B jump <b>K</b> · X grab <b>L</b> · Y guard <b>I</b> · L mobility <b>U</b> · R power <b>O</b> · Pause <b>Esc</b>' + (setup.mode === 'versus' ? '<br>P2: Arrows · A <b>.</b> · B <b>/</b> · X <b>,</b> · Y <b>;</b> · L <b>R-Shift</b> · R <b>Enter</b> (or numpad 1 2 3 5 4 6)' : '');
  const touchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  touchRoot.classList.toggle('off', !touchDevice);
  keysHint.style.display = touchDevice ? 'none' : '';
  paused = false;
  showScreen('none');
  startMusic();
}

function rematch(swap = false) {
  if (swap) { const t = setup.p1; setup.p1 = setup.p2; setup.p2 = t; }
  if (swap || !match) startMatch();
  else { match.restart(); cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null]; trackers.forEach((t) => t.reset()); paused = false; showScreen('none'); }
}

// ============================================================ menus
const menu = document.getElementById('menu')!;
let focusIdx = 0;
function focusables(): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[data-nav]'));
}
function setFocus(i: number) {
  const f = focusables();
  if (!f.length) return;
  focusIdx = (i + f.length) % f.length;
  f.forEach((e, k) => e.classList.toggle('focus', k === focusIdx));
  f[focusIdx].scrollIntoView({ block: 'nearest' });
}

function showScreen(s: Screen) {
  screen = s;
  if (s === 'none') { menu.classList.add('hidden'); return; }
  menu.classList.remove('hidden');
  menu.innerHTML = render(s);
  menu.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', () => { initAudio(); act(el.dataset.act!, el.dataset.arg); });
  });
  setFocus(0);
}

let selectStage: 0 | 1 = 0;
function render(s: Screen): string {
  if (s === 'title') return `
    <div class="screen">
      <h1 class="logo">BREAK<span>LINE</span></h1>
      <div class="tagline">Rooftop superpowered brawler · original characters</div>
      <div class="btns">
        <button class="btn" data-nav data-act="mode" data-arg="cpu">Versus CPU<small>One player against the computer</small></button>
        <button class="btn" data-nav data-act="mode" data-arg="versus">Versus 2P<small>Shared screen: two pads, or keyboard + pad</small></button>
        <button class="btn" data-nav data-act="moves">Controls &amp; Move Sheets</button>
        <button class="btn" data-nav data-act="mute">Sound: ${muted ? 'Off' : 'On'}</button>
      </div>
      <div class="hint">Keyboard: WASD + J K L I U O · Gamepad: A B X Y, LB/LT = L, RB/RT = R · Touch supported. ${connectedPads().length} pad(s) connected.</div>
    </div>`;
  if (s === 'select') {
    const who = selectStage === 0 ? 'PLAYER 1' : setup.mode === 'cpu' ? 'CPU OPPONENT' : 'PLAYER 2';
    return `
    <div class="screen">
      <h2>CHOOSE ${who}</h2>
      <div class="roster">${ROSTER.map((c) => `
        <div class="card" data-nav data-act="pick" data-arg="${c.id}" style="--c:${c.color}">
          ${selectStage === 1 && setup.p1 === c.id ? '<span class="pick p1">P1</span>' : ''}
          <div class="cn">${c.name}</div><div class="ct">${c.title}</div>
          <p>${c.blurb}</p>
          <div class="chips"><span class="chip">${c.recovery} recovery</span><span class="chip">lift: ${['light', 'medium', 'heavy'][c.lift]}</span><span class="chip">speed ${c.speed.toFixed(1)}</span></div>
        </div>`).join('')}
      </div>
      ${setup.mode === 'cpu' ? `<div class="row"><span>CPU difficulty:</span><span class="seg">${(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => `<button class="btn ${setup.diff === d ? 'on' : ''}" data-nav data-act="diff" data-arg="${d}">${d}</button>`).join('')}</span></div>` : ''}
      <div class="row"><span>Arena:</span><span class="seg">${LAYOUTS.map((l) => `<button class="btn ${setup.arena === l.id ? 'on' : ''}" data-nav data-act="arena" data-arg="${l.id}">${l.name}</button>`).join('')}</span></div>
      <div class="hint">${LAYOUTS.find((l) => l.id === setup.arena)!.blurb}</div>
      <div class="row"><button class="btn" data-nav data-act="title">Back</button></div>
    </div>`;
  }
  if (s === 'result' && match?.ended) {
    const e = match.ended;
    const how = e.how === 'ko' ? 'K.O.' : e.how === 'ringout' ? 'RING OUT' : 'FINISHER';
    const wIdx = e.winner.idx;
    const label = setup.mode === 'cpu' ? (wIdx === 0 ? 'YOU WIN' : 'CPU WINS') : `PLAYER ${wIdx + 1} WINS`;
    const st = (f: typeof e.winner) => `${f.def.name}: ${f.stats.hits} hits · ${f.stats.throws} throws · ${f.stats.catches} catches · ${f.stats.recoveries} recoveries · health ${Math.round(f.health)}`;
    return `
    <div class="screen">
      <p class="result-big" style="color:${e.winner.def.color}">${label}</p>
      <h2>${e.winner.def.name} — by ${how}</h2>
      <div class="hint">${st(match.fighters[0])}<br>${st(match.fighters[1])}</div>
      <div class="btns" style="margin-top:16px">
        <button class="btn" data-nav data-act="rematch">Rematch</button>
        <button class="btn" data-nav data-act="swap">Switch Sides<small>Swap fighters and fight again</small></button>
        <button class="btn" data-nav data-act="select">Character Select</button>
        <button class="btn" data-nav data-act="title">Main Menu</button>
      </div>
    </div>`;
  }
  if (s === 'pause') return `
    <div class="screen">
      <h2>PAUSED</h2>
      <div class="btns">
        <button class="btn" data-nav data-act="resume">Resume</button>
        <button class="btn" data-nav data-act="rematch">Restart Bout</button>
        <button class="btn" data-nav data-act="moves">Controls &amp; Move Sheets</button>
        <button class="btn" data-nav data-act="mute">Sound: ${muted ? 'Off' : 'On'}</button>
        <button class="btn" data-nav data-act="title">Quit to Menu</button>
      </div>
    </div>`;
  if (s === 'moves') return `
    <div class="screen">
      <h2>CONTROLS</h2>
      <div class="cols">
        <table class="moves">
          <tr><td>Stick</td><td>Move (camera-relative)</td></tr>
          <tr><td>A</td><td>Attack — repeat for a 3-hit chain; rising / descending air attacks</td></tr>
          <tr><td>B</td><td>Jump</td></tr>
          <tr><td>X</td><td>Grapple the opponent, pick up a prop, or throw what you hold. The diamond marker shows the current target.</td></tr>
          <tr><td>Y</td><td>Guard · Y + direction: evade (A during evade: counter) · Press Y as a thrown prop arrives to catch it</td></tr>
          <tr><td>L</td><td>Mobility (sprint / swing / flight / teleport) · L+A mobility attack</td></tr>
          <tr><td>R + A</td><td>Powered attack (costs energy)</td></tr>
          <tr><td>R + B</td><td>Super jump</td></tr>
          <tr><td>R + X</td><td>Super grapple / super throw. On a DANGER opponent with ≥¼ energy: FINISHER</td></tr>
          <tr><td>R + Y</td><td>Super block — deflects projectiles and thrown props</td></tr>
          <tr><td>Hold R</td><td>Recharge energy (standing still, vulnerable)</td></tr>
          <tr><td>Tap R</td><td>Activate Rage when the meter is full: ${TUNING.rageDuration}s of unlimited power</td></tr>
          <tr><td>L + R</td><td>While launched: recovery (costs ${TUNING.recoveryCost} energy)</td></tr>
        </table>
        <table class="moves">
          <tr><td>Vitality</td><td>Yellow stamina recovers when you're not hit; red health is lasting. Powered hits, throws and props cut health.</td></tr>
          <tr><td>Danger</td><td>Health ≤ ${TUNING.dangerHealth} or stamina ≤ ${TUNING.dangerStamina}: exposed to a finisher.</td></tr>
          <tr><td>Win</td><td>K.O. (health to zero) · RING OUT (fall off the roof) · FINISHER</td></tr>
          <tr><td>Fence</td><td>Launched bodies, throws and power moves break fence segments and open the drop.</td></tr>
        </table>
      </div>
      <h2 style="margin-top:18px">MOVE SHEETS</h2>
      <div class="cols">${ROSTER.map((c) => `
        <table class="moves" style="--c:${c.color}">
          <tr><td style="color:${c.color}">${c.name}</td><td>${c.recovery} recovery · lift ${['light', 'medium', 'heavy'][c.lift]}</td></tr>
          <tr><td>Mobility</td><td>${c.sheet.mobility}</td></tr>
          <tr><td>Power</td><td>${c.sheet.power}</td></tr>
          <tr><td>Grapple</td><td>${c.sheet.grapple}</td></tr>
          <tr><td>Finisher</td><td>${c.sheet.finisher}</td></tr>
          <tr><td>Weakness</td><td>${c.sheet.weakness}</td></tr>
        </table>`).join('')}
      </div>
      <div class="row"><button class="btn" data-nav data-act="back">Back</button></div>
    </div>`;
  return '';
}

let movesReturn: Screen = 'title';
function act(a: string, arg?: string) {
  sfx.select();
  switch (a) {
    case 'mode': setup.mode = arg as Mode; selectStage = 0; showScreen('select'); break;
    case 'pick':
      if (selectStage === 0) { setup.p1 = arg!; selectStage = 1; showScreen('select'); }
      else { setup.p2 = arg!; startMatch(); }
      break;
    case 'arena': setup.arena = arg as LayoutId; { const i = focusIdx; showScreen('select'); setFocus(i); } break;
    case 'diff': setup.diff = arg as Difficulty; { const i = focusIdx; showScreen('select'); setFocus(i); } break;
    case 'title': if (match) { match.dispose(); match = null; } hud.show(false); stopMusic(); touchRoot.classList.add('off'); showScreen('title'); break;
    case 'select': selectStage = 0; showScreen('select'); break;
    case 'rematch': rematch(false); break;
    case 'swap': rematch(true); break;
    case 'resume': paused = false; showScreen('none'); break;
    case 'moves': movesReturn = screen === 'pause' ? 'pause' : 'title'; showScreen('moves'); break;
    case 'back': showScreen(movesReturn); break;
    case 'mute': setMuted(!muted); showScreen(screen); break;
  }
}

// Menu navigation from keyboard / pads.
const menuTrack = [new EdgeTracker(), new EdgeTracker()];
let navCooldown = 0; // ms
function menuInput(dtMs: number) {
  const binds: DeviceBinding[] = [{ keyboard: [0, 1], gamepad: 0, touch: false }, { keyboard: [], gamepad: 1, touch: false }];
  for (let i = 0; i < 2; i++) {
    const raw = readDevices(binds[i]);
    if (keyDown('Enter') || keyDown('Space')) raw.down.attack = true;
    if (keyDown('Escape')) raw.down.jump = true;
    menuTrack[i].update(raw);
    const fr = menuTrack[i].frame;
    if (navCooldown > 0) continue;
    const step = fr.my > 0.5 || fr.mx < -0.5 ? -1 : fr.my < -0.5 || fr.mx > 0.5 ? 1 : 0;
    if (step) { setFocus(focusIdx + step); navCooldown = 150; sfx.menu(); }
    if (fr.b.attack.pressed) { const el = focusables()[focusIdx]; if (el) { initAudio(); el.click(); } navCooldown = 180; }
    if (fr.b.jump.pressed) {
      navCooldown = 180;
      if (screen === 'select') act('title');
      else if (screen === 'moves') act('back');
      else if (screen === 'pause') act('resume');
    }
  }
  if (navCooldown > 0) navCooldown -= dtMs;
  endInputRead();
}

window.addEventListener('gamepadconnected', (e) => { toast(`Controller ${(e as GamepadEvent).gamepad.index + 1} connected`); if (screen === 'title') showScreen('title'); });
window.addEventListener('gamepaddisconnected', (e) => {
  const idx = (e as GamepadEvent).gamepad.index;
  toast(`Controller ${idx + 1} disconnected`);
  // A human player's pad dropped mid-bout: pause so nobody loses to a dead controller.
  if (match && !paused && !match.ended && (idx === 0 || (idx === 1 && setup.mode === 'versus'))) { paused = true; showScreen('pause'); }
});
let toastT = 0;
function toast(msg: string) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toastT);
  toastT = window.setTimeout(() => (t.style.opacity = '0'), 2200);
}

document.addEventListener('pointerdown', () => initAudio(), { once: false });
document.addEventListener('keydown', (e) => {
  initAudio();
  if (e.code === 'F3') { perfEl.style.display = perfEl.style.display === 'none' ? '' : 'none'; e.preventDefault(); }
});

// ============================================================ simulation tick
const DT = 1 / 60;
function simTick() {
  if (!match) return;
  const b = bindings();
  for (let i = 0; i < 2; i++) {
    const f = match.fighters[i];
    let raw: RawState;
    if (forced[i]) raw = forced[i]!;
    else if (cpus[i]) raw = cpus[i]!.read();
    else raw = readDevices(b[i]);
    if (match.inputLocked && f.state !== 'finisher') { const r = emptyRaw(); r.pause = raw.pause; raw = r; }
    trackers[i].update(raw);
    f.input = trackers[i].frame;
    if (trackers[i].frame.pause && !cpus[i] && !match.ended) { paused = true; showScreen('pause'); return; }
  }
  endInputRead();
  match.camBasis.fwd = vcam.fwd;
  match.camBasis.right = vcam.right;
  match.update(DT);
  fx.update(DT);
  if (match.resultReady && screen === 'none') { showScreen('result'); }
}

// ============================================================ performance monitor
const frameTimes: number[] = [];
let lastQualityCheck = 0;
function perfStats() {
  const s = [...frameTimes].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: s[s.length - 1] ?? 0, n: s.length };
}
function adaptQuality(now: number) {
  if (now - lastQualityCheck < 2000 || frameTimes.length < 120) return;
  lastQualityCheck = now;
  const { p95 } = perfStats();
  // Lower particle density and render scale first; simulation and collision are never touched.
  if (p95 > 19) {
    if (bloomOn) bloomOn = false;
    else if (fx.quality > 0.5) fx.quality = 0.5;
    else if (pixelRatio > 0.7) { pixelRatio = Math.max(0.7, pixelRatio - 0.15); renderer.setPixelRatio(pixelRatio); }
    else if (renderer.shadowMap.enabled) { renderer.shadowMap.enabled = false; }
  }
}

// ============================================================ main loop
let acc = 0;
let last = performance.now();
let time = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameTimes.push(rawDt * 1000);
  if (frameTimes.length > 600) frameTimes.shift();
  time += rawDt;

  if (screen !== 'none') menuInput(rawDt * 1000);
  if (match && !paused && screen === 'none' && !manualStep) {
    if (fx.hitstop > 0) fx.hitstop -= rawDt; // brief impact emphasis: sim holds, rendering continues
    else {
      acc += rawDt * simSpeed;
      let n = 0;
      while (acc >= DT && n < 6) { simTick(); acc -= DT; n++; }
      if (n === 6) acc = 0;
    }
  } else if (match && screen !== 'none' && match.ended) {
    // Keep victory animations alive behind the results menu.
    acc += rawDt;
    while (acc >= DT) { match.update(DT); fx.update(DT); acc -= DT; }
  } else if (!match) {
    fx.update(rawDt);
  }

  if (match) {
    for (const f of match.fighters) f.animate(rawDt, time);
    vcam.update(match.fighters, rawDt, fx.shake);
    hud.update(match, time);
    hud.el.classList.toggle('menu-up', screen !== 'none');
    // X-target markers for human players.
    match.fighters.forEach((f, i) => {
      const mk = markers[i];
      const human = !cpus[i];
      const t = human && !match!.ended ? match!.grabHint(f) : null;
      mk.visible = !!t;
      if (t) {
        const p = 'f' in t ? t.f.pos : t.p.pos;
        mk.position.set(p.x, p.y + 0.06, p.z);
        mk.rotation.z = time * 3;
        const sc = t.kind.startsWith('line') ? 1.4 : 1;
        mk.scale.setScalar(sc);
      }
    });
    arena.setFade(vcam.cam.position, match.fighters.map((f) => f.center));
  } else {
    // Attract mode: slow orbit over the roof.
    const a = time * 0.08;
    vcam.cam.position.set(Math.sin(a) * 30, 14, Math.cos(a) * 30);
    vcam.cam.lookAt(0, 1, 0);
  }
  keyLight.position.copy(vcam.cam.position).add(new THREE.Vector3(0, 6, 0));
  keyLight.target.position.copy(vcam.target);
  const raging = !!match && match.fighters.some((f) => f.raging);
  tint.style.opacity = raging ? String(0.38 + Math.sin(time * 10) * 0.08) : '0';
  if (bloomOn) composer.render(); else renderer.render(scene, vcam.cam);
  adaptQuality(now);
  if (perfEl.style.display !== 'none') {
    const s = perfStats();
    perfEl.textContent = `frame ms p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} p99 ${s.p99.toFixed(1)} worst ${s.worst.toFixed(1)}\nbloom ${bloomOn} fx ${fx.quality} dpr ${pixelRatio.toFixed(2)} shadows ${renderer.shadowMap.enabled} calls ${renderer.info.render.calls}`;
  }
}
showScreen('title');
requestAnimationFrame(frame);

// ============================================================ automation / test hooks
(window as any).THREE = THREE;
(window as any).__game = {
  get match() { return match; },
  setup,
  arena,
  fx,
  TUNING,
  forced,
  cpus: () => cpus,
  start(p1: string, p2: string, mode: Mode = 'cpu', diff: Difficulty = 'normal', arenaId: LayoutId = 'rooftop') { setup.p1 = p1; setup.p2 = p2; setup.mode = mode; setup.diff = diff; setup.arena = arenaId; startMatch(); },
  rematch,
  act,
  get screen() { return screen; },
  setManual(on: boolean) { manualStep = on; },
  step(n = 1) { for (let i = 0; i < n; i++) { simTick(); } if (match) for (const f of match.fighters) f.animate(DT, time); },
  setSpeed(s: number) { simSpeed = s; },
  disableCPU() { cpus = [null, null]; },
  enableCPU(diff: Difficulty = 'normal') { if (match) cpus = [null, new CPU(match.fighters[1], match, diff)]; },
  enableCPUs(diff: Difficulty = 'normal') { if (match) cpus = [new CPU(match.fighters[0], match, diff), new CPU(match.fighters[1], match, diff)]; },
  perfStats,
  emptyRaw,
  readGamepad,
  isTouchActive,
  renderer,
  vcam,
};
