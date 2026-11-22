import * as THREE from 'three';
import { BOUNDS } from './arena';

// Pooled visual effects. Debris and sparks are single InstancedMeshes so heavy fights stay cheap.
// Density scales with `quality` (lowered first when frame time is over budget).

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  rv: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  grav: number;
  color: THREE.Color;
}

/** A fading ribbon that follows a striking limb: a readable swoosh for every attack. */
export class Ribbon {
  mesh: THREE.Mesh;
  private pts: { a: THREE.Vector3; b: THREE.Vector3; life: number }[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private color: THREE.Color;
  static N = 14;
  constructor(scene: THREE.Scene, color: number) {
    const N = Ribbon.N;
    this.color = new THREE.Color(color);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3);
    this.col = new Float32Array(N * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  push(a: THREE.Vector3, b: THREE.Vector3) {
    this.pts.unshift({ a: a.clone(), b: b.clone(), life: 0.16 });
    if (this.pts.length > Ribbon.N) this.pts.pop();
  }
  update(dt: number) {
    for (const p of this.pts) p.life -= dt;
    while (this.pts.length && this.pts[this.pts.length - 1].life <= 0) this.pts.pop();
    const N = Ribbon.N;
    for (let i = 0; i < N; i++) {
      const p = this.pts[Math.min(i, this.pts.length - 1)];
      const k = p ? Math.max(0, p.life / 0.16) * (1 - i / N) : 0;
      for (let j = 0; j < 2; j++) {
        const v = p ? (j ? p.b : p.a) : this.mesh.position;
        const o = (i * 2 + j) * 3;
        this.pos[o] = v.x; this.pos[o + 1] = v.y; this.pos[o + 2] = v.z;
        const c = j ? k : k * 0.35;
        this.col[o] = this.color.r * c; this.col[o + 1] = this.color.g * c; this.col[o + 2] = this.color.b * c;
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
  }
}

export class FX {
  quality = 1;
  private debris: THREE.InstancedMesh;
  private sparks: THREE.InstancedMesh;
  private dParts: Particle[] = [];
  private sParts: Particle[] = [];
  private puffs: THREE.InstancedMesh;
  private pParts: Particle[] = [];
  private maxP = 120;
  private rings: { m: THREE.Mesh; life: number; max: number; r0: number; r1: number }[] = [];
  private flashes: { m: THREE.Mesh; life: number; max: number; s: number }[] = [];
  private tmp = new THREE.Object3D();
  private maxD = 260;
  private maxS = 320;
  shake = 0;
  hitstop = 0;

  constructor(public scene: THREE.Scene) {
    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), this.maxD);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    scene.add(this.debris);
    this.sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), this.maxS);
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.frustumCulled = false;
    this.sparks.count = 0;
    scene.add(this.sparks);
    this.puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0xb8b0a8, transparent: true, opacity: 0.45, depthWrite: false }), this.maxP);
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    scene.add(this.puffs);
    const ringGeo = new THREE.RingGeometry(0.85, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.rings.push({ m, life: 0, max: 1, r0: 0, r1: 1 });
    }
    const flashGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.flashes.push({ m, life: 0, max: 1, s: 1 });
    }
  }

  clear() {
    this.dParts.length = 0;
    this.pParts.length = 0;
    this.sParts.length = 0;
    for (const r of this.rings) { r.life = 0; r.m.visible = false; }
    for (const f of this.flashes) { f.life = 0; f.m.visible = false; }
    this.shake = 0;
    this.hitstop = 0;
  }

  burstDebris(pos: THREE.Vector3, count: number, color: number, speed = 6, size = 0.25, dir?: THREE.Vector3) {
    const n = Math.round(count * this.quality);
    for (let i = 0; i < n; i++) {
      if (this.dParts.length >= this.maxD) this.dParts.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (dir) v.addScaledVector(dir, speed * 0.6);
      const c = new THREE.Color(color).multiplyScalar(0.7 + Math.random() * 0.4);
      this.dParts.push({ p: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.5, (Math.random() - 0.5) * 0.5)), v, r: new THREE.Euler(Math.random() * 3, Math.random() * 3, 0), rv: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0), life: 1.6 + Math.random(), max: 2.6, size: size * (0.5 + Math.random()), grav: 22, color: c });
    }
  }

  sparksAt(pos: THREE.Vector3, count: number, color: number, speed = 8, size = 0.08, grav = 6) {
    const n = Math.round(count * this.quality);
    for (let i = 0; i < n; i++) {
      if (this.sParts.length >= this.maxS) this.sParts.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      const life = 0.25 + Math.random() * 0.35;
      this.sParts.push({ p: pos.clone(), v, r: new THREE.Euler(), rv: new THREE.Vector3(), life, max: life, size: size * (0.6 + Math.random()), grav, color: new THREE.Color(color) });
    }
  }

  /** Soft dust from landings, footsteps and slides. */
  dust(pos: THREE.Vector3, count: number, size = 0.35, spread = 1.5) {
    const n = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      if (this.pParts.length >= this.maxP) this.pParts.shift();
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * spread * (0.5 + Math.random()), 0.6 + Math.random() * 0.8, Math.sin(a) * spread * (0.5 + Math.random()));
      const life = 0.45 + Math.random() * 0.35;
      this.pParts.push({ p: pos.clone().add(new THREE.Vector3(0, 0.15, 0)), v, r: new THREE.Euler(), rv: new THREE.Vector3(), life, max: life, size: size * (0.6 + Math.random() * 0.8), grav: 0.5, color: new THREE.Color() });
    }
  }

  trail(pos: THREE.Vector3, color: number, size = 0.12, life = 0.35) {
    if (this.quality < 0.5 && Math.random() < 0.5) return;
    if (this.sParts.length >= this.maxS) this.sParts.shift();
    this.sParts.push({ p: pos.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6), r: new THREE.Euler(), rv: new THREE.Vector3(), life, max: life, size, grav: -1, color: new THREE.Color(color) });
  }

  ring(pos: THREE.Vector3, r1: number, color: number, dur = 0.45) {
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.life = dur;
    r.max = dur;
    r.r0 = 0.3;
    r.r1 = r1;
    r.m.position.copy(pos);
    r.m.position.y += 0.08;
    (r.m.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.m.visible = true;
  }

  flash(pos: THREE.Vector3, size: number, color: number, dur = 0.18) {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.life = dur;
    f.max = dur;
    f.s = size;
    f.m.position.copy(pos);
    (f.m.material as THREE.MeshBasicMaterial).color.setHex(color);
    f.m.visible = true;
  }

  update(dt: number) {
    const t = this.tmp;
    let i = 0;
    for (let k = this.dParts.length - 1; k >= 0; k--) {
      const d = this.dParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.dParts.splice(k, 1); continue; }
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < d.size * 0.5 && Math.abs(d.p.x) < BOUNDS.hw && Math.abs(d.p.z) < BOUNDS.hd) {
        d.p.y = d.size * 0.5;
        d.v.y *= -0.3;
        d.v.x *= 0.6;
        d.v.z *= 0.6;
        d.rv.multiplyScalar(0.6);
      }
      d.r.x += d.rv.x * dt;
      d.r.y += d.rv.y * dt;
      const s = d.size * Math.min(1, d.life / 0.4);
      t.position.copy(d.p);
      t.rotation.copy(d.r);
      t.scale.setScalar(s);
      t.updateMatrix();
      this.debris.setMatrixAt(i, t.matrix);
      this.debris.setColorAt(i, d.color);
      i++;
    }
    this.debris.count = i;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;

    i = 0;
    for (let k = this.sParts.length - 1; k >= 0; k--) {
      const d = this.sParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.sParts.splice(k, 1); continue; }
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      const f = d.life / d.max;
      t.position.copy(d.p);
      t.rotation.set(0, 0, 0);
      t.scale.set(d.size * f, d.size * f * 2.2, d.size * f);
      t.updateMatrix();
      this.sparks.setMatrixAt(i, t.matrix);
      this.sparks.setColorAt(i, d.color);
      i++;
    }
    this.sparks.count = i;
    this.sparks.instanceMatrix.needsUpdate = true;
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;

    i = 0;
    for (let k = this.pParts.length - 1; k >= 0; k--) {
      const d = this.pParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.pParts.splice(k, 1); continue; }
      d.v.multiplyScalar(Math.exp(-3 * dt));
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      const f = 1 - d.life / d.max;
      t.position.copy(d.p);
      t.rotation.set(0, 0, 0);
      t.scale.setScalar(d.size * (0.6 + f * 1.2) * (1 - f * f));
      t.updateMatrix();
      this.puffs.setMatrixAt(i, t.matrix);
      i++;
    }
    this.puffs.count = i;
    this.puffs.instanceMatrix.needsUpdate = true;

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const f = 1 - r.life / r.max;
      const s = r.r0 + (r.r1 - r.r0) * (1 - (1 - f) * (1 - f));
      r.m.scale.set(s, 1, s);
      (r.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f);
      if (r.life <= 0) r.m.visible = false;
    }
    for (const fl of this.flashes) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      const f = 1 - fl.life / fl.max;
      fl.m.scale.setScalar(fl.s * (0.5 + f));
      (fl.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f);
      if (fl.life <= 0) fl.m.visible = false;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }
}
