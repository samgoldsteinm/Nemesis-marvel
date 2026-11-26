import * as THREE from 'three';
import { Arena, LAYOUTS, LayoutId } from './arena';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { FX } from './fx';
import { VersusCamera } from './camera';
import { Match } from './match';
import { HUD } from './hud';
import { CPU, Difficulty } from './ai';
import { ROSTER, CharacterDef, charById } from './characters';
import { EdgeTracker, installKeyboard, installTouch, readDevices, readGamepad, emptyRaw, RawState, DeviceBinding, connectedPads, isTouchActive, keyDown, endInputRead, padActivity, noteInput, lastInputKind } from './input';
import { initAudio, sfx, startMusic, stopMusic, setMuted, muted } from './audio';
import { TUNING } from './fighter';
import { RIM_COLOR } from './characters';
import { renderPortraits, portraitOf } from './portraits';
import { loadBodyModels, loadPropModels } from './skinned';
import { PROP_MODELS } from './arena';

// ============================================================ renderer & scene
const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
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
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -24; sc.right = 24; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 80;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 3;
scene.add(sun.target);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x6c7cff, 0.9);
rim.position.set(25, 12, -20);
scene.add(rim);
// Soft key light that follows the camera so silhouettes stay readable from any framing.
const keyLight = new THREE.DirectionalLight(0xfff0e0, 0.6);
scene.add(keyLight, keyLight.target);

const SHADOW_HALF = 17;
const sunDir = new THREE.Vector3(-22, 26, 12).normalize();
// Per-venue palette: each arena has its own hour, light and colour grade.
interface Palette {
  sky: [number, string][]; fog: number; fogNear: number; fogFar: number;
  hemi: [number, number, number]; sun: [number, number]; sunPos: [number, number, number]; rim: [number, number];
  shadow: [number, number]; // half-extents of the sun's shadow box (x, z)
  grade: { sat: number; lift: [number, number, number]; shadowTint: [number, number, number]; highTint: [number, number, number]; gamma: number };
  bloom: [number, number, number]; // strength, radius, threshold
}
const PALETTES: Record<LayoutId, Palette> = {
  // Hazy late-day roof: warm key light, lifted lilac shadows.
  rooftop: {
    sky: [[0, '#2a2140'], [0.45, '#6a4a70'], [0.7, '#d07a70'], [0.86, '#ffc890'], [1, '#5a4050']], fog: 0x8a7088, fogNear: 45, fogFar: 200,
    hemi: [0xb8a8d8, 0x3a3040, 0.8], sun: [0xffd0a0, 2.6], sunPos: [-22, 26, 12], rim: [0x8aa0ff, 1.2], shadow: [26, 22],
    grade: { sat: 0.8, lift: [0.035, 0.03, 0.05], shadowTint: [0.85, 0.9, 1.15], highTint: [1.0, 0.95, 0.85], gamma: 0.97 }, bloom: [0.42, 0.45, 0.82],
  },
  // Overcast, washed teal daylight: blown highlights, hard girder shadows across the deck.
  overpass: {
    sky: [[0, '#7a9ea8'], [0.5, '#a2c0c4'], [0.8, '#c2d6d4'], [1, '#88a2a4']], fog: 0x8fadb0, fogNear: 30, fogFar: 150,
    hemi: [0xcfe8ec, 0x3a4a4c, 0.85], sun: [0xf4fbff, 2.6], sunPos: [10, 34, 14], rim: [0x9fe0ff, 0.9], shadow: [34, 14],
    grade: { sat: 0.7, lift: [0.03, 0.05, 0.06], shadowTint: [0.82, 1.0, 1.12], highTint: [0.95, 1.0, 1.0], gamma: 0.96 }, bloom: [0.45, 0.5, 0.82],
  },
};
// Sky reflections: an environment map rendered from the palette's sky and sun, so car paint,
// glass, metal and puddles reflect something instead of looking matte.
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT: THREE.WebGLRenderTarget | null = null;
function buildEnvironment(p: Palette) {
  const envScene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ map: skyTexture(p.sky), side: THREE.BackSide }));
  envScene.add(sky);
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.sun[0]).multiplyScalar(6) }));
  sunBall.position.copy(new THREE.Vector3(...p.sunPos).normalize().multiplyScalar(40));
  envScene.add(sunBall);
  // A darker ground hemisphere so reflections read as "city below, sky above".
  const ground = new THREE.Mesh(new THREE.SphereGeometry(49, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.hemi[1]).multiplyScalar(1.2), side: THREE.BackSide }));
  envScene.add(ground);
  envRT?.dispose();
  envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  (scene as any).environmentIntensity = 0.42;
}

