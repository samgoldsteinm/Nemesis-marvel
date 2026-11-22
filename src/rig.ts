import * as THREE from 'three';

// A simple humanoid rig built from groups. Every character attaches its own original meshes
// to these joints, and every pose is authored as joint rotations that are damped toward each frame.

export type JointName =
  | 'hips' | 'spine' | 'head'
  | 'lArm' | 'lFore' | 'rArm' | 'rFore'
  | 'lThigh' | 'lShin' | 'rThigh' | 'rShin';

export const JOINTS: JointName[] = ['hips', 'spine', 'head', 'lArm', 'lFore', 'rArm', 'rFore', 'lThigh', 'lShin', 'rThigh', 'rShin'];

export type Euler3 = [number, number, number];
export interface Pose {
  j: Partial<Record<JointName, Euler3>>;
  bodyY?: number; // vertical offset of hips
  pitch?: number; // whole-body pitch (lying / flying)
  roll?: number;
}

export interface Proportions {
  thigh: number;
  shin: number;
  torso: number; // hips -> shoulder line
  shoulderW: number;
  hipW: number;
  upperArm: number;
  foreArm: number;
  neck: number;
}

export class Rig {
  root = new THREE.Group(); // positioned at feet, yawed to facing
  body = new THREE.Group(); // pitch / roll / bob
  joints: Record<JointName, THREE.Group>;
  hand: { l: THREE.Group; r: THREE.Group };
  foot: { l: THREE.Group; r: THREE.Group };
  chestAnchor = new THREE.Group(); // for wings, capes
  hipHeight: number;
  private cur: Record<JointName, THREE.Vector3>;
  private vel: Record<JointName, THREE.Vector3>;
  /** Spring damping ratio: < 1 gives a little overshoot, i.e. follow-through after strikes. */
  zeta = 0.72;
  private curBodyY = 0;
  private curPitch = 0;
  private curRoll = 0;

  constructor(public p: Proportions) {
    const g = () => new THREE.Group();
    const j = {} as Record<JointName, THREE.Group>;
    for (const n of JOINTS) j[n] = g();
    this.joints = j;
    this.hipHeight = p.thigh + p.shin;
    this.root.add(this.body);
    this.body.add(j.hips);
    j.hips.position.y = this.hipHeight;
    j.hips.add(j.spine);
    j.spine.add(j.head);
    j.head.position.y = p.torso + p.neck;
    j.spine.add(this.chestAnchor);
    this.chestAnchor.position.y = p.torso * 0.75;
    j.spine.add(j.lArm, j.rArm);
    j.lArm.position.set(p.shoulderW / 2, p.torso, 0);
    j.rArm.position.set(-p.shoulderW / 2, p.torso, 0);
    j.lArm.add(j.lFore);
    j.rArm.add(j.rFore);
    j.lFore.position.y = -p.upperArm;
    j.rFore.position.y = -p.upperArm;
    j.hips.add(j.lThigh, j.rThigh);
    j.lThigh.position.set(p.hipW / 2, 0, 0);
    j.rThigh.position.set(-p.hipW / 2, 0, 0);
    j.lThigh.add(j.lShin);
    j.rThigh.add(j.rShin);
    j.lShin.position.y = -p.thigh;
    j.rShin.position.y = -p.thigh;
    const lh = g(), rh = g(), lf = g(), rf = g();
    lh.position.y = -p.foreArm;
    rh.position.y = -p.foreArm;
    j.lFore.add(lh);
    j.rFore.add(rh);
    lf.position.y = -p.shin;
    rf.position.y = -p.shin;
    j.lShin.add(lf);
    j.rShin.add(rf);
    this.hand = { l: lh, r: rh };
    this.foot = { l: lf, r: rf };
    this.cur = {} as Record<JointName, THREE.Vector3>;
    for (const n of JOINTS) this.cur[n] = new THREE.Vector3();
    this.vel = {} as Record<JointName, THREE.Vector3>;
    for (const n of JOINTS) this.vel[n] = new THREE.Vector3();
  }

