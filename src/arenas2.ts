import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Arena } from './arena';
import { BOUNDS, Prop, WallSeg } from './arena';
import { addOutline } from './rig';
import { lightShafts } from './city';
import { hasCityKit, KitBuilding } from './citykit';

// Skyline Site (an unfinished skyscraper floor), plus small builders shared with arenas3.ts. Reuses the arena
// systems (breakable wall segments, props, anchors, cling solids).

type Box = [number, number, number, number, number, number, number?];

export function tex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}
export const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
export const glow = (color: number) => new THREE.MeshBasicMaterial({ color });

/** Merge a list of meshes' geometries (already positioned) into one mesh per material. */
export function merged(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mat: THREE.Material, shadow = true) {
  if (!geos.length) return null;
  const m = new THREE.Mesh(mergeGeometries(geos), mat);
  m.castShadow = shadow; m.receiveShadow = true;
  parent.add(m);
  return m;
}
export const boxG = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};
export const cylG = (r0: number, r1: number, h: number, x: number, y: number, z: number, seg = 10, rx = 0, rz = 0) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
};

/** A neon sign: glowing text on a dark backing, optional frame tube. */
export function neonSign(word: string, color: string, w: number, h: number) {
  const t = tex(512, 128, (g) => {
    g.fillStyle = '#07060c'; g.fillRect(0, 0, 512, 128);
    g.font = 'bold 84px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color; g.shadowBlur = 26; g.fillStyle = color; g.fillText(word, 256, 68);
    g.shadowBlur = 8; g.fillStyle = '#ffffff'; g.globalAlpha = 0.55; g.fillText(word, 256, 68); g.globalAlpha = 1;
    g.strokeStyle = color; g.lineWidth = 5; g.shadowBlur = 16; g.strokeRect(10, 10, 492, 108);
  });
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.25), std({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.85, roughness: 0.6 }));
}

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
  const wall = (c: THREE.Vector3, size: THREE.Vector3, out: THREE.Vector3, style: 'safety', h: number) => {
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
}
