import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Arena } from './arena';
import { BOUNDS, Prop, WallSeg, SHAPE } from './arena';
import { addOutline } from './rig';
import { lightShafts } from './city';
import { hasCityKit, KitBuilding } from './citykit';
import { buildCrate } from './props';

// Three more venues: an unfinished skyscraper floor (Skyline Site), a night pier (Harbor Pier 7) and a
// tiny neon helipad. They reuse the arena systems (breakable wall segments, props, anchors, cling solids).

type Box = [number, number, number, number, number, number, number?];

function tex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const glow = (color: number) => new THREE.MeshBasicMaterial({ color });

/** Merge a list of meshes' geometries (already positioned) into one mesh per material. */
function merged(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mat: THREE.Material, shadow = true) {
  if (!geos.length) return null;
  const m = new THREE.Mesh(mergeGeometries(geos), mat);
  m.castShadow = shadow; m.receiveShadow = true;
  parent.add(m);
  return m;
}
const boxG = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};
const cylG = (r0: number, r1: number, h: number, x: number, y: number, z: number, seg = 10, rx = 0, rz = 0) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
};

/** A neon sign: glowing text on a dark backing, optional frame tube. */
function neonSign(word: string, color: string, w: number, h: number) {
  const t = tex(512, 128, (g) => {
    g.fillStyle = '#07060c'; g.fillRect(0, 0, 512, 128);
    g.font = 'bold 84px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color; g.shadowBlur = 26; g.fillStyle = color; g.fillText(word, 256, 68);
    g.shadowBlur = 8; g.fillStyle = '#ffffff'; g.globalAlpha = 0.55; g.fillText(word, 256, 68); g.globalAlpha = 1;
    g.strokeStyle = color; g.lineWidth = 5; g.shadowBlur = 16; g.strokeRect(10, 10, 492, 108);
  });
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.25), std({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.85, roughness: 0.6 }));
}

