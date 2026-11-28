import * as THREE from 'three';
import { srand } from './rng';
import type { LiftClass } from './characters';
import { addOutline } from './rig';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CityBuilder, farPanorama, lightShafts, facadeMaterial } from './city';
import { hasCityKit, placeKit, kitAt, KIT_SIZE, KitBuilding, KitPlacement } from './citykit';
import { buildCar, buildCrate, buildAC, buildBarrel, buildTank, buildBarrier } from './props';
import { propModel } from './skinned';

/** City Props 1 (CC0, Coding Creature) models the arenas use; loaded at startup. */
export const PROP_MODELS = [
  'barrel_02_big_blue', 'barrel_02_medium_green', 'concrete_jersey_barrier_01_medium', 'garbage_collector_green_large', 'garbage_collector_red_large',
  'metal_garbage_can_01_medium', 'trash_bin_c_green', 'cone_ii_medium', 'mailbox_01_green', 'pallet_medium_01', 'traffic_bollard_02_yellow_large', 'type_ii_barricade_01_medium',
];
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { FX } from './fx';
import { buildConstruction, resetExtra } from './arenas2';
import { buildMarket, buildArchive, buildFoundry, buildLab, resetEnclosed } from './arenas3';
import { sfx } from './audio';

// The Clarion Building rooftop: an enclosed roof that becomes a ring-out arena as its fence breaks.

/** Playable deck half-extents for the current layout (x = width, z = depth). */
export const BOUNDS = { hw: 18, hd: 13 };
export type LayoutId = 'rooftop' | 'overpass' | 'construction' | 'market' | 'archive' | 'foundry' | 'lab';
export const LAYOUTS: { id: LayoutId; name: string; short: string; blurb: string; enclosed?: boolean }[] = [
  { id: 'rooftop', name: 'Clarion Rooftop', short: 'Rooftop', blurb: 'Enclosed roof that becomes a ring-out arena as its fence breaks.' },
  { id: 'overpass', name: 'Route 9 Overpass', short: 'Overpass', blurb: 'Narrow elevated roadway: stalled cars to throw, exposed sides, barriers that give way.' },
  { id: 'construction', name: 'Skyline Site', short: 'Site', blurb: 'Unfinished tower floor: steel beams to throw, a crane to swing from, only safety mesh at the edges.' },
  { id: 'market', name: 'Market Square', short: 'Market', blurb: 'A night plaza boxed in by shop fronts: taxis and a van to throw, steam rising from the grates. No way out.', enclosed: true },
  { id: 'archive', name: 'The Archive', short: 'Archive', blurb: 'A gothic reading hall: towering bookcases, chandeliers to swing from, armour and armchairs to hurl.', enclosed: true },
  { id: 'foundry', name: 'Foundry Roof', short: 'Foundry', blurb: 'A walled factory roof in the smog: tanks for cover, truss towers, gas canisters that go up.', enclosed: true },
  { id: 'lab', name: 'Core Lab', short: 'Lab', blurb: 'A sealed reactor chamber: humming core, tesla coil, consoles and volatile canisters.', enclosed: true },
];
/** A known arena id, or the rooftop (for old saved settings / messages naming removed arenas). */
export function layoutOr(id: unknown): LayoutId {
  return LAYOUTS.some((l) => l.id === id) ? (id as LayoutId) : 'rooftop';
}
/** Circular decks: `inside()` uses this radius instead of the rectangle (no current arena is circular; the camera collider reads it). */
export const SHAPE = { circle: 0 };
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

