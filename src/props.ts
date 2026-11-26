import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { addOutline } from './rig';

// Higher-fidelity prop meshes: sculpted car bodies, slatted crates, grilled A/C units, ribbed barrels,
// rounded edges so corners catch the light. Each builder returns a Group sitting on y = 0.

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function part(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], rot?: [number, number, number], outline = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true;
  m.receiveShadow = true;
  if (outline) addOutline(m, outline);
  g.add(m);
  return m;
}

const cache: Record<string, any> = {};
function once<T>(k: string, f: () => T): T {
  if (!(k in cache)) cache[k] = f();
  return cache[k];
}

// ------------------------------------------------------------------ shared materials
const M = {
  tire: () => once('tire', () => new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 })),
  rim: () => once('rim', () => new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.25, metalness: 0.9 })),
  glass: () => once('glass', () => new THREE.MeshPhysicalMaterial({ color: 0x18242c, roughness: 0.05, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.88 })),
  trimDark: () => once('trimDark', () => new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6, metalness: 0.3 })),
  chrome: () => once('chrome', () => new THREE.MeshStandardMaterial({ color: 0xd0d4da, roughness: 0.15, metalness: 1 })),
  head: () => once('head', () => new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.2 })),
  tail: () => once('tail', () => new THREE.MeshStandardMaterial({ color: 0xa01010, emissive: 0xff2010, emissiveIntensity: 0.8 })),
  steel: () => once('steelP', () => new THREE.MeshStandardMaterial({ color: 0x8a9098, roughness: 0.4, metalness: 0.8 })),
};

// ------------------------------------------------------------------ car
function carBodyShape() {
  // Side profile (x = length, y = height) with wheel arches cut into the sill.
  const s = new THREE.Shape();
  s.moveTo(2.1, 0.32);
  s.lineTo(2.14, 0.62);
  s.quadraticCurveTo(2.1, 0.8, 1.85, 0.84);
  s.lineTo(0.85, 0.94);
  s.lineTo(-1.5, 0.98);
  s.quadraticCurveTo(-2.05, 0.96, -2.12, 0.78);
  s.lineTo(-2.14, 0.34);
  s.lineTo(-1.78, 0.3);
  s.absarc(-1.32, 0.3, 0.46, Math.PI, 0, true);
  s.lineTo(0.86, 0.3);
  s.absarc(1.32, 0.3, 0.46, Math.PI, 0, true);
  s.lineTo(2.1, 0.32);
  return s;
}
function cabinShape() {
  const s = new THREE.Shape();
  s.moveTo(0.82, 0.92);
  s.quadraticCurveTo(0.35, 1.32, 0.1, 1.42);
  s.lineTo(-0.95, 1.42);
  s.quadraticCurveTo(-1.3, 1.3, -1.5, 0.96);
  s.lineTo(0.82, 0.92);
  return s;
}

export function buildCar(color: number, burnt = false) {
  const g = new THREE.Group();
  const paint = burnt
    ? new THREE.MeshStandardMaterial({ color: 0x1e1b19, roughness: 0.95, metalness: 0.3 })
    : new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.12 });
  const width = 1.78;
  const bodyGeo = new THREE.ExtrudeGeometry(carBodyShape(), { depth: width - 0.16, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 3, curveSegments: 10 });
  bodyGeo.translate(0, 0, -(width - 0.16) / 2);
  bodyGeo.rotateY(-Math.PI / 2);
  part(g, bodyGeo, paint, [0, 0, 0], undefined, 1.015);
  const cabGeo = new THREE.ExtrudeGeometry(cabinShape(), { depth: width - 0.42, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 8 });
  cabGeo.translate(0, 0, -(width - 0.42) / 2);
  cabGeo.rotateY(-Math.PI / 2);
  part(g, cabGeo, burnt ? paint : M.glass(), [0, 0, 0], undefined, 1.02);
  if (!burnt) {
    // Roof skin and pillars in body colour over the glass.
    const roof = new THREE.BoxGeometry(width - 0.4, 0.05, 1.0);
    part(g, roof, paint, [0, 1.44, -0.42]);
    part(g, new THREE.BoxGeometry(width - 0.38, 0.5, 0.08), paint, [0, 1.17, -0.32]);
  }
  // Wheels: tyre, rim, hub.
  const tyre = once('tyreGeo', () => { const t = new THREE.CylinderGeometry(0.38, 0.38, 0.26, 22); t.rotateZ(Math.PI / 2); return t; });
  const rimG = once('rimGeo', () => { const t = new THREE.CylinderGeometry(0.24, 0.24, 0.27, 10); t.rotateZ(Math.PI / 2); return t; });
  for (const [x, z] of [[-0.82, 1.32], [0.82, 1.32], [-0.82, -1.32], [0.82, -1.32]]) {
    part(g, tyre, M.tire(), [x, 0.38, z]);
    if (!burnt) part(g, rimG, M.rim(), [x * 1.02, 0.38, z]);
  }
  // Bumpers, grille, lights.
  part(g, new RoundedBoxGeometry(width - 0.05, 0.2, 0.22, 2, 0.06), burnt ? paint : M.trimDark(), [0, 0.42, 2.12]);
  part(g, new RoundedBoxGeometry(width - 0.05, 0.2, 0.22, 2, 0.06), burnt ? paint : M.trimDark(), [0, 0.42, -2.12]);
  if (!burnt) {
    part(g, new THREE.BoxGeometry(0.8, 0.14, 0.05), M.trimDark(), [0, 0.66, 2.15]);
    for (const x of [-0.62, 0.62]) {
      part(g, new RoundedBoxGeometry(0.34, 0.13, 0.06, 2, 0.03), M.head(), [x, 0.68, 2.14]);
      part(g, new RoundedBoxGeometry(0.32, 0.12, 0.06, 2, 0.03), M.tail(), [x, 0.72, -2.15]);
      part(g, new THREE.BoxGeometry(0.06, 0.08, 0.16), M.trimDark(), [x * 1.52, 1.0, 0.75]); // mirrors
    }
    part(g, new THREE.BoxGeometry(0.4, 0.1, 0.04), M.chrome(), [0, 0.46, -2.24]); // plate
  } else {
    g.rotation.z = 0.04;
  }
  return g;
}

