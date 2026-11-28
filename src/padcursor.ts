import { menuButtons, padSrcDown } from './input';
// On-screen arrow cursor for controllers in menus (same feel as Crust Rush's): the left stick moves it
// (faster the further it's pushed), the D-pad walks it, A presses what's under it, B goes back, and the
// right stick scrolls (A/B follow the active button layout). It hides as soon as the mouse, a key or a touch is used, and during a bout.

const CLICKABLE = '[data-act],button,a[href],input,select,label,[role=button]';

interface PadState { prevConfirm?: boolean; prevBack?: boolean; on: boolean; x: number; y: number; prev: boolean[]; last: number; hov: HTMLElement | null; scope: string | null }
/** Controller cursor speed multiplier (menu setting, saved per device). 0.8 = a little slower than the original. */
export let cursorSpeed = 0.8;
try { const v = Number(localStorage.getItem('bl.curs')); if (v >= 0.3 && v <= 1.6) cursorSpeed = v; } catch { /* storage optional */ }
export function setCursorSpeed(v: number) { cursorSpeed = Math.round(Math.min(1.6, Math.max(0.3, v)) * 10) / 10; try { localStorage.setItem('bl.curs', String(cursorSpeed)); } catch { /* */ } }
const S: PadState = { on: false, x: -1, y: -1, prev: [], last: 0, hov: null, scope: null };
let el: HTMLDivElement | null = null;

function arrow(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'padCur';
  // BREAKLINE cursor: a red targeting ring with a centre dot; it snaps in and throws a ripple when you press.
  el.style.cssText = 'position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;z-index:2147483000;pointer-events:none;will-change:transform;display:none';
  el.innerHTML = '<div class="pcr"><svg viewBox="0 0 36 36" width="36" height="36"><circle cx="18" cy="18" r="13" fill="rgba(255,59,78,0.12)" stroke="#ff3b4e" stroke-width="3"/><circle cx="18" cy="18" r="13" fill="none" stroke="#fff" stroke-width="1" stroke-dasharray="4 6" opacity=".7"/><circle cx="18" cy="18" r="3.4" fill="#fff"/></svg></div>';
  document.body.appendChild(el);
  const st = document.createElement('style');
  st.textContent = `.padhover { filter: brightness(1.15); outline: 2px solid #ff3b4e !important; outline-offset: 2px; box-shadow: 0 0 16px rgba(255,59,78,.55); }
#padCur .pcr { width: 36px; height: 36px; filter: drop-shadow(0 0 6px rgba(255,59,78,.8)) drop-shadow(0 2px 2px rgba(0,0,0,.6)); transition: transform .12s ease-out; animation: pcrspin 4s linear infinite; }
#padCur.over .pcr { transform: scale(1.2); }
#padCur.press .pcr { transform: scale(.62); transition-duration: .05s; }
#padCur .rip { position: absolute; left: 50%; top: 50%; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid #ff3b4e; box-shadow: 0 0 12px #ff3b4e; animation: pcrrip .38s ease-out forwards; }
@keyframes pcrrip { from { transform: scale(.5); opacity: 1; } to { transform: scale(2.4); opacity: 0; } }
@keyframes pcrspin { to { rotate: 360deg; } }`;
  document.head.appendChild(st);
  // Any other input takes over from the arrow.
  const off = () => { if (S.on) setOn(false); };
  addEventListener('mousemove', (e) => { if (e.isTrusted && Math.abs(e.movementX) + Math.abs(e.movementY) > 1) off(); }, true);
  addEventListener('keydown', off, true);
  addEventListener('touchstart', off, { capture: true, passive: true });
  return el;
}

function setOn(on: boolean) {
  S.on = on;
  arrow().style.display = on ? 'block' : 'none';
  if (!on && S.hov) { S.hov.classList.remove('padhover'); S.hov = null; }
}

export function padCursorActive() { return S.on; }
export function hidePadCursor() { if (S.on) setOn(false); S.scope = null; }

function scroller(start: Element | null): HTMLElement | null {
  let q = start as HTMLElement | null;
  while (q && q !== document.body) {
    if (q.scrollHeight > q.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(q).overflowY)) return q;
    q = q.parentElement;
  }
  return null;
}

/**
 * Call every frame while a menu is open. `root` is the menu layer, `screenKey` names the screen (the arrow
 * jumps to the main button only when it changes), `onBack` handles B.
 * Returns true if a controller drove the menu this frame (so the caller can skip its own pad handling).
 */