/** Corrugated shipping-container material in a given paint colour. */
const containerMats = new Map<number, THREE.MeshStandardMaterial>();
function containerMat(color: number) {
  let m = containerMats.get(color);
  if (m) return m;
  const c = new THREE.Color(color);
  const t = tex(128, 64, (g) => {
    g.fillStyle = `#${c.getHexString()}`; g.fillRect(0, 0, 128, 64);
    for (let x = 0; x < 128; x += 6) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x, 0, 2, 64); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x + 3, 0, 1, 64); }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, 128, 3); g.fillRect(0, 61, 128, 3);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(90,50,30,${Math.random() * 0.35})`; g.fillRect(Math.random() * 128, Math.random() * 64, 2 + Math.random() * 8, 1 + Math.random() * 3); }
  }, [2, 1]);
  m = std({ map: t, roughness: 0.75, metalness: 0.35 });
  containerMats.set(color, m);
  return m;
}
const CONT = { w: 2.44, h: 2.6, l: 6.06 };

// ====================================================================== SKYLINE SITE (construction)
export function buildConstruction(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  const slabTex = tex(256, 256, (g) => {
    g.fillStyle = '#7a7670'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) { const v = 95 + Math.random() * 40; g.fillStyle = `rgb(${v},${v - 3},${v - 8})`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
    g.strokeStyle = 'rgba(40,38,36,0.55)'; g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    for (let i = 0; i < 6; i++) { const gr = g.createRadialGradient(Math.random() * 256, Math.random() * 256, 4, 128, 128, 90); gr.addColorStop(0, 'rgba(40,36,30,0.18)'); gr.addColorStop(1, 'rgba(40,36,30,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  }, [6, 4]);
  const slab = std({ map: slabTex, roughness: 0.92 });
  const steel = std({ color: 0x7a4a2a, roughness: 0.65, metalness: 0.5 }); // red-oxide primed steel
  const steelDark = std({ color: 0x3a3e44, roughness: 0.5, metalness: 0.6 });
  const yellow = std({ color: 0xe8b020, roughness: 0.55, metalness: 0.3 });
  const grate = std({ map: tex(64, 64, (g) => { g.fillStyle = '#2a2c30'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#5a5e64'; for (let i = 0; i < 64; i += 8) { g.fillRect(i, 0, 2, 64); g.fillRect(0, i, 64, 2); } }, [8, 6]), roughness: 0.5, metalness: 0.6 });

  // Floor slab (the playable deck) with a steel-grating section and an exposed rebar edge.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.5, HD * 2), slab);
  deck.position.y = -0.25; deck.receiveShadow = true; s.add(deck);
  const gr = new THREE.Mesh(new THREE.PlaneGeometry(8, HD * 2 - 1), grate);
  gr.rotation.x = -Math.PI / 2; gr.position.set(HW - 4.5, 0.012, 0); gr.receiveShadow = true; s.add(gr);
  const rebar: THREE.BufferGeometry[] = [];
  for (let x = -HW + 1; x <= HW - 1; x += 0.8) rebar.push(cylG(0.025, 0.025, 0.9 + Math.random() * 0.6, x, -0.1, -HD - 0.15, 5, 0.25));
  merged(s, rebar, steelDark, false);

  // The unfinished tower below: perimeter columns, floor slabs every 4 m, a concrete core.
  const frame: THREE.BufferGeometry[] = [];
  const floors: THREE.BufferGeometry[] = [];
  for (let y = -4; y > -64; y -= 4) {
    floors.push(boxG(HW * 2 - 0.2, 0.4, HD * 2 - 0.2, 0, y, 0));
    for (let x = -HW + 0.4; x <= HW; x += 5.6) for (const z of [-HD + 0.4, HD - 0.4]) frame.push(boxG(0.45, 4, 0.45, x, y + 2, z));
    for (let z = -HD + 0.4; z <= HD; z += 5.4) for (const x of [-HW + 0.4, HW - 0.4]) frame.push(boxG(0.45, 4, 0.45, x, y + 2, z));
  }
  merged(s, floors, std({ color: 0x6a6660, roughness: 0.95 }), false);
  merged(s, frame, steel, false);
  const core = new THREE.Mesh(new THREE.BoxGeometry(9, 64, 7), std({ color: 0x8a8680, roughness: 0.95 }));
  core.position.set(-2, -32.5, 1); s.add(core);

  // Columns rising from this floor toward the next (some interior ones are cover) and partial beams above.
  const cols: THREE.BufferGeometry[] = [];
  const colAt = (x: number, z: number, h: number, solid: boolean) => {
    cols.push(boxG(0.5, h, 0.12, x, h / 2, z), boxG(0.12, h, 0.5, x, h / 2, z), boxG(0.6, 0.1, 0.6, x, 0.05, z));
    if (solid) a.fixedSolids.push({ min: new THREE.Vector3(x - 0.3, 0, z - 0.3), max: new THREE.Vector3(x + 0.3, h, z + 0.3), kind: 'mast', clingable: false });
  };
  // Tall columns on the north edge; the south edge (usually nearest the camera) only has short stubs with rebar.
  for (const x of [-HW - 0.4, -HW / 2, 0, HW / 2, HW + 0.4]) colAt(x, -HD - 0.4, x === 0 || Math.abs(x) > HW ? 7 : 4 + Math.random() * 3, false);
  for (const x of [-HW - 0.4, -HW / 2, 0, HW / 2, HW + 0.4]) colAt(x, HD + 0.4, 0.9 + Math.random() * 0.5, false);
  for (const z of [-HD / 2, HD / 2]) for (const x of [-HW - 0.4, HW + 0.4]) colAt(x, z, 6.5, false);
  colAt(-5.5, -3.5, 7, true);
  colAt(5.5, 3.5, 7, true);
  merged(s, cols, steel);
  const beams: THREE.BufferGeometry[] = [];
  beams.push(boxG(HW + 0.8, 0.45, 0.25, -HW / 2, 7.1, -HD - 0.4), boxG(HW / 2, 0.45, 0.25, HW * 0.75, 7.1, -HD - 0.4));
  beams.push(boxG(0.25, 0.45, HD + 0.4, -HW - 0.4, 7.1, -HD / 2));
  beams.push(boxG(0.25, 0.45, HD + 0.4, 0, 7.1, -HD / 2));
  beams.push(boxG(HW + 0.8, 0.4, 0.22, -HW / 2, 7.1, -3.5));
  merged(s, beams, steel);
  for (const x of [-HW / 2, 0, HW / 2]) a.anchors.push(new THREE.Vector3(x, 7.1, -HD - 0.4));
  a.anchors.push(new THREE.Vector3(-5.5, 7.1, -3.5), new THREE.Vector3(5.5, 7, 3.5), new THREE.Vector3(0, 7.1, -3.5));

  // Hoist cage (construction elevator) at the north-east corner: cover and a wall to cling to.
  const hoist = new THREE.Group();
  const cage = std({ map: tex(64, 64, (g) => { g.clearRect(0, 0, 64, 64); g.strokeStyle = 'rgba(232,176,32,0.95)'; g.lineWidth = 3; for (let i = 0; i <= 64; i += 10) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); } }, [3, 3]), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 });
  const hb: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) hb.push(boxG(0.16, 14, 0.16, x, 3, z));
  for (const y of [0.05, 3.2, 6.5, 10]) for (const [w, d, x, z] of [[3.3, 0.12, 0, -1.6], [3.3, 0.12, 0, 1.6], [0.12, 3.3, -1.6, 0], [0.12, 3.3, 1.6, 0]] as [number, number, number, number][]) hb.push(boxG(w, 0.12, d, x, y, z));
  merged(hoist, hb, yellow);
  for (const [w, d, x, z, ry] of [[3.2, 3.1, 0, -1.6, 0], [3.2, 3.1, 0, 1.6, 0], [3.2, 3.1, -1.6, 0, Math.PI / 2], [3.2, 3.1, 1.6, 0, Math.PI / 2]] as number[][]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), cage); p.position.set(x, 1.6, z); p.rotation.y = ry; hoist.add(p);
  }
  const car = new THREE.Mesh(new RoundedBoxGeometry(2.8, 2.6, 2.8, 2, 0.06), std({ color: 0x4a5058, roughness: 0.6, metalness: 0.5 }));
  car.position.y = 8.4; car.castShadow = true; addOutline(car, 1.02); hoist.add(car);
  hoist.position.set(HW - 3.2, 0, -HD + 3.2);
  s.add(hoist);
  a.fixedSolids.push({ min: new THREE.Vector3(HW - 4.9, 0, -HD + 1.5), max: new THREE.Vector3(HW - 1.5, 3.3, -HD + 4.9), kind: 'hut', clingable: true });
  a.anchors.push(new THREE.Vector3(HW - 3.2, 10, -HD + 3.2));

  // Tower crane: lattice mast off the north-west corner, jib over the floor, hook with a hanging beam load.
  const crane: THREE.BufferGeometry[] = [];
  const mx = -HW - 6, mz = -HD - 6, top = 34;
  for (let y = -40; y < top; y += 2) {
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) crane.push(boxG(0.14, 2, 0.14, mx + x, y + 1, mz + z));
    crane.push(boxG(0.1, 0.1, 2.8, mx - 1, y + 1, mz, 0, 0.78), boxG(0.1, 0.1, 2.8, mx + 1, y + 1, mz, 0, -0.78), boxG(2.8, 0.1, 0.1, mx, y + 1, mz - 1, 0, 0, 0.78), boxG(2.8, 0.1, 0.1, mx, y + 1, mz + 1, 0, 0, -0.78));
  }
  // Jib toward the arena (along +x, slightly toward +z) and a counter-jib with ballast.
  const jibDir = new THREE.Vector3(1, 0, 0.55).normalize();
  const jibYaw = Math.atan2(jibDir.x, jibDir.z) - Math.PI / 2;
  for (let d = 0; d < 46; d += 2) {
    const p = new THREE.Vector3(mx, top, mz).addScaledVector(jibDir, d + 1);
    crane.push(boxG(2, 0.12, 0.12, p.x, p.y, p.z, -jibYaw), boxG(2, 0.12, 0.12, p.x, p.y + 1.6, p.z, -jibYaw));
    crane.push(boxG(0.1, 1.6, 0.1, p.x, p.y + 0.8, p.z));
  }
  for (let d = 0; d < 14; d += 2) { const p = new THREE.Vector3(mx, top, mz).addScaledVector(jibDir, -d - 1); crane.push(boxG(2, 0.14, 0.9, p.x, p.y, p.z, -jibYaw)); }
  crane.push(boxG(3, 2.4, 2.4, ...new THREE.Vector3(mx, top - 1.2, mz).addScaledVector(jibDir, -12).toArray() as [number, number, number], -jibYaw));
  crane.push(boxG(2.2, 2.4, 2.4, mx, top - 1.4, mz)); // operator cab
  merged(s, crane, yellow, false);
  const hookAt = new THREE.Vector3(mx, top, mz).addScaledVector(jibDir, 30);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, top - 12, 4), steelDark);
  cable.position.set(hookAt.x, (top + 12) / 2, hookAt.z); s.add(cable);
  const load = new THREE.Group();
  for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 0.3), steel); b.position.set(0, -0.7 + i * 0.36, (i - 1) * 0.32); b.castShadow = true; load.add(b); }
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.07, 6, 12, Math.PI * 1.4), steelDark); hook.position.y = 0.4; load.add(hook);
  load.position.set(hookAt.x, 11, hookAt.z); load.rotation.y = 0.5; s.add(load);
  a.anchors.push(new THREE.Vector3(hookAt.x, 11.5, hookAt.z));

  // Scaffolding hugging the south and west faces below the floor, topped by a handrail at deck level
  // (nothing above it, so the gameplay camera never films through it).
  const scaf: THREE.BufferGeometry[] = [];
  const planks: THREE.BufferGeometry[] = [];
  for (let x = -HW; x <= HW; x += 2.5) for (const dz of [1.0, 2.2]) scaf.push(boxG(0.07, 13, 0.07, x, -5.3, HD + dz));
  for (const y of [-10, -8, -6, -4, -2]) { for (const dz of [1.0, 2.2]) scaf.push(boxG(HW * 2, 0.06, 0.06, 0, y + 1.0, HD + dz)); planks.push(boxG(HW * 2, 0.06, 1.2, 0, y - 0.03, HD + 1.6)); }
  for (const dz of [1.0, 2.2]) scaf.push(boxG(HW * 2, 0.06, 0.06, 0, 1.15, HD + dz));
  for (let z = -HD; z <= HD; z += 2.5) for (const dx of [1.0, 2.2]) scaf.push(boxG(0.07, 13, 0.07, -HW - dx, -5.3, z));
  for (const y of [-10, -8, -6, -4, -2]) { for (const dx of [1.0, 2.2]) scaf.push(boxG(0.06, 0.06, HD * 2, -HW - dx, y + 1.0, 0)); planks.push(boxG(1.2, 0.06, HD * 2, -HW - 1.6, y - 0.03, 0)); }
  for (const dx of [1.0, 2.2]) scaf.push(boxG(0.06, 0.06, HD * 2, -HW - dx, 1.15, 0));
  merged(s, scaf, std({ color: 0xb8bcc0, roughness: 0.4, metalness: 0.7 }), false);
  merged(s, planks, std({ color: 0x8a6a42, roughness: 0.9 }), false);

  // Work lights on stands, safety signs, cable reels and a tarp-covered pallet stack along the edges.
  const lightM = glow(0xfff0c0);
  const stands: THREE.BufferGeometry[] = [];
  const heads: THREE.BufferGeometry[] = [];
  for (const [x, z, ry] of [[-HW + 1.2, -HD + 1.2, 0.8], [HW - 1.2, HD - 1.2, -2.3], [-HW + 1.2, HD - 1.2, 2.3]]) {
    stands.push(cylG(0.04, 0.04, 2.6, x, 1.3, z, 6), cylG(0.02, 0.02, 1.2, x, 0.3, z, 4, 0, 0.9), cylG(0.02, 0.02, 1.2, x, 0.3, z, 4, 0, -0.9));
    heads.push(boxG(0.7, 0.45, 0.12, x, 2.7, z, ry));
  }
  merged(s, stands, steelDark, false);
  merged(s, heads, lightM, false);
  const signT = tex(256, 128, (g) => { g.fillStyle = '#f0c020'; g.fillRect(0, 0, 256, 128); g.fillStyle = '#141414'; g.font = 'bold 40px Arial'; g.textAlign = 'center'; g.fillText('DANGER', 128, 52); g.font = 'bold 26px Arial'; g.fillText('OPEN EDGE', 128, 96); });
  for (const [x, z, ry] of [[-6, HD + 0.1, Math.PI], [8, -HD - 0.1, 0]]) { const sg = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), std({ map: signT, roughness: 0.6 })); sg.position.set(x, 1.0, z); sg.rotation.y = ry; s.add(sg); }

  // Decals: dust, puddles of curing water, cracks.
  for (let i = 0; i < 10; i++) a.decal('stain', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.6, 2 + Math.random() * 3);
  for (let i = 0; i < 4; i++) a.decal('puddle', (Math.random() - 0.5) * HW * 1.4, (Math.random() - 0.5) * HD * 1.3, 1.5 + Math.random() * 2, Math.random() * 3);
  for (let i = 0; i < 6; i++) a.decal('crack', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.6, 2 + Math.random() * 2.5, Math.random() * 6);

  // The city far below and around: kit buildings stepping down, the skyline, sunset shafts.
  if (hasCityKit()) {
    const kinds: KitBuilding[] = ['Building_Large_2', 'Building_Medium_2_001', 'Building_Small_1'];
    const ring: [number, number, number, number][] = [[-38, -30, 0, -26], [4, -40, 0, -34], [40, -26, -Math.PI / 2, -30], [44, 16, -Math.PI / 2, -40], [-44, 18, Math.PI / 2, -38], [10, 40, Math.PI, -44]];
    ring.forEach(([x, z, ry, base], i) => a.kitBlock(kinds[i % 3], x, z, ry, base, -90, undefined, undefined, 3));
    a.flushKit(false);
  }
  a.buildCity(44, -70, 0xd8a890);
  a.cityB.flush(a.static);
  const street = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), std({ color: 0x2a2228, roughness: 0.95 }));
  street.rotation.x = -Math.PI / 2; street.position.y = -90; s.add(street);
  lightShafts(a.static, [[-HW - 8, 6, 4], [4, 10, -HD - 10], [HW + 9, 8, -2]], new THREE.Vector3(-18, 14, 22), 0xffc890, 0.07);
  a.spawns = [new THREE.Vector3(-6, 0, 1.5), new THREE.Vector3(6, 0, 1.5)];
}

// ====================================================================== HARBOR PIER 7 (docks)
export const WATER_Y = -3.6;
export function buildDocks(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  // Timber pier deck with concrete edge beams and piles down into the water.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 16, 0.6, HD * 2), a.mats.timber);
  deck.position.y = -0.3; deck.receiveShadow = true; s.add(deck);
  (a.mats.timber.map as THREE.Texture).repeat.set(14, 3);
  const conc: THREE.BufferGeometry[] = [boxG(HW * 2 + 16, 0.8, 0.5, 0, -0.5, -HD - 0.2), boxG(HW * 2 + 16, 0.8, 0.5, 0, -0.5, HD + 0.2)];
  const piles: THREE.BufferGeometry[] = [];
  for (let x = -HW - 7; x <= HW + 7; x += 3.5) for (const z of [-HD + 0.2, -HD / 3, HD / 3, HD - 0.2]) piles.push(cylG(0.32, 0.36, 9, x, -4.6, z, 8));
  for (let x = -HW - 7; x <= HW + 7; x += 3.5) piles.push(boxG(0.3, 0.3, HD * 2, x, -1.1, 0));
  merged(s, conc, a.mats.concrete);
  merged(s, piles, std({ color: 0x2e2620, roughness: 0.9 }), false);
  // Black harbour water with a soft sheen, mist banks and the far shore.
  const waterT = tex(256, 256, (g) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) { const v = 100 + Math.random() * 80; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(Math.random() * 256, Math.random() * 256, 10 + Math.random() * 30, 2); }
  }, [30, 30]);
  waterT.colorSpace = THREE.NoColorSpace;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), std({ color: 0x0c1c24, roughness: 0.25, roughnessMap: waterT, metalness: 0.5, bumpMap: waterT, bumpScale: 0.6 }));
  water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; water.receiveShadow = true; s.add(water);

  // Container stacks close both ends of the pier (permanent cover, cling walls).
  const colors = [0xa03a2a, 0x2a5a8a, 0x3a6a3a, 0xc87a20, 0x5a3a6a, 0x8a8a8a];
  const contG = new Map<number, THREE.BufferGeometry[]>();
  const cont = (x: number, y: number, z: number, ry: number, color: number) => {
    const list = contG.get(color) ?? [];
    list.push(boxG(CONT.w, CONT.h, CONT.l, x, y + CONT.h / 2, z, ry));
    contG.set(color, list);
  };
  for (const sx of [-1, 1]) {
    const x0 = sx * (HW - 1.3);
    for (const [dz, lvl] of [[-4.4, 0], [-4.4, 1], [0, 0], [4.4, 0], [4.4, 1], [0, 1], [-4.4, 2]] as [number, number][]) {
      cont(x0, lvl * CONT.h, dz * (HD / 7.5), 0, colors[Math.floor(Math.random() * colors.length)]);
      cont(x0 + sx * CONT.w, lvl * CONT.h, dz * (HD / 7.5), 0, colors[Math.floor(Math.random() * colors.length)]);
    }
    a.fixedSolids.push({ min: new THREE.Vector3(sx > 0 ? HW - 2.6 : -HW, 0, -HD), max: new THREE.Vector3(sx > 0 ? HW : -HW + 2.6, CONT.h * 2, HD), kind: 'hut', clingable: true });
    a.anchors.push(new THREE.Vector3(x0, CONT.h * 3 + 1.5, -3), new THREE.Vector3(x0, CONT.h * 2 + 1.5, 3));
  }
  // One container lying mid-pier as cover (and a wall to cling to).
  cont(-3, 0, -HD + 1.6, Math.PI / 2, 0x2a5a8a);
  a.fixedSolids.push({ min: new THREE.Vector3(-3 - CONT.l / 2, 0, -HD + 1.6 - CONT.w / 2), max: new THREE.Vector3(-3 + CONT.l / 2, CONT.h, -HD + 1.6 + CONT.w / 2), kind: 'hut', clingable: true });
  a.anchors.push(new THREE.Vector3(-3, CONT.h + 4, -HD + 1.6));
  for (const [color, list] of contG) merged(s, list, containerMat(color));
  // Door ends and corner castings so containers read as containers, not boxes.
  const castings: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const dz of [-4.4, 0, 4.4]) for (let lvl = 0; lvl < 2; lvl++) castings.push(boxG(0.05, CONT.h - 0.2, CONT.w - 0.2, sx * (HW - 2.62), lvl * CONT.h + CONT.h / 2, dz * (HD / 7.5)));
  merged(s, castings, std({ color: 0x1a1c20, roughness: 0.6, metalness: 0.5 }), false);

  // Bollards along the pier edges and lamp posts with sodium lights (swing anchors).
  const bol: THREE.BufferGeometry[] = [];
  for (let x = -HW + 4; x <= HW - 4; x += 6) for (const z of [-HD + 0.9, HD - 0.9]) bol.push(cylG(0.2, 0.26, 0.45, x, 0.22, z, 10), cylG(0.3, 0.3, 0.1, x, 0.47, z, 10)); // dressing only: no collision, so launches carry over the edge
  merged(s, bol, std({ color: 0x1c1e22, roughness: 0.5, metalness: 0.6 }));
  const poles: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  for (const x of [-HW + 5, HW - 5]) for (const z of [-HD - 0.5, HD + 0.5]) {
    poles.push(cylG(0.09, 0.13, 8.5, x, 4.25, z, 8), boxG(0.09, 0.09, 1.4, x, 8.5, z - Math.sign(z) * 0.7));
    lamps.push(boxG(0.45, 0.14, 0.6, x, 8.4, z - Math.sign(z) * 1.3));
    a.anchors.push(new THREE.Vector3(x, 8.6, z));
  }
  merged(s, poles, a.mats.steel, false);
  merged(s, lamps, glow(0xffb060), false);

  // Ship-to-shore cranes on the quay across the water: legs, booms reaching over the channel (anchors).
  const cr: THREE.BufferGeometry[] = [];
  const craneMat = std({ color: 0xb83a24, roughness: 0.6, metalness: 0.4 });
  for (const cx of [-18, 16]) {
    const qz = -HD - 26;
    for (const [lx, lz] of [[-5, -4], [5, -4], [-5, 4], [5, 4]]) cr.push(boxG(0.8, 26, 0.8, cx + lx, 9, qz + lz));
    cr.push(boxG(11, 1.2, 1.2, cx, 22, qz - 4), boxG(11, 1.2, 1.2, cx, 22, qz + 4), boxG(1.2, 1.2, 9, cx - 5, 22, qz), boxG(1.2, 1.2, 9, cx + 5, 22, qz));
    // Boom over the water toward the pier, and the back reach.
    cr.push(boxG(1.4, 1.4, 34, cx - 1.5, 24, qz + 17), boxG(1.4, 1.4, 34, cx + 1.5, 24, qz + 17), boxG(4, 0.4, 34, cx, 24.8, qz + 17));
    cr.push(boxG(1.2, 1.2, 16, cx, 24, qz - 12), boxG(4, 3, 4, cx, 26, qz - 6));
    cr.push(boxG(0.3, 16, 0.3, cx, 32, qz), boxG(0.2, 0.2, 22, cx, 34, qz + 9, 0, 0.7), boxG(0.2, 0.2, 14, cx, 33, qz - 7, 0, -0.9));
    // Spreader hanging over the channel.
    cr.push(boxG(2.6, 0.5, 6.2, cx, 14, -HD - 6), boxG(0.06, 10, 0.06, cx - 1, 19, -HD - 6), boxG(0.06, 10, 0.06, cx + 1, 19, -HD - 6));
    a.anchors.push(new THREE.Vector3(cx, 14, -HD - 6));
  }
  merged(s, cr, craneMat, false);
  const quay = new THREE.Mesh(new THREE.BoxGeometry(140, 6, 30), std({ color: 0x4a4a4e, roughness: 0.95 }));
  quay.position.set(0, WATER_Y - 1.5, -HD - 33); s.add(quay);
  // Stacks on the quay.
  for (let i = 0; i < 26; i++) cont(-60 + Math.random() * 120, Math.floor(Math.random() * 3) * CONT.h + WATER_Y + 1.5, -HD - 38 - Math.random() * 10, Math.random() < 0.8 ? Math.PI / 2 : 0, colors[i % colors.length]);
  for (const [color, list] of contG) { list.length = 0; void color; }

  // A cargo ship moored across the far channel: dark hull, white superstructure with lit windows, deck stacks.
  const ship = new THREE.Group();
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-55, 0); hullShape.lineTo(48, 0); hullShape.lineTo(62, 4); hullShape.lineTo(64, 12); hullShape.lineTo(-56, 12); hullShape.lineTo(-56, 3); hullShape.lineTo(-55, 0);
  const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(hullShape, { depth: 22, bevelEnabled: false }), std({ color: 0x1a2228, roughness: 0.7, metalness: 0.3 }));
  hull.position.set(0, WATER_Y - 2, -11); ship.add(hull);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(118, 1.2, 22.2), std({ color: 0x7a1e1a, roughness: 0.8 }));
  stripe.position.set(4, WATER_Y - 1.2, 0); ship.add(stripe);
  const winT = tex(128, 64, (g) => { g.fillStyle = '#d8dce0'; g.fillRect(0, 0, 128, 64); for (let y = 6; y < 64; y += 14) for (let x = 4; x < 128; x += 10) { g.fillStyle = Math.random() < 0.55 ? '#ffe0a0' : '#2a3038'; g.fillRect(x, y, 6, 6); } }, [2, 2]);
  const sup = new THREE.Mesh(new THREE.BoxGeometry(14, 16, 18), std({ map: winT, emissive: 0xffffff, emissiveMap: winT, emissiveIntensity: 0.35, roughness: 0.7 }));
  sup.position.set(-46, WATER_Y + 18, 0); ship.add(sup);
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3, 7, 12), std({ color: 0x9a2a20, roughness: 0.7 }));
  funnel.position.set(-48, WATER_Y + 29, 0); ship.add(funnel);
  const deckStacks: [number, number, number, number, number][] = [];
  for (let x = -34; x < 54; x += 6.4) for (let z = -8; z <= 8; z += 2.6) { const h = 1 + Math.floor(Math.random() * 3); for (let l = 0; l < h; l++) deckStacks.push([x, WATER_Y + 10 + l * CONT.h, z, Math.PI / 2, colors[Math.floor(Math.random() * colors.length)]]); }
  const shipCont = new Map<number, THREE.BufferGeometry[]>();
  for (const [x, y, z, ry, c] of deckStacks) { const l = shipCont.get(c) ?? []; l.push(boxG(CONT.w, CONT.h, CONT.l, x, y + CONT.h / 2, z, ry)); shipCont.set(c, l); }
  for (const [c, l] of shipCont) merged(ship, l, containerMat(c), false);
  for (const [x, col] of [[63, 0x30ff60], [-56, 0xff3030]] as [number, number][]) { const nav = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), glow(col)); nav.position.set(x, WATER_Y + 14, 0); ship.add(nav); }
  ship.position.set(6, 0, HD + 46);
  ship.rotation.y = Math.PI;
  s.add(ship);

  // Far shoreline lights and the city glow beyond the quay.
  const shoreLights: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 160; i++) { const ang = Math.random() * Math.PI * 2, r = 150 + Math.random() * 60; shoreLights.push(boxG(0.8, 0.5 + Math.random() * 1.5, 0.8, Math.cos(ang) * r, WATER_Y + 1 + Math.random() * 6, Math.sin(ang) * r)); }
  merged(s, shoreLights, glow(0xffc880), false);
  a.buildCity(150, WATER_Y - 2, 0x6a8aa0);
  a.cityB.flush(a.static);
  // Decals: wet patches, rope coils, oil stains.
  for (let i = 0; i < 6; i++) a.decal('puddle', (Math.random() - 0.5) * HW * 1.6, (Math.random() - 0.5) * HD * 1.5, 1.5 + Math.random() * 2.5, Math.random() * 3);
  for (let i = 0; i < 8; i++) a.decal('stain', (Math.random() - 0.5) * HW * 1.7, (Math.random() - 0.5) * HD * 1.6, 2 + Math.random() * 2);
  const ropes: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-10, HD - 1.6], [12, -HD + 2.2], [4, HD - 1.4]]) for (let k = 0; k < 3; k++) { const t = new THREE.TorusGeometry(0.45 - k * 0.1, 0.06, 6, 18); t.rotateX(Math.PI / 2); t.translate(x, 0.06 + k * 0.08, z); ropes.push(t); }
  merged(s, ropes, std({ color: 0xb09a6a, roughness: 0.95 }), false);
  lightShafts(a.static, [[-12, 6, HD + 0.5], [8, 6, -HD - 0.5]], new THREE.Vector3(0, 30, 0.01), 0xffc070, 0.05);
  a.spawns = [new THREE.Vector3(-7, 0, 0.5), new THREE.Vector3(7, 0, 0.5)];
}

// ====================================================================== NEON HELIPAD
export function buildHelipad(a: Arena) {
  const s = a.static;
  const R = SHAPE.circle;
  // The pad: a dark disc with the H, a ring of landing lights, sitting on a steel frame over the tower roof.
  const padT = tex(512, 512, (g) => {
    g.fillStyle = '#22242c'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 6000; i++) { const v = 32 + Math.random() * 22; g.fillStyle = `rgb(${v},${v},${v + 6})`; g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
    g.strokeStyle = '#e8e4d8'; g.lineWidth = 14; g.beginPath(); g.arc(256, 256, 200, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#f0c020'; g.lineWidth = 6; g.beginPath(); g.arc(256, 256, 232, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#e8e4d8'; g.fillRect(180, 150, 34, 212); g.fillRect(298, 150, 34, 212); g.fillRect(214, 238, 84, 34);
    g.fillStyle = 'rgba(10,10,14,0.35)'; for (let i = 0; i < 10; i++) { g.beginPath(); g.arc(Math.random() * 512, Math.random() * 512, 20 + Math.random() * 50, 0, Math.PI * 2); g.fill(); }
  });
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.6, 64), [std({ color: 0x3a3c44, roughness: 0.6, metalness: 0.5 }), std({ map: padT, roughness: 0.75 }), std({ color: 0x3a3c44 })]);
  pad.position.y = -0.3; pad.receiveShadow = true; s.add(pad);
  const ringLights: THREE.BufferGeometry[] = [];
  const ringLights2: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 32; i++) { const ang = (i / 32) * Math.PI * 2; (i % 2 ? ringLights2 : ringLights).push(boxG(0.22, 0.08, 0.22, Math.cos(ang) * (R - 0.35), 0.04, Math.sin(ang) * (R - 0.35))); }
  merged(s, ringLights, glow(0x40ff9a), false);
  merged(s, ringLights2, glow(0xf8fbff), false);
  // Support frame down to the tower roof and the tower itself (narrower than the pad: falls go past it).
  const frame: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) { const ang = (i / 8) * Math.PI * 2; const x = Math.cos(ang) * (R - 1.5), z = Math.sin(ang) * (R - 1.5); frame.push(boxG(0.3, 4.2, 0.3, x * 0.55, -2.4, z * 0.55, 0, 0, 0)); frame.push(boxG(0.25, 0.25, R - 1.5, x * 0.5, -0.75, z * 0.5, -ang + Math.PI / 2)); }
  merged(s, frame, std({ color: 0x2a2c34, roughness: 0.5, metalness: 0.7 }), false);
  const towerT = tex(128, 256, (g) => { g.fillStyle = '#0e0d16'; g.fillRect(0, 0, 128, 256); for (let y = 4; y < 256; y += 9) for (let x = 3; x < 128; x += 7) { const r = Math.random(); g.fillStyle = r < 0.22 ? '#ff4fd8' : r < 0.4 ? '#4fe8ff' : r < 0.55 ? '#ffe0a0' : '#1a1824'; g.fillRect(x, y, 4, 5); } }, [2, 10]);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(14, 140, 14), std({ color: 0x8a8aa0, map: towerT, emissive: 0xffffff, emissiveMap: towerT, emissiveIntensity: 0.45, roughness: 0.4, metalness: 0.4 }));
  tower.position.y = -74.5; s.add(tower);
  const roofDeck = new THREE.Mesh(new THREE.BoxGeometry(14.6, 0.6, 14.6), std({ color: 0x2c2c34, roughness: 0.9 }));
  roofDeck.position.y = -4.6; s.add(roofDeck);

  // Light masts at the pad edge (swing anchors) and a windsock.
  const mast: THREE.BufferGeometry[] = [];
  const flood: THREE.BufferGeometry[] = [];
  for (const ang of [Math.PI * 0.25, Math.PI * 1.25]) {
    const x = Math.cos(ang) * (R - 0.6), z = Math.sin(ang) * (R - 0.6);
    mast.push(cylG(0.12, 0.18, 9, x, 4.5, z, 8), boxG(1.4, 0.1, 0.1, x, 8.6, z, -ang));
    flood.push(boxG(0.5, 0.35, 0.3, x - Math.cos(ang) * 0.3, 8.4, z - Math.sin(ang) * 0.3, -ang + Math.PI / 2));
    a.anchors.push(new THREE.Vector3(x, 9, z));
    a.fixedSolids.push({ min: new THREE.Vector3(x - 0.25, 0, z - 0.25), max: new THREE.Vector3(x + 0.25, 9, z + 0.25), kind: 'mast', clingable: false });
  }
  const wsAng = Math.PI * 0.75, wx = Math.cos(wsAng) * (R - 0.5), wz = Math.sin(wsAng) * (R - 0.5);
  mast.push(cylG(0.05, 0.06, 5, wx, 2.5, wz, 6));
  merged(s, mast, std({ color: 0x8a8e98, roughness: 0.4, metalness: 0.8 }), false);
  merged(s, flood, glow(0xe8f4ff), false);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.6, 10, 1, true), std({ color: 0xff6a20, side: THREE.DoubleSide, emissive: 0x401000, emissiveIntensity: 0.6 }));
  sock.rotation.z = Math.PI / 2; sock.position.set(wx + 0.8, 4.9, wz); s.add(sock);
  a.anchors.push(new THREE.Vector3(wx, 5, wz));

  // The neon district: kit towers rising above the pad on every side, neon signs and billboards.
  const nsigns: [string, string][] = [['NOVA', '#ff4fd8'], ['ZEN·CORE', '#4fe8ff'], ['NIGHT MARKET', '#ffb04f'], ['KARAOKE', '#ff4f7a'], ['SYNTH', '#9a6aff'], ['24H', '#4fffa8'], ['ARCADE', '#4fe8ff'], ['HOTEL', '#ff4fd8']];
  if (hasCityKit()) {
    const kinds: KitBuilding[] = ['Building_Large_2', 'Building_Medium_2_001', 'Building_Small_1', 'Building_Medium_2_001', 'Building_Large_2', 'Building_Small_1'];
    const ring: [number, number, number, number][] = [[0, -34, 0, -6], [-34, -6, Math.PI / 2, -14], [32, 4, -Math.PI / 2, -2], [-20, 30, Math.PI, -22], [22, 32, Math.PI, -16], [-30, -30, Math.PI / 4, -24]];
    ring.forEach(([x, z, ry, base], i) => a.kitBlock(kinds[i], x, z, ry, base, -140, undefined, undefined, 2));
    a.flushKit(false);
  }
  const signSpots: [number, number, number, number, number, number][] = [[0, 8, -26, 0, 12, 3], [-26, 2, -6, Math.PI / 2, 10, 2.6], [24, 12, 4, -Math.PI / 2, 9, 2.4], [-20, -4, 22, Math.PI, 11, 2.8], [22, 4, 24, Math.PI, 10, 2.6], [-22, 14, -22, Math.PI / 4, 8, 2.2], [26, -6, -20, -Math.PI / 4, 9, 2.4], [0, 20, 30, Math.PI, 14, 3.4]];
  signSpots.forEach(([x, y, z, ry, w, h], i) => { const [word, col] = nsigns[i % nsigns.length]; const sg = neonSign(word, col, w, h); sg.position.set(x, y, z); sg.rotation.y = ry; s.add(sg); });
  // Vertical neon tube strips on nearby corners.
  const tubes = new Map<number, THREE.BufferGeometry[]>();
  for (let i = 0; i < 14; i++) { const ang = Math.random() * Math.PI * 2, r = 24 + Math.random() * 16, c = [0xff4fd8, 0x4fe8ff, 0x9a6aff][i % 3]; const l = tubes.get(c) ?? []; l.push(boxG(0.18, 6 + Math.random() * 20, 0.18, Math.cos(ang) * r, -10 + Math.random() * 20, Math.sin(ang) * r)); tubes.set(c, l); }
  for (const [c, l] of tubes) merged(s, l, glow(c), false);
  a.buildCity(40, -140, 0x6a3a8a);
  a.cityB.flush(a.static);
  // Searchlight beams sweeping up from the district.
  lightShafts(a.static, [[-30, -10, -40], [36, -12, 20], [-10, -20, 44]], new THREE.Vector3(0.2, 1, 0.1), 0xb8a8ff, 0.06);
  a.ceiling = 14;
  a.spawns = [new THREE.Vector3(-4.5, 0, 0), new THREE.Vector3(4.5, 0, 0)];
}

// ====================================================================== dynamic pieces for the three venues
function beamsProp(a: Arena) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.6, metalness: 0.5 });
  for (let i = 0; i < 3; i++) for (const part of [[2.6, 0.04, 0.22, 0, 0.02], [2.6, 0.04, 0.22, 0, 0.22], [2.6, 0.2, 0.04, 0, 0.12]] as number[][]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(part[0], part[1], part[2]), m);
    b.position.set(0, part[4] + (i === 2 ? 0.25 : 0), (i === 2 ? 0 : i - 0.5) * 0.26);
    b.castShadow = true; addOutline(b, 1.04); g.add(b);
  }
  void a;
  return new Prop('beams', 1, g, new THREE.Vector3(1.3, 0.25, 0.4));
}
function lumberProp() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0xc89a5a, roughness: 0.85 });
  for (let l = 0; l < 3; l++) for (let i = 0; i < 4 - l; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 0.14), m); b.position.set(0, 0.05 + l * 0.1, (i - (3 - l) / 2) * 0.16); b.castShadow = true; addOutline(b, 1.05); g.add(b); }
  return new Prop('lumber', 0, g, new THREE.Vector3(0.9, 0.15, 0.32));
}
function cementProp() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0xc8c0b0, roughness: 0.95 });
  for (const [x, y, z, r] of [[-0.25, 0.12, 0, 0.1], [0.25, 0.12, 0.05, -0.1], [0, 0.34, 0.02, 0.05]]) { const b = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.22, 0.42, 2, 0.08), m); b.position.set(x, y, z); b.rotation.y = r; b.castShadow = true; addOutline(b, 1.05); g.add(b); }
  return new Prop('cement', 0, g, new THREE.Vector3(0.5, 0.23, 0.25));
}
function drumProp() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0xb02a1a, roughness: 0.45, metalness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.92, 16), m); body.position.y = 0.46; body.castShadow = true; addOutline(body, 1.04); g.add(body);
  for (const y of [0.18, 0.74]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.335, 0.025, 6, 20), m); r.rotation.x = Math.PI / 2; r.position.y = y; g.add(r); }
  const lbl = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.22, 16, 1, true, 0, 1.2), new THREE.MeshStandardMaterial({ color: 0xf0c020, roughness: 0.6 })); lbl.position.y = 0.46; g.add(lbl);
  return new Prop('drum', 1, g, new THREE.Vector3(0.33, 0.46, 0.33), true);
}

export function resetExtra(a: Arena) {
  const m = a.mats;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  const add = (p: Prop, x: number, z: number, ry = 0) => {
    p.pos.set(x, 0, z);
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = ry;
    if (Math.abs(Math.sin(ry)) > 0.7) p.half.set(p.half.z, p.half.y, p.half.x);
    p.updateSolid();
    a.props.push(p);
    a.dyn.add(p.mesh);
  };
  const wall = (c: THREE.Vector3, size: THREE.Vector3, out: THREE.Vector3, style: 'safety' | 'rail' | 'rim', h: number) => {
    const w = new WallSeg(c, size, out, m, style, h);
    a.walls.push(w);
    a.dyn.add(w.group);
  };
  const T = 0.4;
  if (a.layout === 'construction') {
    // Orange safety mesh around the whole floor: it gives way under heavy hits.
    for (const zs of [-1, 1]) for (let i = 0; i < 8; i++) wall(new THREE.Vector3(-HW + 2.125 + i * 4.25, 0, zs * (HD - T / 2)), new THREE.Vector3(4.25, 1.6, T), new THREE.Vector3(0, 0, zs), 'safety', 1.6);
    for (const xs of [-1, 1]) for (let i = 0; i < 4; i++) wall(new THREE.Vector3(xs * (HW - T / 2), 0, -HD + T + 2.7 + i * 5.3), new THREE.Vector3(T, 1.6, 5.3), new THREE.Vector3(xs, 0, 0), 'safety', 1.6);
    add(beamsProp(a), -9, -6.5, 0.2);
    add(beamsProp(a), 9.5, 6.8, -0.3);
    add(beamsProp(a), 1, -8.2, 0);
    add(lumberProp(), -12, 5, 0.4);
    add(lumberProp(), 3.5, 6.5, 1.2);
    add(cementProp(), -2, 3.5);
    add(cementProp(), 12, -1);
    add(a.makeTank(), -14, -6.5);
    add(a.makePallet(), 6.5, -5.5);
    add(a.makeBarrel(), -10.5, 8);
    add(a.makeBarrel(), 14.5, 4);
    add(a.makeCone(), -3, -9.6);
    add(a.makeCone(), 4.6, 9.6);
    add(a.makeWheelie(), 14.8, 9.2);
    return;
  }
  if (a.layout === 'docks') {
    // Pier railings over the water on both long sides; the ends are container walls.
    for (const zs of [-1, 1]) for (let i = 0; i < 10; i++) wall(new THREE.Vector3(-HW + 4 + i * 4, 0, zs * (HD - T / 2)), new THREE.Vector3(4, 1.6, T), new THREE.Vector3(0, 0, zs), 'rail', 1.6);
    add(drumProp(), -9, 3.5);
    add(drumProp(), -8.3, 4.3);
    add(drumProp(), 12, -2.5);
    add(a.makeCrate(), 5, 4.5);
    add(a.makeCrate(), 5.8, 3.8);
    add(a.makeCrate(), -14, -1.5);
    add(a.makePallet(), 9, 5);
    add(a.makePallet(), -16.5, 4.5);
    add(a.makeBarrel(), 16, 4.6);
    add(a.makeBarrel(), 2, -2.5);
    add(a.makeBarrier(), 14, -4.6);
    add(a.makeCar(0x3a5a7a), -16, -2.4, Math.PI / 2);
    add(a.makeWheelie(), 18, -5.4);
    return;
  }
  // Helipad: only short hazard rims on three sides; the rest of the edge is open sky.
  const R = SHAPE.circle;
  wall(new THREE.Vector3(0, 0, -(R - T / 2 - 0.2)), new THREE.Vector3(5, 0.7, T), new THREE.Vector3(0, 0, -1), 'rim', 0.7);
  wall(new THREE.Vector3(-(R - T / 2 - 0.2), 0, 0), new THREE.Vector3(T, 0.7, 5), new THREE.Vector3(-1, 0, 0), 'rim', 0.7);
  wall(new THREE.Vector3(R - T / 2 - 0.2, 0, 0), new THREE.Vector3(T, 0.7, 5), new THREE.Vector3(1, 0, 0), 'rim', 0.7);
  add(new Prop('crate', 0, buildCrate(), new THREE.Vector3(0.375, 0.375, 0.375)), -2.5, 5.5);
  add(a.makeCrate(), 3, -5.8);
  add(drumProp(), 6, 4.5);
  add(a.makeCone(), -6.5, -4.5);
  add(a.makeCone(), 1.5, 7.5);
  add(a.makeBin(), -7, 3.5);
}
