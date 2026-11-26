// Gameplay actions are decoupled from hardware. GameCube semantics:
// A = attack, B = jump, X = grab/handle prop, Y = guard, L = mobility, R = power modifier.

export type ActionName = 'attack' | 'jump' | 'grab' | 'guard' | 'mobility' | 'power';
export const ACTIONS: ActionName[] = ['attack', 'jump', 'grab', 'guard', 'mobility', 'power'];

export interface Button {
  down: boolean;
  pressed: boolean; // went down this tick
  released: boolean; // went up this tick
  held: number; // ticks held
  lastHeld: number; // duration of the most recent hold (valid on release)
}

export interface InputFrame {
  mx: number; // stick x  (-1 left .. 1 right)
  my: number; // stick y  (-1 down/back .. 1 up/forward)
  b: Record<ActionName, Button>;
  pause: boolean;
}

export function emptyFrame(): InputFrame {
  const b = {} as Record<ActionName, Button>;
  for (const a of ACTIONS) b[a] = { down: false, pressed: false, released: false, held: 0, lastHeld: 0 };
  return { mx: 0, my: 0, b, pause: false };
}

/** Raw desired state from a device (before edge detection). */
export interface RawState {
  mx: number;
  my: number;
  down: Record<ActionName, boolean>;
  pause: boolean;
}

export function emptyRaw(): RawState {
  return { mx: 0, my: 0, down: { attack: false, jump: false, grab: false, guard: false, mobility: false, power: false }, pause: false };
}

/** Converts raw per-tick states into edge-detected frames. */
export class EdgeTracker {
  frame = emptyFrame();
  private prevPause = false;
  update(raw: RawState) {
    this.frame.mx = raw.mx;
    this.frame.my = raw.my;
    for (const a of ACTIONS) {
      const btn = this.frame.b[a];
      const d = raw.down[a];
      btn.pressed = d && !btn.down;
      btn.released = !d && btn.down;
      if (btn.released) btn.lastHeld = btn.held;
      btn.down = d;
      btn.held = d ? btn.held + 1 : 0;
    }
    this.frame.pause = raw.pause && !this.prevPause;
    this.prevPause = raw.pause;
  }
  reset() {
    this.frame = emptyFrame();
  }
}

// ---------------------------------------------------------------- keyboard
const KB_LAYOUTS: { move: [string[], string[], string[], string[]]; map: Record<ActionName, string[]>; pause: string[] }[] = [
  {
    // P1: WASD + J K L I / U O
    move: [['KeyW'], ['KeyS'], ['KeyA'], ['KeyD']],
    map: { attack: ['KeyJ'], jump: ['KeyK'], grab: ['KeyL'], guard: ['KeyI'], mobility: ['KeyU'], power: ['KeyO'] },
    pause: ['Escape'],
  },
  {
    // P2: Arrows + . / , ; RightShift Enter (or numpad 1 2 3 5 4 6)
    move: [['ArrowUp'], ['ArrowDown'], ['ArrowLeft'], ['ArrowRight']],
    map: {
      attack: ['Period', 'Numpad1'],
      jump: ['Slash', 'Numpad2'],
      grab: ['Comma', 'Numpad3'],
      guard: ['Semicolon', 'Numpad5'],
      mobility: ['ShiftRight', 'Numpad4'],
      power: ['Enter', 'Numpad6', 'NumpadEnter'],
    },
    pause: ['Backspace'],
  },
];

const keys = new Set<string>();
// Keys pressed since the last input read: a tap shorter than one frame still registers.
const tapped = new Set<string>();
const GAME_KEYS = new Set<string>();
for (const l of KB_LAYOUTS) {
  l.move.flat().forEach((k) => GAME_KEYS.add(k));
  Object.values(l.map).flat().forEach((k) => GAME_KEYS.add(k));
}

