import * as THREE from 'three';
import type { Fighter } from './fighter';
import type { CamCollider } from './camcollide';

const UP = new THREE.Vector3(0, 1, 0);
/**
 * Alternative poses tried when the line from the focus (or a fighter) to the camera is blocked:
 * [yaw offset (rad), extra height (m), distance scale], cheapest first. Covers swinging round, craning up, and —
 * for walled halls where nothing at the full distance is inside the room — coming in closer, high above the
 * shelving or low underneath it.
 */
const AVOID: [number, number, number][] = (() => {
  const out: [number, number, number, number][] = [];
  for (const yo of [0, 0.3, -0.3, 0.6, -0.6, 1, -1, 1.6, -1.6, Math.PI]) {
    for (const h of [0, 2, 4, 7, 11, -2, -4]) {
      for (const k of [1, 0.7, 0.45, 0.3]) {
        if (!yo && !h && k === 1) continue;
        out.push([yo, h, k, Math.abs(yo) * 3 + Math.abs(h) * 0.45 + (1 - k) * 7]);
      }
    }
  }
  return out.sort((a, b) => a[3] - b[3]).map(([yo, h, k]) => [yo, h, k] as [number, number, number]);
})();

// Shared dynamic Versus camera. Frames both fighters plus where a launched body is heading,
// sits perpendicular to the line between them, and rotates/zooms smoothly so controls stay readable.