function applyPalette(id: LayoutId) {
  const p = PALETTES[id];
  buildEnvironment(p);
  scene.background = skyTexture(p.sky);
  scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);
  hemi.color.setHex(p.hemi[0]); hemi.groundColor.setHex(p.hemi[1]); hemi.intensity = p.hemi[2];
  sun.color.setHex(p.sun[0]); sun.intensity = p.sun[1]; sun.position.set(...p.sunPos);
  rim.color.setHex(p.rim[0]); rim.intensity = p.rim[1];
  // Tight shadow box that follows the action (see frame loop): crisp, soft shadows where it matters.
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
  sc.near = 1; sc.far = 120;
  sc.updateProjectionMatrix();
  sunDir.set(...p.sunPos).normalize();
  RIM_COLOR.value.setHex(p.rim[0]).lerp(new THREE.Color(0xffffff), 0.35);
  const u = grade.uniforms;
  u.sat.value = p.grade.sat;
  u.lift.value.set(...p.grade.lift);
  u.shadowTint.value.set(...p.grade.shadowTint);
  u.highTint.value.set(...p.grade.highTint);
  u.gamma.value = p.grade.gamma;
  bloom.strength = p.bloom[0]; bloom.radius = p.bloom[1]; bloom.threshold = p.bloom[2];
}

const fx = new FX(scene);
const arena = new Arena(scene, fx);
const vcam = new VersusCamera(window.innerWidth / window.innerHeight);
// Bloom: hazy highlights on lamps, sparks, explosions and power effects. First thing dropped when slow.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, vcam.cam));
// Contact shadows (ambient occlusion): grounds props, fighters and buildings. Desktop by default;
// the adaptive quality step turns it off first when frames run long.
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (isTouch) sun.shadow.mapSize.set(1536, 1536);
// Motion blur (afterimage) only switches on for fast moves and big impacts.
const blurPass = new AfterimagePass(0);
blurPass.enabled = false;
composer.addPass(blurPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.75, 0.5, 0.62);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// Colour grade in display space: desaturate, split-tone, lift blacks, vignette, grain.
const grade = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, sat: { value: 0.7 }, gamma: { value: 0.9 },
    lift: { value: new THREE.Vector3(0.06, 0.08, 0.09) }, shadowTint: { value: new THREE.Vector3(0.85, 1, 1.1) }, highTint: { value: new THREE.Vector3(1, 1, 1) },
    flash: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, sat, gamma, flash; uniform vec3 lift, shadowTint, highTint; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, sat);
      c *= mix(shadowTint, vec3(1.0), smoothstep(0.0, 0.55, l));
      c = mix(c, c * highTint, smoothstep(0.55, 1.0, l));
      c = lift + c * (1.0 - lift);
      c = pow(max(c, 0.0), vec3(gamma));
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * 0.6;
      float n = fract(sin(dot(vUv * vec2(1731.0, 977.0) + time * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * 0.03;
      c = mix(c, vec3(1.0), flash);
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);
let bloomOn = !new URLSearchParams(location.search).has('nobloom');
let postOn = !new URLSearchParams(location.search).has('nopost');
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
  vcam.zLimit = setup.arena === 'overpass' ? 5.8 : Infinity;
  match = new Match(scene, arena, fx, vcam, d);
  cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null];
  trackers.forEach((t) => t.reset());
  hud.setNames(match, setup.mode === 'cpu' ? ['YOU', `CPU · ${setup.diff}`] : ['PAD 1 / WASD', 'PAD 2 / ARROWS']);
  hud.show(true);
  keysHint.innerHTML = 'Move <b>WASD</b> · A attack <b>J</b> · B jump <b>K</b> · X grab <b>L</b> · Y guard <b>I</b> · L mobility <b>U</b> · R power <b>O</b> · Pause <b>Esc</b>' + (setup.mode === 'versus' ? '<br>P2: Arrows · A <b>.</b> · B <b>/</b> · X <b>,</b> · Y <b>;</b> · L <b>R-Shift</b> · R <b>Enter</b> (or numpad 1 2 3 5 4 6)' : '');
  if (connectedPads().length) noteInput('pad');
  updateControlOverlay();
  paused = false;
  showScreen('none');
  startMusic();
}