let inputListenersInstalled = false;
export function installKeyboard() {
  if (inputListenersInstalled) return;
  inputListenersInstalled = true;
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    noteInput('keys');
    tapped.add(e.code);
    if (GAME_KEYS.has(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
}

export function keyDown(code: string) {
  return keys.has(code) || tapped.has(code);
}

/** Call once after every input read cycle. */
export function endInputRead() {
  tapped.clear();
}

function readKeyboard(layout: number, out: RawState) {
  const l = KB_LAYOUTS[layout];
  const any = (arr: string[]) => arr.some((k) => keys.has(k) || tapped.has(k));
  const up = any(l.move[0]), dn = any(l.move[1]), lf = any(l.move[2]), rt = any(l.move[3]);
  out.mx += (rt ? 1 : 0) - (lf ? 1 : 0);
  out.my += (up ? 1 : 0) - (dn ? 1 : 0);
  for (const a of ACTIONS) if (any(l.map[a])) out.down[a] = true;
  if (any(l.pause)) out.pause = true;
}

// ---------------------------------------------------------------- gamepad
// Standard mapping: face buttons are mapped by label position, which matches GameCube semantics
// on an Xbox-style pad (A attack, B jump, X grab, Y guard). LB/LT = L, RB/RT = R.
/** Which kind of device the player used most recently: drives which on-screen hints are shown. */
export let lastInputKind: 'touch' | 'pad' | 'keys' = (('ontouchstart' in window) || navigator.maxTouchPoints > 0) ? 'touch' : 'keys';
export function noteInput(kind: 'touch' | 'pad' | 'keys') { lastInputKind = kind; }

/** True if any connected pad shows button or stick activity right now. */
export function padActivity(): boolean {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    if (gp.buttons.some((b) => b.pressed || b.value > 0.4)) return true;
    if (gp.axes.some((a) => Math.abs(a) > 0.35)) return true;
  }
  return false;
}

export function readGamepad(index: number, out: RawState): boolean {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads[index];
  if (!gp || !gp.connected) return false;
  const dz = (v: number) => (Math.abs(v) < 0.2 ? 0 : (v - Math.sign(v) * 0.2) / 0.8);
  let x = dz(gp.axes[0] ?? 0), y = -dz(gp.axes[1] ?? 0);
  const btn = (i: number) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
  if (btn(12)) y = 1;
  if (btn(13)) y = -1;
  if (btn(14)) x = -1;
  if (btn(15)) x = 1;
  out.mx += x;
  out.my += y;
  if (btn(0)) out.down.attack = true;
  if (btn(1)) out.down.jump = true;
  if (btn(2)) out.down.grab = true;
  if (btn(3)) out.down.guard = true;
  if (btn(4) || btn(6)) out.down.mobility = true;
  if (btn(5) || btn(7)) out.down.power = true;
  if (btn(9)) out.pause = true;
  return true;
}

// ---------------------------------------------------------------- touch
export const touchState: RawState = emptyRaw();
let touchActive = false;
export function isTouchActive() {
  return touchActive;
}

export function installTouch(root: HTMLElement) {
  window.addEventListener('touchstart', () => noteInput('touch'), { passive: true });
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  root.innerHTML = `
    <div class="tstick" id="tstick"><div class="tknob" id="tknob"></div></div>
    <div class="tbtns">
      <button data-a="mobility" class="tb tl">L</button>
      <button data-a="power" class="tb tr">R</button>
      <button data-a="guard" class="tb ty">Y</button>
      <button data-a="grab" class="tb tx">X</button>
      <button data-a="attack" class="tb ta">A</button>
      <button data-a="jump" class="tb tbb">B</button>
      <button data-a="mobility+power" class="tb tchord tc1">L+R<small>recover</small></button>
      <button data-a="power+guard" class="tb tchord tc2">R+Y<small>s.block</small></button>
    </div>
    <button data-a="pause" class="tb tpause">II</button>`;
  if (!isTouch) root.style.display = 'none';
  const stick = root.querySelector('#tstick') as HTMLElement;
  const knob = root.querySelector('#tknob') as HTMLElement;
  let stickId: number | null = null;
  let cx = 0, cy = 0;
  const R = 50;
  stick.addEventListener('touchstart', (e) => {
    e.preventDefault();
    touchActive = true;
    const t = e.changedTouches[0];
    stickId = t.identifier;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    moveStick(t.clientX, t.clientY);
  }, { passive: false });
  const moveStick = (x: number, y: number) => {
    let dx = x - cx, dy = y - cy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touchState.mx = dx / R;
    touchState.my = -dy / R;
  };
  window.addEventListener('touchmove', (e) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === stickId) { e.preventDefault(); moveStick(t.clientX, t.clientY); }
  }, { passive: false });
  const endStick = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === stickId) {
      stickId = null;
      touchState.mx = 0; touchState.my = 0;
      knob.style.transform = '';
    }
  };
  window.addEventListener('touchend', endStick);
  window.addEventListener('touchcancel', endStick);

  // Each button tracks its own touch ids so several can be held while steering.
  root.querySelectorAll<HTMLButtonElement>('.tb').forEach((b) => {
    const acts = (b.dataset.a || '').split('+');
    const ids = new Set<number>();
    const apply = () => {
      const on = ids.size > 0;
      b.classList.toggle('on', on);
      recomputeTouchButtons();
    };
    (b as any)._ids = ids;
    (b as any)._acts = acts;
    b.addEventListener('touchstart', (e) => { e.preventDefault(); touchActive = true; for (const t of Array.from(e.changedTouches)) ids.add(t.identifier); apply(); }, { passive: false });
    const end = (e: TouchEvent) => { for (const t of Array.from(e.changedTouches)) ids.delete(t.identifier); apply(); };
    b.addEventListener('touchend', end);
    b.addEventListener('touchcancel', end);
  });
  function recomputeTouchButtons() {
    for (const a of ACTIONS) touchState.down[a] = false;
    touchState.pause = false;
    root.querySelectorAll<HTMLButtonElement>('.tb').forEach((b) => {
      if ((b as any)._ids.size === 0) return;
      for (const a of (b as any)._acts as string[]) {
        if (a === 'pause') touchState.pause = true;
        else touchState.down[a as ActionName] = true;
      }
    });
  }
}

// ---------------------------------------------------------------- player binding
export interface DeviceBinding {
  keyboard: number[]; // layout indices
  gamepad: number | null;
  touch: boolean;
}

export function readDevices(bind: DeviceBinding): RawState {
  const out = emptyRaw();
  for (const k of bind.keyboard) readKeyboard(k, out);
  if (bind.gamepad !== null) readGamepad(bind.gamepad, out);
  if (bind.touch) {
    out.mx += touchState.mx;
    out.my += touchState.my;
    for (const a of ACTIONS) if (touchState.down[a]) out.down[a] = true;
    if (touchState.pause) out.pause = true;
  }
  const l = Math.hypot(out.mx, out.my);
  if (l > 1) { out.mx /= l; out.my /= l; }
  return out;
}

export function connectedPads(): number[] {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const r: number[] = [];
  for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i]!.connected) r.push(i);
  return r;
}
