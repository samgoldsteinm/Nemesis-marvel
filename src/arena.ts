import * as THREE from 'three';
import type { LiftClass } from './characters';
import { addOutline } from './rig';
import { FX } from './fx';
import { sfx } from './audio';

// The Clarion Building rooftop: an enclosed roof that becomes a ring-out arena as its fence breaks.

export const HW = 18; // roof half-width (x)
export const HD = 13; // roof half-depth (z)
export const WALL_H = 3.0;
export const WALL_T = 0.5;
export const KILL_Y = -14;

export interface Solid {
  min: THREE.Vector3;
  max: THREE.Vector3;
  kind: 'wall' | 'hut' | 'mast' | 'prop';
  ref?: any;
  clingable: boolean;
}

export class WallSeg {
  hp = 100;
  broken = false;
  solid: Solid;
  group = new THREE.Group();
  base: THREE.Mesh;
  fence: THREE.Object3D;
  constructor(public center: THREE.Vector3, public size: THREE.Vector3, public outward: THREE.Vector3, mats: ArenaMats) {
    this.solid = {
      min: new THREE.Vector3(center.x - size.x / 2, 0, center.z - size.z / 2),
      max: new THREE.Vector3(center.x + size.x / 2, WALL_H, center.z + size.z / 2),
      kind: 'wall', ref: this, clingable: true,
    };
    this.group.position.copy(center);
    this.base = new THREE.Mesh(new THREE.BoxGeometry(size.x, 1.0, size.z), mats.concrete);
    this.base.position.y = 0.5;
    this.base.castShadow = this.base.receiveShadow = true;
    addOutline(this.base, 1.02);
    this.group.add(this.base);
    // Chain-link fence panel with posts: visibly tall, so the collision height is readable.
    const fence = new THREE.Group();
    const along = size.x > size.z ? 'x' : 'z';
    const len = Math.max(size.x, size.z);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.1, 2.0), mats.fence);
    panel.position.y = 2.0;
    if (along === 'z') panel.rotation.y = Math.PI / 2;
    fence.add(panel);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? len : 0.08, 0.08, along === 'z' ? len : 0.08), mats.steel);
    rail.position.y = 3.0;
    fence.add(rail);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.12), mats.steel);
      post.position.set(along === 'x' ? (s * len) / 2 : 0, 2.0, along === 'z' ? (s * len) / 2 : 0);
      post.castShadow = true;
      fence.add(post);
    }
    this.fence = fence;
    this.group.add(fence);
  }

  damage(amount: number, fx: FX, dir?: THREE.Vector3): boolean {
    if (this.broken) return false;
    this.hp -= amount;
    const p = this.center.clone();
    p.y = 1.2;
    if (this.hp <= 0) {
      this.broken = true;
      this.fence.visible = false;
      this.base.scale.y = 0.22;
      this.base.position.y = 0.11;
      fx.burstDebris(p, 26, 0x8a8f98, 9, 0.35, dir ?? this.outward);
      fx.sparksAt(p.clone().setY(2.2), 16, 0xc0c8d8, 8);
      fx.shake = Math.max(fx.shake, 0.6);
      sfx.wallBreak();
      return true;
    }
    // Visible damage stage: fence leans outward and concrete darkens.
    const f = 1 - this.hp / 100;
    this.fence.rotation.set(this.outward.z * f * 0.35, 0, -this.outward.x * f * 0.35);
    fx.burstDebris(p, 6, 0x8a8f98, 4, 0.2, dir);
    sfx.crack();
    return false;
  }
}

export type PropKind = 'panel' | 'crate' | 'letter' | 'ac' | 'tank' | 'rubble';
export type PropState = 'rest' | 'held' | 'thrown' | 'falling' | 'gone';