  /** Damp toward the target pose. rate ~ responsiveness per second. */
  apply(target: Pose, rate: number, dt: number) {
    const k = 1 - Math.exp(-rate * dt);
    if (rate > 1e5) {
      for (const n of JOINTS) { const t = target.j[n] ?? ZERO; this.cur[n].set(t[0], t[1], t[2]); this.vel[n].set(0, 0, 0); this.joints[n].rotation.set(t[0], t[1], t[2]); }
    } else {
      // Second-order spring per joint (sub-stepped for stability): anticipation in, overshoot out.
      const w = rate * 0.9;
      const kk = w * w, cc = 2 * this.zeta * w;
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (const n of JOINTS) {
        const t = target.j[n] ?? ZERO;
        const c = this.cur[n], v = this.vel[n];
        for (let i = 0; i < steps; i++) {
          v.x += (kk * (t[0] - c.x) - cc * v.x) * h;
          v.y += (kk * (t[1] - c.y) - cc * v.y) * h;
          v.z += (kk * (t[2] - c.z) - cc * v.z) * h;
          c.x += v.x * h; c.y += v.y * h; c.z += v.z * h;
        }
        this.joints[n].rotation.set(c.x, c.y, c.z);
      }
    }
    this.curBodyY += ((target.bodyY ?? 0) - this.curBodyY) * k;
    this.curPitch += ((target.pitch ?? 0) - this.curPitch) * k;
    this.curRoll += ((target.roll ?? 0) - this.curRoll) * k;
    this.joints.hips.position.y = this.hipHeight + this.curBodyY;
    this.body.rotation.set(this.curPitch, 0, this.curRoll);
  }

  snap(target: Pose) {
    this.apply(target, 1e6, 1);
  }
}

const ZERO: Euler3 = [0, 0, 0];

// ------------------------------------------------------------ mesh helpers
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x07070c, side: THREE.BackSide });
const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

export function addOutline(mesh: THREE.Mesh, thickness = 1.06) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat);
  o.scale.setScalar(thickness);
  o.castShadow = false;
  o.receiveShadow = false;
  o.userData.outline = true;
  mesh.add(o);
  return mesh;
}