// ------------------------------------------------------------------ crate
export function buildCrate() {
  const g = new THREE.Group();
  const wood = once('crateMat', () => {
    const map = canvas(128, 128, (c) => {
      c.fillStyle = '#8a6a42'; c.fillRect(0, 0, 128, 128);
      for (let y = 0; y < 128; y += 32) { c.fillStyle = y % 64 ? '#7c5e3a' : '#94744a'; c.fillRect(0, y + 1, 128, 30); }
      c.strokeStyle = 'rgba(40,28,14,0.5)';
      for (let i = 0; i < 60; i++) { c.beginPath(); const y = Math.random() * 128; c.moveTo(0, y); c.bezierCurveTo(40, y + 3, 80, y - 3, 128, y + 1); c.stroke(); }
      c.fillStyle = '#5a4026'; c.fillRect(0, 0, 128, 10); c.fillRect(0, 118, 128, 10); c.fillRect(0, 0, 10, 128); c.fillRect(118, 0, 10, 128);
      c.save(); c.translate(64, 64); c.rotate(Math.PI / 4); c.fillRect(-90, -6, 180, 12); c.restore();
      c.fillStyle = '#2a2a2a'; for (const [x, y] of [[5, 5], [123, 5], [5, 123], [123, 123]]) c.fillRect(x - 2, y - 2, 4, 4);
    });
    return new THREE.MeshStandardMaterial({ map, roughness: 0.85, bumpMap: map, bumpScale: 1.5 });
  });
  part(g, new RoundedBoxGeometry(0.75, 0.75, 0.75, 2, 0.04), wood, [0, 0.375, 0], undefined, 1.04);
  return g;
}

// ------------------------------------------------------------------ A/C unit
export function buildAC() {
  const g = new THREE.Group();
  const shell = once('acShell', () => new THREE.MeshStandardMaterial({ color: 0xb4b8be, roughness: 0.45, metalness: 0.6 }));
  const grille = once('acGrille', () => {
    const map = canvas(128, 64, (c) => {
      c.fillStyle = '#2a2e34'; c.fillRect(0, 0, 128, 64);
      c.fillStyle = '#6a7078';
      for (let x = 2; x < 128; x += 5) c.fillRect(x, 0, 2, 64);
    });
    return new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.5, bumpMap: map, bumpScale: 2 });
  });
  part(g, new RoundedBoxGeometry(1.7, 1.2, 1.2, 3, 0.07), shell, [0, 0.6, 0], undefined, 1.03);
  part(g, new THREE.PlaneGeometry(1.4, 0.8), grille, [0, 0.62, 0.605]);
  part(g, new THREE.PlaneGeometry(1.0, 0.8), grille, [0.855, 0.62, 0], [0, Math.PI / 2, 0]);
  // Fan housing and blades on top.
  part(g, new THREE.CylinderGeometry(0.48, 0.48, 0.08, 24), M.trimDark(), [0.1, 1.22, 0]);
  const blades = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.12), M.steel());
    b.position.x = 0.2;
    b.rotation.x = 0.4;
    const holder = new THREE.Group();
    holder.rotation.y = (i * Math.PI) / 2;
    holder.add(b);
    blades.add(holder);
  }
  blades.position.set(0.1, 1.27, 0);
  g.add(blades);
  part(g, new THREE.TorusGeometry(0.47, 0.025, 6, 24), M.steel(), [0.1, 1.3, 0], [Math.PI / 2, 0, 0]);
  // Pipe stubs.
  part(g, new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), M.chrome(), [-0.7, 0.3, -0.62], [Math.PI / 2, 0, 0]);
  part(g, new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8), M.chrome(), [-0.55, 0.3, -0.62], [Math.PI / 2, 0, 0]);
  return g;
}