export class Prop {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  spin = new THREE.Vector3();
  state: PropState = 'rest';
  holder: any = null;
  thrower: any = null;
  power = 1; // throw multiplier (super throw)
  life = 0;
  solid: Solid;
  hitIds = new Set<any>();
  constructor(public kind: PropKind, public cls: LiftClass, public mesh: THREE.Object3D, public half: THREE.Vector3, public explosive = false) {
    this.solid = { min: new THREE.Vector3(), max: new THREE.Vector3(), kind: 'prop', ref: this, clingable: cls >= 1 };
    mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.outline) { o.castShadow = true; o.receiveShadow = true; } });
  }
  get blocking() {
    return this.state === 'rest' && this.cls >= 1;
  }
  updateSolid() {
    this.solid.min.set(this.pos.x - this.half.x, this.pos.y, this.pos.z - this.half.z);
    this.solid.max.set(this.pos.x + this.half.x, this.pos.y + this.half.y * 2, this.pos.z + this.half.z);
  }
  get damage() {
    return [8, 14, 22][this.cls] * this.power;
  }
  get label() {
    return { panel: 'Sign panel', crate: 'Crate', letter: 'Sign letter', ac: 'A/C unit', tank: 'Fuel tank', rubble: 'Rubble' }[this.kind];
  }
}

interface ArenaMats {
  concrete: THREE.MeshStandardMaterial;
  fence: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  ac: THREE.MeshStandardMaterial;
  acDark: THREE.MeshStandardMaterial;
  tank: THREE.MeshStandardMaterial;
  stripe: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  hut: THREE.MeshStandardMaterial;
  rubble: THREE.MeshStandardMaterial;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

const LETTERS = 'CLARION';

export class Arena {
  name = 'Clarion Rooftop';
  static = new THREE.Group();
  dyn = new THREE.Group();
  walls: WallSeg[] = [];
  props: Prop[] = [];
  letters: { mesh: THREE.Mesh; hp: number; down: boolean; x: number; char: string }[] = [];
  anchors: THREE.Vector3[] = [];
  fixedSolids: Solid[] = [];
  mats: ArenaMats;
  letterTex: Map<string, THREE.Texture> = new Map();
  spawns: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(-6, 0, 2), new THREE.Vector3(6, 0, 2)];
  fadeables: THREE.Object3D[] = [];

