import * as THREE from 'three';
import type { Rig } from './rig';
import { addOutline } from './rig';
import type { SkinnedBody, BodyLook } from './skinned';
import { finishMaterial } from './characters';

// Character designs for the rigged bodies: each fighter's mannequin is vertex-painted into skin,
// clothes, fur or stone (see Paint in skinned.ts) and dressed with bone-attached pieces: hair, hoods,
// capes, tails, horns, armour and faces. Moving cloth (scarves, capes, tails, coat tails) sways on its own.

type Adorn = (b: SkinnedBody, rig: Rig) => THREE.MeshStandardMaterial[];
type V3 = [number, number, number];

/** Standard material with the shared rim light. */
function M(color: number, rough = 0.6, metal = 0.05, emissive = 0x000000, ei = 0, side: THREE.Side = THREE.FrontSide) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei, side });
  finishMaterial(m, 'body');
  return m;
}
/** A positioned mesh, outlined unless it is a glow or tiny detail. */
function G(geo: THREE.BufferGeometry, m: THREE.Material, pos: V3, rot?: V3, scl?: V3, outline = true) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(...pos);
  if (rot) o.rotation.set(...rot);
  if (scl) o.scale.set(...scl);
  o.castShadow = true;
  if (outline) addOutline(o, 1.05);
  return o;
}
const sph = (r: number, ws = 14, hs = 10) => new THREE.SphereGeometry(r, ws, hs);
const boxG = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cone = (r: number, h: number, s = 8) => new THREE.ConeGeometry(r, h, s);
const cyl = (r0: number, r1: number, h: number, s = 12, open = false) => new THREE.CylinderGeometry(r0, r1, h, s, 1, open);
const torus = (r: number, t: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, 8, 24, arc);
/** A cap of a sphere: phi range around Y, theta from the top. */
const shell = (r: number, phiStart: number, phiLen: number, thetaLen: number) => new THREE.SphereGeometry(r, 18, 12, phiStart, phiLen, 0, thetaLen);
/** Flared skirt / coat tails: a curved lathe, optionally split open at the front (radians). */
function skirt(rTop: number, rBot: number, len: number, open = 0, depth = 0.9) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(rTop + (rBot - rTop) * Math.pow(t, 0.75), -t * len)); }
  const g = new THREE.LatheGeometry(pts, 22, open / 2, Math.PI * 2 - open);
  g.scale(1, 1, depth);
  return g;
}
/** Horn: a cone bent by stacking. */
function horn(m: THREE.Material, len: number, r: number, bend: number) {
  const g = new THREE.Group();
  let y = 0, z = 0, a = 0;
  for (let i = 0; i < 3; i++) {
    const l = len / 3, rr = r * (1 - i / 3);
    const c = new THREE.Mesh(cyl(rr * 0.7, rr, l, 8), m);
    c.castShadow = true;
    c.position.set(0, y + Math.cos(a) * l / 2, z - Math.sin(a) * l / 2);
    c.rotation.x = -a;
    g.add(c);
    y += Math.cos(a) * l; z -= Math.sin(a) * l;
    a += bend;
  }
  const tip = new THREE.Mesh(cone(r * 0.25, len * 0.25, 8), m);
  tip.position.set(0, y + Math.cos(a) * len * 0.12, z - Math.sin(a) * len * 0.12);
  tip.rotation.x = -a;
  g.add(tip);
  return g;
}

/** A pivoted chain of segments that sways over time (tails, scarves, hair, capes). */
function swayChain(segs: THREE.Mesh[], len: number, opts: { base: V3; amp: number; speed: number; droop?: number; side?: number; phase?: number }) {
  const root = new THREE.Group();
  let parent: THREE.Object3D = root;
  const pivots: THREE.Group[] = [];
  segs.forEach((s, i) => {
    const p = new THREE.Group();
    if (i > 0) p.position.y = -len;
    s.position.y = -len / 2;
    p.add(s);
    parent.add(p);
    parent = p;
    pivots.push(p);
  });
  root.rotation.set(...opts.base);
  const ph = opts.phase ?? Math.random() * 6;
  segs[0].onBeforeRender = () => {
    const t = performance.now() / 1000;
    pivots.forEach((p, i) => {
      p.rotation.x = (opts.droop ?? 0.12) + Math.sin(t * opts.speed - i * 0.7 + ph) * opts.amp * (0.5 + i * 0.25);
      p.rotation.z = Math.sin(t * opts.speed * 0.7 - i * 0.9 + ph) * opts.amp * 0.6 * (opts.side ?? 1);
    });
  };
  return root;
}

/** Head pieces are authored for a 1.95 m fighter's head (centre y 0.135, half-size 0.09 x 0.145 x 0.12) and scaled per fighter. */
const heads = new WeakMap<SkinnedBody, THREE.Group>();
function HA(b: SkinnedBody, obj: THREE.Object3D) {
  let g = heads.get(b);
  if (!g) {
    g = new THREE.Group();
    const hy = b.look.height / 1.95, hx = hy * b.look.bulk / 0.98;
    g.scale.set(hx, hy, hx);
    b.attach('head', g);
    heads.set(b, g);
  }
  g.add(obj);
}

