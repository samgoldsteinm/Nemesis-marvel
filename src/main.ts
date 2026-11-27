import { Online } from './online';
import { CANON, toCanonical, MatchCfg } from './netplay';
import { FightIntro, VictoryCine } from './intro';
import { updatePadCursor, hidePadCursor } from './padcursor';
import { VFX } from './vfx';
import { TRAITS } from './traits';
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
import { EdgeTracker, installKeyboard, installTouch, readDevices, readGamepad, emptyRaw, RawState, DeviceBinding, connectedPads, isTouchActive, refreshTouchLabels, padLayout, setPadLayout, autoLayoutForPads, layoutText, actionLabel, getBinding, saveBinding, bindingFor, PadBinding, PadSrc, ACTIONS, keyDown, endInputRead, padActivity, noteInput, lastInputKind, setTouchContext } from './input';
import { initAudio, sfx, startMusic, stopMusic, setMuted, muted, setIntensity } from './audio';
import { TUNING } from './fighter';
import { RIM_COLOR } from './characters';
import { renderPortraits, portraitOf, comicOf, faceOf, profileOf } from './portraits';
import { loadBodyModels, loadPropModels } from './skinned';
import { loadCityKit, hasCityKit } from './citykit';
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
  // Unfinished tower at sunset: low orange sun raking across the slab, violet sky overhead.
  construction: {
    sky: [[0, '#2a2038'], [0.42, '#6a3a52'], [0.68, '#d8744a'], [0.84, '#ffc070'], [1, '#4a3038']], fog: 0x9a6a5c, fogNear: 60, fogFar: 230,
    hemi: [0xd8b0a0, 0x3a2a2a, 0.8], sun: [0xffb070, 2.6], sunPos: [-18, 14, 22], rim: [0x7a90ff, 1.0], shadow: [24, 18],
    grade: { sat: 0.85, lift: [0.04, 0.03, 0.035], shadowTint: [0.9, 0.9, 1.1], highTint: [1.05, 0.95, 0.84], gamma: 0.97 }, bloom: [0.4, 0.45, 0.82],
  },
  // Night pier: cold teal fog, sodium-orange key light from the lamps, black water.
  docks: {
    sky: [[0, '#03070c'], [0.5, '#0a1a26'], [0.8, '#1c3a46'], [1, '#0a1218']], fog: 0x1a323c, fogNear: 30, fogFar: 170,
    hemi: [0x7aa0c0, 0x182430, 1.05], sun: [0xffb468, 2.2], sunPos: [8, 30, 10], rim: [0x5ad0ff, 1.3], shadow: [30, 14],
    grade: { sat: 0.85, lift: [0.035, 0.05, 0.07], shadowTint: [0.8, 0.95, 1.2], highTint: [1.08, 0.98, 0.86], gamma: 0.97 }, bloom: [0.5, 0.5, 0.78],
  },
  // Neon district at night: cool moonlight key, magenta rim, violet haze.
  helipad: {
    sky: [[0, '#06030e'], [0.5, '#1a0a30'], [0.78, '#4a1a5a'], [0.9, '#8a2a7a'], [1, '#1a0a20']], fog: 0x2a1438, fogNear: 40, fogFar: 200,
    hemi: [0x8a6ad8, 0x1a0a20, 0.85], sun: [0xb8d8ff, 1.8], sunPos: [12, 30, -10], rim: [0xff4fd8, 1.4], shadow: [14, 14],
    grade: { sat: 0.95, lift: [0.04, 0.02, 0.06], shadowTint: [0.95, 0.85, 1.2], highTint: [1.0, 0.92, 1.05], gamma: 0.96 }, bloom: [0.55, 0.5, 0.75],
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
fx.vfx = new VFX(scene, '');
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

function fitView() {
  const w = window.innerWidth, h = window.innerHeight, aspect = w / h;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  vcam.cam.aspect = aspect;
  // Wide landscape: the horizontal view is wider, so frame closer (fighters read bigger on phones).
  // Small screens get a little extra zoom; portrait pulls back so both fighters fit.
  const wide = aspect > 1.6 ? THREE.MathUtils.clamp(Math.sqrt(1.6 / aspect), 0.8, 1) : aspect < 1 ? 1.25 : 1;
  vcam.zoomMul = wide * (h < 500 && aspect > 1 ? 0.92 : 1);
  vcam.cam.fov = aspect < 1 ? 66 : 57;
  vcam.cam.updateProjectionMatrix();
  document.body.classList.toggle('landscape-short', aspect > 1 && h < 560);
}
window.addEventListener('resize', fitView);
window.addEventListener('orientationchange', () => setTimeout(fitView, 250));
fitView();

/** On phones: go fullscreen and lock to landscape when a match starts (needs a user gesture; silently ignored where unsupported). */
function goLandscape() {
  if (!(('ontouchstart' in window) || navigator.maxTouchPoints > 0)) return;
  const el = document.documentElement as any;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).then(() => (window.screen.orientation as any)?.lock?.('landscape')).catch(() => {});
}

// ============================================================ app state
type Mode = 'cpu' | 'versus' | 'online';
interface Setup { mode: Mode; p1: string; p2: string; diff: Difficulty; p1Human: boolean; arena: LayoutId; lives: number }
const setup: Setup = { mode: 'cpu', p1: 'tether', p2: 'basalt', diff: 'normal', p1Human: true, arena: 'rooftop', lives: 1 };
try { const l = Number(localStorage.getItem('bl.lives')); if ([1, 2, 3, 5].includes(l)) setup.lives = l; } catch { /* storage optional */ }
let match: Match | null = null;
let cpus: (CPU | null)[] = [null, null];
const trackers = [new EdgeTracker(), new EdgeTracker()];
let paused = false;
type Screen = 'start' | 'title' | 'mode' | 'select' | 'result' | 'pause' | 'moves' | 'padsetup' | 'online' | 'none';
let screen: Screen = 'title' as Screen;
/** Test/automation override: when set, replaces a player's raw input each tick. */
const forced: (RawState | null)[] = [null, null];
let simSpeed = 1;
let manualStep = false;

function bindings(): DeviceBinding[] {
  if (setup.mode === 'cpu' || setup.mode === 'online') return [{ keyboard: [0, 1], gamepad: 0, touch: true }, { keyboard: [], gamepad: null, touch: false }];
  return [{ keyboard: [0], gamepad: 0, touch: true }, { keyboard: [1], gamepad: 1, touch: false }];
}