  constructor(public scene: THREE.Scene, public fx: FX) {
    const fenceTex = canvasTex(64, 64, (g) => {
      g.clearRect(0, 0, 64, 64);
      g.strokeStyle = 'rgba(190,200,215,0.9)';
      g.lineWidth = 2;
      for (let i = -64; i < 128; i += 12) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
        g.beginPath(); g.moveTo(i + 64, 0); g.lineTo(i, 64); g.stroke();
      }
    }, [6, 3]);
    const roofTex = canvasTex(256, 256, (g) => {
      g.fillStyle = '#3a3640';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 3000; i++) {
        const v = 40 + Math.random() * 40;
        g.fillStyle = `rgb(${v},${v - 4},${v + 6})`;
        g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
      g.strokeStyle = 'rgba(20,18,24,0.8)';
      g.lineWidth = 3;
      for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    }, [9, 6.5]);
    this.mats = {
      concrete: new THREE.MeshStandardMaterial({ color: 0x8b8a90, roughness: 0.95 }),
      fence: new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5c6470, roughness: 0.45, metalness: 0.7 }),
      roof: new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.95 }),
      ac: new THREE.MeshStandardMaterial({ color: 0xa7adb5, roughness: 0.5, metalness: 0.5 }),
      acDark: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.4 }),
      tank: new THREE.MeshStandardMaterial({ color: 0xc8401c, roughness: 0.45, metalness: 0.4 }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xf0c020, roughness: 0.5, emissive: 0x302000 }),
      panel: new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.7 }),
      crate: new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 }),
      hut: new THREE.MeshStandardMaterial({ color: 0x77706e, roughness: 0.9 }),
      rubble: new THREE.MeshStandardMaterial({ color: 0x7d7f86, roughness: 0.95, flatShading: true }),
    };
    for (const ch of new Set(LETTERS)) {
      this.letterTex.set(ch, canvasTex(128, 128, (g) => {
        g.fillStyle = '#1b1015';
        g.fillRect(0, 0, 128, 128);
        g.strokeStyle = '#3a2a30';
        g.lineWidth = 6;
        g.strokeRect(3, 3, 122, 122);
        g.font = 'bold 104px Impact, "Arial Black", sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.shadowColor = '#ff3a3a';
        g.shadowBlur = 16;
        g.fillStyle = '#ffd7c8';
        g.fillText(ch, 64, 70);
      }));
    }
    this.buildStatic();
    scene.add(this.static, this.dyn);
    this.reset();
  }

  // ------------------------------------------------------------------ static scenery
  private buildStatic() {
    const s = this.static;
    // Roof deck and the building under it.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.6, HD * 2), this.mats.roof);
    deck.position.y = -0.3;
    deck.receiveShadow = true;
    s.add(deck);
    // Painted roof marking (original emblem: a split diamond).
    const mark = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 4), new THREE.MeshBasicMaterial({ color: 0xc9b98a, transparent: true, opacity: 0.35 }));
    mark.rotation.x = -Math.PI / 2;
    mark.position.y = 0.02;
    s.add(mark);
    const winTex = canvasTex(64, 128, (g) => {
      g.fillStyle = '#121019';
      g.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 128; y += 10) for (let x = 3; x < 64; x += 8) {
        const lit = Math.random() < 0.35;
        g.fillStyle = lit ? (Math.random() < 0.5 ? '#ffcf7a' : '#ffe9b8') : '#1d1b26';
        g.fillRect(x, y, 5, 6);
      }
    });
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8c8794, map: winTex, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.55, roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 - 0.2, 70, HD * 2 - 0.2), bodyMat);
    body.position.y = -35.6;
    s.add(body);
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 0.8, 0.5, HD * 2 + 0.8), this.mats.concrete);
    cornice.position.y = -0.9;
    s.add(cornice);

    // Skyline: instanced towers at varied heights and distances, tops near and below roof level so the drop reads.
    const n = 150;
    const towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x6f6a7a, map: winTex, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.6, roughness: 0.9 }), n);
    const o = new THREE.Object3D();
    let k = 0;
    for (let i = 0; i < n * 4 && k < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 34 + Math.random() * 110;
      const x = Math.cos(a) * d, z = Math.sin(a) * d * 0.9;
      if (Math.abs(x) < HW + 10 && Math.abs(z) < HD + 10) continue;
      const w = 6 + Math.random() * 12, dd = 6 + Math.random() * 12;
      const top = -30 + Math.random() * (d > 80 ? 70 : 38);
      const h = top + 90;
      o.position.set(x, top - h / 2, z);
      o.scale.set(w, h, dd);
      o.rotation.y = Math.random() < 0.2 ? Math.random() : 0;
      o.updateMatrix();
      towers.setMatrixAt(k++, o.matrix);
    }
    towers.count = k;
    s.add(towers);
    // Street grid far below, with light streaks.
    const streetTex = canvasTex(256, 256, (g) => {
      g.fillStyle = '#0c0b10';
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#2a2530';
      g.fillRect(0, 118, 256, 20);
      g.fillRect(118, 0, 20, 256);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = Math.random() < 0.5 ? '#ff5040' : '#fff0c0';
        g.fillRect(Math.random() * 256, 124 + Math.random() * 8, 6, 2);
        g.fillRect(124 + Math.random() * 8, Math.random() * 256, 2, 6);
      }
    }, [12, 12]);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ map: streetTex }));
    street.rotation.x = -Math.PI / 2;
    street.position.y = -70;
    s.add(street);

    // Rooftop access hut (permanent cover and a wall to cling to).
    const hut = new THREE.Group();
    const hb = new THREE.Mesh(new THREE.BoxGeometry(4, 3.6, 3.2), this.mats.hut);
    hb.position.y = 1.8;
    hb.castShadow = hb.receiveShadow = true;
    addOutline(hb, 1.02);
    hut.add(hb);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.06), this.mats.acDark);
    door.position.set(0, 1.1, 1.62);
    hut.add(door);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    lamp.position.set(0, 2.6, 1.7);
    hut.add(lamp);
    hut.position.set(11, 0, -5.5);
    s.add(hut);
    this.fadeables.push(hut);
    this.fixedSolids.push({ min: new THREE.Vector3(9, 0, -7.1), max: new THREE.Vector3(13, 3.6, -3.9), kind: 'hut', clingable: true });

    // Antenna masts at the corners: tall swing anchors.
    for (const [x, z] of [[-16.6, -11.6], [16.6, -11.6], [-16.6, 11.6], [16.6, 11.6]]) {
      const mast = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 13, 8), this.mats.steel);
      pole.position.y = 6.5;
      pole.castShadow = true;
      mast.add(pole);
      for (let i = 1; i < 5; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4 - i * 0.2, 0.06, 0.06), this.mats.steel);
        bar.position.y = 4 + i * 2;
        mast.add(bar);
      }
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
      beacon.position.y = 13.1;
      mast.add(beacon);
      mast.position.set(x, 0, z);
      s.add(mast);
      this.anchors.push(new THREE.Vector3(x, 12.8, z));
      this.fixedSolids.push({ min: new THREE.Vector3(x - 0.25, 0, z - 0.25), max: new THREE.Vector3(x + 0.25, 13, z + 0.25), kind: 'mast', clingable: false });
    }
    // Big sign scaffold above the north fence.
    const scaf = new THREE.Group();
    for (let x = -9; x <= 9; x += 3) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 7, 0.15), this.mats.steel);
      leg.position.set(x, 3.5, -13.7);
      leg.castShadow = true;
      scaf.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(19, 0.2, 0.2), this.mats.steel);
    beam.position.set(0, 6.9, -13.7);
    scaf.add(beam);
    const beam2 = beam.clone();
    beam2.position.y = 3.4;
    scaf.add(beam2);
    s.add(scaf);
    this.anchors.push(new THREE.Vector3(-5, 7.2, -13.7), new THREE.Vector3(5, 7.2, -13.7));
    // Mid-air swing points over the long sides (cables strung to neighbouring towers).
    for (const z of [-20, 20]) for (const x of [-10, 0, 10]) this.anchors.push(new THREE.Vector3(x, 14, z));
    for (const x of [-26, 26]) for (const z of [-6, 6]) this.anchors.push(new THREE.Vector3(x, 14, z));
    const cableMat = new THREE.LineBasicMaterial({ color: 0x20222a });
    const pts: THREE.Vector3[] = [];
    for (const a of this.anchors.slice(6)) { pts.push(a, a.clone().multiplyScalar(1.8).setY(-10)); }
    s.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
  }

  // ------------------------------------------------------------------ dynamic (reset on rematch)
  reset() {
    for (const c of [...this.dyn.children]) this.dyn.remove(c);
    this.walls = [];
    this.props = [];
    this.letters = [];
    const m = this.mats;
    // Fence: north/south edges in 4m segments, east/west in 5m segments.
    for (const zs of [-1, 1]) for (let i = 0; i < 9; i++) {
      const c = new THREE.Vector3(-HW + 2 + i * 4, 0, zs * (HD - WALL_T / 2));
      const w = new WallSeg(c, new THREE.Vector3(4, WALL_H, WALL_T), new THREE.Vector3(0, 0, zs), m);
      this.walls.push(w);
      this.dyn.add(w.group);
    }
    for (const xs of [-1, 1]) for (let i = 0; i < 5; i++) {
      const c = new THREE.Vector3(xs * (HW - WALL_T / 2), 0, -HD + WALL_T + 2.5 + i * 5);
      const w = new WallSeg(c, new THREE.Vector3(WALL_T, WALL_H, 5), new THREE.Vector3(xs, 0, 0), m);
      this.walls.push(w);
      this.dyn.add(w.group);
    }
    // Sign letters.
    LETTERS.split('').forEach((ch, i) => {
      const mat = new THREE.MeshStandardMaterial({ map: this.letterTex.get(ch)!, emissive: 0xffffff, emissiveMap: this.letterTex.get(ch)!, emissiveIntensity: 0.9, roughness: 0.6 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.4, 0.25), mat);
      const x = -7.8 + i * 2.6;
      mesh.position.set(x, 5.2, -13.55);
      mesh.castShadow = true;
      addOutline(mesh, 1.03);
      this.dyn.add(mesh);
      this.letters.push({ mesh, hp: 40, down: false, x, char: ch });
    });
    // Props.
    const add = (p: Prop, x: number, z: number) => {
      p.pos.set(x, 0, z);
      p.mesh.position.copy(p.pos);
      p.updateSolid();
      this.props.push(p);
      this.dyn.add(p.mesh);
    };
    add(this.makeAC(), -5.5, -8.2);
    add(this.makeAC(), 5.5, 8.3);
    add(this.makeAC(), -14.2, -1.5);
    add(this.makeTank(), -11, 8);
    add(this.makePanel(), 1.5, -4.5);
    add(this.makePanel(), -2.5, 5.2);
    add(this.makeCrate(), 13.5, 6.5);
    add(this.makeCrate(), -9, -4.5);
    add(this.makeCrate(), 3.5, 1.4);
  }

  makeAC() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 1.2), this.mats.ac);
    b.position.y = 0.6;
    addOutline(b, 1.03);
    g.add(b);
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 16), this.mats.acDark);
    fan.position.set(0, 1.22, 0);
    g.add(fan);
    const grill = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.04), this.mats.acDark);
    grill.position.set(0, 0.6, 0.61);
    g.add(grill);
    return new Prop('ac', 1, g, new THREE.Vector3(0.85, 0.6, 0.6));
  }
  makeTank() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.7, 16), this.mats.tank);
    b.position.y = 0.85;
    addOutline(b, 1.04);
    g.add(b);
    for (const y of [0.35, 1.35]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.16, 16), this.mats.stripe);
      s.position.y = y;
      g.add(s);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.2, 8), this.mats.steel);
    cap.position.y = 1.8;
    g.add(cap);
    return new Prop('tank', 2, g, new THREE.Vector3(0.7, 0.85, 0.7), true);
  }
  makePanel() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.85), this.mats.panel);
    b.position.y = 0.06;
    addOutline(b, 1.04);
    g.add(b);
    return new Prop('panel', 0, g, new THREE.Vector3(0.65, 0.06, 0.42));
  }
  makeCrate() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), this.mats.crate);
    b.position.y = 0.375;
    addOutline(b, 1.04);
    g.add(b);
    return new Prop('crate', 0, g, new THREE.Vector3(0.375, 0.375, 0.375));
  }
  makeRubble() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), this.mats.rubble);
    b.position.y = 0.4;
    addOutline(b, 1.05);
    g.add(b);
    return new Prop('rubble', 0, g, new THREE.Vector3(0.4, 0.4, 0.4));
  }

  /** Knock a sign letter loose: it drops onto the roof as a throwable light prop. */
  hitLetter(i: number, dmg: number) {
    const L = this.letters[i];
    if (!L || L.down) return;
    L.hp -= dmg;
    this.fx.sparksAt(L.mesh.position, 8, 0xff6040, 6);
    if (L.hp > 0) { L.mesh.rotation.z = (Math.random() - 0.5) * 0.25; sfx.crack(); return; }
    L.down = true;
    this.dyn.remove(L.mesh);
    const g = new THREE.Group();
    const lm = L.mesh.clone();
    lm.position.set(0, 1.2, 0);
    lm.rotation.set(0, 0, 0);
    g.add(lm);
    g.scale.setScalar(0.45);
    const p = new Prop('letter', 0, g, new THREE.Vector3(0.55, 0.55, 0.15));
    p.pos.copy(L.mesh.position).setY(4.5);
    p.pos.z = -12;
    p.vel.set((Math.random() - 0.5) * 2, 2, 5);
    p.spin.set(3, 0, 1);
    p.state = 'falling';
    this.props.push(p);
    this.dyn.add(g);
    this.fx.sparksAt(L.mesh.position, 20, 0xff4030, 9);
    sfx.wallBreak();
  }

  spawnRubble(at: THREE.Vector3) {
    const p = this.makeRubble();
    p.pos.copy(at);
    p.pos.y = Math.max(0.5, at.y);
    p.vel.set((Math.random() - 0.5) * 3, 3, (Math.random() - 0.5) * 3);
    p.state = 'falling';
    this.props.push(p);
    this.dyn.add(p.mesh);
  }

  // ------------------------------------------------------------------ queries
  inside(x: number, z: number) {
    return Math.abs(x) <= HW && Math.abs(z) <= HD;
  }

  solids(): Solid[] {
    const s: Solid[] = [...this.fixedSolids];
    for (const w of this.walls) if (!w.broken) s.push(w.solid);
    for (const p of this.props) if (p.blocking) s.push(p.solid);
    return s;
  }

  /** Highest supporting surface under (x,z) not more than `step` above y. */
  groundAt(x: number, z: number, y: number, step = 0.35): number {
    let g = this.inside(x, z) ? 0 : -Infinity;
    for (const s of this.solids()) {
      if (s.kind === 'mast') continue;
      if (x >= s.min.x && x <= s.max.x && z >= s.min.z && z <= s.max.z && s.max.y <= y + step && s.max.y > g) g = s.max.y;
    }
    return g;
  }

  /** Circle-vs-AABB push out. Returns contacts. */
  pushOut(pos: THREE.Vector3, r: number, h: number, ignore?: (s: Solid) => boolean) {
    const contacts: { s: Solid; n: THREE.Vector3 }[] = [];
    for (const s of this.solids()) {
      if (ignore && ignore(s)) continue;
      if (pos.y >= s.max.y - 0.05 || pos.y + h <= s.min.y) continue;
      const cx = THREE.MathUtils.clamp(pos.x, s.min.x, s.max.x);
      const cz = THREE.MathUtils.clamp(pos.z, s.min.z, s.max.z);
      let dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      let n: THREE.Vector3;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        n = new THREE.Vector3(dx / d, 0, dz / d);
        pos.x = cx + n.x * r;
        pos.z = cz + n.z * r;
      } else {
        const pen = [pos.x - s.min.x, s.max.x - pos.x, pos.z - s.min.z, s.max.z - pos.z];
        const i = pen.indexOf(Math.min(...pen));
        n = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)][i];
        if (i === 0) pos.x = s.min.x - r;
        if (i === 1) pos.x = s.max.x + r;
        if (i === 2) pos.z = s.min.z - r;
        if (i === 3) pos.z = s.max.z + r;
      }
      contacts.push({ s, n });
    }
    return contacts;
  }

  wallAt(p: THREE.Vector3, r: number): WallSeg | null {
    for (const w of this.walls) {
      if (w.broken) continue;
      const s = w.solid;
      if (p.y > s.max.y || p.y < -0.5) continue;
      if (p.x > s.min.x - r && p.x < s.max.x + r && p.z > s.min.z - r && p.z < s.max.z + r) return w;
    }
    return null;
  }

  nearestAnchor(from: THREE.Vector3, maxDist: number, preferToward?: THREE.Vector3): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const a of this.anchors) {
      const d = a.distanceTo(from);
      if (d > maxDist || a.y < from.y + 2) continue;
      let score = d;
      if (preferToward) score += a.clone().setY(0).distanceTo(preferToward.clone().setY(0)) * 0.6;
      if (score < bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  /** Anchor for a recovery line: the nearest mast, sign or intact fence post on the roof. */
  recoveryAnchor(from: THREE.Vector3, maxDist = 26): THREE.Vector3 | null {
    const cands: THREE.Vector3[] = this.anchors.filter((a) => this.inside(a.x, a.z));
    for (const w of this.walls) {
      if (w.broken) continue;
      const along = w.size.x > w.size.z;
      const half = (along ? w.size.x : w.size.z) / 2;
      for (const s of [-1, 1]) cands.push(new THREE.Vector3(w.center.x + (along ? s * half : 0), WALL_H, w.center.z + (along ? 0 : s * half)));
    }
    let best: THREE.Vector3 | null = null;
    let bd = maxDist;
    for (const c of cands) {
      const d = c.distanceTo(from);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  openEdgeNear(p: THREE.Vector3, dist: number): WallSeg | null {
    for (const w of this.walls) {
      if (!w.broken) continue;
      if (w.center.distanceTo(new THREE.Vector3(p.x, 0, p.z)) < dist) return w;
    }
    return null;
  }

  // ------------------------------------------------------------------ prop simulation (non-combat parts)
  update(dt: number, onLand: (p: Prop, speed: number) => void) {
    for (const p of this.props) {
      if (p.state === 'gone' || p.state === 'held') continue;
      if (p.state === 'rest') {
        // Rest on whatever supports it; if support vanished, fall.
        const g = this.groundAtForProp(p);
        if (g < p.pos.y - 0.05) p.state = 'falling';
        continue;
      }
      p.life += dt;
      p.vel.y -= 26 * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      const g = this.groundAtForProp(p);
      if (p.pos.y <= g) {
        const speed = p.vel.length();
        p.pos.y = g;
        if (p.state === 'thrown') {
          onLand(p, speed);
        } else {
          p.vel.set(0, 0, 0);
          p.state = 'rest';
          p.mesh.rotation.set(0, p.mesh.rotation.y, 0);
          p.thrower = null;
          sfx.land();
        }
      }
      if (p.pos.y < KILL_Y * 3) this.removeProp(p);
      p.mesh.position.copy(p.pos);
      p.updateSolid();
    }
  }

  private groundAtForProp(p: Prop) {
    let g = this.inside(p.pos.x, p.pos.z) ? 0 : -Infinity;
    for (const s of this.solids()) {
      if (s.ref === p || s.kind === 'mast') continue;
      if (p.pos.x >= s.min.x && p.pos.x <= s.max.x && p.pos.z >= s.min.z && p.pos.z <= s.max.z && s.max.y <= p.pos.y + 0.3 && s.max.y > g) g = s.max.y;
    }
    return g;
  }

  removeProp(p: Prop) {
    p.state = 'gone';
    p.mesh.visible = false;
    if (p.holder) p.holder = null;
  }

  setFade(camPos: THREE.Vector3, targets: THREE.Vector3[]) {
    // Foreground fading: any blocking prop or the hut between the camera and a fighter goes translucent.
    const ray = new THREE.Ray();
    const box = new THREE.Box3();
    const check = (obj: THREE.Object3D, min: THREE.Vector3, max: THREE.Vector3) => {
      box.set(min, max);
      let hide = false;
      for (const t of targets) {
        ray.origin.copy(camPos);
        ray.direction.copy(t).sub(camPos);
        const len = ray.direction.length();
        ray.direction.normalize();
        const hit = ray.intersectBox(box, new THREE.Vector3());
        if (hit && hit.distanceTo(camPos) < len - 1) hide = true;
      }
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || o.userData.outline) { if (o.userData.outline) o.visible = !hide; return; }
        if (!o.userData.fadeMat) { o.userData.fadeMat = m.clone(); o.userData.baseMat = m; o.userData.fadeMat.transparent = true; o.userData.fadeMat.opacity = 0.28; o.userData.fadeMat.depthWrite = false; }
        (o as THREE.Mesh).material = hide ? o.userData.fadeMat : o.userData.baseMat;
      });
    };
    check(this.fadeables[0], new THREE.Vector3(9, 0, -7.1), new THREE.Vector3(13, 3.6, -3.9));
    for (const p of this.props) if (p.state === 'rest' && p.cls >= 1) check(p.mesh, p.solid.min, p.solid.max);
  }
}