/** Simple readable face on the head bone: eyes, brows, optional mouth. */
function face(b: SkinnedBody, o: { eye: number; eyeGlow?: number; brow?: number; mouth?: number; y?: number; z?: number; spread?: number; slant?: number; eyeScale?: V3 }) {
  const y = o.y ?? 0.165, z = o.z ?? 0.116, sx = o.spread ?? 0.036;
  const eyeM = o.eyeGlow ? M(o.eye, 0.3, 0, o.eye, o.eyeGlow) : M(o.eye, 0.25, 0.1);
  for (const s of [-1, 1]) {
    HA(b, G(sph(0.013, 10, 8), eyeM, [s * sx, y, z], [0, 0, s * (o.slant ?? 0)], o.eyeScale ?? [1.4, 0.8, 0.6], false));
    if (o.brow !== undefined) HA(b, G(boxG(0.034, 0.008, 0.012), M(o.brow, 0.8), [s * sx, y + 0.024, z - 0.002], [0, 0, -s * 0.18], undefined, false));
  }
  if (o.mouth !== undefined) HA(b, G(boxG(0.03, 0.006, 0.01), M(o.mouth, 0.7), [0, y - 0.075, z - 0.008], undefined, undefined, false));
  return eyeM;
}

// ------------------------------------------------------------------ BASALT — living rock golem
const basaltLook: BodyLook = {
  height: 2.5, bulk: 1.22, body: 0x5a5f66, joints: 0xff5a1a, jointGlow: 0.9, bodyRough: 0.95, bodyMetal: 0.02,
  paint: {
    skin: 0x5d636a, hair: 0x4a5058, top: 0x555b63, chest: 0x666c72, upper: 0x4f555d, sleeve: 0x5a6068, hands: 0x474d55,
    pants: 0x4c5259, calf: 0x555b62, boots: 0x3d4249,
    detail: { kind: 'stone', amount: 0.55 },
    cracks: { color: 0xff5010, amount: 2.2, scale: 6.5, width: 0.05 },
  },
};
const basaltAdorn: Adorn = (b) => {
  const rock = M(0x5c626a, 0.95, 0.02), rock2 = M(0x42474f, 0.95, 0.02), moss = M(0x4f6a2a, 1, 0);
  const magma = M(0xff5a1a, 0.4, 0, 0xff4a10, 1.8);
  const D = (r: number) => new THREE.DodecahedronGeometry(r, 0);
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, G(D(0.3), rock2, [sx * 0.02, 0.04, 0], [0.4, 0.3, 0.2], [1.35, 0.95, 1.15]));
    b.attach(j, G(D(0.11), moss, [sx * 0.02, 0.24, -0.02], [0.2, 0.5, 0], [1.6, 0.45, 1.4], false));
  }
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, G(new THREE.BoxGeometry(0.3, 0.4, 0.3), rock2, [0, -0.22, 0.02], [0.1, 0.3, 0.05]));
    // Huge fists: a boulder with knuckle stones.
    b.attach(j, G(D(0.22), rock, [0, -0.6, 0.04], [0.5, 0.2, 0.3], [1.15, 0.95, 1.15]));
    for (const dx of [-0.08, 0, 0.08]) b.attach(j, G(D(0.06), rock2, [dx, -0.72, 0.14], [dx * 9, 0.4, 0]));
  }
  b.attach('spine', G(new THREE.BoxGeometry(0.75, 0.5, 0.2), rock2, [0, 0.05, 0.2], [0.1, 0, 0]));
  b.attach('spine', G(new THREE.CircleGeometry(0.09, 6), magma, [0, 0.02, 0.305], undefined, undefined, false));
  for (const [x, y] of [[0.2, 0.1], [-0.22, 0.0], [0, -0.2]]) b.attach('spine', G(D(0.2), rock, [x, y, -0.22], [x, y, 0.4], [1.2, 0.9, 0.8]));
  b.attach('spine', G(D(0.16), moss, [-0.18, 0.2, -0.3], [0.5, 0.2, 0], [1.4, 0.35, 1.2], false));
  b.attach('spine', G(D(0.22), rock, [0, 0.3, 0.12], [0.2, 0.6, 0], [1.4, 0.8, 1]));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(new THREE.BoxGeometry(0.28, 0.4, 0.22), rock2, [0, -0.2, 0.08], [0.1, 0, 0]));
  for (const j of ['lThigh', 'rThigh'] as const) { b.attach(j, G(D(0.2), rock, [0, -0.15, 0.06], [0.3, 0.5, 0.1], [1.1, 1.3, 1])); b.attach(j, G(D(0.16), rock2, [0, -0.38, 0.05], [1.2, 0.2, 0.4])); }
  b.attach('hips', G(new THREE.BoxGeometry(0.62, 0.22, 0.4), rock2, [0, 0.02, 0], [0, 0.1, 0]));
  // Head: heavy brow ridge over glowing eyes, a jaw slab and a mossy crown.
  HA(b, G(D(0.12), rock, [0, 0.15, -0.01], [0.3, 0.2, 0], [1.0, 1.25, 1.1]));
  HA(b, G(new THREE.BoxGeometry(0.24, 0.06, 0.1), rock2, [0, 0.21, 0.085], [-0.25, 0, 0]));
  HA(b, G(new THREE.BoxGeometry(0.18, 0.07, 0.1), rock2, [0, 0.06, 0.07], [0.15, 0, 0]));
  HA(b, G(D(0.08), moss, [0.02, 0.28, -0.02], [0, 0.3, 0], [1.4, 0.4, 1.3], false));
  const eyes = face(b, { eye: 0xff7a20, eyeGlow: 2.6, y: 0.17, z: 0.128, spread: 0.045, eyeScale: [1.6, 0.6, 0.5] });
  return [magma, eyes, b.jointMat];
};

