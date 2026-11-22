import * as THREE from 'three';
import type { Fighter } from './fighter';

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
  right = new THREE.Vector3(1, 0, 0);

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 600);
  }

  snapTo(fs: Fighter[]) {
    this.update(fs, 1, 0, true);
  }

  update(fs: Fighter[], dt: number, shake: number, snap = false) {
    const pts: THREE.Vector3[] = [];
    for (const f of fs) {
      if (f.state === 'out') continue;
      pts.push(f.pos.clone().setY(f.pos.y + f.def.height * 0.6));
      // Leave room in the direction of a launch.
      if (f.state === 'launched' || f.state === 'swing' || f.state === 'fly') pts.push(f.pos.clone().addScaledVector(f.vel, 0.45).setY(Math.max(-2, f.pos.y + f.vel.y * 0.2)));
    }
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
      wantDist = THREE.MathUtils.clamp(6.5 + spread * 1.25 + vspan * 0.6, 8, 28);
      wantH = 1.6 + wantDist * 0.2 + vspan * 0.35;
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
    const camPos = new THREE.Vector3(this.target.x + Math.sin(this.yaw) * this.dist, this.target.y + this.height, this.target.z + Math.cos(this.yaw) * this.dist);
    if (camPos.y < 1.5) camPos.y = 1.5;
    this.pos.copy(camPos);
    this.cam.position.copy(camPos);
    if (shake > 0) {
      const s = shake * shake * 0.35;
      this.cam.position.x += (Math.random() - 0.5) * s;
      this.cam.position.y += (Math.random() - 0.5) * s;
      this.cam.position.z += (Math.random() - 0.5) * s;
    }
    this.cam.lookAt(this.target.x, this.target.y - 0.15, this.target.z);
    this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
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