function rematch(swap = false) {
  if (swap) { const t = setup.p1; setup.p1 = setup.p2; setup.p2 = t; }
  if (swap || !match) startMatch();
  else { match.restart(); cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null]; trackers.forEach((t) => t.reset()); paused = false; showScreen('none'); }
}

/** Show touch buttons only for touch players and key hints only for keyboard players; a gamepad hides both. */
function updateControlOverlay() {
  if (padActivity()) noteInput('pad');
  const inMatch = !!match && screen === 'none';
  touchRoot.classList.toggle('off', !(inMatch && lastInputKind === 'touch'));
  keysHint.style.display = inMatch && lastInputKind === 'keys' ? '' : 'none';
}
window.addEventListener('gamepadconnected', () => { noteInput('pad'); updateControlOverlay(); });
window.addEventListener('gamepaddisconnected', () => {
  if (!connectedPads().length) noteInput(('ontouchstart' in window) || navigator.maxTouchPoints > 0 ? 'touch' : 'keys');
  updateControlOverlay();
});

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

let selectSide: 0 | 1 = 0; // which player is choosing on the fighter screen
let howTab: 'controls' | 'combat' | 'fighters' = 'controls';
const RATINGS: Record<string, { power: number; speed: number; range: number; toughness: number; difficulty: string }> = {
  basalt: { power: 5, speed: 2, range: 2, toughness: 5, difficulty: 'Easy' },
  tether: { power: 2, speed: 5, range: 4, toughness: 2, difficulty: 'Hard' },
  aerin: { power: 3, speed: 4, range: 5, toughness: 3, difficulty: 'Medium' },
  shunt: { power: 3, speed: 4, range: 3, toughness: 3, difficulty: 'Hard' },
  vanta: { power: 3, speed: 5, range: 2, toughness: 2, difficulty: 'Medium' },
  magna: { power: 4, speed: 2, range: 5, toughness: 3, difficulty: 'Medium' },
  ember: { power: 4, speed: 3, range: 3, toughness: 4, difficulty: 'Easy' },
  rift: { power: 3, speed: 4, range: 4, toughness: 2, difficulty: 'Hard' },
};
const ICON = { ground: '⛰', swing: '🪢', flight: '🪽', teleport: '✦' } as Record<string, string>;
const LIFT = ['Light objects', 'Medium objects', 'Anything — even cars'];
function por(def: CharacterDef, cls = 'pimg') {
  const url = portraitOf(def);
  return url ? `<img class="${cls}" src="${url}" alt="${def.name}">` : `<div class="${cls} ini" style="--c:${def.color}">${def.name[0]}</div>`;
}
function bars(id: string) {
  const r = RATINGS[id];
  const row = (label: string, v: number) => `<div class="stat"><span>${label}</span><i>${[1, 2, 3, 4, 5].map((k) => `<b class="${k <= v ? 'on' : ''}"></b>`).join('')}</i></div>`;
  return row('Power', r.power) + row('Speed', r.speed) + row('Range', r.range) + row('Toughness', r.toughness);
}
function sidePanel(side: 0 | 1) {
  const id = side === 0 ? setup.p1 : setup.p2;
  const def = charById(id);
  const who = side === 0 ? 'PLAYER 1' : setup.mode === 'cpu' ? 'CPU' : 'PLAYER 2';
  const active = selectSide === side;
  return `
    <div class="side ${active ? 'active' : ''} s${side}" style="--c:${def.color}" data-act="side" data-arg="${side}">
      <div class="side-who"><span class="badge p${side}">${who}</span>${active ? '<span class="choosing">choosing…</span>' : ''}</div>
      <div class="side-art">${por(def, 'side-img')}</div>
      <div class="side-name">${def.name}</div>
      <div class="side-title">${def.title}</div>
      <div class="stats">${bars(id)}</div>
      <div class="chips"><span class="chip">${ICON[def.recovery]} ${def.recovery} recovery</span><span class="chip">💪 ${LIFT[def.lift]}</span><span class="chip">★ ${RATINGS[id].difficulty}</span></div>
    </div>`;
}