// ------------------------------------------------------------------ TETHER — human acrobat vigilante
const tetherLook: BodyLook = {
  height: 1.95, bulk: 0.98, body: 0x109c8e, joints: 0x14161c, jointGlow: 0, bodyRough: 0.55, bodyMetal: 0.05,
  paint: {
    skin: 0xc68a64, hair: 0x2a1c14, hairline: 0.8, mask: { color: 0x10161a, from: 0.5, to: 0.8 },
    top: 0x13a090, chest: 0x0c6f66, stripe: 0x0a2a2c, upper: 0x13a090, sleeve: 0x13a090, hands: 0x16181e,
    belt: 0x4a3018, pants: 0x0e7a70, calf: 0x16181e, boots: 0x1a1c22,
    detail: { kind: 'cloth', amount: 0.18 },
  },
};
const tetherAdorn: Adorn = (b) => {
  const gold = M(0xe8b520, 0.3, 0.8, 0x6a4800, 0.3), dark = M(0x15181e, 0.5, 0.2), leather = M(0x5a3a1c, 0.8);
  const lens = M(0xd8fbff, 0.15, 0, 0x8ff2ff, 1.3), hair = M(0x2a1c14, 0.9), scarf = M(0xd8452a, 0.85, 0, 0, 0, THREE.DoubleSide);
  // Line shooters on the wrists.
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, G(boxG(0.1, 0.13, 0.12), gold, [0, -0.2, 0.05]));
    b.attach(j, G(cyl(0.022, 0.026, 0.12, 8), dark, [0, -0.25, 0.12], [Math.PI / 2, 0, 0], undefined, false));
  }
  // Goggles over the half mask, strap, messy hair.
  for (const s of [-1, 1]) {
    HA(b, G(cyl(0.027, 0.027, 0.03, 14), dark, [s * 0.037, 0.168, 0.112], [Math.PI / 2, 0, 0], undefined, false));
    HA(b, G(new THREE.CircleGeometry(0.021, 14), lens, [s * 0.037, 0.168, 0.128], undefined, undefined, false));
  }
  HA(b, G(torus(0.1, 0.007), dark, [0, 0.168, 0.0], [Math.PI / 2, 0, 0], [0.95, 1.25, 1], false));
  HA(b, G(sph(0.1, 14, 10), hair, [0, 0.185, -0.018], undefined, [0.98, 0.98, 1.15]));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.2;
    HA(b, G(cone(0.032, 0.1, 6), hair, [Math.sin(a) * 0.065, 0.27, Math.cos(a) * 0.04 - 0.02], [-0.6 + Math.cos(a) * 0.3, 0, -a * 0.5], undefined, false));
  }
  face(b, { eye: 0x1a1410, mouth: 0x6a3a2a });
  // Scarf round the neck with trailing tails.
  b.attach('spine', G(torus(0.1, 0.035), scarf, [0, 0.3, 0.0], [Math.PI / 2 - 0.15, 0, 0], [1.1, 1, 1]));
  const segs = [0, 1, 2, 3].map((i) => new THREE.Mesh(boxG(0.09 - i * 0.012, 0.16, 0.015), scarf));
  segs.forEach((m) => { m.castShadow = true; });
  const sc = swayChain(segs, 0.15, { base: [0.5, 0, 0.25], amp: 0.22, speed: 5, droop: 0.15 });
  sc.position.set(0.05, 0.28, -0.1);
  b.attach('spine', sc);
  // Utility belt with pouches, emblem, knee pads.
  b.attach('hips', G(boxG(0.36, 0.06, 0.25), leather, [0, 0.04, 0]));
  for (const x of [-0.14, -0.05, 0.05, 0.14]) b.attach('hips', G(boxG(0.055, 0.07, 0.045), leather, [x, 0.02, 0.13]));
  b.attach('hips', G(boxG(0.06, 0.05, 0.02), gold, [0, 0.04, 0.135], undefined, undefined, false));
  const em = new THREE.Mesh(torus(0.07, 0.014, Math.PI * 1.4), gold);
  em.position.set(0, 0.05, 0.16); em.rotation.z = -0.6;
  b.attach('spine', em);
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(sph(0.07, 10, 8), dark, [0, 0.0, 0.07], undefined, [1, 1, 0.6]));
  return [lens, gold];
};