export function updatePadCursor(root: HTMLElement, screenKey: string, dtMs: number, onBack: () => void, primarySel: string[] = ['[data-act="fight"]', '[data-act="confirm"]', '.bigbtn.primary', '.focus', '[data-nav]:not([data-act="back"]):not([data-act="title"])']): boolean {
  let pads: (Gamepad | null)[] = [];
  try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch { return false; }
  // The most recently used pad drives the arrow.
  let gp: Gamepad | null = null;
  for (const g of pads) if (g && g.connected && (!gp || g.timestamp > gp.timestamp)) gp = g;
  if (!gp) { hidePadCursor(); return false; }
  const W = innerWidth, H = innerHeight, dt = Math.min(0.05, dtMs / 1000);
  const btn = (i: number) => !!gp!.buttons[i] && (gp!.buttons[i].pressed || gp!.buttons[i].value > 0.5);
  const mb = menuButtons(gp);
  const confirmDown = padSrcDown(gp, mb.confirm), backDown = padSrcDown(gp, mb.back);
  const confirmEdge = confirmDown && !S.prevConfirm, backEdge = backDown && !S.prevBack;
  S.prevConfirm = confirmDown; S.prevBack = backDown;
  arrow();
  if (S.x < 0) { S.x = W / 2; S.y = H / 2; }

  // New screen (not a redraw of the same one): start on its main button.
  if (screenKey !== S.scope) {
    S.scope = screenKey;
    let b: HTMLElement | null = null;
    for (const q of primarySel) { b = root.querySelector<HTMLElement>(q); if (b) break; }
    if (b) { const r = b.getBoundingClientRect(); if (r.width) { S.x = r.left + r.width / 2; S.y = r.top + r.height / 2; } }
  }

  // Stick: speed grows with the square of the push; D-pad: a steady walk. Scaled to the screen size.
  const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0, dz = 0.16, m = Math.hypot(ax, ay);
  const k = Math.min(Math.max(Math.min(W, H) / 720, 0.7), 1.6) * cursorSpeed;
  let vx = 0, vy = 0;
  if (m > dz) { const f = Math.min(1, (m - dz) / (1 - dz)), sp = (200 + 1300 * f * f) * k; vx = (ax / m) * sp; vy = (ay / m) * sp; }
  vx += ((btn(15) ? 1 : 0) - (btn(14) ? 1 : 0)) * 430 * k;
  vy += ((btn(13) ? 1 : 0) - (btn(12) ? 1 : 0)) * 430 * k;
  let used = false;
  if (vx || vy) {
    if (!S.on) setOn(true);
    S.x = Math.min(W - 3, Math.max(2, S.x + vx * dt));
    S.y = Math.min(H - 3, Math.max(2, S.y + vy * dt));
    used = true;
  }
  const a = arrow();
  a.style.transform = `translate(${S.x.toFixed(1)}px,${S.y.toFixed(1)}px)`;

  // What's under the arrow.
  const under = S.on ? document.elementFromPoint(S.x, S.y) : null;
  let hit = under?.closest<HTMLElement>(CLICKABLE) ?? null;
  if (hit && (hit as HTMLButtonElement).disabled) hit = null;
  if (hit && !root.contains(hit)) hit = null;
  if (hit !== S.hov) { S.hov?.classList.remove('padhover'); S.hov = hit; hit?.classList.add('padhover'); a.classList.toggle('over', !!hit); }

  // Right stick scrolls whatever scrolls under the arrow (or the menu); the arrow held at an edge scrolls too.
  const sc = scroller(under) ?? scroller(root.querySelector('.how-body') ?? root.firstElementChild);
  const ry = gp.axes[3] ?? 0;
  if (sc && Math.abs(ry) > 0.2) { sc.scrollBy(0, ry * Math.abs(ry) * 1500 * dt); used = true; }
  if (sc && S.on) { const z = Math.max(36, H * 0.075); if (vy > 0 && S.y > H - z) sc.scrollBy(0, 600 * dt); else if (vy < 0 && S.y < z) sc.scrollBy(0, -600 * dt); }

  // A: press what's under the arrow. B: back.
  if (confirmEdge) {
    if (!S.on) setOn(true);
    // Press feedback: the ring snaps in and a ripple rings out, so a click is unmistakable.
    a.classList.add('press');
    const rip = document.createElement('i'); rip.className = 'rip'; a.appendChild(rip);
    setTimeout(() => { a.classList.remove('press'); rip.remove(); }, 380);
    if (hit) hit.click();
    used = true;
  }
  if (backEdge) { onBack(); used = true; }
  S.prev = gp.buttons.map((b) => !!b && (b.pressed || b.value > 0.5));
  return used || S.on;
}

/**
 * List-style menus (title, pause, results): no cursor; stick / D-pad steps the highlighted item and A / B confirm / go back.
 * Returns the step (-1 / 1 / 0) and button edges for the caller to apply to its focus list.
 */
const LN = { y: 0, t: 0, conf: false, back: false };
export function padListNav(dtMs: number): { step: number; confirm: boolean; back: boolean; used: boolean } {
  hidePadCursor();
  let pads: (Gamepad | null)[] = [];
  try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch { return { step: 0, confirm: false, back: false, used: false }; }
  let gp: Gamepad | null = null;
  for (const g of pads) if (g && g.connected && (!gp || g.timestamp > gp.timestamp)) gp = g;
  if (!gp) return { step: 0, confirm: false, back: false, used: false };
  const btn = (i: number) => !!gp!.buttons[i] && (gp!.buttons[i].pressed || gp!.buttons[i].value > 0.5);
  const ay = gp.axes[1] ?? 0;
  const dir = btn(12) || ay < -0.55 ? -1 : btn(13) || ay > 0.55 ? 1 : 0;
  let step = 0;
  LN.t -= dtMs;
  if (dir !== LN.y) { LN.y = dir; if (dir) { step = dir; LN.t = 380; } } // first press: immediate; hold: repeat
  else if (dir && LN.t <= 0) { step = dir; LN.t = 140; }
  const mb = menuButtons(gp);
  const c = padSrcDown(gp, mb.confirm), b = padSrcDown(gp, mb.back);
  const confirm = c && !LN.conf, back = b && !LN.back;
  LN.conf = c; LN.back = b;
  S.prevConfirm = c; S.prevBack = b; // don't double-fire when switching to a cursor screen
  return { step, confirm, back, used: !!step || confirm || back };
}
