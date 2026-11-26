// On-screen arrow cursor for controllers in menus (same feel as Crust Rush's): the left stick moves it
// (faster the further it's pushed), the D-pad walks it, A presses what's under it, B goes back, and the
// right stick scrolls. It hides as soon as the mouse, a key or a touch is used, and during a bout.

const CLICKABLE = '[data-act],button,a[href],input,select,label,[role=button]';

interface PadState { on: boolean; x: number; y: number; prev: boolean[]; last: number; hov: HTMLElement | null; scope: string | null }
const S: PadState = { on: false, x: -1, y: -1, prev: [], last: 0, hov: null, scope: null };
let el: HTMLDivElement | null = null;

function arrow(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'padCur';
  el.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;margin:-3px 0 0 -3px;z-index:2147483000;pointer-events:none;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.65));display:none';
  el.innerHTML = '<svg viewBox="0 0 30 30" width="30" height="30"><path d="M3 2 L3 23 L8.8 17.8 L13 27 L16.8 25.3 L12.6 16.2 L20.5 16.2 Z" fill="#fff" stroke="#140e18" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(el);
  const st = document.createElement('style');
  st.textContent = '.padhover { filter: brightness(1.2) saturate(1.1); outline: 2px solid rgba(255,255,255,.65); outline-offset: 2px; }';
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
  const edge = (i: number) => btn(i) && !S.prev[i];
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
  const k = Math.min(Math.max(Math.min(W, H) / 720, 0.7), 1.6);
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
  if (hit !== S.hov) { S.hov?.classList.remove('padhover'); S.hov = hit; hit?.classList.add('padhover'); }

  // Right stick scrolls whatever scrolls under the arrow (or the menu); the arrow held at an edge scrolls too.
  const sc = scroller(under) ?? scroller(root.querySelector('.how-body') ?? root.firstElementChild);
  const ry = gp.axes[3] ?? 0;
  if (sc && Math.abs(ry) > 0.2) { sc.scrollBy(0, ry * Math.abs(ry) * 1500 * dt); used = true; }
  if (sc && S.on) { const z = Math.max(36, H * 0.075); if (vy > 0 && S.y > H - z) sc.scrollBy(0, 600 * dt); else if (vy < 0 && S.y < z) sc.scrollBy(0, -600 * dt); }

  // A: press what's under the arrow. B: back.
  if (edge(0)) {
    if (!S.on) setOn(true);
    if (hit) hit.click();
    used = true;
  }
  if (edge(1)) { onBack(); used = true; }
  S.prev = gp.buttons.map((b) => !!b && (b.pressed || b.value > 0.5));
  return used || S.on;
}