// ------------------------------------------------------------------ AERIN VOLT — storm sorceress
const aerinLook: BodyLook = {
  female: true, height: 1.95, bulk: 0.96, body: 0xe6e4f2, joints: 0x8a4cff, jointGlow: 0, bodyRough: 0.5, bodyMetal: 0.05,
  paint: {
    skin: 0xecc6a8, hair: 0xf2f0ff, top: 0x3a1f5c, chest: 0x5a3290, upper: 0x3a1f5c, sleeve: 0xecc6a8, hands: 0xecc6a8,
    belt: 0x1e1030, pants: 0x2a1844, calf: 0x1a1024, boots: 0x140c1c, stripe: 0x7a4ac0,
    detail: { kind: 'cloth', amount: 0.14 },
    cracks: { color: 0xa070ff, amount: 1.4, scale: 7, width: 0.028, regions: ['fore', 'neck'] },
  },
};
const aerinAdorn: Adorn = (b, rig) => {
  const hair = M(0xf2f0ff, 0.65, 0.05), coat = M(0x3a1f5c, 0.7, 0.05, 0, 0, THREE.DoubleSide), trim = M(0xc9a8ff, 0.4, 0.4);
  const glow = M(0xc9a8ff, 0.2, 0, 0xa070ff, 1.6);
  // Hair: cap, fringe, side locks and a long swinging ponytail.
  HA(b, G(sph(0.1, 16, 12), hair, [0, 0.185, -0.02], undefined, [1.0, 1.0, 1.18]));
  HA(b, G(boxG(0.17, 0.035, 0.05), hair, [0, 0.245, 0.09], [0.6, 0, 0]));
  for (const s of [-1, 1]) HA(b, G(boxG(0.03, 0.17, 0.045), hair, [s * 0.088, 0.12, 0.035], [0, 0, s * 0.06]));
  const pony = [0, 1, 2, 3].map((i) => new THREE.Mesh(cyl(0.045 - i * 0.008, 0.05 - i * 0.008, 0.14, 8), hair));
  pony.forEach((m) => { m.castShadow = true; });
  const pc = swayChain(pony, 0.13, { base: [0.9, 0, 0], amp: 0.18, speed: 4, droop: 0.2 });
  pc.position.set(0, 0.24, -0.12);
  HA(b, pc);
  HA(b, G(torus(0.026, 0.01), trim, [0, 0.24, -0.118], [0.4, 0, 0], undefined, false));
  // Glowing circlet and face.
  HA(b, G(torus(0.1, 0.006, Math.PI), glow, [0, 0.215, 0.0], [Math.PI / 2 + 0.2, 0, 0], [0.97, 1.26, 1], false));
  face(b, { eye: 0x7a50d0, eyeGlow: 0.6, brow: 0xd8d4f0, mouth: 0xb06070 });
  // Coat: high collar, open coat tails, shoulder trim.
  b.attach('spine', G(cyl(0.1, 0.14, 0.12, 14, true), coat, [0, 0.33, -0.01], [-0.1, 0, 0], undefined, false));
  b.attach('hips', G(skirt(0.17, 0.33, 0.62, 1.9), coat, [0, 0.06, -0.01], undefined, undefined, false));
  b.attach('hips', G(boxG(0.34, 0.05, 0.24), glow, [0, 0.05, 0], undefined, undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) b.attach(j, G(sph(0.1, 12, 8), coat, [sx * 0.02, 0.0, 0], undefined, [1.15, 0.7, 1.15]));
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, G(torus(0.055, 0.012), trim, [0, -0.22, 0], [Math.PI / 2, 0, 0], undefined, false));
  // Wings (shimmer driven by the fighter).
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0); wingShape.lineTo(1.15, 0.55); wingShape.lineTo(0.95, -0.15); wingShape.lineTo(1.25, -0.65); wingShape.lineTo(0.15, -0.35); wingShape.lineTo(0, 0);
  const wingGeo = new THREE.ShapeGeometry(wingShape);
  wingGeo.rotateY(1.4); // swept back once the fighter angles them
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const lw = new THREE.Mesh(wingGeo, wingMat);
  lw.position.set(0.08, 0.1, -0.16); lw.scale.setScalar(0.72);
  const rw = new THREE.Mesh(wingGeo, wingMat);
  rw.scale.set(-0.72, 0.72, 0.72); rw.position.set(-0.08, 0.1, -0.16);
  b.attach('spine', lw); b.attach('spine', rw);
  (rig as any).wings = [lw, rw];
  return [glow];
};