let intro: FightIntro | null = null;
let lastIntroT = -1;
let introsOn = true, voicesOn = true;
try { introsOn = localStorage.getItem('bl.intros') !== '0'; voicesOn = localStorage.getItem('bl.voices') !== '0'; } catch { /* storage optional */ }
const introEl = document.getElementById('intro')!;
function endIntro() { if (intro) { intro.finish(); intro = null; } if (victory) { victory.finish(); victory = null; } victoryDone = false; }
/** Victory cinematic after the final K.O. (presentational only; skipped when intros are off or for test matches). */
let victory: VictoryCine | null = null, victoryDone = false, matchCine = false;
function startMatch(withIntro = true, seed?: number) {
  endIntro();
  if (match) match.dispose();
  const d: [CharacterDef, CharacterDef] = [charById(setup.p1), charById(setup.p2)];
  if (arena.layout !== setup.arena) arena.setLayout(setup.arena);
  applyPalette(setup.arena);
  vcam.zLimit = setup.arena === 'overpass' ? 5.8 : Infinity;
  match = new Match(scene, arena, fx, vcam, d);
  if (seed !== undefined) match.restart(seed);
  match.setLives(setup.lives);
  cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null];
  trackers.forEach((t) => t.reset());
  hud.setNames(match, setup.mode === 'cpu' ? ['YOU', `CPU · ${setup.diff}`] : setup.mode === 'online' ? (online.side === 0 ? ['YOU', 'ONLINE'] : ['ONLINE', 'YOU']) : ['PAD 1 / WASD', 'PAD 2 / ARROWS']);
  hud.show(true);
  keysHint.innerHTML = 'Move <b>WASD</b> · Attack <b>J</b> · Jump <b>K</b> · Grab <b>L</b> · Guard <b>I</b> · Mobility <b>U</b> · Power <b>O</b> · Pause <b>Esc</b>' + (setup.mode === 'versus' ? '<br>P2: Arrows · Attack <b>.</b> · Jump <b>/</b> · Grab <b>,</b> · Guard <b>;</b> · Mobility <b>R-Shift</b> · Power <b>Enter</b> (or numpad 1 2 3 5 4 6)' : '');
  if (connectedPads().length) noteInput('pad');
  updateControlOverlay();
  paused = false;
  showScreen('none');
  startMusic('fight', setup.arena);
  setIntensity(0);
  matchCine = introsOn && withIntro;
  if (introsOn && withIntro) intro = new FightIntro(match, vcam, introEl, voicesOn);
}

// ------------------------------------------------------------ online play (see online.ts / netplay.ts / net.ts)
const online = new Online({
  show: (s) => showScreen(s as Screen),
  rerender: () => { if (screen === 'select' || screen === 'online' || screen === 'result') rerender(); },
  toast: (m) => toast(m),
  startMatch: (cfg: MatchCfg) => {
    setup.mode = 'online'; setup.p1 = cfg.p1; setup.p2 = cfg.p2; setup.arena = cfg.arena as LayoutId; setup.lives = cfg.lives;
    goLandscape();
    startMatch(true, cfg.seed);
    if (!intro) online.introDone();
  },
  match: () => match,
  simulate: (pair) => { forced[0] = pair[0]; forced[1] = pair[1]; simTick(); forced[0] = forced[1] = null; },
  sample: () => {
    if (!match || (screen !== 'none' && screen !== 'pause')) return emptyRaw();
    if (screen === 'pause') return emptyRaw();
    const raw = readDevices(bindings()[0]);
    return toCanonical(raw, vcam.fwd, vcam.right);
  },
  onFight: () => { trackers.forEach((t) => t.reset()); paused = false; if (screen !== 'none' && screen !== 'pause') showScreen('none'); },
  leave: () => { endIntro(); if (match) { match.dispose(); match = null; } hud.show(false); touchRoot.classList.add('off'); paused = false; setup.mode = 'cpu'; startMusic('menu'); },
});
/** A ?room=CODE link joins that room after Press Start. */
let pendingRoom = '';
try { pendingRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase(); } catch { /* */ }
function syncOnlineSelect() {
  const s = online.session;
  if (!s) return;
  setup.mode = 'online';
  const mine = s.me, theirs = s.them;
  if (online.side === 0) { setup.p1 = mine.pick; setup.p2 = theirs.pick; } else { setup.p1 = theirs.pick; setup.p2 = mine.pick; }
  locked[online.side] = mine.locked; locked[1 - online.side] = theirs.locked;
  selectSide = online.side;
  setup.arena = s.arena as LayoutId; setup.lives = s.lives;
}
/** Online versions of select-screen actions. Returns true when handled. */
function onlineAct(a: string, arg?: string): boolean {
  const s = online.session;
  if (!online.active) return false;
  switch (a) {
    case 'pick': if (!s) return true; if (s.me.locked) { s.setPick(arg!, false); return true; } s.setPick(arg!, s.me.pick === arg); return true;
    case 'confirm': if (s) s.setPick(s.me.pick, true); return true;
    case 'side': return true;
    case 'fight': return true;
    case 'arenaStep': if (s && online.isHost) { const i = LAYOUTS.findIndex((l) => l.id === s.arena); const n = LAYOUTS[(i + Number(arg) + LAYOUTS.length) % LAYOUTS.length]; s.setCfg(n.id, s.lives); } return true;
    case 'lives': if (s && online.isHost) s.setCfg(s.arena, Number(arg)); return true;
    case 'rematch': online.rematch(); rerender(); return true;
    case 'swap': return true;
    case 'select': return true;
    case 'title': case 'online-leave': online.close(); online.error = ''; act('title-raw'); return true;
    case 'resume': paused = false; showScreen('none'); return true;
  }
  return false;
}
function renderOnline() {
  const err = online.error ? `<p class="net-err">${online.error}</p>` : '';
  if (!online.active) return `
    <div class="screen online-screen">
      <div class="topbar"><button class="pill" data-nav data-act="title">← Back</button><h2>Play online</h2><span></span></div>
      <div class="net-body">
        ${err}
        <div class="net-cards">
          <div class="net-card"><h3>Host a match</h3><p>Get a room code and send it (or the link) to a friend.</p><button class="btn2 primary" data-nav data-act="online-host">Host</button></div>
          <div class="net-card"><h3>Join a match</h3><p>Enter the code your friend gave you.</p>
            <input id="roomCode" class="net-code-in" maxlength="6" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false">
            <button class="btn2 primary" data-nav data-act="online-join">Join</button></div>
        </div>
        <p class="note">1v1 over the internet. Players connect directly when possible and through a relay otherwise; no account needed.</p>
      </div>
    </div>`;
  const host = online.isHost;
  return `
    <div class="screen online-screen">
      <div class="topbar"><button class="pill" data-nav data-act="online-leave">← Leave</button><h2>${host ? 'Hosting' : 'Joining'}</h2><span></span></div>
      <div class="net-body">
        ${err}
        <p class="note">Room code</p>
        <div class="net-code">${online.code}</div>
        ${host ? `<p class="note">Send this code to a friend, or share the link:</p><div class="net-link"><input readonly value="${online.shareUrl}"><button class="pill" data-nav data-act="online-copy">Copy link</button></div>` : ''}
        <p class="net-status"><span class="dot ${online.connected ? 'ok' : ''}"></span>${online.connected ? 'Connected!' : host ? 'Waiting for your opponent to join…' : 'Connecting to the room…'}</p>
      </div>
    </div>`;
}
const netStat = document.createElement('div');
netStat.id = 'netstat';
document.body.appendChild(netStat);
function updateNetStat() {
  const show = online.active && !!match && (screen === 'none' || screen === 'pause');
  netStat.style.display = show ? '' : 'none';
  if (!show) return;
  const p = online.ping;
  netStat.className = p < 90 ? 'good' : p < 180 ? 'ok' : 'bad';
  netStat.innerHTML = `<i></i>${p ? p + ' ms' : '…'} · ${online.direct ? 'direct' : 'relay'}${online.waiting ? ' · <b>waiting for opponent…</b>' : online.phase === 'intro' ? ' · <b>getting ready…</b>' : ''}`;
}