function render(s: Screen): string {
  if (s === 'title') return `
    <div class="screen title-screen">
      <h1 class="logo">BREAK<span>LINE</span></h1>
      <p class="tagline">Superpowered brawls on breakable rooftops and overpasses</p>
      <div class="big-btns">
        <button class="bigbtn primary" data-nav data-act="mode" data-arg="cpu"><span class="ico">▶</span><span><b>Fight the CPU</b><small>Single player</small></span></button>
        <button class="bigbtn" data-nav data-act="mode" data-arg="versus"><span class="ico">⚔</span><span><b>2 Players</b><small>Same screen · two pads, or pad + keyboard</small></span></button>
        <button class="bigbtn" data-nav data-act="moves"><span class="ico">?</span><span><b>How to play</b><small>Controls, combat basics and move lists</small></span></button>
      </div>
      <div class="foot">
        <button class="pill" data-nav data-act="mute">${muted ? '🔇 Sound off' : '🔊 Sound on'}</button>
        <span class="pill static">🎮 ${connectedPads().length ? connectedPads().length + ' controller' + (connectedPads().length > 1 ? 's' : '') + ' connected' : 'Keyboard: WASD + J K L I U O'}</span>
      </div>
    </div>`;
  if (s === 'select') {
    const who = selectSide === 0 ? 'Player 1' : setup.mode === 'cpu' ? 'the CPU' : 'Player 2';
    return `
    <div class="screen select-screen">
      <div class="topbar">
        <button class="pill" data-nav data-act="title">← Back</button>
        <h2>Choose fighters</h2>
        <span class="hintline">Picking for <b>${who}</b></span>
      </div>
      <div class="select-grid">
        ${sidePanel(0)}
        <div class="roster">
          ${ROSTER.map((c) => `
            <button class="rcard ${setup.p1 === c.id ? 'pick1' : ''} ${setup.p2 === c.id ? 'pick2' : ''}" data-nav data-act="pick" data-arg="${c.id}" style="--c:${c.color}">
              ${por(c, 'rimg')}
              <span class="rname">${c.name}</span>
              <span class="rtags">${setup.p1 === c.id ? '<i class="t1">P1</i>' : ''}${setup.p2 === c.id ? `<i class="t2">${setup.mode === 'cpu' ? 'CPU' : 'P2'}</i>` : ''}</span>
            </button>`).join('')}
          <p class="blurb">${charById(selectSide === 0 ? setup.p1 : setup.p2).blurb}</p>
        </div>
        ${sidePanel(1)}
      </div>
      <div class="options">
        <div class="opt"><span class="opt-label">Arena</span><div class="seg">${LAYOUTS.map((l) => `<button class="segbtn ${setup.arena === l.id ? 'on' : ''}" data-nav data-act="arena" data-arg="${l.id}"><span class="arena-sw ${l.id}"></span>${l.name}</button>`).join('')}</div></div>
        ${setup.mode === 'cpu' ? `<div class="opt"><span class="opt-label">CPU level</span><div class="seg">${(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => `<button class="segbtn ${setup.diff === d ? 'on' : ''}" data-nav data-act="diff" data-arg="${d}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</div></div>` : ''}
        <button class="fight" data-nav data-act="fight">FIGHT ▶</button>
      </div>
    </div>`;
  }
  if (s === 'result' && match?.ended) {
    const e = match.ended;
    const how = e.how === 'ko' ? 'K.O.' : e.how === 'ringout' ? 'Ring out' : 'Finisher';
    const wIdx = e.winner.idx;
    const label = setup.mode === 'cpu' ? (wIdx === 0 ? 'You win!' : 'CPU wins') : `Player ${wIdx + 1} wins!`;
    const stat = (f: typeof e.winner) => `
      <div class="rstat" style="--c:${f.def.color}">${por(f.def, 'mini')}<div><b>${f.def.name}</b>
        <span>${f.stats.hits} hits · ${f.stats.throws} throws · ${f.stats.catches} catches · ${f.stats.recoveries} recoveries</span></div></div>`;
    return `
    <div class="screen result-screen" style="--c:${e.winner.def.color}">
      <div class="result-art">${por(e.winner.def, 'result-img')}</div>
      <div class="result-body">
        <p class="kicker">${how}</p>
        <h1 class="result-big">${label}</h1>
        <p class="sub">${e.winner.def.name} takes the bout.</p>
        <div class="rstats">${stat(match.fighters[0])}${stat(match.fighters[1])}</div>
        <div class="row-btns">
          <button class="btn2 primary" data-nav data-act="rematch">↻ Rematch</button>
          <button class="btn2" data-nav data-act="swap">⇄ Swap sides</button>
          <button class="btn2" data-nav data-act="select">Change fighters</button>
          <button class="btn2" data-nav data-act="title">Main menu</button>
        </div>
      </div>
    </div>`;
  }
  if (s === 'pause') return `
    <div class="screen pause-screen">
      <div class="card">
        <h2>Paused</h2>
        <button class="btn2 primary wide" data-nav data-act="resume">▶ Resume</button>
        <button class="btn2 wide" data-nav data-act="rematch">↻ Restart bout</button>
        <button class="btn2 wide" data-nav data-act="moves">? How to play</button>
        <button class="btn2 wide" data-nav data-act="mute">${muted ? '🔇 Sound off' : '🔊 Sound on'}</button>
        <button class="btn2 wide" data-nav data-act="title">Quit to menu</button>
      </div>
    </div>`;
  if (s === 'moves') {
    const tab = (id: typeof howTab, label: string) => `<button class="tab ${howTab === id ? 'on' : ''}" data-nav data-act="tab" data-arg="${id}">${label}</button>`;
    const k = (x: string) => `<kbd>${x}</kbd>`;
    const ctl: [string, string, string, string][] = [
      ['Move', 'Left stick', k('W') + k('A') + k('S') + k('D'), 'Left pad'],
      ['Attack', k('A'), k('J'), 'A'],
      ['Jump', k('B'), k('K'), 'B'],
      ['Grab / pick up / throw', k('X'), k('L'), 'X'],
      ['Guard (tap as a prop arrives to catch it)', k('Y'), k('I'), 'Y'],
      ['Mobility: sprint, swing, fly, teleport', k('LB') + '/' + k('LT'), k('U'), 'L'],
      ['Power modifier', k('RB') + '/' + k('RT'), k('O'), 'R'],
      ['Pause', k('Start'), k('Esc'), '❚❚'],
    ];
    const body = howTab === 'controls' ? `
      <table class="ctl"><thead><tr><th>Action</th><th>Gamepad</th><th>Keyboard</th><th>Touch</th></tr></thead>
      <tbody>${ctl.map(([a, g, kb, t]) => `<tr><td>${a}</td><td>${g}</td><td>${kb}</td><td>${t}</td></tr>`).join('')}</tbody></table>
      <p class="note">Player 2 on keyboard: arrows to move, ${k('.')} attack, ${k('/')} jump, ${k(',')} grab, ${k(';')} guard, ${k('Right Shift')} mobility, ${k('Enter')} power.</p>`
      : howTab === 'combat' ? `
      <div class="tips">
        <div class="tip"><h4>Combos</h4><p>Press ${k('A')} up to three times for a chain. Attack while running, jumping or using mobility for different moves.</p></div>
        <div class="tip"><h4>Power moves</h4><p>Hold ${k('R')} and press ${k('A')}. Keep ${k('A')} held to charge a stronger version, or use it while running for a dash attack. Power moves cost energy (the blue pips).</p></div>
        <div class="tip"><h4>Grabs &amp; throws</h4><p>${k('X')} grabs the opponent or picks up an object. Press ${k('A')} to pummel, ${k('X')} to throw. ${k('R')}+${k('X')} is your fighter's power grapple.</p></div>
        <div class="tip"><h4>Defence</h4><p>Hold ${k('Y')} to guard, and add a direction to roll away. ${k('R')}+${k('Y')} super-blocks and reflects projectiles.</p></div>
        <div class="tip"><h4>Energy &amp; Rage</h4><p>Hold ${k('R')} while standing still to recharge. Landing hits fills Rage: tap ${k('R')} when it's full for ${TUNING.rageDuration}s of unlimited power.</p></div>
        <div class="tip"><h4>Winning</h4><p>Empty their health (<b>K.O.</b>), knock them off the edge (<b>Ring out</b>), or press ${k('R')}+${k('X')} when they flash <b>DANGER</b> and you have one energy pip (<b>Finisher</b>).</p></div>
        <div class="tip"><h4>Recovery</h4><p>Knocked into the air? Press ${k('L')}+${k('R')} to recover. Each fighter recovers differently, and it costs energy.</p></div>
        <div class="tip"><h4>The arena</h4><p>Fences and barriers break. Every broken section is a new way to win by ring out, for either fighter.</p></div>
      </div>`
      : `<div class="fcards">${ROSTER.map((c) => `
        <div class="fcard" style="--c:${c.color}">
          <div class="fhead">${por(c, 'mini')}<div><b>${c.name}</b><span>${c.title}</span></div></div>
          <table class="mlist">${c.sheet.moves.map(([kk, v]) => `<tr><td>${kk}</td><td>${v}</td></tr>`).join('')}<tr><td>Finisher</td><td>${c.sheet.finisher}</td></tr><tr><td>Weakness</td><td>${c.sheet.weakness}</td></tr></table>
        </div>`).join('')}</div>`;
    return `
    <div class="screen how-screen">
      <div class="topbar"><button class="pill" data-nav data-act="back">← Back</button><h2>How to play</h2><span></span></div>
      <div class="tabs">${tab('controls', 'Controls')}${tab('combat', 'Combat')}${tab('fighters', 'Fighters')}</div>
      <div class="how-body">${body}</div>
    </div>`;
  }
  return '';
}

let movesReturn: Screen = 'title';
function rerender(keepFocus = true) {
  const i = focusIdx;
  showScreen(screen);
  if (keepFocus) setFocus(i);
}
function act(a: string, arg?: string) {
  sfx.select();
  switch (a) {
    case 'mode': setup.mode = arg as Mode; selectSide = 0; showScreen('select'); break;
    case 'side': selectSide = Number(arg) as 0 | 1; rerender(); break;
    case 'pick': {
      if (selectSide === 0) { setup.p1 = arg!; selectSide = 1; rerender(); }
      else {
        setup.p2 = arg!;
        showScreen('select');
        // Both chosen: jump to the FIGHT button.
        const f = focusables();
        setFocus(f.findIndex((e) => e.dataset.act === 'fight'));
      }
      break;
    }
    case 'fight': startMatch(); break;
    case 'arena': setup.arena = arg as LayoutId; rerender(); break;
    case 'diff': setup.diff = arg as Difficulty; rerender(); break;
    case 'tab': howTab = arg as typeof howTab; rerender(); break;
    case 'title': if (match) { match.dispose(); match = null; } hud.show(false); stopMusic(); touchRoot.classList.add('off'); showScreen('title'); break;
    case 'select': selectSide = 0; if (match) { match.dispose(); match = null; } hud.show(false); showScreen('select'); break;
    case 'rematch': rematch(false); break;
    case 'swap': rematch(true); break;
    case 'resume': paused = false; showScreen('none'); break;
    case 'moves': movesReturn = screen === 'pause' ? 'pause' : 'title'; howTab = 'controls'; showScreen('moves'); break;
    case 'back': showScreen(movesReturn); break;
    case 'mute': setMuted(!muted); rerender(); break;
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
      if (screen === 'select') { if (selectSide === 1) { selectSide = 0; rerender(); } else act('title'); }
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
    else if (fx.blurAllowed) fx.blurAllowed = false;
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

  updateControlOverlay();
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
  // Sun shadow frustum centred on the action, snapped to texels to stop shimmer.
  {
    const c = match ? vcam.target : new THREE.Vector3(0, 0, 0);
    const texel = (SHADOW_HALF * 2) / sun.shadow.mapSize.x;
    const tx = Math.round(c.x / texel) * texel, tz = Math.round(c.z / texel) * texel;
    sun.target.position.set(tx, 0, tz);
    sun.position.set(tx + sunDir.x * 60, sunDir.y * 60, tz + sunDir.z * 60);
  }
  const raging = !!match && match.fighters.some((f) => f.raging);
  tint.style.opacity = raging ? String(0.38 + Math.sin(time * 10) * 0.08) : '0';
  // Post stack: grade always (cheap); bloom and motion blur only when affordable.
  bloom.enabled = bloomOn;
  const blurAmt = fx.blurAllowed ? Math.min(0.82, fx.blur) : 0;
  blurPass.enabled = blurAmt > 0.05;
  blurPass.uniforms['damp'].value = blurAmt;
  grade.uniforms.time.value = time;
  grade.uniforms.flash.value = Math.min(0.85, fx.screenFlash);
  if (postOn) composer.render(); else renderer.render(scene, vcam.cam);
  adaptQuality(now);
  if (perfEl.style.display !== 'none') {
    const s = perfStats();
    perfEl.textContent = `frame ms p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} p99 ${s.p99.toFixed(1)} worst ${s.worst.toFixed(1)}\nbloom ${bloomOn} post ${postOn} blur ${blurPass.enabled} fx ${fx.quality} dpr ${pixelRatio.toFixed(2)} shadows ${renderer.shadowMap.enabled} calls ${renderer.info.render.calls}`;
  }
}
applyPalette('rooftop');
menu.innerHTML = '<div class="screen"><h1 class="logo">BREAK<span>LINE</span></h1><div class="tagline">Loading fighters…</div></div>';
requestAnimationFrame(frame);

// ============================================================ automation / test hooks
(window as any).THREE = THREE;
const hooks = {
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
  getCPUs() { return cpus; },
  enableCPUs(diff: Difficulty = 'normal') { if (match) cpus = [new CPU(match.fighters[0], match, diff), new CPU(match.fighters[1], match, diff)]; },
  perfStats,
  emptyRaw,
  readGamepad,
  isTouchActive,
  renderer,
  vcam,
};

// Load the rigged body model, then open the menu. Falls back to procedural bodies if it fails.
Promise.all([loadBodyModels('./models'), loadPropModels('./models/props', PROP_MODELS)])
  .catch((e) => console.warn('Rigged body model unavailable, using procedural bodies:', e))
  .finally(() => {
    try { renderPortraits(renderer); } catch (e) { console.warn('portraits failed', e); }
    hud.portraits = (id: string) => portraitOf(charById(id));
    (window as any).__game = hooks;
    showScreen('title');
  });