// ------------------------------------------------------------------ SHUNT — hooded operative
const shuntLook: BodyLook = {
  height: 2.0, bulk: 1.02, body: 0x2b303c, joints: 0x37f2ff, jointGlow: 0, bodyRough: 0.75, bodyMetal: 0.1,
  paint: {
    skin: 0xa8785a, hair: 0x1a1a1e, top: 0x2f3541, chest: 0x1c2028, upper: 0x2f3541, sleeve: 0x2f3541, hands: 0x111318,
    belt: 0x0e0f12, pants: 0x1c1f27, calf: 0x111318, boots: 0x0f1014, stripe: 0x1d5e66,
    detail: { kind: 'cloth', amount: 0.2 },
  },
};
const shuntAdorn: Adorn = (b) => {
  const coat = M(0x2f3541, 0.8, 0.05, 0, 0, THREE.DoubleSide), cyan = M(0x37f2ff, 0.2, 0, 0x20e0ff, 1.5);
  const plate = M(0x9aa4b0, 0.4, 0.6), dark = M(0x15181e, 0.6, 0.3);
  // Hood (open at the front), visor band across the eyes, cloth mask over the mouth.
  HA(b, G(shell(0.13, Math.PI * 0.72, Math.PI * 1.56, Math.PI * 0.66), coat, [0, 0.15, -0.012], undefined, [0.92, 1.18, 1.02]));
  HA(b, G(torus(0.12, 0.018, Math.PI), coat, [0, 0.15, 0.03], [0.15, 0, 0], [0.92, 1.25, 1], false));
  HA(b, G(boxG(0.15, 0.026, 0.03), cyan, [0, 0.168, 0.115], undefined, undefined, false));
  HA(b, G(sph(0.082, 12, 8), dark, [0, 0.085, 0.04], undefined, [1.05, 0.75, 0.95], false));
  // Long coat: skirt, collar, shoulder plates, backpack displacement core.
  b.attach('hips', G(skirt(0.19, 0.4, 0.9, 1.1), coat, [0, 0.08, -0.01], undefined, undefined, false));
  b.attach('spine', G(cyl(0.12, 0.17, 0.14, 14, true), coat, [0, 0.3, -0.02], [-0.15, 0, 0], undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, G(boxG(0.2, 0.07, 0.22), plate, [sx * 0.03, 0.03, 0], [0, 0, sx * 0.35]));
    b.attach(j, G(boxG(0.12, 0.02, 0.18), cyan, [sx * 0.07, 0.075, 0], [0, 0, sx * 0.35], undefined, false));
  }
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, G(boxG(0.1, 0.16, 0.11), dark, [0, -0.2, 0.01]));
  b.attach('spine', G(boxG(0.3, 0.38, 0.14), dark, [0, 0, -0.2]));
  b.attach('spine', G(sph(0.07, 10, 8), cyan, [0, 0, -0.28], undefined, undefined, false));
  for (const y of [-0.12, 0.12]) b.attach('spine', G(boxG(0.24, 0.015, 0.015), cyan, [0, y, -0.275], undefined, undefined, false));
  b.attach('hips', G(boxG(0.38, 0.05, 0.27), dark, [0, 0.05, 0]));
  b.attach('hips', G(boxG(0.07, 0.1, 0.05), dark, [0.16, -0.06, 0.1]));
  return [cyan];
};

// ------------------------------------------------------------------ VANTA — feline beast-woman
const vantaLook: BodyLook = {
  female: true, height: 1.85, bulk: 0.95, body: 0x2a2228, joints: 0xe8c040, jointGlow: 0, bodyRough: 0.9, bodyMetal: 0,
  paint: {
    skin: 0x4a3e44, hair: 0x18121a, top: 0x2e262c, chest: 0x3a3036, upper: 0x2e262c, sleeve: 0x2e262c, hands: 0x18121a,
    pants: 0x2e262c, calf: 0x282026, boots: 0x18121a, stripe: 0x1e181e,
    detail: { kind: 'fur', amount: 0.55 },
  },
};
const vantaAdorn: Adorn = (b) => {
  const fur = M(0x2e262c, 0.95), mane = M(0x18121a, 0.95), pink = M(0xa05a6a, 0.8);
  const gold = M(0xe8c040, 0.25, 0.85, 0x6a4800, 0.4), blade = M(0xe8e4d8, 0.2, 0.9);
  // Cat ears, mane, glowing eyes, muzzle.
  for (const s of [-1, 1]) {
    HA(b, G(cone(0.055, 0.13, 4), fur, [s * 0.062, 0.3, -0.01], [-0.15, Math.PI / 4, s * -0.35]));
    HA(b, G(cone(0.03, 0.085, 4), pink, [s * 0.06, 0.295, 0.01], [-0.15, Math.PI / 4, s * -0.35], undefined, false));
  }
  HA(b, G(sph(0.1, 14, 10), mane, [0, 0.18, -0.03], undefined, [1.02, 1.0, 1.12]));
  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 2.6;
    HA(b, G(cone(0.045, 0.2, 5), mane, [Math.sin(a) * 0.08, 0.12 - Math.abs(a) * 0.02, -0.08 - Math.cos(a) * 0.035], [-2.4 + Math.abs(a) * 0.2, 0, a * 0.4]));
  }
  HA(b, G(sph(0.04, 10, 8), M(0x4a3a40, 0.9), [0, 0.11, 0.1], undefined, [1.1, 0.75, 0.8], false));
  HA(b, G(cone(0.012, 0.02, 3), M(0x1a1016, 0.5), [0, 0.125, 0.138], [Math.PI / 2 + 0.4, 0, Math.PI], undefined, false));
  const eyes = face(b, { eye: 0xffd040, eyeGlow: 2.2, spread: 0.038, slant: 0.35, eyeScale: [1.7, 0.75, 0.5] });
  // Tail from the base of the spine.
  const tail = [0, 1, 2, 3, 4, 5].map((i) => new THREE.Mesh(cyl(0.032 - i * 0.003, 0.036 - i * 0.003, 0.15, 8), i === 5 ? mane : fur));
  tail.forEach((m) => { m.castShadow = true; });
  const tc = swayChain(tail, 0.14, { base: [2.2, 0, 0], amp: 0.28, speed: 2.6, droop: -0.18, side: 1.4 });
  tc.position.set(0, -0.02, -0.14);
  b.attach('hips', tc);
  // Gold claws, bracers, collar.
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, G(cyl(0.055, 0.05, 0.12, 10), gold, [0, -0.17, 0.0]));
    for (const dx of [-0.035, 0, 0.035]) b.attach(j, G(cone(0.014, 0.2, 5), blade, [dx, -0.38, 0.06], [Math.PI - 0.25, 0, 0], undefined, false));
  }
  b.attach('spine', G(torus(0.09, 0.014), gold, [0, 0.3, 0.0], [Math.PI / 2 - 0.2, 0, 0], undefined, false));
  b.attach('spine', G(cone(0.025, 0.05, 4), gold, [0, 0.24, 0.1], [Math.PI, 0, 0], undefined, false));
  for (const sx of [-1, 1]) b.attach('spine', G(boxG(0.035, 0.42, 0.012), gold, [sx * 0.05, 0.06, 0.135], [0.1, 0, sx * 0.42], undefined, false));
  b.attach('spine', G(boxG(0.2, 0.05, 0.16), M(0x18121a, 0.6), [0, -0.05, 0.06], undefined, [1, 1, 1], false));
  b.attach('hips', G(boxG(0.32, 0.05, 0.22), gold, [0, 0.03, 0], undefined, undefined, false));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(torus(0.05, 0.01), gold, [0, -0.36, 0], [Math.PI / 2, 0, 0], undefined, false));
  return [eyes, gold];
};