/** A tapered limb that hangs down -Y from its joint. */
export function limb(parent: THREE.Object3D, len: number, r0: number, r1: number, mat: THREE.Material, outline = true) {
  const geo = cached(`limb${len.toFixed(3)}_${r0.toFixed(3)}_${r1.toFixed(3)}`, () => {
    const g = new THREE.CylinderGeometry(r0, r1, len, 10, 1);
    g.translate(0, -len / 2, 0);
    return g;
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  if (outline) addOutline(m, 1.08);
  parent.add(m);
  const jGeo = cached(`ball${r0.toFixed(3)}`, () => new THREE.SphereGeometry(r0, 10, 8));
  const jm = new THREE.Mesh(jGeo, mat);
  jm.castShadow = true;
  parent.add(jm);
  return m;
}

export function box(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, pos: [number, number, number], rot?: [number, number, number], outline = true) {
  const geo = cached(`box${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true;
  if (outline) addOutline(m, 1.07);
  parent.add(m);
  return m;
}

export function sphere(parent: THREE.Object3D, r: number, mat: THREE.Material, pos: [number, number, number], scale?: [number, number, number], outline = true) {
  const geo = cached(`sph${r}`, () => new THREE.SphereGeometry(r, 14, 10));
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  if (scale) m.scale.set(...scale);
  m.castShadow = true;
  if (outline) addOutline(m, 1.08);
  parent.add(m);
  return m;
}

// ------------------------------------------------------------ pose library
export const P = {
  guard(t: number, heavy: number): Pose {
    const b = Math.sin(t * 2.2) * 0.03;
    return {
      j: {
        spine: [0.1 + b + heavy * 0.1, 0, 0],
        head: [-0.05 - heavy * 0.05, 0, 0],
        lArm: [-0.55, 0, 0.25 + heavy * 0.25], lFore: [-1.4, 0, 0],
        rArm: [-0.45, 0, -0.25 - heavy * 0.25], rFore: [-1.5, 0, 0],
        lThigh: [-0.25, 0, 0.08 + heavy * 0.1], lShin: [0.4, 0, 0],
        rThigh: [0.15, 0, -0.08 - heavy * 0.1], rShin: [0.35, 0, 0],
        hips: [0, 0.2, 0],
      },
      bodyY: -0.06 - heavy * 0.06 + b * 0.5,
    };
  },
  run(phase: number, lean: number, heavy: number): Pose {
    const s = Math.sin(phase), c = Math.cos(phase);
    const amp = 0.9 - heavy * 0.25;
    return {
      j: {
        spine: [0.2 + lean, -s * 0.15, 0],
        head: [-0.15 - lean * 0.6, s * 0.1, 0],
        lArm: [0.8 * s, 0, 0.15 + heavy * 0.25], lFore: [-1.3, 0, 0],
        rArm: [-0.8 * s, 0, -0.15 - heavy * 0.25], rFore: [-1.3, 0, 0],
        lThigh: [-amp * s - 0.15, 0, 0.05], lShin: [0.3 + 1.0 * Math.max(0, c), 0, 0],
        rThigh: [amp * s - 0.15, 0, -0.05], rShin: [0.3 + 1.0 * Math.max(0, -c), 0, 0],
        hips: [0, s * 0.12, 0],
      },
      bodyY: -0.04 + 0.07 * Math.abs(c) - heavy * 0.05,
    };
  },
  air(vy: number): Pose {
    const up = THREE.MathUtils.clamp(vy / 10, -1, 1);
    return {
      j: {
        spine: [0.15 - up * 0.1, 0, 0],
        lArm: [-0.4 - up * 0.8, 0, 0.6], lFore: [-0.9, 0, 0],
        rArm: [-0.2 - up * 0.8, 0, -0.6], rFore: [-0.9, 0, 0],
        lThigh: [-1.0 + up * 0.2, 0, 0.1], lShin: [1.4, 0, 0],
        rThigh: [-0.4, 0, -0.1], rShin: [0.9, 0, 0],
      },
    };
  },
  jabW(): Pose { return { j: { spine: [0.15, 0.5, 0], rArm: [-0.4, 0, -0.5], rFore: [-2.2, 0, 0], lArm: [-0.8, 0, 0.3], lFore: [-1.5, 0, 0], lThigh: [-0.4, 0, 0.1], lShin: [0.4, 0, 0], rThigh: [0.3, 0, 0], rShin: [0.3, 0, 0] }, bodyY: -0.1 }; },
  jabS(): Pose { return { j: { spine: [0.25, -0.6, 0], hips: [0, -0.3, 0], rArm: [-1.65, 0.3, -0.1], rFore: [-0.05, 0, 0], lArm: [-0.4, 0, 0.4], lFore: [-1.6, 0, 0], lThigh: [-0.6, 0, 0.1], lShin: [0.5, 0, 0], rThigh: [0.45, 0, 0], rShin: [0.2, 0, 0] }, bodyY: -0.12 }; },
  crossW(): Pose { return { j: { spine: [0.15, -0.5, 0], lArm: [-0.4, 0, 0.5], lFore: [-2.2, 0, 0], rArm: [-0.8, 0, -0.3], rFore: [-1.5, 0, 0], lThigh: [-0.3, 0, 0.1], lShin: [0.4, 0, 0], rThigh: [0.2, 0, 0], rShin: [0.4, 0, 0] }, bodyY: -0.1 }; },
  crossS(): Pose { return { j: { spine: [0.25, 0.6, 0], hips: [0, 0.3, 0], lArm: [-1.65, -0.3, 0.1], lFore: [-0.05, 0, 0], rArm: [-0.4, 0, -0.4], rFore: [-1.6, 0, 0], lThigh: [-0.5, 0, 0.1], lShin: [0.3, 0, 0], rThigh: [0.5, 0, 0], rShin: [0.3, 0, 0] }, bodyY: -0.12 }; },
  upperW(): Pose { return { j: { spine: [0.5, 0.3, 0], rArm: [0.4, 0, -0.3], rFore: [-1.8, 0, 0], lArm: [-0.6, 0, 0.3], lFore: [-1.5, 0, 0], lThigh: [-0.8, 0, 0.1], lShin: [1.0, 0, 0], rThigh: [0.3, 0, 0], rShin: [0.9, 0, 0] }, bodyY: -0.3 }; },
  upperS(): Pose { return { j: { spine: [-0.25, -0.4, 0], head: [-0.3, 0, 0], rArm: [-2.8, 0, -0.2], rFore: [-0.6, 0, 0], lArm: [-0.2, 0, 0.5], lFore: [-1.2, 0, 0], lThigh: [-0.2, 0, 0.1], lShin: [0.2, 0, 0], rThigh: [0.4, 0, 0], rShin: [0.1, 0, 0] }, bodyY: 0.05 }; },
  kickS(): Pose { return { j: { spine: [-0.3, 0, 0], lThigh: [-1.6, 0, 0.1], lShin: [0.05, 0, 0], rThigh: [0.3, 0, 0], rShin: [0.8, 0, 0], lArm: [0.4, 0, 1.0], rArm: [0.4, 0, -1.0], lFore: [-0.5, 0, 0], rFore: [-0.5, 0, 0] } }; },
  diveS(): Pose { return { j: { spine: [0.6, 0, 0], lThigh: [-0.3, 0, 0], lShin: [0.2, 0, 0], rThigh: [-0.3, 0, 0], rShin: [0.2, 0, 0], lArm: [-2.6, 0, 0.2], rArm: [-2.6, 0, -0.2], lFore: [0, 0, 0], rFore: [0, 0, 0] }, pitch: 0.5 }; },
  overheadW(): Pose { return { j: { spine: [-0.35, 0, 0], head: [-0.2, 0, 0], lArm: [-3.0, 0, 0.3], lFore: [-0.4, 0, 0], rArm: [-3.0, 0, -0.3], rFore: [-0.4, 0, 0], lThigh: [-0.3, 0, 0.25], lShin: [0.5, 0, 0], rThigh: [0.1, 0, -0.25], rShin: [0.5, 0, 0] }, bodyY: -0.05 }; },
  slamS(): Pose { return { j: { spine: [0.75, 0, 0], head: [-0.4, 0, 0], lArm: [-1.1, 0, 0.1], lFore: [-0.2, 0, 0], rArm: [-1.1, 0, -0.1], rFore: [-0.2, 0, 0], lThigh: [-0.9, 0, 0.35], lShin: [1.2, 0, 0], rThigh: [0.2, 0, -0.35], rShin: [1.1, 0, 0] }, bodyY: -0.4 }; },
  clapW(): Pose { return { j: { spine: [-0.15, 0, 0], lArm: [-1.4, 0, 1.4], lFore: [-0.2, 0, 0], rArm: [-1.4, 0, -1.4], rFore: [-0.2, 0, 0], lThigh: [-0.4, 0, 0.3], lShin: [0.6, 0, 0], rThigh: [0.2, 0, -0.3], rShin: [0.6, 0, 0] }, bodyY: -0.15 }; },
  clapS(): Pose { return { j: { spine: [0.35, 0, 0], lArm: [-1.55, 0, -0.1], lFore: [-0.1, 0, 0], rArm: [-1.55, 0, 0.1], rFore: [-0.1, 0, 0], lThigh: [-0.6, 0, 0.3], lShin: [0.7, 0, 0], rThigh: [0.4, 0, -0.3], rShin: [0.4, 0, 0] }, bodyY: -0.25 }; },
  grab(): Pose { return { j: { spine: [0.35, 0, 0], lArm: [-1.5, 0, 0.15], lFore: [-0.3, 0, 0], rArm: [-1.5, 0, -0.15], rFore: [-0.3, 0, 0], lThigh: [-0.5, 0, 0.1], lShin: [0.5, 0, 0], rThigh: [0.3, 0, 0], rShin: [0.3, 0, 0] }, bodyY: -0.1 }; },
  holdOver(): Pose { return { j: { spine: [-0.1, 0, 0], lArm: [-2.9, 0, 0.35], lFore: [-0.35, 0, 0], rArm: [-2.9, 0, -0.35], rFore: [-0.35, 0, 0], lThigh: [-0.2, 0, 0.2], lShin: [0.4, 0, 0], rThigh: [0.1, 0, -0.2], rShin: [0.4, 0, 0] }, bodyY: -0.12 }; },
  carry(): Pose { return { j: { spine: [0.05, 0, 0], lArm: [-1.2, 0, 0.3], lFore: [-1.0, 0, 0], rArm: [-1.2, 0, -0.3], rFore: [-1.0, 0, 0] } }; },
  throwW(): Pose { return { j: { spine: [-0.55, 0.3, 0], head: [-0.2, 0, 0], lArm: [-2.6, 0, 0.5], lFore: [-0.9, 0, 0], rArm: [-2.6, 0, -0.5], rFore: [-0.9, 0, 0], lThigh: [-0.6, 0, 0.3], lShin: [0.5, 0, 0], rThigh: [0.4, 0, -0.3], rShin: [0.4, 0, 0] }, bodyY: -0.2 }; },
  throwS(): Pose { return { j: { spine: [0.7, -0.3, 0], head: [-0.4, 0, 0], lArm: [-1.3, 0, 0.2], lFore: [-0.1, 0, 0], rArm: [-1.3, 0, -0.2], rFore: [-0.1, 0, 0], lThigh: [-0.9, 0, 0.3], lShin: [0.9, 0, 0], rThigh: [0.6, 0, -0.3], rShin: [0.2, 0, 0] }, bodyY: -0.3 }; },
  block(): Pose { return { j: { spine: [0.3, 0, 0], head: [0.2, 0, 0], lArm: [-1.4, -0.6, 0.2], lFore: [-1.9, 0, 0], rArm: [-1.4, 0.6, -0.2], rFore: [-1.9, 0, 0], lThigh: [-0.5, 0, 0.2], lShin: [0.8, 0, 0], rThigh: [0.3, 0, -0.2], rShin: [0.7, 0, 0] }, bodyY: -0.2 }; },
  evade(): Pose { return { j: { spine: [0.6, 0, 0], lArm: [-0.6, 0, 0.6], lFore: [-1.2, 0, 0], rArm: [-0.6, 0, -0.6], rFore: [-1.2, 0, 0], lThigh: [-1.3, 0, 0.3], lShin: [1.8, 0, 0], rThigh: [-0.2, 0, -0.3], rShin: [1.6, 0, 0] }, bodyY: -0.45 }; },
  hit(side: number): Pose { return { j: { spine: [-0.45, side * 0.4, side * 0.2], head: [-0.4, 0, 0], lArm: [-0.2, 0, 0.9], lFore: [-0.6, 0, 0], rArm: [-0.2, 0, -0.9], rFore: [-0.6, 0, 0], lThigh: [-0.2, 0, 0.1], lShin: [0.5, 0, 0], rThigh: [0.3, 0, 0], rShin: [0.3, 0, 0] }, bodyY: -0.1 }; },
  launched(): Pose { return { j: { spine: [-0.5, 0, 0], head: [-0.5, 0, 0], lArm: [0.5, 0, 1.6], lFore: [-0.3, 0, 0], rArm: [0.5, 0, -1.6], rFore: [-0.3, 0, 0], lThigh: [-0.5, 0, 0.5], lShin: [0.9, 0, 0], rThigh: [0.3, 0, -0.5], rShin: [0.5, 0, 0] }, pitch: -0.7 }; },
  down(): Pose { return { j: { spine: [-0.1, 0, 0], lArm: [0.2, 0, 1.2], rArm: [0.2, 0, -1.4], lFore: [-0.3, 0, 0], rFore: [-0.2, 0, 0], lThigh: [-0.1, 0, 0.2], rThigh: [-0.3, 0, -0.1], lShin: [0.3, 0, 0], rShin: [0.6, 0, 0] }, pitch: -1.5, bodyY: -0.55 }; },
  getup(): Pose { return { j: { spine: [0.7, 0, 0], lArm: [-0.7, 0, 0.5], rArm: [-0.7, 0, -0.5], lFore: [-0.8, 0, 0], rFore: [-0.8, 0, 0], lThigh: [-1.4, 0, 0.3], lShin: [2.0, 0, 0], rThigh: [-0.2, 0, -0.3], rShin: [1.7, 0, 0] }, bodyY: -0.5 }; },
  swing(t: number): Pose {
    const s = Math.sin(t * 3);
    return { j: { spine: [0.1, 0, 0], rArm: [-3.0, 0, -0.25], rFore: [-0.1, 0, 0], lArm: [-0.5, 0, 0.8], lFore: [-1.0, 0, 0], lThigh: [-1.0 + s * 0.3, 0, 0.15], lShin: [1.5, 0, 0], rThigh: [-0.6 - s * 0.3, 0, -0.15], rShin: [1.2, 0, 0] } };
  },
  cling(): Pose { return { j: { spine: [0.3, 0, 0], lArm: [-2.5, 0, 0.6], lFore: [-0.9, 0, 0], rArm: [-2.5, 0, -0.6], rFore: [-0.9, 0, 0], lThigh: [-1.2, 0, 0.6], lShin: [1.6, 0, 0], rThigh: [-0.8, 0, -0.6], rShin: [1.8, 0, 0] }, pitch: 0.2 }; },
  fly(speed: number): Pose {
    const s = THREE.MathUtils.clamp(speed / 12, 0, 1);
    return { j: { spine: [0.1, 0, 0], head: [-0.6 * s - 0.1, 0, 0], lArm: [0.5 * s, 0, 0.35], lFore: [-0.3, 0, 0], rArm: [0.5 * s, 0, -0.35], rFore: [-0.3, 0, 0], lThigh: [0.15, 0, 0.08], lShin: [0.3, 0, 0], rThigh: [0.05, 0, -0.08], rShin: [0.5, 0, 0] }, pitch: 1.1 * s };
  },
  shoot(): Pose { return { j: { spine: [0.1, -0.5, 0], rArm: [-1.6, 0.5, 0], rFore: [0, 0, 0], lArm: [-0.4, 0, 0.5], lFore: [-1.3, 0, 0], lThigh: [-0.3, 0, 0.1], lShin: [0.3, 0, 0], rThigh: [0.25, 0, 0], rShin: [0.25, 0, 0] } }; },
  charge(t: number): Pose {
    const q = Math.sin(t * 30) * 0.02;
    return { j: { spine: [-0.25 + q, 0, 0], head: [-0.3, 0, 0], lArm: [0.1, 0, 0.6], lFore: [-0.8, 0, 0], rArm: [0.1, 0, -0.6], rFore: [-0.8, 0, 0], lThigh: [-0.3, 0, 0.35], lShin: [0.7, 0, 0], rThigh: [-0.3, 0, -0.35], rShin: [0.7, 0, 0] }, bodyY: -0.25 };
  },
  victory(t: number): Pose { return { j: { spine: [-0.15, 0, 0], head: [-0.25, 0, 0], rArm: [-3.0, 0, -0.3 + Math.sin(t * 4) * 0.1], rFore: [-0.2, 0, 0], lArm: [0.1, 0, 0.3], lFore: [-1.6, 0, 0], lThigh: [-0.1, 0, 0.2], rThigh: [0.05, 0, -0.2] } }; },
  defeat(): Pose { return { j: { spine: [0.8, 0, 0], head: [0.5, 0, 0], lArm: [-0.3, 0, 0.2], rArm: [-0.3, 0, -0.2], lFore: [-0.3, 0, 0], rFore: [-0.3, 0, 0], lThigh: [-1.5, 0, 0.2], lShin: [2.2, 0, 0], rThigh: [0.0, 0, -0.2], rShin: [2.0, 0, 0] }, bodyY: -0.6 }; },
  teleport(): Pose { return { j: { spine: [0.5, 0, 0], lArm: [-0.2, 0, 1.0], rArm: [-0.2, 0, -1.0], lThigh: [-1.0, 0, 0.3], lShin: [1.6, 0, 0], rThigh: [-0.6, 0, -0.3], rShin: [1.5, 0, 0] }, bodyY: -0.35 }; },
  heldVictim(): Pose { return { j: { spine: [-0.2, 0, 0], head: [-0.3, 0, 0], lArm: [-0.4, 0, 0.8], rArm: [-0.4, 0, -0.8], lFore: [-0.6, 0, 0], rFore: [-0.6, 0, 0], lThigh: [-0.3, 0, 0.1], lShin: [0.6, 0, 0], rThigh: [0.2, 0, -0.1], rShin: [0.4, 0, 0] } }; },
};