// ------------------------------------------------------------------ barrel
export function buildBarrel(color = 0x2f6a9a) {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  const H = 0.95, R = 0.34;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const rib = Math.exp(-Math.pow((t - 0.3) / 0.025, 2)) + Math.exp(-Math.pow((t - 0.7) / 0.025, 2));
    const r = R * (1 + 0.025 * Math.sin(t * Math.PI)) + rib * 0.018;
    pts.push(new THREE.Vector2(t === 0 || t === 1 ? R * 0.96 : r, t * H));
  }
  pts.unshift(new THREE.Vector2(0.001, 0.01));
  pts.push(new THREE.Vector2(0.001, H - 0.01));
  const label = once('barrelLabel' + color, () => {
    const map = canvas(256, 64, (c) => {
      c.fillStyle = '#' + color.toString(16).padStart(6, '0'); c.fillRect(0, 0, 256, 64);
      c.fillStyle = 'rgba(0,0,0,0.18)'; for (let i = 0; i < 200; i++) c.fillRect(Math.random() * 256, Math.random() * 64, 3, 1);
      c.fillStyle = '#f0c020'; c.fillRect(100, 22, 56, 22);
      c.fillStyle = '#111'; c.font = 'bold 14px Arial'; c.textAlign = 'center'; c.fillText('⚠ 55', 128, 38);
      c.fillStyle = 'rgba(90,40,20,0.35)'; for (let i = 0; i < 25; i++) c.fillRect(Math.random() * 256, 50 + Math.random() * 14, 6, 3);
    });
    return new THREE.MeshStandardMaterial({ map, roughness: 0.5, metalness: 0.5 });
  });
  part(g, new THREE.LatheGeometry(pts, 28), label, [0, 0, 0], undefined, 1.05);
  part(g, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8), M.steel(), [0.15, H + 0.01, 0.05]);
  return g;
}

// ------------------------------------------------------------------ fuel tank (heavy)
export function buildTank(bodyMat: THREE.Material, stripeMat: THREE.Material) {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, 0)];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(0.55 + Math.sin(a) * 0.15, 0.15 - Math.cos(a) * 0.15)); }
  pts.push(new THREE.Vector2(0.7, 1.55));
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(0.55 + Math.cos(a) * 0.15, 1.55 + Math.sin(a) * 0.15)); }
  pts.push(new THREE.Vector2(0.001, 1.72));
  part(g, new THREE.LatheGeometry(pts, 24), bodyMat, [0, 0, 0], undefined, 1.04);
  for (const y of [0.35, 1.35]) part(g, new THREE.CylinderGeometry(0.715, 0.715, 0.14, 24, 1, true), stripeMat, [0, y, 0]);
  part(g, new THREE.CylinderGeometry(0.13, 0.13, 0.2, 10), M.steel(), [0, 1.8, 0]);
  part(g, new THREE.TorusGeometry(0.12, 0.03, 6, 12), M.steel(), [0, 1.92, 0], [Math.PI / 2, 0, 0]);
  part(g, new THREE.BoxGeometry(0.12, 0.25, 0.12), M.steel(), [0.55, 1.2, 0.3]);
  return g;
}

// ------------------------------------------------------------------ jersey barrier
export function buildBarrier(mat: THREE.Material) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.4, 0); shape.lineTo(0.4, 0); shape.lineTo(0.2, 0.32); shape.lineTo(0.12, 0.9); shape.lineTo(-0.12, 0.9); shape.lineTo(-0.2, 0.32); shape.lineTo(-0.4, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2 });
  geo.translate(0, 0, -1.05);
  geo.rotateY(Math.PI / 2);
  part(g, geo, mat, [0, 0, 0], undefined, 1.03);
  // Reflector strip and lifting slots.
  const refl = once('reflector', () => new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x804000, emissiveIntensity: 0.5 }));
  part(g, new THREE.BoxGeometry(1.6, 0.08, 0.02), refl, [0, 0.62, 0.15], [0.17, 0, 0]);
  part(g, new THREE.BoxGeometry(1.6, 0.08, 0.02), refl, [0, 0.62, -0.15], [-0.17, 0, 0]);
  return g;
}