export class VersusCamera {
  cam: THREE.PerspectiveCamera;
  yaw = 0;
  dist = 14;
  height = 7;
  target = new THREE.Vector3(0, 1, 0);
  private pos = new THREE.Vector3(0, 8, 16);
  cinematic: { focus: () => THREE.Vector3; yaw: number; dist: number; h: number; t: number } | null = null;
  fwd = new THREE.Vector3(0, 0, -1);
  /** Brief zoom-in on heavy impacts. */
  punch = 0;
  /** Keep the camera inside a corridor (narrow venues): max |z|. */
  zLimit = Infinity;
  /** Framing distance multiplier: wide landscape screens can sit closer and still keep both fighters in shot. */
  zoomMul = 1;
  /** Player's camera-distance setting (Settings → Camera, 0.7-1.4). Presentation only: never touches the sim. */
  userZoom = 1;
  right = new THREE.Vector3(1, 0, 0);
  /** Static-geometry occupancy for the current arena (Arena.camCollider); null = no collision (tests, menus). */
  collider: CamCollider | null = null;
  /** Deck extents: a fighter falling off the map is framed at the edge, not followed down past the buildings. */
  deck = { hw: 18, hd: 13, circle: 0 };
  /** Covered venues (the Overpass truss): the camera stays under the roof beams. */
  maxY = Infinity;
  /** Walled arenas: the camera stays inside the room (half extents), never behind or outside the walls. */
  room: { hw: number; hd: number } | null = null;
  // Obstacle avoidance state: smoothed yaw/height offsets toward a clear pose, and the pull-in distance.
  private avoidYaw = 0;
  private avoidH = 0;
  private avoidYawT = 0;
  private avoidHT = 0;
  private avoidK = 1;
  private avoidKT = 1;
  /** How far (0-1) the camera is slid toward the pivot above the action. */
  private pullT = 0;
  /** Last frame's collision result (debug / tests). */
  lastHit = { blocked: false, pulled: false, yaw: 0, h: 0, why: '' };
  /** Fighters' head points this frame (each must see the camera too, not just the focus between them). */
  private heads: THREE.Vector3[] = [];

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(57, aspect, 0.1, 600);
  }

  snapTo(fs: Fighter[]) {
    this.update(fs, 1, 0, true);
  }

  update(fs: Fighter[], dt: number, shake: number, snap = false) {
    const pts: THREE.Vector3[] = [];
    for (const f of fs) {
      if (f.state === 'out') continue;
      pts.push(this.onDeck(f.pos.clone().setY(f.pos.y + f.def.height * 0.6)));
      // Leave room in the direction of a launch.
      if (f.state === 'launched' || f.state === 'swing' || f.state === 'fly') pts.push(this.onDeck(f.pos.clone().addScaledVector(f.vel, 0.45).setY(Math.max(-2, f.pos.y + f.vel.y * 0.2))));
    }
    this.heads = [];
    for (const f of fs) if (f.state !== 'out' && f.pos.y > -1) this.heads.push(f.pos.clone().setY(f.pos.y + f.def.height * 0.85));
    if (pts.length === 0) pts.push(new THREE.Vector3(0, 1, 0));
    const mid = new THREE.Vector3();
    for (const p of pts) mid.add(p);
    mid.divideScalar(pts.length);
    let spread = 0, ymin = Infinity, ymax = -Infinity;
    for (const p of pts) {
      spread = Math.max(spread, Math.hypot(p.x - mid.x, p.z - mid.z));
      ymin = Math.min(ymin, p.y);
      ymax = Math.max(ymax, p.y);
    }
    const vspan = ymax - ymin;

    let wantYaw = this.yaw;
    let wantDist: number, wantH: number;
    let focus = mid;
    if (this.cinematic) {
      const c = this.cinematic;
      c.t += dt;
      focus = c.focus();
      wantYaw = c.yaw + c.t * 0.35;
      wantDist = c.dist;
      wantH = c.h;
    } else {
      const a = fs[0], b = fs[1];
      if (a && b && a.state !== 'out' && b.state !== 'out') {
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const hd = Math.hypot(dx, dz);
        // When one fighter is directly above the other the line is undefined: hold the yaw.
        if (hd > 2.5) {
          const lineYaw = Math.atan2(dx, dz);
          const c1 = lineYaw + Math.PI / 2, c2 = lineYaw - Math.PI / 2;
          wantYaw = angDiff(c1, this.yaw) < angDiff(c2, this.yaw) ? c1 : c2;
          // Prefer a camera on the roof-center side so the drop is visible behind the fighters at the edge.
          const camDir = new THREE.Vector3(Math.sin(wantYaw), 0, Math.cos(wantYaw));
          const outward = new THREE.Vector3(mid.x, 0, mid.z);
          if (outward.length() > 8 && camDir.dot(outward.normalize()) > 0.75 && hd > 5) {
            const alt = wantYaw === c1 ? c2 : c1;
            if (angDiff(alt, this.yaw) < 1.2) wantYaw = alt;
          }
        }
      }
      // Low, close framing near shoulder height; pulls wide only as the fighters separate.
      // The player's setting scales the same framing (combined with the screen-shape zoomMul), within a range
      // that keeps both fighters readable; narrow venues (zLimit) cap the far end so the camera doesn't get
      // pinned against the corridor limit and swing round.
      const fit = THREE.MathUtils.clamp(6.5 + spread * 1.25 + vspan * 0.6, 8, 28) * this.zoomMul;
      const maxD = Number.isFinite(this.zLimit) ? Math.max(fit, Math.min(fit * this.userZoom, this.zLimit * 2.2)) : 36;
      wantDist = THREE.MathUtils.clamp(fit * this.userZoom, 5.5, maxD);
      // Wider settings also look down a little more, so roof parapets and railings don't fill the foreground.
      wantH = 1.6 + wantDist * 0.2 * (1 + Math.max(0, wantDist / fit - 1) * 0.9) + vspan * 0.35;
    }
    if (snap) {
      this.yaw = wantYaw;
      this.dist = wantDist;
      this.height = wantH;
      this.target.copy(focus);
    } else {
      // Rate-limited, damped rotation so rapid side swaps don't whip the camera.
      let d = wrap(wantYaw - this.yaw);
      const maxRate = this.cinematic ? 3 : 1.4;
      const step = THREE.MathUtils.clamp(d * (1 - Math.exp(-2.2 * dt)), -maxRate * dt, maxRate * dt);
      this.yaw = wrap(this.yaw + step);
      const k = 1 - Math.exp(-(this.cinematic ? 6 : 3) * dt);
      this.dist += (wantDist - this.dist) * k;
      this.height += (wantH - this.height) * k;
      this.target.lerp(focus, 1 - Math.exp(-(this.cinematic ? 8 : 5) * dt));
    }
    this.punch = Math.max(0, this.punch - dt * 3.5);
    const pd = this.dist * (1 - 0.14 * this.punch);
    const camPos = new THREE.Vector3(this.target.x + Math.sin(this.yaw) * pd, this.target.y + this.height * (1 - 0.1 * this.punch), this.target.z + Math.cos(this.yaw) * pd);
    if (camPos.y < 1.5) camPos.y = 1.5;
    // Narrow venue: slide the camera back inside the roadway (along it) instead of filming through the girders.
    if (Math.abs(camPos.z) > this.zLimit && !this.cinematic) {
      const over = Math.abs(camPos.z) - this.zLimit;
      camPos.z = Math.sign(camPos.z) * this.zLimit;
      const along = Math.sign(camPos.x - this.target.x) || 1;
      camPos.x += along * over * 0.9;
      camPos.y += over * 0.25;
      // Nudge the stored yaw toward an along-the-road view so it settles there.
      const roadYaw = along > 0 ? Math.PI / 2 : -Math.PI / 2;
      this.yaw = wrap(this.yaw + wrap(roadYaw - this.yaw) * Math.min(1, dt * 1.5));
    }
    if (this.collider) this.collide(camPos, dt, snap);
    this.pos.copy(camPos);
    this.cam.position.copy(camPos);
    if (shake > 0) {
      const s = shake * shake * 0.35;
      this.cam.position.x += (Math.random() - 0.5) * s;
      this.cam.position.y += (Math.random() - 0.5) * s;
      this.cam.position.z += (Math.random() - 0.5) * s;
    }
    this.cam.lookAt(this.target.x, this.target.y - 0.15, this.target.z);
    // A touch of dutch tilt on heavy impacts.
    if (this.punch > 0) this.cam.rotateZ(Math.sin(this.punch * 9) * 0.035 * this.punch);
    // Controls follow where the camera actually looks (it may have swung round an obstacle).
    const viewYaw = this.avoidYaw ? Math.atan2(camPos.x - this.target.x, camPos.z - this.target.z) : this.yaw;
    this.fwd.set(-Math.sin(viewYaw), 0, -Math.cos(viewYaw));
    this.right.set(Math.cos(viewYaw), 0, -Math.sin(viewYaw));
  }

  /** Framing point of a fighter who has left the deck: held at the edge at about shoulder height. */
  private onDeck(p: THREE.Vector3) {
    if (p.y > -0.5) return p;
    p.y = 0.8;
    const d = this.deck;
    if (d.circle) { const r = Math.hypot(p.x, p.z), m = d.circle + 1; if (r > m) p.multiplyScalar(m / r).setY(0.8); }
    else { p.x = THREE.MathUtils.clamp(p.x, -d.hw - 1, d.hw + 1); p.z = THREE.MathUtils.clamp(p.z, -d.hd - 1, d.hd + 1); }
    return p;
  }

  /**
   * Keep the camera out of buildings and in sight of the focus: if the straight line focus → camera crosses solid
   * geometry, ease toward the cheapest clear alternative (raise / swing round), and in any case cut the distance to
   * stop `margin` in front of the first solid cell (instantly when closing in, eased when opening out).
   */
  private collide(camPos: THREE.Vector3, dt: number, snap: boolean) {
    const C = this.collider!;
    const F = this.target;
    if (this.room) { camPos.x = THREE.MathUtils.clamp(camPos.x, -this.room.hw, this.room.hw); camPos.z = THREE.MathUtils.clamp(camPos.z, -this.room.hd, this.room.hd); }
    const off = camPos.clone().sub(F);
    const cine = !!this.cinematic;
    const room = this.room;
    const inRoom = (p: THREE.Vector3) => { if (room) { p.x = THREE.MathUtils.clamp(p.x, -room.hw, room.hw); p.z = THREE.MathUtils.clamp(p.z, -room.hd, room.hd); } return p; };
    const pose = (yo: number, h: number, k = 1, out = new THREE.Vector3()) => inRoom(out.copy(off).setY(0).multiplyScalar(k).applyAxisAngle(UP, yo).add(F).setY(Math.min(Math.max(camPos.y + h, 2, F.y + 0.5), this.maxY))); // never a floor-level lens
    const heads = this.heads;
    const sees = (from: THREE.Vector3, p: THREE.Vector3) => C.march(from, p) >= from.distanceTo(p);
    // Room around the lens too (a beam right beside the camera fills the near plane even if the view is clear).
    const roomy = (p: THREE.Vector3) => { const r = 0.6; return !C.solidAt(p.x, p.y, p.z) && !C.solidAt(p.x + r, p.y, p.z) && !C.solidAt(p.x - r, p.y, p.z) && !C.solidAt(p.x, p.y + r, p.z) && !C.solidAt(p.x, p.y - r, p.z) && !C.solidAt(p.x, p.y, p.z + r) && !C.solidAt(p.x, p.y, p.z - r); };
    // In frame: a detour that sees everyone but looks at the floor between them is no good (closer poses in halls).
    const d1 = new THREE.Vector3(), d2 = new THREE.Vector3();
    const framed = (p: THREE.Vector3, h: THREE.Vector3) => d1.copy(h).sub(p).normalize().dot(d2.copy(F).sub(p).normalize()) > 0.74; // ~42°
    const seen = (p: THREE.Vector3) => roomy(p) && sees(F, p) && heads.every((h) => sees(h, p));
    // The fitted pose frames the fighters by construction; detours must prove it (cinematics frame their subject).
    const clearOf = (p: THREE.Vector3) => seen(p) && (cine || heads.every((h) => framed(p, h)));
    // When nothing is clear: prefer room + focus visible, then fighters in frame, then fighters visible.
    const score = (p: THREE.Vector3) => (!roomy(p) || !sees(F, p) ? -1 : heads.reduce((n, h) => n + (framed(p, h) ? 2 : 0) + (sees(h, p) ? 1 : 0), 0));
    const tmp = new THREE.Vector3();
    const blocked = !seen(pose(0, 0, 1, tmp));
    if (blocked) {
      // Keep the current detour while it still works; otherwise take the cheapest clear one (or the least bad).
      if (!(this.avoidYawT || this.avoidHT || this.avoidKT !== 1) || !clearOf(pose(this.avoidYawT, this.avoidHT, this.avoidKT, tmp))) {
        let best: [number, number, number] | null = null, bestScore = -Infinity, bestAny: [number, number, number] = [0, 0, 1];
        for (const [yo, h, k] of AVOID) {
          if (cine && (h > 5 || k < 0.7)) continue; // cinematics stay low and near their distance: swing round instead
          const p = pose(yo, h, k, tmp);
          if (clearOf(p)) { best = [yo, h, k]; break; }
          // Least bad: framing score, then how far the worst sight line gets before hitting something.
          let frac = Math.min(1, C.march(F, p) / F.distanceTo(p));
          for (const hd of heads) frac = Math.min(frac, C.march(hd, p) / hd.distanceTo(p));
          const sc = score(p) * 10 + frac;
          if (sc > bestScore) { bestScore = sc; bestAny = [yo, h, k]; }
        }
        [this.avoidYawT, this.avoidHT, this.avoidKT] = best ?? bestAny;
      }
    } else { this.avoidYawT = 0; this.avoidHT = 0; this.avoidKT = 1; }
    const k = snap ? 1 : 1 - Math.exp(-(blocked ? 6 : 1.8) * dt);
    this.avoidYaw += (this.avoidYawT - this.avoidYaw) * k;
    this.avoidH += (this.avoidHT - this.avoidH) * k;
    this.avoidK += (this.avoidKT - this.avoidK) * k;
    if (Math.abs(this.avoidYaw) < 1e-3 && !this.avoidYawT) this.avoidYaw = 0;
    if (Math.abs(this.avoidH) < 1e-3 && !this.avoidHT) this.avoidH = 0;
    pose(this.avoidYaw, this.avoidH, this.avoidK, camPos);
    // Hard guarantee: if this pose still isn't clear (focus or a fighter hidden, or no room around the lens), slide
    // the camera toward a pivot above the action and stop at the first clear point. Pulling straight toward the
    // focus (hip height) dropped the camera to the floor in the middle of the fight in small walled rooms.
    const P = F.clone().setY(Math.min(F.y + (cine ? 0.6 : 2.5), this.maxY));
    if (C.solidAt(P.x, P.y, P.z)) P.copy(F);
    const at = (t: number, out = tmp) => out.copy(camPos).lerp(P, t);
    let tNeed = 0, why = '';
    const ok = (p: THREE.Vector3) => (blocked || this.avoidYaw || this.avoidH || this.avoidK !== 1 ? clearOf(p) : seen(p));
    if (!ok(camPos)) {
      // First clear point toward the pivot; if there is none, the best-scoring one (never just the pivot itself:
      // in a hall with fighters far apart that looked at the floor with nobody in frame).
      let bestT = 0, bestS = score(camPos);
      tNeed = -1;
      for (let t = 0.05; t <= 1.001; t += 0.05) {
        const q = at(t);
        if (ok(q)) { tNeed = t; break; }
        const sc = score(q);
        if (sc > bestS) { bestS = sc; bestT = t; }
      }
      if (tNeed < 0) tNeed = bestT;
      why = `slid ${(tNeed * 100).toFixed(0)}% to pivot`;
    }
    // Snap in, ease back out (re-checked: if the eased point isn't clear, use the needed one).
    if (snap || tNeed >= this.pullT) this.pullT = tNeed;
    else { this.pullT = Math.max(tNeed, this.pullT - 1.6 * dt); if (!ok(at(this.pullT))) this.pullT = tNeed; }
    const pulled = this.pullT > 0;
    if (pulled) camPos.copy(at(this.pullT, new THREE.Vector3()));
    // Never under the deck (all decks sit at y ≈ 0) or well below the action.
    camPos.y = Math.max(camPos.y, F.y - 1, 1);
    this.lastHit = { blocked, pulled, yaw: this.avoidYaw, h: this.avoidH, why };
  }
}

function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function angDiff(a: number, b: number) {
  return Math.abs(wrap(a - b));
}