// ------------------------------------------------------------------ MAGNA — magnetic master (human)
const magnaLook: BodyLook = {
  height: 2.0, bulk: 1.05, body: 0x9aa2ac, joints: 0xd02040, jointGlow: 0, bodyRough: 0.6, bodyMetal: 0.1,
  paint: {
    skin: 0xd0a080, hair: 0x6a5a50, top: 0x6a1424, chest: 0x2a2a32, upper: 0x6a1424, sleeve: 0x2a2a32, hands: 0x7a1a28,
    belt: 0x24242c, pants: 0x2a2a32, calf: 0x7a1a28, boots: 0x6a1622,
    detail: { kind: 'cloth', amount: 0.16 },
  },
};
const magnaAdorn: Adorn = (b, rig) => {
  const red = M(0xa01a2c, 0.45, 0.4), steel = M(0xc8ced6, 0.22, 0.95), cape = M(0x8a1222, 0.85, 0, 0, 0, THREE.DoubleSide);
  const capeIn = M(0x3a0a12, 0.9, 0, 0, 0, THREE.DoubleSide);
  // Helmet: crown, crest fin, cheek guards, open face.
  HA(b, G(shell(0.11, 0, Math.PI * 2, Math.PI * 0.5), red, [0, 0.17, -0.01], undefined, [0.95, 1.12, 1.18]));
  HA(b, G(boxG(0.025, 0.08, 0.22), red, [0, 0.29, -0.03], [0.2, 0, 0]));
  for (const s of [-1, 1]) {
    HA(b, G(boxG(0.022, 0.1, 0.09), red, [s * 0.095, 0.13, 0.03], [0, s * 0.2, 0]));
    HA(b, G(cone(0.025, 0.09, 4), steel, [s * 0.105, 0.23, 0.0], [0, 0, -s * 1.1], undefined, false));
  }
  HA(b, G(boxG(0.16, 0.018, 0.03), steel, [0, 0.205, 0.115], [-0.2, 0, 0], undefined, false));
  face(b, { eye: 0x2a3a4a, brow: 0x5a4a40, mouth: 0x7a4a40 });
  // Cape from the shoulders.
  const capeSegs = [0, 1, 2, 3].map((i) => {
    const w = 0.46 + i * 0.03;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(w, w, 0.26, 12, 1, true, Math.PI * 0.72, Math.PI * 0.56), cape);
    m.scale.set(1, 1, 0.35);
    const inner = new THREE.Mesh(m.geometry, capeIn);
    inner.scale.setScalar(0.985); m.add(inner);
    m.castShadow = true;
    return m;
  });
  const cc = swayChain(capeSegs, 0.24, { base: [0.12, 0, 0], amp: 0.05, speed: 3, droop: 0.06, side: 0.3 });
  cc.position.set(0, 0.3, 0.02);
  b.attach('spine', cc);
  // Silver chest plate, pauldrons, gauntlets, belt buckle.
  b.attach('spine', G(sph(0.2, 18, 12), steel, [0, 0.1, 0.07], [-0.1, 0, 0], [1.05, 0.85, 0.55]));
  b.attach('spine', G(new THREE.CircleGeometry(0.045, 16), M(0xff5a7a, 0.2, 0, 0xff3a5a, 1.6), [0, 0.11, 0.185], [-0.15, 0, 0], undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, G(sph(0.13, 12, 8), steel, [sx * 0.03, 0.02, 0], undefined, [1.25, 0.75, 1.25]));
    b.attach(j, G(sph(0.11, 12, 8), red, [sx * 0.05, -0.02, 0], undefined, [1.2, 0.6, 1.2]));
  }
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, G(cyl(0.06, 0.07, 0.16, 10), steel, [0, -0.17, 0]));
  b.attach('hips', G(boxG(0.36, 0.06, 0.25), steel, [0, 0.05, 0]));
  b.attach('hips', G(new THREE.OctahedronGeometry(0.04), red, [0, 0.05, 0.135]));
  // Orbiting shards (spun by the fighter).
  const orbit = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    orbit.add(G(new THREE.OctahedronGeometry(0.06, 0), steel, [Math.cos(a) * 0.55, Math.sin(i * 1.7) * 0.12, Math.sin(a) * 0.55], [a, a * 0.5, 0], [1, 1.8, 1], false));
  }
  b.attach('hips', orbit);
  (rig as any).orbit = orbit;
  return [];
};