export type WallStyle = 'fence' | 'noise' | 'safety';
export class WallSeg {
  hp = 100;
  broken = false;
  solid: Solid;
  group = new THREE.Group();
  base: THREE.Mesh;
  fence: THREE.Object3D;
  constructor(public center: THREE.Vector3, public size: THREE.Vector3, public outward: THREE.Vector3, mats: ArenaMats, style: WallStyle = 'fence', public height = WALL_H) {
    this.solid = {
      min: new THREE.Vector3(center.x - size.x / 2, 0, center.z - size.z / 2),
      max: new THREE.Vector3(center.x + size.x / 2, height, center.z + size.z / 2),
      kind: 'wall', ref: this, clingable: true,
    };
    this.group.position.copy(center);
    const along = size.x > size.z ? 'x' : 'z';
    const len = Math.max(size.x, size.z);
    const bx = (l: number, h: number, t: number, m: THREE.Material, y: number, off = 0) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? l : t, h, along === 'z' ? l : t), m);
      b.position.set(along === 'x' ? off : 0, y, along === 'z' ? off : 0);
      b.castShadow = true;
      return b;
    };
    const fence = new THREE.Group();
    if (style === 'fence' || style === 'noise') {
      this.base = new THREE.Mesh(new THREE.BoxGeometry(size.x, 1.0, size.z), mats.concrete);
      this.base.position.y = 0.5;
      // Chain-link fence panel with posts: visibly tall, so the collision height is readable.
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.1, 2.0), style === 'noise' ? mats.noise : mats.fence);
      panel.position.y = 2.0;
      if (along === 'z') panel.rotation.y = Math.PI / 2;
      fence.add(panel);
      fence.add(bx(len, 0.08, 0.08, mats.steel, 3.0));
      for (const sgn of [-1, 1]) fence.add(bx(0.12, 2.1, 0.12, mats.steel, 2.0, (sgn * len) / 2));
    } else {
      // Construction-site edge (safety): steel kerb, orange safety mesh and a striped hand rail.
      this.base = new THREE.Mesh(new THREE.BoxGeometry(size.x, 0.25, size.z), mats.steel);
      this.base.position.y = 0.125;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.1, 1.15), mats.safety);
      panel.position.y = 0.85;
      if (along === 'z') panel.rotation.y = Math.PI / 2;
      fence.add(panel);
      fence.add(bx(len, 0.1, 0.1, mats.stripe, height - 0.05));
      fence.add(bx(len, 0.06, 0.06, mats.stripe, 1.45));
      for (const sgn of [-1, 0, 1]) fence.add(bx(0.09, height, 0.09, mats.steel, height / 2, (sgn * len) / 2.05));
    }
    this.base.castShadow = this.base.receiveShadow = true;
    addOutline(this.base, 1.02);
    this.group.add(this.base);
    this.fence = fence;
    this.group.add(fence);
    this.baseH = this.base.position.y * 2;
  }
  private baseH = 1;

  damage(amount: number, fx: FX, dir?: THREE.Vector3): boolean {
    if (this.broken) return false;
    this.hp -= amount;
    const p = this.center.clone();
    p.y = Math.min(1.2, this.height * 0.6);
    if (this.hp <= 0) {
      this.broken = true;
      this.fence.visible = false;
      this.base.scale.y = 0.22;
      this.base.position.y = this.baseH * 0.11;
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

export type PropKind = 'panel' | 'crate' | 'letter' | 'ac' | 'tank' | 'rubble' | 'car' | 'barrel' | 'barrier' | 'wreck' | 'cone' | 'bin' | 'pallet' | 'wheelie' | 'barricade' | 'mailbox' | 'beams' | 'lumber' | 'cement' | 'van' | 'bench' | 'hydrant' | 'armchair' | 'armour' | 'cabinet' | 'table' | 'console' | 'canister';
export type PropState = 'rest' | 'held' | 'thrown' | 'falling' | 'gone';

export class Prop {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  spin = new THREE.Vector3();
  state: PropState = 'rest';
  holder: any = null;
  thrower: any = null;
  power = 1; // throw multiplier (super throw)
  uses = 0; // melee swings taken with it
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
    return { panel: 'Sign panel', crate: 'Crate', letter: 'Sign letter', ac: 'A/C unit', tank: 'Fuel tank', rubble: 'Rubble', car: 'Car', barrel: 'Barrel', barrier: 'Barrier block', wreck: 'Burnt wreck', cone: 'Traffic cone', bin: 'Trash can', pallet: 'Pallet', wheelie: 'Wheelie bin', barricade: 'Road barricade', mailbox: 'Mailbox', beams: 'Steel beams', lumber: 'Lumber', cement: 'Cement bags', van: 'Van', bench: 'Bench', hydrant: 'Hydrant', armchair: 'Armchair', armour: 'Suit of armour', cabinet: 'Display cabinet', table: 'Side table', console: 'Console', canister: 'Gas canister' }[this.kind];
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
  noise: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  barrel: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  tire: THREE.MeshStandardMaterial;
  safety: THREE.MeshStandardMaterial;
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
      noise: new THREE.MeshStandardMaterial({ color: 0x7fd8d0, transparent: true, opacity: 0.38, side: THREE.DoubleSide, roughness: 0.15, metalness: 0.1, depthWrite: false }),
      asphalt: new THREE.MeshStandardMaterial({ map: canvasTex(256, 256, (g) => {
        g.fillStyle = '#26282c'; g.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 4000; i++) { const v = 30 + Math.random() * 30; g.fillStyle = `rgb(${v},${v},${v + 4})`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
      }, [12, 4]), roughness: 0.92 }),
      barrel: new THREE.MeshStandardMaterial({ color: 0x2f6a9a, roughness: 0.5, metalness: 0.5 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x14202a, roughness: 0.1, metalness: 0.6 }),
      tire: new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.9 }),
      safety: new THREE.MeshStandardMaterial({ map: canvasTex(64, 64, (g) => {
        g.clearRect(0, 0, 64, 64);
        g.strokeStyle = 'rgba(255,120,30,0.95)'; g.lineWidth = 3;
        for (let i = 0; i <= 64; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); }
      }, [6, 1.5]), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.7, emissive: 0x401400, emissiveIntensity: 0.5 }),
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
    scene.add(this.static, this.dyn);
    this.setLayout('rooftop');
  }

  layout: LayoutId = 'rooftop';
  /** Walled arena: no ring-outs (bodies are clamped inside BOUNDS; the AI and UI know). */
  enclosed = false;
  /** Per-layout ambient effects (steam, fire, arcs), called from update(); visual only. */
  ambient: ((dt: number) => void) | null = null;
  /** Height limit for fliers (below overhead structure). */
  ceiling = 14;
  /** Swap venues: rebuild static scenery, solids and anchors, then reset dynamic pieces. */
  setLayout(id: LayoutId) {
    id = layoutOr(id);
    this.layout = id;
    this.enclosed = !!LAYOUTS.find((l) => l.id === id)!.enclosed;
    this.ambient = null;
    this.name = LAYOUTS.find((l) => l.id === id)!.name;
    for (const c of [...this.static.children]) this.static.remove(c);
    this.fixedSolids = [];
    this.anchors = [];
    this.fadeables = [];
    this.ceiling = 14;
    SHAPE.circle = 0;
    if (id === 'rooftop') {
      BOUNDS.hw = 18; BOUNDS.hd = 13;
      this.buildStatic();
    } else if (id === 'overpass') {
      BOUNDS.hw = 26; BOUNDS.hd = 7;
      this.buildOverpass();
    } else if (id === 'construction') {
      BOUNDS.hw = 17; BOUNDS.hd = 11;
      buildConstruction(this);
    } else if (id === 'market') {
      BOUNDS.hw = 17; BOUNDS.hd = 12;
      buildMarket(this);
    } else if (id === 'archive') {
      BOUNDS.hw = 16; BOUNDS.hd = 11;
      buildArchive(this);
    } else if (id === 'foundry') {
      BOUNDS.hw = 17; BOUNDS.hd = 12;
      buildFoundry(this);
    } else {
      BOUNDS.hw = 15; BOUNDS.hd = 11;
      buildLab(this);
    }
    this.reset();
  }

  private city: CityBuilder | null = null;
  get cityB() {
    if (!this.city) this.city = new CityBuilder(this.mats.concrete, this.mats.steel, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.9 }));
    return this.city;
  }

  /** Mid-distance varied towers (merged) plus a painted far panorama. */
  buildCity(minR: number, yBase = -30, tint?: number) {
    this.cityB.skyline(BOUNDS.hw + 8, BOUNDS.hd + 8, minR, minR + 95, 46, yBase);
    // Far panorama tinted toward each venue's haze.
    this.static.add(farPanorama(260, yBase - 20, 150, tint ?? (this.layout === 'overpass' ? 0xe4eef0 : 0xa49ab8)));
  }

  get winTex() {
    if (!this._winTex) this._winTex = canvasTex(64, 128, (g) => {
      g.fillStyle = '#121019';
      g.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 128; y += 10) for (let x = 3; x < 64; x += 8) {
        const lit = Math.random() < 0.35;
        g.fillStyle = lit ? (Math.random() < 0.5 ? '#ffcf7a' : '#ffe9b8') : '#1d1b26';
        g.fillRect(x, y, 5, 6);
      }
    });
    return this._winTex;
  }
  private _winTex: THREE.Texture | null = null;

  /** Merge many boxes into one mesh (one draw call) — used for trusses, pipes and clutter. */
  boxes(list: [number, number, number, number, number, number, number?][], mat: THREE.Material, shadow = true) {
    const geos = list.map(([w, h, d, x, y, z, ry]) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (ry) g.rotateY(ry);
      g.translate(x, y, z);
      return g;
    });
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    this.static.add(m);
    return m;
  }

  /** A flat decal on the deck: cracks, skid marks, stains, puddles. */
  decal(kind: 'crack' | 'skid' | 'stain' | 'puddle', x: number, z: number, size: number, rot = 0) {
    const key = `decal_${kind}`;
    let mat = this.decalMats.get(key);
    if (!mat) {
      if (kind === 'puddle') {
        // Irregular round puddle: soft-edged alpha so it never reads as a square.
        const alpha = canvasTex(128, 128, (g) => {
          g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128);
          for (let k = 0; k < 5; k++) {
            const x = 40 + Math.random() * 48, y = 40 + Math.random() * 48, r = 22 + Math.random() * 20;
            const gr = g.createRadialGradient(x, y, r * 0.3, x, y, r);
            gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
          }
        });
        alpha.colorSpace = THREE.NoColorSpace;
        mat = new THREE.MeshStandardMaterial({ color: 0x4a5a60, roughness: 0.03, metalness: 0.85, transparent: true, alphaMap: alpha, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      }
      else {
        const tex = canvasTex(128, 128, (g) => {
          g.clearRect(0, 0, 128, 128);
          if (kind === 'crack') {
            g.strokeStyle = 'rgba(10,10,12,0.85)';
            for (let k = 0; k < 4; k++) {
              g.lineWidth = 2.5 - k * 0.5;
              g.beginPath(); let px = 64, py = 64; g.moveTo(px, py);
              for (let i = 0; i < 9; i++) { px += (Math.random() - 0.5) * 30; py += (Math.random() - 0.5) * 30; g.lineTo(px, py); }
              g.stroke();
            }
          } else if (kind === 'skid') {
            for (const y of [44, 84]) { const gr = g.createLinearGradient(0, 0, 128, 0); gr.addColorStop(0, 'rgba(8,8,8,0)'); gr.addColorStop(0.3, 'rgba(8,8,8,0.7)'); gr.addColorStop(1, 'rgba(8,8,8,0.15)'); g.fillStyle = gr; g.fillRect(0, y, 128, 10); }
          } else {
            const gr = g.createRadialGradient(64, 64, 4, 64, 64, 60); gr.addColorStop(0, 'rgba(20,16,12,0.6)'); gr.addColorStop(1, 'rgba(20,16,12,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
          }
        });
        mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 });
      }
      this.decalMats.set(key, mat);
    }
    const geo = kind === 'puddle' ? new THREE.CircleGeometry(size / 2, 28).scale(1, 0.6, 1) : new THREE.PlaneGeometry(size, kind === 'skid' ? size * 0.4 : size);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, rot);
    m.position.set(x, 0.015 + Math.random() * 0.005, z);
    m.receiveShadow = true;
    this.static.add(m);
  }
  private decalMats = new Map<string, THREE.Material>();

  /** Painted or lit storefront sign texture with a generic word. */
  signTex(word: string, bg: string, fg: string) {
    return canvasTex(256, 64, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, 256, 64);
      g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(6, 6, 244, 52);
      g.fillStyle = fg; g.font = 'bold 40px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(word, 128, 35);
    });
  }

  /** A close city block face: tall, windowed, with a storefront sign at the given height. */
  /** A close city block: a detailed building with a storefront sign and awning facing the action. */
  private block(x: number, z: number, w: number, d: number, bottom: number, top: number, face: 1 | -1, sign?: [string, string, string], signY?: number) {
    this.cityB.building({ x, z, w, d, bottom, top, detail: 2, front: new THREE.Vector3(0, 0, face) });
    if (sign) {
      const tex = this.signTex(...sign);
      const sm = new THREE.Mesh(new RoundedBoxGeometry(Math.min(w * 0.8, 9), 2, 0.3, 2, 0.06), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5 }));
      sm.position.set(x, signY ?? bottom + 4, z + face * (d / 2 + 0.4));
      this.static.add(sm);
      const aw = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w * 0.8, 9), 0.12, 1.6), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.45, 0.35), roughness: 0.8 }));
      aw.position.set(x, (signY ?? bottom + 4) - 1.4, z + face * (d / 2 + 0.9));
      aw.rotation.x = face * 0.25;
      aw.castShadow = true;
      this.static.add(aw);
    }
  }

  /**
   * A kit building (Downtown City MegaKit) whose footprint centre is (x, z), front facing `ry`
   * (0 = +Z), standing on a procedural podium from `podiumBottom` up to `base`. Pieces are queued in
   * `this.kitQueue` and merged per material by flushKit().
   */
  kitBlock(name: KitBuilding, x: number, z: number, ry: number, base: number, podiumBottom: number, sign?: [string, string, string], signY?: number, roofAC = 0) {
    const k = KIT_SIZE[name];
    const quarter = Math.abs(Math.round(ry / (Math.PI / 2))) % 2 === 1;
    const w = quarter ? k.d : k.w, d = quarter ? k.w : k.d;
    if (base > podiumBottom + 0.5) this.cityB.podium(x, z, w - 0.3, d - 0.3, podiumBottom, base + 0.02, Math.random() < 0.5 ? 'concrete' : 'darkbrick');
    this.kitQueue.push(kitAt(name, x, base, z, ry));
    const front = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
    // Rooftop AC units and vents on the kit roof.
    for (let i = 0; i < roofAC; i++) {
      const ax = x + (Math.random() - 0.5) * (w - 4), az = z + (Math.random() - 0.5) * (d - 4);
      this.kitQueue.push({ name: 'Prop_ACUnit', x: ax, y: base + k.h + 0.05, z: az, ry: Math.floor(Math.random() * 4) * Math.PI / 2, scale: 2.4 });
    }
    if (sign) {
      const depth = k.d;
      const tex = this.signTex(...sign);
      const sw = Math.min((quarter ? k.d : k.w) * 0.55, 8);
      const sm = new THREE.Mesh(new RoundedBoxGeometry(sw, 1.8, 0.3, 2, 0.06), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5 }));
      const at = new THREE.Vector3(x, signY ?? base + 4.6, z).addScaledVector(front, depth / 2 + 0.35);
      sm.position.copy(at);
      sm.rotation.y = ry;
      this.static.add(sm);
    }
  }
  kitQueue: KitPlacement[] = [];
  flushKit(castShadow = false) {
    placeKit(this.static, this.kitQueue, { castShadow });
    this.kitQueue = [];
  }

  /** A prop from the City Props pack, sized from its real bounds; falls back if the model is missing. */
  modelProp(file: string, kind: PropKind, cls: 0 | 1 | 2, fallback: () => Prop, explosive = false, scale = 1) {
    const base = propModel(file);
    if (!base) return fallback();
    const obj = base.clone(true);
    obj.scale.setScalar(scale);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    obj.position.set(-c.x, -box.min.y, -c.z);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.outline) addOutline(m, 1.04);
    });
    const g = new THREE.Group();
    g.add(obj);
    return new Prop(kind, cls, g, new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2), explosive);
  }

  makeWreck() {
    return new Prop('wreck', 2, buildCar(0, true), new THREE.Vector3(0.95, 0.6, 2.05), false);
  }

  // ------------------------------------------------------------------ overpass
  private buildOverpass() {
    const s = this.static;
    const hw = BOUNDS.hw, hd = BOUNDS.hd;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 30, 1.2, hd * 2), this.mats.asphalt);
    deck.position.y = -0.6;
    deck.receiveShadow = true;
    s.add(deck);
    // Lane markings.
    const dash = new THREE.MeshBasicMaterial({ color: 0xd8d2a0 });
    for (let x = -hw - 14; x < hw + 14; x += 4) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.15), dash);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, 0);
      s.add(m);
    }
    for (const z of [-hd + 0.9, hd - 0.9]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 28, 0.12), new THREE.MeshBasicMaterial({ color: 0xe0b030 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0.01, z);
      s.add(m);
    }
    // Massive support piers down to the street below.
    this.boxes([-24, -8, 8, 24].flatMap((x) => [[3.2, 22, 7, x, -11.2, 0], [5, 1.2, hd * 2 + 2, x, -1.6, 0]] as [number, number, number, number, number, number][]), this.mats.concrete);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.mats.asphalt.clone());
    (street.material as THREE.MeshStandardMaterial).color.setHex(0x9a9a9a);
    street.rotation.x = -Math.PI / 2;
    street.position.y = -22;
    street.receiveShadow = true;
    s.add(street);
    // Through-truss: side trusses and overhead cross beams. Their shadows stripe the deck.
    const tz = hd + 0.7, top = 8.2;
    const truss: [number, number, number, number, number, number, number?][] = [];
    for (const z of [-tz, tz]) {
      truss.push([hw * 2 + 24, 0.45, 0.45, 0, top, z]);
      truss.push([hw * 2 + 24, 0.35, 0.35, 0, 3.3, z]);
      for (let x = -hw - 12; x <= hw + 12; x += 4) {
        truss.push([0.4, top - 3.3, 0.4, x, (top + 3.3) / 2, z]);
        const len = Math.hypot(4, top - 3.3);
        void len;
      }
    }
    for (let x = -hw - 12; x <= hw + 12; x += 4) truss.push([0.35, 0.5, tz * 2, x, top + 0.1, 0]);
    for (let x = -hw - 10; x <= hw + 12; x += 8) truss.push([0.18, 0.18, Math.hypot(tz * 2, 4), x - 2, top + 0.1, 0, Math.atan2(4, tz * 2)]);
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x5f7a7e, roughness: 0.55, metalness: 0.6 });
    const tm = this.boxes(truss, trussMat);
    // Tilt the diagonals: rebuild them with rotation in their own geometry pass.
    void tm;
    const diag: THREE.BufferGeometry[] = [];
    for (const z of [-tz, tz]) for (let x = -hw - 12; x <= hw + 12; x += 4) {
      const len = Math.hypot(4, top - 3.3);
      const g = new THREE.BoxGeometry(0.22, len, 0.22);
      g.rotateZ(Math.atan2(4, top - 3.3) * ((x / 4) % 2 === 0 ? 1 : -1));
      g.translate(x + 2, (top + 3.3) / 2, z);
      diag.push(g);
    }
    const dm = new THREE.Mesh(mergeGeometries(diag), trussMat);
    dm.castShadow = true;
    s.add(dm);
    for (const z of [-tz, tz]) for (let x = -24; x <= 24; x += 8) this.anchors.push(new THREE.Vector3(x, top, z));
    for (let x = -20; x <= 20; x += 8) this.anchors.push(new THREE.Vector3(x, top, 0));
    this.ceiling = top - 0.8;
    // Close city blocks on both sides, with storefronts at deck level.
    const signs: [string, string, string][] = [['DELI', '#f0e6c8', '#a02018'], ['HOTEL', '#1a2a3a', '#ffd070'], ['PAWN', '#f2c230', '#1a1a1a'], ['PARKING', '#1a4a8a', '#ffffff'], ['24 HR', '#202020', '#ff4040'], ['LAUNDRY', '#e8f0f0', '#206080'], ['DINER', '#c02a20', '#fff0d0'], ['SURPLUS', '#2a3a20', '#e8e0b0']];
    let si = 0;
    if (hasCityKit()) {
      // Real modular buildings (Downtown City MegaKit) lining both sides, storefronts at deck level.
      const kinds: KitBuilding[] = ['Building_Medium_2_001', 'Building_Small_1', 'Building_Large_2', 'Building_Small_1', 'Building_Medium_2_001'];
      let ki = Math.floor(Math.random() * kinds.length);
      for (const face of [1, -1] as const) {
        for (let x = -hw - 22; x < hw + 22; ) {
          const kind = kinds[ki++ % kinds.length];
          const k = KIT_SIZE[kind];
          const z = -face * (hd + 9 + k.d / 2 + Math.random() * 2);
          // Some buildings sit on a taller podium so the street wall steps up and down.
          const base = Math.random() < 0.3 ? 3.4 : 0;
          this.kitBlock(kind, x + k.w / 2, z, face > 0 ? 0 : Math.PI, base, -22, signs[si++ % signs.length], base + 2.6 + Math.random() * 1.6, 2);
          x += k.w + 0.6 + Math.random() * 1.5;
        }
      }
      // The street under the overpass: real road tiles with markings, sidewalks and manholes.
      for (let x = -66; x <= 66; x += 6) this.kitQueue.push({ name: 'Street_4Lane', x, y: -22 + 0.02, z: 0, ry: 0 });
      for (let i = 0; i < 6; i++) this.kitQueue.push({ name: 'Prop_ManholeCover', x: -40 + i * 16 + Math.random() * 4, y: -21.97, z: (Math.random() - 0.5) * 8 });
      // Drains and manhole covers on the deck itself (flat dressing, no collision).
      for (let i = 0; i < 5; i++) this.kitQueue.push({ name: 'Prop_Drain', x: -hw + 4 + i * (hw * 2 - 8) / 4, y: 0.02, z: (i % 2 ? 1 : -1) * (hd - 0.5) });
      for (const x of [-12, 10]) this.kitQueue.push({ name: 'Prop_ManholeCover', x, y: 0.02, z: (Math.random() - 0.5) * 4 });
      this.flushKit(false);
    } else {
      for (const face of [1, -1] as const) {
        for (let x = -hw - 20; x < hw + 20; ) {
          const w = 8 + Math.random() * 8;
          const d = 10 + Math.random() * 6;
          const z = -face * (hd + 9 + d / 2 + Math.random() * 4);
          this.block(x + w / 2, z, w, d, -22, 6 + Math.random() * 26, face, signs[si++ % signs.length], 2.5 + Math.random() * 2);
          x += w + 1 + Math.random() * 2;
        }
      }
    }
    // Road decals, puddles and clutter.
    for (let i = 0; i < 16; i++) this.decal('crack', (Math.random() - 0.5) * hw * 1.8, (Math.random() - 0.5) * hd * 1.6, 2 + Math.random() * 3, Math.random() * 6);
    for (let i = 0; i < 6; i++) this.decal('skid', (Math.random() - 0.5) * hw * 1.6, (Math.random() - 0.5) * hd, 5 + Math.random() * 4, (Math.random() - 0.5) * 0.4);
    for (let i = 0; i < 7; i++) this.decal('puddle', (Math.random() - 0.5) * hw * 1.7, (Math.random() - 0.5) * hd * 1.5, 1.5 + Math.random() * 2.5, Math.random() * 3);
    for (let i = 0; i < 8; i++) this.decal('stain', (Math.random() - 0.5) * hw * 1.8, (Math.random() - 0.5) * hd * 1.6, 2 + Math.random() * 2);
    const junk: [number, number, number, number, number, number, number?][] = [];
    for (let i = 0; i < 40; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const sz = 0.12 + Math.random() * 0.35;
      junk.push([sz, sz * 0.7, sz * 1.2, (Math.random() - 0.5) * hw * 1.9, sz * 0.35, side * (hd - 0.7 - Math.random() * 0.8), Math.random() * 3]);
    }
    this.boxes(junk, this.mats.rubble);
    // Wreck pile-ups close both ends of the fighting stretch (permanent cover):
    // a jack-knifed box truck, burnt cars and a row of jersey barriers.
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      const truck = new THREE.Group();
      const box = new THREE.Mesh(new RoundedBoxGeometry(2.5, 3.0, 6.2, 2, 0.1), new THREE.MeshStandardMaterial({ color: 0x8a3020, roughness: 0.55, metalness: 0.2 }));
      box.position.set(0, 1.95, -0.6); box.castShadow = true; addOutline(box, 1.02); truck.add(box);
      const cab = new THREE.Mesh(new RoundedBoxGeometry(2.4, 2.2, 1.9, 3, 0.25), new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.4, metalness: 0.3 }));
      cab.position.set(0, 1.55, 3.6); cab.castShadow = true; addOutline(cab, 1.02); truck.add(cab);
      const ws = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.9), new THREE.MeshPhysicalMaterial({ color: 0x18242c, roughness: 0.05, metalness: 0.3, clearcoat: 1 }));
      ws.position.set(0, 2.05, 4.56); truck.add(ws);
      for (const [wx, wz] of [[-1.15, 3.5], [1.15, 3.5], [-1.15, -2.2], [1.15, -2.2], [-1.15, -3.2], [1.15, -3.2]]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 18), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 }));
        w.rotation.z = Math.PI / 2; w.position.set(wx, 0.5, wz); w.castShadow = true; truck.add(w);
      }
      truck.position.set(sx * 0.4, 0, -1.2);
      truck.rotation.y = 0.18 * sx;
      g.add(truck);
      for (const [cz, ry] of [[3.6, 0.5], [-5.2, -0.4]]) {
        const car = buildCar(0, true);
        car.position.set(-sx * 0.6, 0, cz);
        car.rotation.y = ry * 0.4;
        g.add(car);
      }
      for (const bz of [-1.2, 1.2]) {
        const bar = buildBarrier(this.mats.concrete);
        bar.position.set(-sx * 1.4, 0, bz + 4.8 * Math.sign(bz));
        bar.rotation.y = Math.PI / 2 + (Math.random() - 0.5) * 0.3;
        g.add(bar);
      }
      g.position.set(sx * (hw - 0.8), 0, 0);
      s.add(g);
      this.fixedSolids.push({ min: new THREE.Vector3(sx > 0 ? hw - 2.6 : -hw, 0, -hd), max: new THREE.Vector3(sx > 0 ? hw : -hw + 2.6, 3.4, hd), kind: 'hut', clingable: true });
    }
    // Light poles along both rails: swing anchors and the arena's warm sodium glow.
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffc070 });
    for (const z of [-hd - 0.3, hd + 0.3]) for (let x = -20; x <= 20; x += 10) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 9, 8), this.mats.steel);
      pole.position.set(x, 4.5, z);
      s.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.6), this.mats.steel);
      arm.position.set(x, 9, z - Math.sign(z) * 0.8);
      s.add(arm);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.6), lampMat);
      lamp.position.set(x, 8.9, z - Math.sign(z) * 1.5);
      s.add(lamp);
      this.anchors.push(new THREE.Vector3(x, 9, z));
    }
    // Overhead sign gantry across the road.
    const gantryMat = this.mats.steel;
    for (const z of [-hd - 0.4, hd + 0.4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7.5, 0.3), gantryMat);
      leg.position.set(4, 3.75, z);
      s.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, hd * 2 + 1), gantryMat);
    beam.position.set(4, 7.4, 0);
    s.add(beam);
    const signTex = canvasTex(256, 64, (g) => {
      g.fillStyle = '#0d5a34'; g.fillRect(0, 0, 256, 64);
      g.strokeStyle = '#e8f0e8'; g.lineWidth = 3; g.strokeRect(4, 4, 248, 56);
      g.fillStyle = '#e8f0e8'; g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('ROUTE 9  ·  EXIT 14', 128, 34);
    });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 6), new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.25 }));
    sign.position.set(4.2, 6.5, -2);
    s.add(sign);
    for (const z of [-4, 0, 4]) this.anchors.push(new THREE.Vector3(4, 7.4, z));
    // Skyline beyond the close blocks, then merge the whole city into a few draw calls.
    this.buildCity(70, -22);
    this.cityB.flush(this.static);
    lightShafts(this.static, [[-14, 10, -12], [6, 12, 13], [20, 10, -13], [-4, 14, 16]], new THREE.Vector3(10, 34, 14), 0xf4fbff, 0.07);
    this.spawns = [new THREE.Vector3(-7, 0, 0), new THREE.Vector3(7, 0, 0)];
  }

  // ------------------------------------------------------------------ static scenery
  private buildStatic() {
    const s = this.static;
    const HW = BOUNDS.hw, HD = BOUNDS.hd;
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
    const winTex = this.winTex;
    this.spawns = [new THREE.Vector3(-6, 0, 2), new THREE.Vector3(6, 0, 2)];
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8c8794, map: winTex, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.55, roughness: 0.9 });
    // The Clarion building itself: a stone facade at true window scale.
    void bodyMat;
    const fac = facadeMaterial('stone').clone();
    fac.vertexColors = false;
    fac.map = fac.map!.clone(); fac.map.repeat.set((HW * 2) / 24, 70 / 27.2); fac.map.needsUpdate = true;
    fac.emissiveMap = fac.emissiveMap!.clone(); fac.emissiveMap.repeat.copy(fac.map.repeat); fac.emissiveMap.needsUpdate = true;
    fac.bumpMap = fac.bumpMap!.clone(); fac.bumpMap.repeat.copy(fac.map.repeat); fac.bumpMap.needsUpdate = true;
    const body = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 - 0.2, 70, HD * 2 - 0.2), fac);
    body.position.y = -35.6;
    s.add(body);
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 0.8, 0.5, HD * 2 + 0.8), this.mats.concrete);
    cornice.position.y = -0.9;
    s.add(cornice);

    this.buildCity(34);
    // Close neighbours: taller blocks crowd the roof, with signage and rooftop clutter.
    const nsigns: [string, string, string][] = [['HOTEL', '#1a2a3a', '#ffd070'], ['FRESH 24/7', '#f0e6c8', '#c02a20'], ['RADIO', '#202028', '#7ad0ff'], ['GARAGE', '#e8d020', '#202020']];
    if (hasCityKit()) {
      // Real modular buildings (Downtown City MegaKit) on podiums, fronts facing the roof.
      // Only windowed faces look at the roof and the gameplay camera: Medium is windowed on its front
      // only, Large on its front and left side, Small on its front and left side.
      this.kitBlock('Building_Medium_2_001', -3, -HD - 15, 0, -1, -60, nsigns[0], 9, 4);
      this.cityB.building({ x: 12, z: -HD - 16, w: 12, d: 12, bottom: -60, top: 18, detail: 2, front: new THREE.Vector3(0, 0, 1) });
      this.cityB.podium(-20, -HD - 17, 12, 12, -60, 10, 'brick');
      this.kitBlock('Building_Small_1', -HW - 13, -2, Math.PI / 2, -5, -60, nsigns[1], 6, 2);
      this.kitBlock('Building_Large_2', HW + 13, 2, 0, 2, -60, nsigns[2], 12, 5);
      this.kitBlock('Building_Small_1', -10, HD + 18, Math.PI, -11, -60, nsigns[3], 2, 3);
      this.kitBlock('Building_Medium_2_001', 14, HD + 19, Math.PI, -20, -60, undefined, undefined, 2);
      this.flushKit(false);
    } else {
      this.block(0, -HD - 16, 30, 12, -60, 24, 1, nsigns[0], 9);
      this.block(-HW - 14, -2, 12, 22, -60, 12, 1, nsigns[1], 6);
      this.block(HW + 13, 4, 12, 18, -60, 30, 1, nsigns[2], 12);
      this.block(-10, HD + 18, 18, 14, -60, 6, -1, nsigns[3], 2);
    }
    this.cityB.flush(this.static);
    lightShafts(this.static, [[-HW - 6, 8, -8], [6, 14, -HD - 7], [HW + 5, 10, 6]], new THREE.Vector3(-22, 26, 12), 0xffd8a8, 0.06);
    // Water tower on the neighbouring roof, billboard frame, rooftop pipes and vents.
    const wt = new THREE.Group();
    const tankM = new THREE.MeshStandardMaterial({ color: 0x6a4a34, roughness: 0.9 });
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3.4, 16), tankM);
    tank.position.y = 6.2; tank.castShadow = true; wt.add(tank);
    const roofCone = new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.4, 16), tankM);
    roofCone.position.y = 8.6; roofCone.castShadow = true; wt.add(roofCone);
    for (const [lx, lz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.5, 0.2), this.mats.steel); leg.position.set(lx, 2.25, lz); leg.castShadow = true; wt.add(leg); }
    wt.position.set(-HW - 12, 12, -6);
    s.add(wt);
    const bb = this.signTex('CITY PULSE 98.1', '#103048', '#9fe8ff');
    const board = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 0.3), new THREE.MeshStandardMaterial({ map: bb, emissive: 0xffffff, emissiveMap: bb, emissiveIntensity: 0.35 }));
    board.position.set(HW + 7, 36, 4);
    board.rotation.y = -Math.PI / 2;
    board.castShadow = true;
    s.add(board);
    this.boxes([
      [HW * 2 - 2, 0.25, 0.25, 0, 0.35, HD - 1.0], [HW * 2 - 2, 0.18, 0.18, 0, 0.65, HD - 1.0],
      [0.25, 0.25, HD * 2 - 2, -HW + 1.0, 0.35, 0],
      [0.8, 0.9, 0.8, -3, 0.45, HD - 1.6], [0.8, 0.9, 0.8, 7, 0.45, HD - 1.6], [0.6, 1.4, 0.6, -HW + 1.6, 0.7, -8],
    ], this.mats.steel);
    for (let i = 0; i < 10; i++) this.decal('stain', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.6, 2 + Math.random() * 3);
    for (let i = 0; i < 5; i++) this.decal('puddle', (Math.random() - 0.5) * HW * 1.6, (Math.random() - 0.5) * HD * 1.4, 1.5 + Math.random() * 2, Math.random() * 3);
    for (let i = 0; i < 8; i++) this.decal('crack', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.6, 2 + Math.random() * 2.5, Math.random() * 6);
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
    const hb = new THREE.Mesh(new RoundedBoxGeometry(4, 3.6, 3.2, 3, 0.08), this.mats.hut);
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
    // Roof lip, vent stack, conduit and a door frame so the hut reads as built, not a box.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(4.3, 0.18, 3.5), this.mats.concrete);
    lip.position.y = 3.65; lip.castShadow = true; hut.add(lip);
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.1, 12), this.mats.steel);
    vent.position.set(-1.2, 4.2, -0.6); vent.castShadow = true; hut.add(vent);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.25, 12), this.mats.steel);
    cap.position.set(-1.2, 4.85, -0.6); hut.add(cap);
    const conduit = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.2, 0.08), this.mats.steel);
    conduit.position.set(1.7, 1.7, 1.63); hut.add(conduit);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.42, 0.05), this.mats.concrete);
    frame.position.set(0, 1.2, 1.6); hut.add(frame);
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
    const HW = BOUNDS.hw, HD = BOUNDS.hd;
    if (this.layout === 'construction') { resetExtra(this); return; }
    if (this.enclosed) { resetEnclosed(this); return; }
    if (this.layout === 'overpass') {
      // Noise-barrier segments along both long edges; the ends are closed by wreckage.
      for (const zs of [-1, 1]) for (let i = 0; i < 13; i++) {
        const c = new THREE.Vector3(-HW + 2 + i * 4, 0, zs * (HD - WALL_T / 2));
        const w = new WallSeg(c, new THREE.Vector3(4, WALL_H, WALL_T), new THREE.Vector3(0, 0, zs), m, 'noise');
        this.walls.push(w);
        this.dyn.add(w.group);
      }
      const add = (p: Prop, x: number, z: number, ry = 0) => {
        p.pos.set(x, 0, z);
        p.mesh.position.copy(p.pos);
        p.mesh.rotation.y = ry;
        if (Math.abs(Math.sin(ry)) > 0.7) p.half.set(p.half.z, p.half.y, p.half.x);
        p.updateSolid();
        this.props.push(p);
        this.dyn.add(p.mesh);
      };
      add(this.makeCar(0xd8b020), -13, -3.2, Math.PI / 2);
      add(this.makeCar(0x8a9aa8), 11, 3.4, Math.PI / 2 + 0.1);
      add(this.makeCar(0x6a1f24), 18, -3.0, Math.PI / 2);
      add(this.makeBarrier(), -3, 4.6);
      add(this.makeBarrier(), 3, -4.8);
      add(this.makeBarrel(), -8, 4.5);
      add(this.makeBarrel(), -7.2, 5.3);
      add(this.makeBarrel(), 14.5, -1);
      add(this.makeBarrel(), 0, -2);
      add(this.makeCrate(), -18, 2.5);
      add(this.makeCrate(), 6, 0.5);
      // Road-works clutter: cones, barricades and a bin.
      add(this.makeCone(), -16.5, -5.6);
      add(this.makeCone(), -15.2, -5.9);
      add(this.makeCone(), 16.2, 5.5);
      add(this.makeCone(), 9, -5.8);
      add(this.makeBarricade(), -20.5, 4.6, Math.PI / 2);
      add(this.makeBarricade(), 21, -2.2, Math.PI / 2);
      add(this.makeBin(), 20.5, 5.6);
      return;
    }
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
    add(this.makePallet(), 1.5, -4.5);
    add(this.makePanel(), -2.5, 5.2);
    add(this.makeCrate(), 13.5, 6.5);
    add(this.makeCrate(), -9, -4.5);
    add(this.makeCrate(), 3.5, 1.4);
    add(this.makeWheelie(), 15.6, -10.8);
    add(this.makeBin(), -15.8, 10.6);
    add(this.makeBin(), 8.5, -10.6);
  }

  makeCar(color: number) {
    return new Prop('car', 2, buildCar(color), new THREE.Vector3(0.95, 0.8, 2.1), true);
  }
  makeBarrel() {
    const colors = [0x2f6a9a, 0x8a2a20, 0x3a5a2a, 0x7a6a20];
    const fallback = () => new Prop('barrel', 0, buildBarrel(colors[Math.floor(srand() * colors.length)]), new THREE.Vector3(0.34, 0.475, 0.34));
    return this.modelProp(srand() < 0.5 ? 'barrel_02_big_blue' : 'barrel_02_medium_green', 'barrel', 0, fallback, false, 1.1);
  }
  makeBarrier() {
    return this.modelProp('concrete_jersey_barrier_01_medium', 'barrier', 1, () => new Prop('barrier', 1, buildBarrier(this.mats.concrete), new THREE.Vector3(1.1, 0.45, 0.4)));
  }
  makeCone() {
    return this.modelProp('cone_ii_medium', 'cone', 0, () => this.makeCrate());
  }
  makeBin() {
    return this.modelProp(srand() < 0.5 ? 'metal_garbage_can_01_medium' : 'trash_bin_c_green', 'bin', 0, () => this.makeCrate(), false, 1.15);
  }
  makePallet() {
    return this.modelProp('pallet_medium_01', 'pallet', 0, () => this.makePanel());
  }
  makeWheelie() {
    return this.modelProp(srand() < 0.5 ? 'garbage_collector_green_large' : 'garbage_collector_red_large', 'wheelie', 1, () => this.makeAC(), false, 1.15);
  }
  makeBarricade() {
    return this.modelProp('type_ii_barricade_01_medium', 'barricade', 0, () => this.makeCrate());
  }
  makeAC() {
    return new Prop('ac', 1, buildAC(), new THREE.Vector3(0.85, 0.6, 0.6));
  }
  makeTank() {
    return new Prop('tank', 2, buildTank(this.mats.tank, this.mats.stripe), new THREE.Vector3(0.7, 0.85, 0.7), true);
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
    return new Prop('crate', 0, buildCrate(), new THREE.Vector3(0.375, 0.375, 0.375));
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
    p.vel.set((srand() - 0.5) * 2, 2, 5);
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
    p.vel.set((srand() - 0.5) * 3, 3, (srand() - 0.5) * 3);
    p.state = 'falling';
    this.props.push(p);
    this.dyn.add(p.mesh);
  }

  // ------------------------------------------------------------------ queries
  inside(x: number, z: number) {
    if (SHAPE.circle) return x * x + z * z <= SHAPE.circle * SHAPE.circle;
    return Math.abs(x) <= BOUNDS.hw && Math.abs(z) <= BOUNDS.hd;
  }

  solids(): Solid[] {
    const s: Solid[] = [...this.fixedSolids];
    for (const w of this.walls) if (!w.broken) s.push(w.solid);
    for (const p of this.props) if (p.blocking) s.push(p.solid);
    return s;
  }

  /** Highest supporting surface under (x,z) not more than `step` above y. */
  groundAt(x: number, z: number, y: number, step = 0.35): number {
    // The deck (y = 0) only supports things at or above it, like every other surface: a body that has already
    // dropped below the deck edge must keep falling, never be snapped back up when it drifts over the footprint.
    let g = this.inside(x, z) && y + step >= 0 ? 0 : -Infinity;
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
    if (this.enclosed) {
      // Backstop for walled arenas: nothing (fast launches, teleports, Displace) ends up outside the floor.
      const mx = BOUNDS.hw - r, mz = BOUNDS.hd - r;
      pos.x = Math.min(mx, Math.max(-mx, pos.x));
      pos.z = Math.min(mz, Math.max(-mz, pos.z));
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
    this.ambient?.(dt);
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
      if (this.enclosed) {
        const mx = BOUNDS.hw - p.half.x, mz = BOUNDS.hd - p.half.z;
        if (Math.abs(p.pos.x) > mx) { p.pos.x = Math.sign(p.pos.x) * mx; p.vel.x *= -0.3; }
        if (Math.abs(p.pos.z) > mz) { p.pos.z = Math.sign(p.pos.z) * mz; p.vel.z *= -0.3; }
      }
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
    if (this.fadeables[0]) check(this.fadeables[0], new THREE.Vector3(9, 0, -7.1), new THREE.Vector3(13, 3.6, -3.9));
    for (const p of this.props) if (p.state === 'rest' && p.cls >= 1) check(p.mesh, p.solid.min, p.solid.max);
  }
}