function rematch(swap = false) {
  if (swap) { const t = setup.p1; setup.p1 = setup.p2; setup.p2 = t; }
  if (swap || !match) startMatch();
  else { endIntro(); match.restart(); cpus = [null, setup.mode === 'cpu' ? new CPU(match.fighters[1], match, setup.diff) : null]; trackers.forEach((t) => t.reset()); paused = false; showScreen('none'); }
}

/** Show touch buttons only for touch players and key hints only for keyboard players; a gamepad hides both. */
function updateControlOverlay() {
  if (padActivity()) noteInput('pad');
  const inMatch = !!match && screen === 'none';
  touchRoot.classList.toggle('off', !(inMatch && lastInputKind === 'touch'));
  keysHint.style.display = inMatch && lastInputKind === 'keys' ? '' : 'none';
  document.body.classList.toggle('in-match', inMatch);
  document.body.classList.toggle('touch-mode', lastInputKind === 'touch');
  // Contextual touch buttons (Rage, Finish, Recover, Charge, Throw) for the local touch player.
  if (inMatch && lastInputKind === 'touch' && match) {
    const f = match.fighters[setup.mode === 'online' ? online.side : 0];
    setTouchContext({
      rage: f.alive && f.rage >= 100 && !f.raging,
      finish: f.alive && f.opp.danger && f.hasEnergy(TUNING.finisherCost),
      recover: f.alive && f.state === 'launched' && f.t > 6 && f.hasEnergy(TUNING.recoveryCost),
      holding: !!f.heldProp,
      charge: f.alive && f.onGround && (f.state === 'ground' || f.state === 'charge') && f.energy < 100 && !f.raging,
      guarding: f.state === 'guard' || f.state === 'sblock',
    });
  }
}
window.addEventListener('gamepadconnected', () => { noteInput('pad'); autoLayoutForPads(); refreshLayoutLabels(); updateControlOverlay(); });
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
    el.addEventListener('click', (e) => { e.stopPropagation(); initAudio(); act(el.dataset.act!, el.dataset.arg); });
  });
  setFocus(0);
}

let selectSide: 0 | 1 = 0; // which player is choosing on the fighter screen
/** Whether each side has locked in its fighter. Tapping a card only previews it until it's confirmed. */
const locked: [boolean, boolean] = [false, false];
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
      <div class="side-who"><span class="badge p${side}">${who}</span>${locked[side] ? '<span class="lockd">✓ Locked in</span>' : active ? '<span class="choosing">previewing…</span>' : ''}</div>
      <div class="side-art">${por(def, 'side-img')}</div>
      <div class="side-name">${def.name}</div>
      <div class="side-title">${def.title}</div>
      <div class="stats">${bars(id)}</div>
      ${TRAITS[id] ? `<div class="trait" title="${TRAITS[id].desc}"><b>✦ ${TRAITS[id].name}</b> ${TRAITS[id].desc}</div>` : ''}
      <div class="chips"><span class="chip">${ICON[def.recovery]} ${def.recovery} recovery</span><span class="chip">💪 ${LIFT[def.lift]}</span><span class="chip">★ ${RATINGS[id].difficulty}</span></div>
    </div>`;
}

// ------------------------------------------------------------ menu art helpers
/** A city skyline silhouette (deterministic per seed) as an SVG data URL, for comic-style panel backdrops. */
const skylineCache = new Map<number, string>();
function skyline(seed: number) {
  let url = skylineCache.get(seed);
  if (url) return url;
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  let x = 0, back = '', front = '', wins = '';
  while (x < 400) { const w = 14 + rnd() * 30, h = 70 + rnd() * 110; back += `<rect x="${x.toFixed(1)}" y="${(260 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`; x += w + 1; }
  x = -6;
  while (x < 400) {
    const w = 22 + rnd() * 40, h = 40 + rnd() * 120;
    front += `<rect x="${x.toFixed(1)}" y="${(260 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
    if (rnd() < 0.35) front += `<rect x="${(x + w * 0.45).toFixed(1)}" y="${(260 - h - 14).toFixed(1)}" width="2" height="14"/>`;
    for (let wy = 260 - h + 8; wy < 250; wy += 9) for (let wx = x + 4; wx < x + w - 4; wx += 7) if (rnd() < 0.16) wins += `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="3" height="4"/>`;
    x += w + 2;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260" preserveAspectRatio="xMidYMax slice"><g fill="rgba(0,0,0,0.28)">${back}</g><g fill="rgba(0,0,0,0.55)">${front}</g><g fill="rgba(255,255,255,0.18)">${wins}</g></svg>`;
  url = `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`; // single quotes: it goes inside a double-quoted style attribute
  skylineCache.set(seed, url);
  return url;
}
/** Button prompts that follow the device in use: pad (A/B), keyboard (Enter/Esc) or touch. */
function prompts(items: ['confirm' | 'back' | 'tab', string][]) {
  const pad = connectedPads().length > 0 && lastInputKind !== 'touch';
  const touch = lastInputKind === 'touch';
  const key = (k: string) => (pad ? { confirm: 'A', back: 'B', tab: 'LB/RB' } : { confirm: 'Enter', back: 'Esc', tab: '←→' })[k as 'confirm'];
  if (touch) return `<div class="prompts"><span><i class="pk tap">☝</i>${items.find(([k]) => k === 'confirm')?.[1] ?? 'Tap'}</span></div>`;
  return `<div class="prompts">${items.map(([k, t]) => `<span><i class="pk ${pad ? 'pad-' + k : 'key'}">${key(k)}</i>${t}</span>`).join('')}</div>`;
}
function pressLabel() {
  if (lastInputKind === 'touch') return 'Tap to start';
  if (connectedPads().length) return 'Press START';
  return 'Press Enter';
}
/** The fighter shown on the title screen (changes each visit). */
let titleHero = ROSTER[Math.floor(Math.random() * ROSTER.length)];