// ------------------------------------------------------------------ EMBER — fire demon
const emberLook: BodyLook = {
  height: 2.15, bulk: 1.12, body: 0x2c2622, joints: 0xff5a10, jointGlow: 1.3, bodyRough: 0.85, bodyMetal: 0.05,
  paint: {
    skin: 0x2a201c, hair: 0x1a1412, top: 0x221c19, chest: 0x2e2420, upper: 0x241d1a, sleeve: 0x221c19, hands: 0x1a1412,
    pants: 0x1e1816, calf: 0x1a1412, boots: 0x141010,
    detail: { kind: 'stone', amount: 0.4 },
    cracks: { color: 0xff5a10, amount: 2.6, scale: 8, width: 0.045 },
  },
};
const emberAdorn: Adorn = (b) => {
  const char = M(0x1e1a18, 0.9, 0.05), bone = M(0x3a302a, 0.7, 0.05);
  const lava = M(0xff6a1a, 0.4, 0, 0xff4a10, 1.8), flameA = M(0xff7a1a, 0.5, 0, 0xff5a10, 2.2), flameB = M(0xffc040, 0.5, 0, 0xffa020, 2.4);
  // Horns, burning eyes, a mane of fire.
  for (const s of [-1, 1]) {
    const h = horn(bone, 0.22, 0.035, 0.45);
    h.position.set(s * 0.065, 0.25, 0.02);
    h.rotation.set(0.2, 0, -s * 0.55);
    h.children.slice().forEach((o) => addOutline(o as THREE.Mesh, 1.06));
    HA(b, h);
  }
  const eyes = face(b, { eye: 0xffb020, eyeGlow: 3, brow: 0x0e0a08, spread: 0.038, slant: 0.3, eyeScale: [1.6, 0.6, 0.5] });
  HA(b, G(boxG(0.045, 0.008, 0.01), lava, [0, 0.088, 0.108], undefined, undefined, false));
  const flames = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const f = new THREE.Mesh(cone(0.05, 0.24 + (i % 3) * 0.07, 6), i % 2 ? flameA : flameB);
    f.position.set(Math.sin(a) * 0.055, 0.27, Math.cos(a) * 0.05 - 0.04);
    f.rotation.set(-0.35 - Math.cos(a) * 0.2, 0, Math.sin(a) * 0.3);
    flames.add(f);
  }
  (flames.children[0] as THREE.Mesh).onBeforeRender = () => {
    const t = performance.now() / 1000;
    flames.children.forEach((f, i) => { f.scale.y = 0.75 + Math.sin(t * 13 + i * 1.9) * 0.25; f.scale.x = f.scale.z = 1 + Math.sin(t * 9 + i) * 0.12; });
  };
  HA(b, flames);
  // Shoulder spikes, molten chest core, charred bracers.
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, G(new THREE.DodecahedronGeometry(0.17, 0), char, [sx * 0.03, 0.02, 0], [0.3, 0.2, 0], [1.2, 0.8, 1.1]));
    for (const k of [-1, 1]) b.attach(j, G(cone(0.04, 0.18, 6), bone, [sx * 0.08, 0.13, k * 0.06], [k * 0.3, 0, -sx * 0.5]));
  }
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, G(boxG(0.16, 0.28, 0.16), char, [0, -0.2, 0.02], [0.1, 0.2, 0]));
  b.attach('spine', G(new THREE.IcosahedronGeometry(0.07, 0), lava, [0, 0.08, 0.17], undefined, undefined, false));
  b.attach('spine', G(torus(0.09, 0.02), char, [0, 0.08, 0.16]));
  b.attach('hips', G(boxG(0.4, 0.07, 0.28), char, [0, 0.04, 0]));
  return [lava, eyes, flameA, flameB, b.jointMat];
};

// ------------------------------------------------------------------ RIFT — portal witch
const riftLook: BodyLook = {
  female: true, height: 1.95, bulk: 0.96, body: 0x22302c, joints: 0x7dff6a, jointGlow: 0, bodyRough: 0.8, bodyMetal: 0.05,
  paint: {
    skin: 0xb88466, hair: 0x1a1420, top: 0x1c2e26, chest: 0x2a3e34, upper: 0x1c2e26, sleeve: 0x1c2e26, hands: 0xb88466,
    belt: 0x3a2a40, pants: 0x18201c, calf: 0x141a16, boots: 0x101410,
    detail: { kind: 'cloth', amount: 0.2 },
  },
};
const riftAdorn: Adorn = (b) => {
  const robe = M(0x1c2e26, 0.85, 0.02, 0, 0, THREE.DoubleSide), hair = M(0x1a1420, 0.8), sash = M(0x5a2a6a, 0.7, 0, 0, 0, THREE.DoubleSide);
  const glow = M(0x9dff8a, 0.2, 0, 0x5aff4a, 1.7), silver = M(0xc8d2cc, 0.25, 0.9);
  // Hood, long dark hair, forehead gem.
  HA(b, G(shell(0.13, Math.PI * 0.75, Math.PI * 1.5, Math.PI * 0.68), robe, [0, 0.15, -0.012], undefined, [0.93, 1.2, 1.04]));
  HA(b, G(cone(0.06, 0.14, 8), robe, [0, 0.27, -0.1], [-1.0, 0, 0]));
  HA(b, G(sph(0.1, 14, 10), hair, [0, 0.18, -0.02], undefined, [0.98, 0.98, 1.15]));
  for (const s of [-1, 1]) HA(b, G(boxG(0.03, 0.24, 0.045), hair, [s * 0.085, 0.08, 0.035], [0, 0, s * 0.05]));
  const strands = [0, 1, 2].map((i) => new THREE.Mesh(boxG(0.17 - i * 0.02, 0.18, 0.04), hair));
  strands.forEach((m) => { m.castShadow = true; });
  const sc = swayChain(strands, 0.17, { base: [0.15, 0, 0], amp: 0.08, speed: 2.5, droop: 0.05 });
  sc.position.set(0, 0.16, -0.11);
  HA(b, sc);
  HA(b, G(new THREE.OctahedronGeometry(0.014), glow, [0, 0.215, 0.118], undefined, [1, 1.4, 0.6], false));
  face(b, { eye: 0x2a6a3a, eyeGlow: 0.5, brow: 0x1a1420, mouth: 0x8a4a50 });
  // Robe skirt to the shins, sash across the chest with hanging ends.
  b.attach('hips', G(skirt(0.18, 0.4, 0.84, 0.7), robe, [0, 0.08, -0.01], undefined, undefined, false));
  b.attach('spine', G(boxG(0.07, 0.62, 0.02), sash, [0, 0.05, 0.16], [0.08, 0, 0.62]));
  b.attach('hips', G(boxG(0.38, 0.07, 0.26), sash, [0, 0.05, 0]));
  const ends = [0, 1].map(() => new THREE.Mesh(boxG(0.07, 0.2, 0.01), sash));
  const ec = swayChain(ends, 0.19, { base: [0.1, 0, 0.1], amp: 0.12, speed: 3.5 });
  ec.position.set(0.12, 0.03, 0.12);
  b.attach('hips', ec);
  // Portal rings: wrists and a halo on the back.
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, G(torus(0.09, 0.016), glow, [0, -0.2, 0], [Math.PI / 2, 0, 0], undefined, false));
    b.attach(j, G(cyl(0.065, 0.06, 0.14, 10), silver, [0, -0.12, 0]));
  }
  const halo = new THREE.Group();
  halo.add(G(torus(0.3, 0.022), glow, [0, 0, 0], undefined, undefined, false));
  halo.add(G(torus(0.22, 0.01), silver, [0, 0, 0], undefined, undefined, false));
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; halo.add(G(new THREE.OctahedronGeometry(0.025), glow, [Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0], undefined, undefined, false)); }
  halo.position.set(0, 0.12, -0.26);
  (halo.children[0] as THREE.Mesh).onBeforeRender = () => { halo.rotation.z = performance.now() / 1000 * 0.8; };
  b.attach('spine', halo);
  return [glow];
};

export const LOOKS: Record<string, { look: BodyLook; adorn: Adorn }> = {
  basalt: { look: basaltLook, adorn: basaltAdorn },
  tether: { look: tetherLook, adorn: tetherAdorn },
  aerin: { look: aerinLook, adorn: aerinAdorn },
  shunt: { look: shuntLook, adorn: shuntAdorn },
  vanta: { look: vantaLook, adorn: vantaAdorn },
  magna: { look: magnaLook, adorn: magnaAdorn },
  ember: { look: emberLook, adorn: emberAdorn },
  rift: { look: riftLook, adorn: riftAdorn },
};