function renderStart() {
  const prof = profileOf('shunt') || profileOf('rift');
  return `
    <div class="screen start-screen" data-act="start">
      <div class="band"><i class="smoke s1"></i><i class="smoke s2"></i><i class="smoke s3"></i>${prof ? `<img class="prof" src="${prof}" alt="">` : ''}</div>
      <div class="logo-wrap"><h1 class="chrome">BREAK<span>LINE</span></h1><div class="chrome-sub">ROOFTOP · OVERPASS · NO WAY DOWN</div></div>
      <div class="press">${pressLabel()}</div>
      <div class="copy">© 2026 BREAKLINE</div>
    </div>`;
}
function renderTitle() {
  const h = titleHero;
  return `
    <div class="screen title-screen">
      <div class="title-art" style="--c:${h.color};--sky:${skyline(7)}"><div class="bg"></div>${comicOf(h) ? `<img class="pose" src="${comicOf(h)}" alt="">` : ''}<div class="hero-name">${h.name}</div></div>
      <div class="title-menu">
        <h1 class="chrome small">BREAK<span>LINE</span></h1>
        <div class="big-btns">
          <button class="bigbtn primary" data-nav data-act="mode" data-arg="cpu"><span class="ico">▶</span><span><b>Fight the CPU</b><small>Single player</small></span></button>
          <button class="bigbtn" data-nav data-act="mode" data-arg="versus"><span class="ico">⚔</span><span><b>2 Players</b><small>Same screen · two pads, or pad + keyboard</small></span></button>
          <button class="bigbtn" data-nav data-act="online"><span class="ico">🌐</span><span><b>Play online</b><small>1v1 with a friend · room code</small></span></button>
          <button class="bigbtn" data-nav data-act="moves"><span class="ico">?</span><span><b>How to play</b><small>Controls, combat basics and move lists</small></span></button>
        </div>
        <div class="foot">
          <button class="pill" data-nav data-act="mute"><i class="pi">${muted ? '🔇' : '🔊'}</i> Sound ${muted ? 'off' : 'on'}</button>
          <button class="pill" data-nav data-act="intros"><i class="pi">🎬</i> Intros ${introsOn ? 'on' : 'off'}</button>
          <button class="pill" data-nav data-act="voices"><i class="pi">🗣</i> Voices ${voicesOn ? 'on' : 'off'}</button>
          <button class="pill" data-nav data-act="layoutcycle"><i class="pi">🎮</i> ${padLayout === 'xbox' ? 'Xbox' : 'GameCube'}<span class="pl-long"> buttons</span></button>
          <span class="pill static">${connectedPads().length ? connectedPads().length + ' controller' + (connectedPads().length > 1 ? 's' : '') + ' connected' : 'Keyboard: WASD + J K L I U O'}</span>
        </div>
      </div>
      ${prompts([['confirm', 'Select']])}
    </div>`;
}
/** One side of the fighter select: a comic-toned pose over a duotone skyline, with the fighter's info. */
/** Phones: each select panel's stats are tucked behind a tap so the fighter art can be big. */
const statsOpen: [boolean, boolean] = [false, false];
function selHalf(side: 0 | 1) {
  const id = side === 0 ? setup.p1 : setup.p2;
  const def = charById(id);
  const who = setup.mode === 'online' ? (side === online.side ? 'YOU' : 'OPPONENT') : side === 0 ? 'PLAYER 1' : setup.mode === 'cpu' ? 'CPU' : 'PLAYER 2';
  const active = selectSide === side && !(locked[0] && locked[1]);
  const art = comicOf(def);
  return `
    <div class="half h${side} ${active ? 'active' : ''} ${locked[side] ? 'locked' : ''} ${statsOpen[side] ? 'stats-open' : ''}" style="--c:${def.color};--sky:${skyline(side ? 11 : 3)}" data-act="side" data-arg="${side}">
      <div class="bg"></div>
      <div class="art">${art ? `<img class="pose" src="${art}" alt="${def.name}">` : `<div class="pose ini">${def.name[0]}</div>`}</div>
      <div class="tag"><span class="badge p${side}">${who}</span>${locked[side] ? '<span class="lockd">✓ LOCKED IN</span>' : active ? '<span class="choosing">CHOOSING…</span>' : ''}</div>
      <div class="info">
        <div class="nm">${def.name}</div>
        <div class="ttl">${def.title}</div>
        <button class="stats-tog" data-act="stats" data-arg="${side}" aria-expanded="${statsOpen[side]}">${statsOpen[side] ? '✕ Hide stats' : 'ⓘ Stats'}</button>
        <div class="stats">${bars(id)}</div>
        ${TRAITS[id] ? `<div class="trait"><b>✦ ${TRAITS[id].name}</b> ${TRAITS[id].desc}</div>` : ''}
        <div class="chips"><span class="chip">${ICON[def.recovery]} ${def.recovery} recovery</span><span class="chip">💪 ${LIFT[def.lift]}</span><span class="chip">★ ${RATINGS[id].difficulty}</span></div>
      </div>
    </div>`;
}
function renderSelect() {
  const who = setup.mode === 'online' ? 'you' : selectSide === 0 ? 'Player 1' : setup.mode === 'cpu' ? 'the CPU' : 'Player 2';
  const cur = LAYOUTS.find((l) => l.id === setup.arena)!;
  const net = online.active;
  const netNote = net ? `<div class="net-sel"><span class="dot ok"></span>Online · room ${online.code} · ${online.ping || '…'} ms${online.isHost ? ' · you pick the arena and lives' : ' · the host picks the arena and lives'}${locked[online.side] && !locked[1 - online.side] ? ' · waiting for your opponent to lock in…' : ''}</div>` : '';
  return `
    <div class="screen select-screen">
      <div class="sel-top">
        <button class="btn-back" data-nav data-act="title">◀ Back</button>
        <h2 class="sel-h">${locked[0] && locked[1] ? 'Ready to fight' : `Choose a fighter <small>for ${who}</small>`}</h2>
        ${prompts([['confirm', locked[0] && locked[1] ? 'Fight' : 'Preview · again to lock in'], ['back', 'Back']])}
      </div>
      ${netNote}
      <div class="vs">${selHalf(0)}${selHalf(1)}<svg class="seam" viewBox="0 0 100 100" preserveAspectRatio="none">${['glow', 'edge', 'core'].map((k) => `<line class="${k} ls" x1="54" y1="0" x2="46" y2="100"/><line class="${k} pt" x1="0" y1="54" x2="100" y2="46"/>`).join('')}</svg><div class="vsmark">VS</div></div>
      <div class="strip">
        ${ROSTER.map((c) => {
          const f = faceOf(c);
          return `<button class="th ${setup.p1 === c.id ? 'pick1' : ''} ${setup.p2 === c.id ? 'pick2' : ''}" data-nav data-act="pick" data-arg="${c.id}" style="--c:${c.color}" title="${c.name}">
            <span class="thi">${f ? `<img src="${f}" alt="${c.name}">` : `<b>${c.name[0]}</b>`}</span>
            <span class="thn">${c.name}</span>
            ${setup.p1 === c.id ? '<i class="t1">1</i>' : ''}${setup.p2 === c.id ? `<i class="t2">${setup.mode === 'cpu' ? 'C' : '2'}</i>` : ''}
          </button>`;
        }).join('')}
      </div>
      <div class="options">
        <div class="opt"><span class="opt-label">Arena</span><div class="seg arena-pick"><button class="segbtn arr" data-nav data-act="arenaStep" data-arg="-1" aria-label="Previous arena">◀</button><button class="segbtn on arena-cur" data-nav data-act="arenaStep" data-arg="1" title="${cur.blurb}"><span class="arena-sw ${setup.arena}"></span><span class="lfull">${cur.name}</span><span class="lshort">${cur.short}</span><small class="anum">${LAYOUTS.findIndex((l) => l.id === setup.arena) + 1}/${LAYOUTS.length}</small></button><button class="segbtn arr" data-nav data-act="arenaStep" data-arg="1" aria-label="Next arena">▶</button></div></div>
        <div class="opt"><span class="opt-label">Lives</span><div class="seg">${[1, 2, 3, 5].map((n) => `<button class="segbtn ${setup.lives === n ? 'on' : ''}" data-nav data-act="lives" data-arg="${n}">${n} ♥</button>`).join('')}</div></div>
        ${setup.mode === 'cpu' ? `<div class="opt"><span class="opt-label">CPU level</span><div class="seg">${(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => `<button class="segbtn ${setup.diff === d ? 'on' : ''}" data-nav data-act="diff" data-arg="${d}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</div></div>` : ''}
        ${net && locked[0] && locked[1] ? '<button class="fight" disabled>Starting…</button>' : locked[0] && locked[1]
          ? '<button class="fight" data-nav data-act="fight">FIGHT ▶</button>'
          : `<button class="fight confirm" data-nav data-act="confirm">${net && locked[online.side] ? 'Waiting…' : `✓ Lock in<span class="cname"> ${charById(selectSide === 0 ? setup.p1 : setup.p2).name}</span>`}</button>`}
      </div>
    </div>`;
}
function renderResult() {
  if (!match?.ended) return '';
  const e = match.ended;
  const how = e.how === 'ko' ? 'K.O.' : e.how === 'ringout' ? 'Ring out' : 'Finisher';
  const wIdx = e.winner.idx;
  const label = setup.mode === 'cpu' ? (wIdx === 0 ? 'You win!' : 'CPU wins') : setup.mode === 'online' ? (wIdx === online.side ? 'You win!' : 'You lose') : `Player ${wIdx + 1} wins!`;
  const stat = (f: typeof e.winner) => `
    <div class="rstat" style="--c:${f.def.color}">${faceOf(f.def) ? `<img class="mini" src="${faceOf(f.def)}" alt="">` : por(f.def, 'mini')}<div><b>${f.def.name}</b>
      <span>${f.stats.hits} hits · ${f.stats.throws} throws · ${f.stats.catches} catches · ${f.stats.recoveries} recoveries</span></div></div>`;
  return `
    <div class="screen result-screen" style="--c:${e.winner.def.color};--sky:${skyline(19)}">
      <div class="result-art"><div class="bg"></div>${comicOf(e.winner.def) ? `<img class="result-img" src="${comicOf(e.winner.def)}" alt="">` : por(e.winner.def, 'result-img')}</div>
      <div class="result-body">
        <p class="kicker">${how}</p>
        <h1 class="result-big">${label}</h1>
        <p class="sub">${e.winner.def.name} takes the bout.</p>
        <div class="rstats">${stat(match.fighters[0])}${stat(match.fighters[1])}</div>
        <div class="row-btns">${online.active ? `
          <button class="btn2 primary" data-nav data-act="rematch">${online.session?.rematchMine ? 'Waiting for opponent…' : online.session?.rematchTheirs ? '↻ Rematch (opponent is ready)' : '↻ Rematch'}</button>
          <button class="btn2" data-nav data-act="title">Leave</button>` : `
          <button class="btn2 primary" data-nav data-act="rematch">↻ Rematch</button>
          <button class="btn2" data-nav data-act="swap">⇄ Swap sides</button>
          <button class="btn2" data-nav data-act="select">Change fighters</button>
          <button class="btn2" data-nav data-act="title">Main menu</button>`}
        </div>
      </div>
    </div>`;
}

function render(s: Screen): string {
  if (s === 'start') return renderStart();
  if (s === 'title') return renderTitle();
  if (s === 'online') return renderOnline();
  if (s === 'select') { if (online.active) syncOnlineSelect(); return renderSelect(); }
  if (s === 'result') return renderResult();
  if (s === 'pause') return `
    <div class="screen pause-screen">
      <div class="card">
        <h2 class="paused-h">Paused</h2>
        <button class="btn2 primary wide" data-nav data-act="resume">▶ Resume</button>
        ${online.active ? '<p class="note">Online: the match keeps running while this menu is open.</p>' : '<button class="btn2 wide" data-nav data-act="rematch">↻ Restart bout</button>'}
        <button class="btn2 wide" data-nav data-act="moves">? How to play</button>
        <button class="btn2 wide" data-nav data-act="mute"><i class="pi">${muted ? '🔇' : '🔊'}</i> Sound ${muted ? 'off' : 'on'}</button>
        <button class="btn2 wide" data-nav data-act="title">${online.active ? 'Leave match' : 'Quit to menu'}</button>
      </div>
    </div>`;
  if (s === 'padsetup') {
    const steps = PAD_STEPS.map(([a, name], i) => {
      const src = setupBind[a];
      const got = src && src.length ? ('b' in src[0] ? `button ${src[0].b}` : `axis ${src[0].a}${src[0].dir > 0 ? '+' : '−'}`) : '';
      return `<li class="${i === setupStep ? 'cur' : i < setupStep ? 'done' : ''}"><b>${name}</b><span>${i < setupStep ? (got || 'skipped') : i === setupStep ? 'press a button…' : ''}</span></li>`;
    }).join('');
    const pad = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((g) => g && g.connected) : null;
    return `
    <div class="screen how-screen">
      <div class="topbar"><button class="pill" data-nav data-act="padsetup-cancel">← Back</button><h2>Set up controller</h2><span></span></div>
      <div class="how-body">
        ${pad ? `<p class="note">Controller: <b>${pad.id.replace(/</g, '')}</b></p>` : '<p class="note"><b>Plug in or press a button on your controller.</b></p>'}
        <p class="note">Press the button you want for each action. Triggers work too.</p>
        <ol class="padsteps">${steps}</ol>
        <div class="padopts"><button class="pill" data-nav data-act="padsetup-skip">Skip this one</button><button class="pill" data-nav data-act="padsetup-reset">Reset to default</button></div>
      </div>
    </div>`;
  }
  if (s === 'moves') {
    const tab = (id: typeof howTab, label: string) => `<button class="tab ${howTab === id ? 'on' : ''}" data-nav data-act="tab" data-arg="${id}">${label}</button>`;
    const k = (x: string) => `<kbd>${x}</kbd>`;
    const kp = (x: string) => `<kbd>${layoutText(x)}</kbd>`; // pad button, named for the active layout
    const ctl: [string, string, string, string][] = [
      ['Move', 'Left stick', k('W') + k('A') + k('S') + k('D'), 'Drag anywhere on the left'],
      ['Attack', kp('X'), k('J'), 'ATTACK'],
      ['Jump', kp('A'), k('K'), 'JUMP'],
      ['Grab / pick up / throw', kp('Y'), k('L'), 'GRAB (becomes THROW)'],
      ['Guard (tap as a prop arrives to catch it)', padLayout === 'gamecube' ? kp('B') : kp('B') + '/' + kp('LT'), k('I'), 'GUARD (+ stick = dodge)'],
      ['Mobility: sprint, swing, fly, teleport', kp('LB'), k('U'), 'DASH (hold)'],
      ['Power modifier', padLayout === 'gamecube' ? kp('RT') : kp('RT') + '/' + kp('RB'), k('O'), 'SPECIAL = power attack · hold to charge it up'],
      ['Pause', k('Start'), k('Esc'), '❚❚'],
    ];
    const body = howTab === 'controls' ? `
      <table class="ctl"><thead><tr><th>Action</th><th>Gamepad</th><th>Keyboard</th><th>Touch</th></tr></thead>
      <tbody>${ctl.map(([a, g, kb, t]) => `<tr><td>${a}</td><td>${g}</td><td>${kb}</td><td>${t}</td></tr>`).join('')}</tbody></table>
      <div class="padopts"><span class="opt-label">Button layout</span><div class="seg">${(['xbox', 'gamecube'] as const).map((l) => `<button class="segbtn ${padLayout === l ? 'on' : ''}" data-nav data-act="layout" data-arg="${l}">${l === 'xbox' ? 'Xbox' : 'GameCube'}</button>`).join('')}</div>
        <button class="pill" data-nav data-act="padsetup">🎮 Set up controller</button></div>
      <p class="note"><b>On a phone:</b> drag anywhere on the left half to move. <b>GUARD + SPECIAL</b> together = super block. Extra buttons pop up when you can use them: <b>RAGE</b> (meter full), <b>FINISH</b> (opponent in Danger), <b>RECOVER</b> (knocked into the air) and <b>CHARGE</b> (hold to refill energy).</p>
      <p class="note">GameCube controllers switch to the GameCube layout automatically. If a button doesn't respond (some adapters report unusual button numbers), use <b>Set up controller</b> and press each button once.</p>
      <p class="note">Player 2 on keyboard: arrows to move, ${k('.')} attack, ${k('/')} jump, ${k(',')} grab, ${k(';')} guard, ${k('Right Shift')} mobility, ${k('Enter')} power.</p>`
      : howTab === 'combat' ? `
      <div class="tips">
        <div class="tip"><h4>Combos</h4><p>Press ${kp('X')} up to three times for a chain. Attack while running, jumping or using mobility for different moves.</p></div>
        <div class="tip"><h4>Power moves</h4><p>Hold ${kp('RT')} and press ${kp('X')}. Keep ${kp('X')} held to charge a stronger version, or use it while running for a dash attack. Power moves cost energy (the blue pips).</p></div>
        <div class="tip"><h4>Grabs &amp; throws</h4><p>${kp('Y')} grabs the opponent or picks up an object. Press ${kp('X')} to pummel, ${kp('Y')} to throw. ${kp('RT')}+${kp('Y')} is your fighter's power grapple.</p></div>
        <div class="tip"><h4>Defence</h4><p>Hold ${kp('B')} to guard, and add a direction to roll away. ${kp('RT')}+${kp('B')} super-blocks and reflects projectiles.</p></div>
        <div class="tip"><h4>Energy &amp; Rage</h4><p>Hold ${kp('RT')} while standing still to recharge. Landing hits fills Rage: tap ${kp('RT')} when it's full for ${TUNING.rageDuration}s of unlimited power.</p></div>
        <div class="tip"><h4>Winning</h4><p>Empty their health (<b>K.O.</b>), knock them off the edge (<b>Ring out</b>), or press ${kp('RT')}+${kp('Y')} when they flash <b>DANGER</b> and you have one energy pip (<b>Finisher</b>).</p></div>
        <div class="tip"><h4>Recovery</h4><p>Knocked into the air? Press ${kp('LB')}+${kp('RT')} to recover. Each fighter recovers differently, and it costs energy.</p></div>
        <div class="tip"><h4>The arena</h4><p>Fences and barriers break. Every broken section is a new way to win by ring out, for either fighter.</p></div>
      </div>`
      : `<div class="fcards">${ROSTER.map((c) => `
        <div class="fcard" style="--c:${c.color}">
          <div class="fhead">${por(c, 'mini')}<div><b>${c.name}</b><span>${c.title}</span></div></div>
          <table class="mlist">${c.sheet.moves.map(([kk, v]) => `<tr><td>${layoutText(kk)}</td><td>${layoutText(v)}</td></tr>`).join('')}${TRAITS[c.id] ? `<tr><td>Trait</td><td><b>${TRAITS[c.id].name}:</b> ${TRAITS[c.id].desc}</td></tr>` : ''}<tr><td>Finisher</td><td>${c.sheet.finisher}</td></tr><tr><td>Weakness</td><td>${c.sheet.weakness}</td></tr></table>
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
  if (a === 'back' || a === 'title') sfx.back(); else if (a === 'confirm' || a === 'fight') sfx.lockIn(); else sfx.select();
  if (onlineAct(a, arg)) return;
  switch (a) {
    case 'start': startPressed(); break;
    case 'online': online.error = ''; showScreen('online'); break;
    case 'online-host': online.host(); break;
    case 'online-join': { const el = document.getElementById('roomCode') as HTMLInputElement | null; online.join(el?.value ?? ''); break; }
    case 'online-copy': try { void navigator.clipboard.writeText(online.shareUrl); toast('Link copied'); } catch { toast(online.shareUrl); } break;
    case 'online-leave': break;
    case 'title-raw': act('title'); break;
    case 'mode': setup.mode = arg as Mode; selectSide = 0; locked[0] = locked[1] = false; showScreen('select'); break;
    case 'side': selectSide = Number(arg) as 0 | 1; locked[selectSide] = false; rerender(); break;
    case 'stats': { const sd = Number(arg) as 0 | 1; statsOpen[sd] = !statsOpen[sd]; rerender(); break; }
    case 'pick': {
      // Tap = preview (stats, trait, portrait). Tapping the previewed fighter again confirms it.
      const cur = selectSide === 0 ? setup.p1 : setup.p2;
      if (cur === arg) { act('confirm'); return; }
      if (selectSide === 0) setup.p1 = arg!; else setup.p2 = arg!;
      locked[selectSide] = false;
      rerender();
      break;
    }
    case 'confirm': {
      locked[selectSide] = true;
      if (!locked[1]) selectSide = 1;
      else if (!locked[0]) selectSide = 0;
      showScreen('select');
      const f = focusables();
      // Both locked: jump to FIGHT; otherwise to the next confirm button.
      setFocus(f.findIndex((e) => e.dataset.act === 'fight' || e.dataset.act === 'confirm'));
      break;
    }
    case 'fight': goLandscape(); startMatch(); break;
    case 'arena': setup.arena = arg as LayoutId; rerender(); break;
    case 'arenaStep': {
      const i = LAYOUTS.findIndex((l) => l.id === setup.arena);
      setup.arena = LAYOUTS[(i + Number(arg) + LAYOUTS.length) % LAYOUTS.length].id;
      rerender();
      break;
    }
    case 'diff': setup.diff = arg as Difficulty; rerender(); break;
    case 'lives': setup.lives = Number(arg); try { localStorage.setItem('bl.lives', String(setup.lives)); } catch { /* */ } rerender(); break;
    case 'tab': howTab = arg as typeof howTab; rerender(); break;
    case 'title': titleHero = ROSTER[Math.floor(Math.random() * ROSTER.length)]; endIntro(); if (match) { match.dispose(); match = null; } hud.show(false); startMusic('menu'); touchRoot.classList.add('off'); showScreen('title'); break;
    case 'select': startMusic('menu'); endIntro(); selectSide = 0; locked[0] = locked[1] = false; if (match) { match.dispose(); match = null; } hud.show(false); showScreen('select'); break;
    case 'rematch': rematch(false); break;
    case 'swap': rematch(true); break;
    case 'resume': paused = false; showScreen('none'); break;
    case 'moves': movesReturn = screen === 'pause' ? 'pause' : 'title'; howTab = 'controls'; showScreen('moves'); break;
    case 'back': showScreen(movesReturn); break;
    case 'mute': setMuted(!muted); rerender(); break;
    case 'layout': setPadLayout(arg as 'xbox' | 'gamecube'); refreshLayoutLabels(); rerender(); break;
    case 'layoutcycle': setPadLayout(padLayout === 'xbox' ? 'gamecube' : 'xbox'); refreshLayoutLabels(); rerender(); break;
    case 'padsetup': startPadSetup(); break;
    case 'padsetup-skip': setupStep++; setupArmed = false; if (setupStep >= PAD_STEPS.length) finishPadSetup(); else rerender(); break;
    case 'padsetup-reset': { const g = firstPad(); if (g) saveBinding(g.id, null); toast('Controller reset to the default layout'); showScreen('moves'); break; }
    case 'padsetup-cancel': showScreen('moves'); break;
    case 'intros': introsOn = !introsOn; try { localStorage.setItem('bl.intros', introsOn ? '1' : '0'); } catch { /* */ } rerender(); break;
    case 'voices': voicesOn = !voicesOn; try { localStorage.setItem('bl.voices', voicesOn ? '1' : '0'); } catch { /* */ } rerender(); break;
  }
}

// Menu navigation from keyboard / pads.
const menuTrack = [new EdgeTracker(), new EdgeTracker()];
let navCooldown = 0; // ms
// ------------------------------------------------------------ controller setup (press each button)
const PAD_STEPS: [keyof PadBinding, string][] = [['attack', 'Attack'], ['jump', 'Jump'], ['grab', 'Grab / throw'], ['guard', 'Guard'], ['mobility', 'Mobility'], ['power', 'Power (and Rage)'], ['pause', 'Pause']];
let setupStep = 0, setupArmed = false, setupRest: number[] = [];
let setupBind: PadBinding = {};
function firstPad(): Gamepad | null {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  let gp: Gamepad | null = null;
  for (const g of pads) if (g && g.connected && (!gp || g.timestamp > gp.timestamp)) gp = g;
  return gp;
}
function startPadSetup() { setupStep = 0; setupArmed = false; setupBind = {}; setupRest = []; showScreen('padsetup'); }
function finishPadSetup() {
  const g = firstPad();
  if (g) {
    // Unset actions keep the default for this pad.
    const base = bindingFor(g);
    const merged: PadBinding = {};
    for (const [a] of PAD_STEPS) merged[a] = setupBind[a]?.length ? setupBind[a] : base[a];
    saveBinding(g.id, merged);
    toast('Controller saved');
  }
  showScreen('moves');
}
function pollPadSetup() {
  const g = firstPad();
  if (!g) return;
  if (!setupRest.length) setupRest = g.axes.map((v) => (Math.abs(v) > 0.5 ? Math.sign(v) : 0));
  const pressed = g.buttons.findIndex((b) => b && (b.pressed || b.value > 0.5));
  let axis = -1, dir: 1 | -1 = 1;
  g.axes.forEach((v, i) => { if (i < 2 || axis >= 0) return; const d = v - (setupRest[i] ?? 0); if (Math.abs(d) > 0.6) { axis = i; dir = d > 0 ? 1 : -1; } });
  const idle = pressed < 0 && axis < 0;
  if (!setupArmed) { if (idle) setupArmed = true; return; } // wait for everything to be released between steps
  if (idle) return;
  const src: PadSrc = pressed >= 0 ? { b: pressed } : { a: axis, dir };
  setupBind[PAD_STEPS[setupStep][0]] = [src];
  setupStep++;
  setupArmed = false;
  sfx.menu();
  if (setupStep >= PAD_STEPS.length) finishPadSetup(); else rerender();
}
/** Button names in the HUD and touch controls follow the active layout. */
function refreshLayoutLabels() {
  hud.refreshLabels();
  refreshTouchLabels(touchRoot);
}

// ------------------------------------------------------------ Press Start
/** Leaves the Press Start screen: unlocks audio, starts the menu music, opens the title menu. */
function startPressed() {
  if (screen !== 'start') return;
  initAudio();
  startMusic('menu');
  sfx.lockIn?.();
  showScreen('title');
  if (pendingRoom) { const r = pendingRoom; pendingRoom = ''; online.join(r); }
}
let startPadPrev = true; // ignore a button already held when the screen appears
function pollStartPads() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  const any = pads.some((g) => g && g.connected && g.buttons.some((b) => b && (b.pressed || b.value > 0.5)));
  if (any && !startPadPrev) startPressed();
  startPadPrev = any;
}
document.addEventListener('keydown', (e) => { if (screen === 'start' && !e.repeat && !['F3', 'F5', 'F12'].includes(e.code)) { e.preventDefault(); startPressed(); } });

function menuBack() {
  if (screen === 'select') {
    // Back steps out of the last lock-in first, then leaves the screen.
    if (locked[1]) { locked[1] = false; selectSide = 1; rerender(); }
    else if (locked[0]) { locked[0] = false; selectSide = 0; rerender(); }
    else if (selectSide === 1) { selectSide = 0; rerender(); }
    else act('title');
  }
  else if (screen === 'moves') act('back');
  else if (screen === 'pause') act('resume');
}
function menuInput(dtMs: number) {
  // Controllers drive an on-screen arrow cursor; the keyboard keeps step-by-step focus navigation.
  if (screen === 'start') { hidePadCursor(); pollStartPads(); endInputRead(); return; }
  startPadPrev = true;
  if (screen === 'padsetup') { hidePadCursor(); pollPadSetup(); }
  const padUsed = screen === 'padsetup' ? false : updatePadCursor(menu, screen, dtMs, () => { if (navCooldown <= 0) { navCooldown = 180; sfx.menu(); menuBack(); } });
  if (padUsed) initAudio();
  const binds: DeviceBinding[] = [{ keyboard: [0, 1], gamepad: null, touch: false }];
  for (let i = 0; i < binds.length; i++) {
    const raw = readDevices(binds[i]);
    if (keyDown('Enter') || keyDown('Space')) raw.down.attack = true;
    if (keyDown('Escape')) raw.down.jump = true;
    menuTrack[i].update(raw);
    const fr = menuTrack[i].frame;
    if (navCooldown > 0) continue;
    const step = fr.my > 0.5 || fr.mx < -0.5 ? -1 : fr.my < -0.5 || fr.mx > 0.5 ? 1 : 0;
    if (step) { setFocus(focusIdx + step); navCooldown = 150; sfx.menu(); }
    if (fr.b.attack.pressed) { const el = focusables()[focusIdx]; if (el) { initAudio(); el.click(); } navCooldown = 180; }
    if (fr.b.jump.pressed) { navCooldown = 180; menuBack(); }
  }
  if (navCooldown > 0) navCooldown -= dtMs;
  endInputRead();
}

window.addEventListener('gamepadconnected', (e) => { toast(`Controller ${((e as GamepadEvent).gamepad?.index ?? 0) + 1} connected`); if (screen === 'title' || screen === 'start' || screen === 'select') rerender(); });
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
  // Online the stick arrives already in a fixed world frame (identical on both machines).
  match.camBasis.fwd = setup.mode === 'online' ? CANON.fwd : vcam.fwd;
  match.camBasis.right = setup.mode === 'online' ? CANON.right : vcam.right;
  match.update(DT);
  fx.update(DT);
  // Music intensity follows the fight: Rage, Danger and low health raise the extra layer.
  setIntensity(match.ended ? 0 : Math.max(...match.fighters.map((f) => (f.raging ? 1 : f.danger ? 0.8 : f.health < 40 ? 0.45 : 0))));
  if (match.resultReady && screen === 'none' && !victory) {
    if (matchCine && !victoryDone && match.ended) victory = new VictoryCine(match, vcam, introEl, voicesOn, match.ended.winner);
    else { showScreen('result'); startMusic('menu'); }
  }
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
  else hidePadCursor();
  if (intro && match && !paused && screen === 'none' && !intro.update(rawDt)) { intro = null; if (online.active) online.introDone(); }
  if (online.active && intro === null && online.phase === 'intro') online.introDone();
  if (victory && match && screen === 'none' && !victory.update(rawDt)) { victory = null; victoryDone = true; }
  (window as any).__introT = intro ? intro.t : 99;
  (window as any).__victoryT = victory ? victory.t : -1;
  // "FIGHT!" stinger the moment the banner appears (READY → FIGHT at introT 45; works for new rounds too).
  if (match) { if (match.introT === 45 && lastIntroT !== 45) sfx.fightStart?.(); lastIntroT = match.introT; }
  if (online.active) {
    // Online: the lockstep decides when ticks run (both players' inputs known); menus never pause the simulation.
    if (fx.hitstop > 0) fx.hitstop = Math.max(0, fx.hitstop - rawDt);
    online.pump(rawDt * 1000);
  } else if (match && !paused && screen === 'none' && !manualStep) {
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
  updateNetStat();
  if (match) {
    for (const f of match.fighters) f.animate(rawDt, time);
    vcam.update(match.fighters, rawDt, fx.shake);
    hud.update(match, time);
    hud.el.classList.toggle('menu-up', screen !== 'none');
    hud.el.classList.toggle('cine', !!intro || !!victory);
    document.body.classList.toggle('cine', !!intro || !!victory);
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
menu.innerHTML = '<div class="screen start-screen loading"><div class="band"><i class="smoke s1"></i><i class="smoke s2"></i></div><div class="logo-wrap"><h1 class="chrome">BREAK<span>LINE</span></h1></div><div class="press">Loading fighters…</div></div>';
requestAnimationFrame(frame);

// ============================================================ automation / test hooks
(window as any).THREE = THREE;
const hooks = {
  get match() { return match; },
  /** Last frame's draw calls / triangles (perf checks). */
  renderInfo() { const ar = renderer.info.autoReset; renderer.info.autoReset = false; renderer.info.reset(); renderer.render(scene, vcam.cam); const r = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; renderer.info.autoReset = ar; return r; },
  setup,
  arena,
  fx,
  TUNING,
  forced,
  online,
  cpus: () => cpus,
  start(p1: string, p2: string, mode: Mode = 'cpu', diff: Difficulty = 'normal', arenaId: LayoutId = 'rooftop') { setup.p1 = p1; setup.p2 = p2; setup.mode = mode; setup.diff = diff; setup.arena = arenaId; startMatch(false); },
  setLives(n: number) { setup.lives = n; },
  startWithIntro(p1: string, p2: string) { setup.p1 = p1; setup.p2 = p2; setup.mode = 'cpu'; startMatch(true); },
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
Promise.all([loadBodyModels('./models'), loadPropModels('./models/props', PROP_MODELS), loadCityKit('./models/city/megakit.glb').then(() => { if (hasCityKit()) arena.setLayout(arena.layout); })])
  .catch((e) => console.warn('Rigged body model unavailable, using procedural bodies:', e))
  .finally(() => {
    try { renderPortraits(renderer); } catch (e) { console.warn('portraits failed', e); }
    hud.portraits = (id: string) => portraitOf(charById(id));
    (window as any).__game = hooks;
    startMusic('menu'); // begins as soon as audio is unlocked by the first tap/key
    showScreen('start');
  });
