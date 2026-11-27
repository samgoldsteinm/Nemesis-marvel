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
    b.attach('head', g);
    if (b.isModel) {
      // Textured character heads differ in size and position: map the measured head box onto the
      // mannequin head frame the pieces were authored in (male / female), so hoods, helmets and hair fit.
      const { pts } = headGeometry(b, g);
      const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pts[i + k]); mx[k] = Math.max(mx[k], pts[i + k]); }
      const T = b.look.female ? { mn: [-0.086, 0.001, -0.096], mx: [0.086, 0.259, 0.13] } : { mn: [-0.1, 0.051, -0.134], mx: [0.1, 0.285, 0.13] };
      if (pts.length) {
        // Uniform scale from head height (ears and horns would skew the width); chin and face front aligned.
        const sc = (mx[1] - mn[1]) / (T.mx[1] - T.mn[1]);
        g.scale.setScalar(sc);
        g.position.set((mn[0] + mx[0]) / 2, mn[1] - T.mn[1] * sc, mx[2] - T.mx[2] * sc);
      }
    } else {
      const hy = b.look.height / 1.95, hx = hy * b.look.bulk / 0.98;
      g.scale.set(hx, hy, hx);
    }
    heads.set(b, g);
  }
  g.add(obj);
}
/** Head vertices (weight >= 0.9) and triangles, in the local frame of `frame`. */
function headGeometry(b: SkinnedBody, frame: THREE.Object3D) {
  b.model.updateMatrixWorld(true);
  const inv = frame.matrixWorld.clone().invert();
  const out: number[] = [], tris: number[] = [];
  b.inner.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || m.userData.outline || m.userData.headless || /eye|hair|collar/i.test(m.name)) return;
    const hi = m.skeleton.bones.findIndex((x) => x.name === 'Head');
    if (hi < 0) return;
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, v = new THREE.Vector3();
    const wHead = new Float32Array(si.count), P = new Float32Array(si.count * 3);
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === hi) w += sw.getComponent(i, c);
      wHead[i] = w;
      if (w < 0.4) continue;
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
      if (w >= 0.9) out.push(v.x, v.y, v.z);
    }
    const idx = m.geometry.index;
    const n = idx ? idx.count : si.count;
    for (let t = 0; t < n; t += 3) {
      const a = idx ? idx.getX(t) : t, b2 = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      if (wHead[a] < 0.4 || wHead[b2] < 0.4 || wHead[c] < 0.4) continue;
      for (const k of [a, b2, c]) tris.push(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
    }
  });
  return { pts: new Float32Array(out), tris };
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

/** The real head surface in the head-piece frame, measured from the skinned mesh (male and female heads differ). */
interface HeadFrame { y0: number; y1: number; pts: Float32Array; ell: { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number }; surf: THREE.Mesh | null }
const frames = new WeakMap<SkinnedBody, HeadFrame>();
function headFrame(b: SkinnedBody): HeadFrame {
  let f = frames.get(b);
  if (f) return f;
  HA(b, new THREE.Group()); // make sure the head group exists
  const g = heads.get(b)!;
  const { pts, tris } = headGeometry(b, g);
  let surf: THREE.Mesh | null = null;
  if (tris.length) {
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    surf = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    surf.updateMatrixWorld(true);
  }
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pts[i + k]); mx[k] = Math.max(mx[k], pts[i + k]); }
  if (!pts.length) { mn.splice(0, 3, -0.09, -0.01, -0.12); mx.splice(0, 3, 0.09, 0.28, 0.12); }
  f = { y0: mn[1], y1: mx[1], pts, surf, ell: { cx: (mn[0] + mx[0]) / 2, cy: (mn[1] + mx[1]) / 2, cz: (mn[2] + mx[2]) / 2, rx: (mx[0] - mn[0]) / 2, ry: (mx[1] - mn[1]) / 2, rz: (mx[2] - mn[2]) / 2 } };
  frames.set(b, f);
  return f;
}
/** Height on the head as a fraction (0 chin .. 1 crown). */
function fy(b: SkinnedBody, frac: number) { const f = headFrame(b); return f.y0 + (f.y1 - f.y0) * frac; }
/** z of the face surface at (x, y): the nearest measured vertices, never inside the fitted ellipsoid. */
const ray = new THREE.Raycaster();
function surfZb(b: SkinnedBody, x: number, y: number) {
  const f = headFrame(b), e = f.ell;
  if (f.surf) {
    // Cast from in front of the face straight back; the first hit is the skin.
    ray.set(new THREE.Vector3(x, y, e.cz + e.rz * 3), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(f.surf, false)[0];
    if (hit && hit.point.z > e.cz) return hit.point.z;
  }
  const k = 1 - ((x - e.cx) / e.rx) ** 2 - ((y - e.cy) / e.ry) ** 2;
  let z = e.cz + e.rz * Math.sqrt(Math.max(0.02, k));
  // Front-facing vertices only (the back of the head shares x and y); fall back to the ellipsoid.
  for (const tol of [0.008, 0.014, 0.022]) {
    let best = -1e9;
    for (let i = 0; i < f.pts.length; i += 3) {
      if (f.pts[i + 2] < e.cz + e.rz * 0.3) continue;
      if (Math.abs(f.pts[i + 1] - y) < tol && Math.abs(f.pts[i] - x) < tol * 1.2) best = Math.max(best, f.pts[i + 2]);
    }
    if (best > -1e8) return Math.max(best, z - 0.01);
  }
  return z;
}
/** Legacy fixed-frame surface (male head), for pieces placed before measurement. */
const HEAD = { cy: 0.135, rx: 0.09, ry: 0.145, rz: 0.12 };
function surfZ(x: number, y: number) {
  const k = 1 - (x / HEAD.rx) ** 2 - ((y - HEAD.cy) / HEAD.ry) ** 2;
  return HEAD.rz * Math.sqrt(Math.max(0.05, k));
}
/** Place a feature on the face surface at (x, y), lifted by `lift`, turned to follow the curvature. */
function onFace(b: SkinnedBody, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, lift = 0.002, rotZ = 0, scl?: V3, outline = false) {
  const f = headFrame(b), e = f.ell;
  const z = surfZb(b, x, y) + lift;
  const ry = Math.asin(THREE.MathUtils.clamp((x - e.cx) / e.rx, -0.95, 0.95)) * 0.7;
  const rx = -Math.asin(THREE.MathUtils.clamp((y - e.cy) / e.ry, -0.95, 0.95)) * 0.45;
  const o = G(geo, m, [x, y, z], [rx, ry, rotZ], scl, outline);
  HA(b, o);
  return o;
}
interface FaceSpec {
  eyes?: { sclera?: number; iris: number; glow?: number; pupil?: number; slit?: boolean; w?: number; h?: number; slant?: number; spread?: number; y?: number; lash?: number; full?: boolean };
  brows?: { color: number; angle?: number; thick?: number; y?: number; w?: number };
  nose?: { color: number; size?: number };
  lips?: { color: number; w?: number; full?: number; y?: number };
}
/** A readable stylised face: almond eyes (white, iris, pupil, lash line), brows, nose and lips. Returns the eye-glow material. */
function face2(b: SkinnedBody, f: FaceSpec) {
  let glowM: THREE.MeshStandardMaterial | null = null;
  const e = f.eyes;
  const ey = fy(b, e?.y ?? 0.52), sx = e?.spread ?? 0.034, w = e?.w ?? 0.019, h = e?.h ?? 0.011;
  if (e) {
    const irisM = e.glow ? M(e.iris, 0.3, 0, e.iris, e.glow) : M(e.iris, 0.25, 0.1);
    if (e.glow) glowM = irisM;
    const scleraM = M(e.sclera ?? 0xf4efe8, 0.35, 0), pupilM = M(e.pupil ?? 0x0a0808, 0.2, 0.2), lashM = M(e.lash ?? 0x140c0c, 0.7);
    for (const s of [-1, 1]) {
      const x = s * sx, rz = s * (e.slant ?? 0.12);
      if (e.full) {
        // Whole eye glows (beasts, demons, golems): almond of iris colour with a slit or round pupil.
        onFace(b, sph(1, 14, 10), irisM, x, ey, 0.0, rz, [w, h, 0.006]);
      } else {
        onFace(b, sph(1, 14, 10), scleraM, x, ey, -0.001, rz, [w, h, 0.006]);
        onFace(b, new THREE.CircleGeometry(h * 0.95, 16), irisM, x + s * 0.001, ey - h * 0.05, 0.0045, 0);
      }
      onFace(b, new THREE.CircleGeometry(h * (e.full ? 0.9 : 0.5), 12), pupilM, x + s * (e.full ? 0 : 0.001), ey - h * 0.05, 0.0055, 0, e.slit ? [0.28, 1.05, 1] : undefined);
      // Upper lash line gives the eye its shape from a distance.
      onFace(b, boxG(w * 2.1, 0.0035, 0.004), lashM, x, ey + h * 0.85, 0.004, rz - s * 0.12);
    }
  }
  if (f.brows) {
    const by = f.brows.y !== undefined ? fy(b, f.brows.y) : ey + 0.024, bw = f.brows.w ?? 0.036, bt = f.brows.thick ?? 0.0065;
    const bm = M(f.brows.color, 0.85);
    for (const s of [-1, 1]) onFace(b, boxG(bw, bt, 0.007), bm, s * (sx + 0.002), by, 0.003, -s * (f.brows.angle ?? 0.15));
  }
  if (f.nose) {
    const ns = f.nose.size ?? 1, nm = M(f.nose.color, 0.6);
    // Bridge and tip: a slim wedge standing proud of the face.
    onFace(b, cone(0.011 * ns, 0.05 * ns, 4), nm, 0, fy(b, 0.43), 0.006 * ns, 0, [1, 1, 0.75]).rotation.x += -0.3;
    onFace(b, sph(0.011 * ns, 10, 8), nm, 0, fy(b, 0.35), 0.009 * ns, 0, [1.25, 0.8, 0.9]);
  }
  if (f.lips) {
    const lw = f.lips.w ?? 0.03, lf = f.lips.full ?? 1, ly = fy(b, f.lips.y ?? 0.22), lm = M(f.lips.color, 0.45);
    onFace(b, sph(1, 14, 8), lm, 0, ly + 0.0045, 0.0, 0, [lw * 0.5, 0.0045 * lf, 0.006]);
    onFace(b, sph(1, 14, 8), lm, 0, ly - 0.004, 0.0, 0, [lw * 0.46, 0.0058 * lf, 0.007]);
    onFace(b, boxG(lw * 0.9, 0.0018, 0.004), M(0x2a1010, 0.8), 0, ly, 0.004);
  }
  return glowM;
}

// ------------------------------------------------------------------ BASALT — living rock golem
/** Rounded, irregular boulder: a subdivided icosahedron with seeded lumps (no flat box faces). */
function rockGeo(r: number, seed: number, sx = 1, sy = 1, sz = 1) {
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = (x: number, y: number, z: number) => Math.sin(x * 5.1 + seed) * Math.cos(y * 4.3 - seed * 1.7) + Math.sin(z * 6.7 + seed * 2.3) * 0.6 + Math.sin((x + y + z) * 9 + seed) * 0.25;
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k);
    const u = v.clone().normalize();
    const d = 1 + 0.11 * n(u.x * 2, u.y * 2, u.z * 2);
    v.copy(u).multiplyScalar(r * d);
    p.setXYZ(k, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}

const basaltLook: BodyLook = {
  height: 2.22, bulk: 1.14, golem: { emissive: 0xffb070, emissiveIntensity: 2.4 }, body: 0x5a5f66, joints: 0xff5a1a, jointGlow: 0.9, bodyRough: 0.95, bodyMetal: 0.02,
  paint: {
    skin: 0x5d636a, hair: 0x4a5058, top: 0x555b63, chest: 0x666c72, upper: 0x4f555d, sleeve: 0x5a6068, hands: 0x474d55,
    pants: 0x4c5259, calf: 0x555b62, boots: 0x3d4249,
    detail: { kind: 'stone', amount: 0.55 },
    cracks: { color: 0xff5010, amount: 2.2, scale: 6.5, width: 0.05 },
  },
};
const basaltAdorn: Adorn = (b) => {
  // Rock golem body (Oscar Creativo's model): its own lava-crack emissive is the accent that pulses with Rage.
  if (b.isGolem) return [b.bodyMat];
  const rock = M(0x5c626a, 0.95, 0.02), rock2 = M(0x42474f, 0.95, 0.02), moss = M(0x4f6a2a, 1, 0);
  const magma = M(0xff5a1a, 0.4, 0, 0xff4a10, 1.8);
  const D = (r: number) => new THREE.DodecahedronGeometry(r, 0);
  const R = rockGeo;
  // Shoulder boulders sit low and out so the neck and head stay clear.
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, G(R(0.24, sx * 3.1, 1.15, 0.78, 1.05), rock2, [sx * 0.06, -0.02, 0], [0.3, 0.2, sx * -0.35]));
    b.attach(j, G(R(0.1, sx * 1.3, 1.5, 0.45, 1.3), moss, [sx * 0.05, 0.13, -0.03], [0.2, 0.5, 0], undefined, false));
  }
  for (const j of ['lFore', 'rFore'] as const) {
    // Rock gauntlets tapering into huge boulder fists with knuckle stones.
    b.attach(j, G(R(0.17, j === 'lFore' ? 2 : 5, 0.95, 1.35, 0.95), rock2, [0, -0.22, 0.02], [0.1, 0.3, 0.05]));
    b.attach(j, G(R(0.2, j === 'lFore' ? 7 : 9, 1.12, 0.95, 1.12), rock, [0, -0.58, 0.04], [0.5, 0.2, 0.3]));
    for (const dx of [-0.08, 0, 0.08]) b.attach(j, G(R(0.05, dx * 40 + 1, 1, 0.9, 1), rock2, [dx, -0.7, 0.14], [dx * 9, 0.4, 0]));
  }
  // Chest plate: a broad rounded slab, kept below the collarbone.
  b.attach('spine', G(R(0.3, 4.4, 1.25, 0.8, 0.42), rock2, [0, -0.02, 0.17], [0.1, 0, 0]));
  b.attach('spine', G(new THREE.CircleGeometry(0.08, 10), magma, [0, -0.03, 0.305], undefined, undefined, false));
  for (const [x, y] of [[0.2, 0.06], [-0.22, -0.02], [0, -0.22]]) b.attach('spine', G(R(0.19, x * 10 + y * 7, 1.15, 0.9, 0.8), rock, [x, y, -0.22], [x, y, 0.4]));
  b.attach('spine', G(R(0.14, 8.8, 1.4, 0.35, 1.2), moss, [-0.18, 0.16, -0.3], [0.5, 0.2, 0], undefined, false));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(R(0.15, j === 'lShin' ? 11 : 13, 0.95, 1.4, 0.85), rock2, [0, -0.2, 0.08], [0.1, 0, 0]));
  for (const j of ['lThigh', 'rThigh'] as const) { b.attach(j, G(R(0.19, j === 'lThigh' ? 15 : 17, 1.05, 1.3, 1), rock, [0, -0.15, 0.06], [0.3, 0.5, 0.1])); b.attach(j, G(R(0.14, j === 'lThigh' ? 19 : 21), rock2, [0, -0.38, 0.05], [1.2, 0.2, 0.4])); }
  b.attach('hips', G(R(0.3, 23, 1.05, 0.42, 0.75), rock2, [0, 0.02, 0], [0, 0.1, 0]));
  // Carved boulder head sized to Basalt's real head (the reference head ×1.28 for his 2.5 m height): a
  // skull that just covers the mannequin head, brow ridge over magma eyes, nose ridge, slab
  // jaw with a glowing mouth crack, moss tufts. Features sit on the face, nothing juts far out.
  const eyes = M(0xffa040, 0.3, 0, 0xff6a10, 3.2);
  const shade = M(0x1c1f24, 1, 0);
  const k = 1.28;
  HA(b, G(rockGeo(0.12, 31, 1.0, 1.5, 1.27), rock, [0, 0.172, -0.004], [0.06, 0.2, 0]));
  HA(b, G(rockGeo(0.036 * k, 33, 2.3, 0.5, 0.75), rock2, [0, 0.178 * k, 0.106 * k], [-0.3, 0, 0]));
  // Eyes: angled almond slits of magma in dark recessed sockets, with a hot core.
  const core = M(0xfff0c0, 0.3, 0, 0xffd080, 4.5);
  for (const sx of [-1, 1]) {
    const ex = sx * 0.034 * k, ey = 0.152 * k, ez = 0.114 * k, tilt = sx * -0.3;
    HA(b, G(sph(1, 14, 10), shade, [ex, ey + 0.002, ez], [0, sx * 0.22, tilt], [0.023 * k, 0.013 * k, 0.008 * k], false));
    HA(b, G(sph(1, 14, 10), eyes, [ex, ey, ez + 0.007], [0, sx * 0.22, tilt], [0.019 * k, 0.0075 * k, 0.005 * k], false));
    HA(b, G(sph(1, 10, 8), core, [ex + sx * 0.002, ey, ez + 0.011], [0, sx * 0.22, tilt], [0.009 * k, 0.0035 * k, 0.003 * k], false));
  }
  HA(b, G(rockGeo(0.013 * k, 35, 0.8, 1.6, 0.9), rock, [0, 0.127 * k, 0.123 * k], [-0.2, 0, 0]));
  HA(b, G(rockGeo(0.05 * k, 37, 1.3, 0.58, 1.0), rock2, [0, 0.05 * k, 0.065 * k], [0.12, 0, 0]));
  // Mouth: a level, gritted magma snarl — a jagged straight crack with teeth biting up and down.
  for (let i = -3; i <= 3; i++) {
    const x = i * 0.0105, y = 0.054 + (i % 2 ? 0.0012 : -0.0012), z = (0.112 - Math.abs(x) * 0.25) * k;
    HA(b, G(boxG(0.0115 * k, 0.0042 * k, 0.008 * k), magma, [x * k, y * k, z], [0, x * 4, (i % 2 ? 0.22 : -0.22)], undefined, false));
    if (Math.abs(i) < 3) HA(b, G(boxG(0.0028 * k, 0.0075 * k, 0.007 * k), magma, [x * k, (y + (i % 2 ? -0.0042 : 0.0042)) * k, z], [0, x * 4, 0], undefined, false));
  }
  for (const [x, z, r] of [[0.03, -0.02, 0.03], [-0.035, -0.045, 0.026], [0.0, -0.075, 0.024]] as V3[]) HA(b, G(rockGeo(r * k, x * 50 + z * 30, 1.3, 0.5, 1.2), moss, [x * k, 0.345, z * k], [0.2, x * 10, 0], undefined, false));
  // Glowing rune glyphs carved into the chest plate and shoulder boulders.
  const glyph = (j: Parameters<SkinnedBody['attach']>[0], cx: number, cy: number, cz: number, s: number, ry = 0) => {
    for (const [x, y, w, h2] of [[0, 0, 0.012, 0.11], [-0.03, 0.03, 0.06, 0.01], [0.025, -0.025, 0.05, 0.01], [-0.02, -0.045, 0.01, 0.03]] as [number, number, number, number][]) {
      b.attach(j, G(boxG(w * s, h2 * s, 0.01), magma, [cx + x * s, cy + y * s, cz], [0, ry, 0], undefined, false));
    }
  };
  glyph('spine', -0.17, 0.1, 0.31, 1.1);
  glyph('spine', 0.17, 0.1, 0.31, 1.1);
  glyph('lArm', 0.05, 0.08, 0.2, 0.9, 0.3);
  glyph('rArm', -0.05, 0.08, 0.2, 0.9, -0.3);
  return [magma, eyes, core, b.jointMat];
};

// ------------------------------------------------------------------ TETHER — human acrobat vigilante
const tetherLook: BodyLook = {
  height: 1.95, bulk: 0.98, body: 0x109c8e, joints: 0x14161c, jointGlow: 0, bodyRough: 0.55, bodyMetal: 0.05,
  paint: {
    skin: 0x13a090, hair: 0x0c6f66, hairline: 0.98, mask: { color: 0x0c5a54, from: 0.55, to: 0.82 },
    top: 0x13a090, chest: 0x0c6f66, stripe: 0x0a2a2c, upper: 0x13a090, sleeve: 0x13a090, hands: 0x16181e,
    belt: 0x4a3018, pants: 0x0e7a70, calf: 0x16181e, boots: 0x1a1c22,
    detail: { kind: 'cloth', amount: 0.18 },
    pattern: { kind: 'web', color: 0x04221f, amount: 0.9, scale: 16, regions: ['head', 'neck', 'torso', 'upper', 'fore', 'hips', 'thigh'] },
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
  // Full-face mask: big angular white lenses with thick dark frames, a centre seam and a brow ridge.
  const lensW = M(0xf4fbff, 0.2, 0, 0xbff6ff, 0.55), frame = M(0x07121a, 0.5, 0.1);
  const lensShape = (scale: number) => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.028 * scale, 0.006 * scale); sh.lineTo(0.022 * scale, 0.016 * scale); sh.lineTo(0.03 * scale, -0.004 * scale);
    sh.lineTo(0.008 * scale, -0.019 * scale); sh.lineTo(-0.024 * scale, -0.012 * scale); sh.lineTo(-0.028 * scale, 0.006 * scale);
    return new THREE.ShapeGeometry(sh);
  };
  for (const s2 of [-1, 1]) {
    const fr = onFace(b, lensShape(1.75), frame, s2 * 0.039, fy(b, 0.52), 0.005, s2 * 0.2);
    const ln = onFace(b, lensShape(1.32), lensW, s2 * 0.039, fy(b, 0.52), 0.008, s2 * 0.2);
    if (s2 < 0) { fr.scale.x *= -1; ln.scale.x *= -1; }
  }
  onFace(b, boxG(0.004, 0.13, 0.004), frame, 0, 0.17, 0.003); // centre seam over the head
  onFace(b, boxG(0.09, 0.006, 0.006), frame, 0, 0.2, 0.003, 0, undefined);
  onFace(b, boxG(0.03, 0.004, 0.004), frame, 0, 0.088, 0.003); // mouth seam
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
  // Chest emblem: a gold grappling hook on a dark disc.
  b.attach('spine', G(cyl(0.085, 0.085, 0.012, 20), dark, [0, 0.08, 0.15], [Math.PI / 2 - 0.12, 0, 0]));
  b.attach('spine', G(boxG(0.016, 0.1, 0.012), gold, [0, 0.09, 0.16], [-0.12, 0, 0], undefined, false));
  b.attach('spine', G(torus(0.032, 0.008, Math.PI), gold, [0, 0.045, 0.162], [-0.12, 0, Math.PI], undefined, false));
  b.attach('spine', G(cone(0.018, 0.03, 3), gold, [0, 0.145, 0.158], [-0.12, 0, 0], undefined, false));
  // Shoulder straps for the line rig and wrist lines.
  for (const sx of [-1, 1]) b.attach('spine', G(boxG(0.03, 0.42, 0.012), leather, [sx * 0.09, 0.08, 0.14], [0.05, 0, sx * 0.32]));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(sph(0.07, 10, 8), dark, [0, 0.0, 0.07], undefined, [1, 1, 0.6]));
  return [lens, gold];
};

// ------------------------------------------------------------------ AERIN VOLT — storm sorceress
const aerinLook: BodyLook = {
  female: true, height: 1.95, bulk: 0.96, body: 0xe6e4f2, joints: 0x8a4cff, jointGlow: 0, bodyRough: 0.5, bodyMetal: 0.05,
  model: 'elf_f', eyeGlow: 0x8a5aff, skinTint: 0xfff0e8,
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
  // Hair: cap, fringe, side locks (mannequin only; the elf model has its own) and a long swinging ponytail.
  if (!b.isModel) {
    HA(b, G(sph(0.1, 16, 12), hair, [0, 0.185, -0.02], undefined, [1.0, 1.0, 1.18]));
    HA(b, G(boxG(0.17, 0.035, 0.05), hair, [0, 0.245, 0.09], [0.6, 0, 0]));
    for (const s of [-1, 1]) HA(b, G(boxG(0.03, 0.17, 0.045), hair, [s * 0.088, 0.12, 0.035], [0, 0, s * 0.06]));
  }
  const pony = [0, 1, 2, 3].map((i) => new THREE.Mesh(cyl(0.045 - i * 0.008, 0.05 - i * 0.008, 0.14, 8), hair));
  pony.forEach((m) => { m.castShadow = true; });
  const pc = swayChain(pony, 0.13, { base: [0.9, 0, 0], amp: 0.18, speed: 4, droop: 0.2 });
  pc.position.set(0, 0.24, -0.12);
  HA(b, pc);
  HA(b, G(torus(0.026, 0.01), trim, [0, 0.24, -0.118], [0.4, 0, 0], undefined, false));
  // Glowing circlet and face.
  HA(b, G(torus(0.1, 0.006, Math.PI), glow, [0, 0.215, 0.0], [Math.PI / 2 + 0.2, 0, 0], [0.97, 1.26, 1], false));
  if (!b.isModel) face2(b, {
    eyes: { iris: 0x9a6aff, glow: 1.4, w: 0.02, h: 0.0115, slant: 0.18, lash: 0x1a1020 },
    brows: { color: 0xe6e2f8, angle: 0.2, thick: 0.006 },
    nose: { color: 0xe4b898, size: 0.85 },
    lips: { color: 0xb8506a, w: 0.028, full: 1.1 },
  });
  // Lightning tattoo down the left cheek.
  for (const [x, y, r] of [[0.052, 0.47, 0.5], [0.058, 0.39, -0.6], [0.053, 0.31, 0.5]] as V3[]) onFace(b, boxG(0.004, 0.026, 0.004), glow, x, fy(b, y), 0.003, r);
  // Coat: high collar, open coat tails, shoulder trim.
  b.attach('spine', G(cyl(0.1, 0.14, b.isModel ? 0.05 : 0.12, 14, true), coat, [0, b.isModel ? 0.29 : 0.33, -0.01], [-0.1, 0, 0], undefined, false));
  b.attach('hips', G(skirt(0.17, 0.33, 0.62, 1.9), coat, [0, 0.06, -0.01], undefined, undefined, false));
  b.attach('hips', G(boxG(0.34, 0.05, 0.24), glow, [0, 0.05, 0], undefined, undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) b.attach(j, G(sph(0.1, 12, 8), coat, [sx * 0.02, 0.0, 0], undefined, [1.15, 0.7, 1.15]));
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, G(torus(0.055, 0.012), trim, [0, -0.22, 0], [Math.PI / 2, 0, 0], undefined, false));
  // Coat trims: glowing runic hem band, silver lapels, a storm-gem brooch at the collar.
  b.attach('hips', G(skirt(0.322, 0.335, 0.035, 1.9), glow, [0, 0.06 - 0.6, -0.01], undefined, undefined, false));
  for (let i = 0; i < 7; i++) { const a = -1.9 / 2 - 0.25 - i * ((Math.PI * 2 - 1.9 - 0.5) / 6); b.attach('hips', G(boxG(0.03, 0.012, 0.004), glow, [Math.sin(a) * 0.33, -0.48, Math.cos(a) * 0.33 * 0.9], [0, a, (i % 2 ? 0.5 : -0.5)], undefined, false)); }
  for (const sx of [-1, 1]) b.attach('spine', G(boxG(0.035, 0.36, 0.012), trim, [sx * 0.075, 0.08, 0.14], [0.08, 0, sx * 0.12], undefined, false));
  b.attach('spine', G(new THREE.OctahedronGeometry(0.03), glow, [0, 0.27, 0.12], undefined, [1, 1.3, 0.6], false));
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
  model: 'elf_m', eyeGlow: 0x37f2ff, skinDesat: 0.4, skinTint: 0x9a8a80,
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
  // Wrap-around visor with HUD scan lines, and a rebreather with vents and side canisters.
  HA(b, G(torus(0.104, 0.018, Math.PI * 0.8), dark, [0, 0.167, 0.0], [Math.PI / 2, 0, Math.PI * 0.1], [1.0, 1.16, 1.4], false));
  HA(b, G(torus(0.106, 0.012, Math.PI * 0.72), cyan, [0, 0.167, 0.004], [Math.PI / 2, 0, Math.PI * 0.14], [1.0, 1.16, 1.4], false));
  const hud = M(0x0a3a44, 0.4, 0, 0x0a6070, 0.6);
  for (const dy of [-0.004, 0.004]) onFace(b, boxG(0.11, 0.0015, 0.003), hud, 0, 0.167 + dy, 0.014);
  onFace(b, sph(0.045, 14, 10), dark, 0, fy(b, 0.2), -0.022, 0, [1.0, 0.7, 0.8]);
  onFace(b, cyl(0.02, 0.024, 0.026, 12), M(0x3a4048, 0.4, 0.6), 0, fy(b, 0.19), 0.012, 0).rotation.x += Math.PI / 2;
  for (const dx of [-0.008, 0, 0.008]) onFace(b, boxG(0.003, 0.018, 0.004), cyan, dx, fy(b, 0.19), 0.027);
  for (const sx of [-1, 1]) HA(b, G(cyl(0.012, 0.012, 0.035, 10), M(0x3a4048, 0.4, 0.6), [sx * 0.058, 0.075, 0.075], [Math.PI / 2, 0, sx * 0.4], undefined, false));
  // Long coat: skirt, collar, shoulder plates, backpack displacement core.
  b.attach('hips', G(skirt(0.19, 0.4, 0.9, 1.1), coat, [0, 0.08, -0.01], undefined, undefined, false));
  b.attach('spine', G(cyl(0.12, 0.17, b.isModel ? 0.05 : 0.14, 14, true), coat, [0, b.isModel ? 0.25 : 0.3, -0.02], [-0.15, 0, 0], undefined, false));
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
  // Tactical harness: crossed chest straps with a glowing buckle, pouches on the belt, thigh holster.
  const strap = M(0x1a1d24, 0.7, 0.2);
  for (const sx of [-1, 1]) b.attach('spine', G(boxG(0.035, 0.46, 0.014), strap, [sx * 0.02, 0.06, 0.15], [0.06, 0, sx * 0.55]));
  b.attach('spine', G(cyl(0.028, 0.028, 0.014, 14), plate, [0, 0.06, 0.165], [Math.PI / 2, 0, 0]));
  b.attach('spine', G(cyl(0.016, 0.016, 0.016, 12), cyan, [0, 0.06, 0.168], [Math.PI / 2, 0, 0], undefined, false));
  for (const x of [-0.13, -0.05, 0.06]) b.attach('hips', G(boxG(0.05, 0.065, 0.04), strap, [x, 0.02, 0.14]));
  b.attach('lThigh', G(boxG(0.08, 0.16, 0.05), strap, [0.06, -0.12, 0.02], [0, 0.3, 0]));
  return [cyan];
};

// ------------------------------------------------------------------ VANTA — feline beast-woman
const vantaLook: BodyLook = {
  female: true, height: 1.85, bulk: 0.95, body: 0x2a2228, joints: 0xe8c040, jointGlow: 0, bodyRough: 0.9, bodyMetal: 0,
  paint: {
    skin: 0x4a3e44, hair: 0x18121a, top: 0x2e262c, chest: 0x3a3036, upper: 0x2e262c, sleeve: 0x2e262c, hands: 0x18121a,
    pants: 0x2e262c, calf: 0x282026, boots: 0x18121a, stripe: 0x1e181e,
    detail: { kind: 'fur', amount: 0.55 },
    pattern: { kind: 'rosette', color: 0x0c080c, amount: 0.9, scale: 22, regions: ['torso', 'upper', 'fore', 'hips', 'thigh', 'calf'] },
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
  // Feline face: muzzle, triangular nose, almond gold eyes with slit pupils, whisker marks, fangs.
  onFace(b, sph(0.042, 12, 8), M(0x4a3a40, 0.9), 0, fy(b, 0.3), -0.02, 0, [1.15, 0.75, 0.75]);
  onFace(b, cone(0.014, 0.018, 3), M(0x1a1016, 0.5), 0, fy(b, 0.39), 0.012, Math.PI);
  const eyesM = face2(b, { eyes: { iris: 0xffc828, glow: 2.4, full: true, slit: true, w: 0.022, h: 0.011, slant: 0.38, spread: 0.037, lash: 0x0a0608 } })!;
  const wh = M(0xd8cfc4, 0.6);
  for (const sx of [-1, 1]) for (const k of [-1, 0, 1]) onFace(b, boxG(0.03, 0.0018, 0.002), wh, sx * 0.045, fy(b, 0.33) + k * 0.007, 0.012, sx * k * 0.15);
  onFace(b, boxG(0.03, 0.0025, 0.004), M(0x0a0608, 0.6), 0, fy(b, 0.22), 0.012);
  for (const sx of [-1, 1]) onFace(b, cone(0.0035, 0.012, 5), wh, sx * 0.009, fy(b, 0.2), 0.012, Math.PI);
  const eyes = eyesM;
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
  b.attach('spine', G(new THREE.OctahedronGeometry(0.02), M(0x40e0a0, 0.2, 0.2, 0x20c080, 1.2), [0, 0.215, 0.108], undefined, [1, 1.3, 0.7], false));
  for (const sx of [-1, 1]) b.attach('spine', G(boxG(0.035, 0.42, 0.012), gold, [sx * 0.05, 0.06, 0.135], [0.1, 0, sx * 0.42], undefined, false));
  b.attach('spine', G(boxG(0.2, 0.05, 0.16), M(0x18121a, 0.6), [0, -0.05, 0.06], undefined, [1, 1, 1], false));
  b.attach('hips', G(boxG(0.32, 0.05, 0.22), gold, [0, 0.03, 0], undefined, undefined, false));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, G(torus(0.05, 0.01), gold, [0, -0.36, 0], [Math.PI / 2, 0, 0], undefined, false));
  return [eyes, gold];
};

// ------------------------------------------------------------------ MAGNA — magnetic master (human)
const magnaLook: BodyLook = {
  height: 2.0, bulk: 1.05, body: 0x9aa2ac, joints: 0xd02040, jointGlow: 0, bodyRough: 0.6, bodyMetal: 0.1,
  model: 'elf_m', hideHair: true,
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
  if (!b.isModel) face2(b, {
    eyes: { iris: 0x3a6a8a, w: 0.018, h: 0.009, slant: -0.05, lash: 0x1a1210 },
    brows: { color: 0x8a8078, angle: -0.28, thick: 0.009, w: 0.04 },
    nose: { color: 0xc49274, size: 1.1 },
    lips: { color: 0x8a5048, w: 0.03, full: 0.7 },
  });
  // Stern lines: nasolabial creases and a scar across the brow.
  const crease = M(0x8a5a46, 0.8);
  if (!b.isModel) {
    for (const sx of [-1, 1]) onFace(b, boxG(0.0025, 0.03, 0.003), crease, sx * 0.024, fy(b, 0.27), 0.004, sx * 0.35);
    onFace(b, boxG(0.0025, 0.035, 0.003), M(0xe0a890, 0.8), 0.03, fy(b, 0.6), 0.005, 0.5);
  }
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
  // Breastplate emblem: a red horseshoe magnet with silver poles and a glowing field arc.
  const coreG = M(0xff5a7a, 0.2, 0, 0xff3a5a, 1.6);
  b.attach('spine', G(torus(0.045, 0.014, Math.PI), red, [0, 0.12, 0.19], [-0.15, 0, Math.PI], undefined, false));
  for (const sx of [-1, 1]) {
    b.attach('spine', G(boxG(0.028, 0.03, 0.03), red, [sx * 0.045, 0.135, 0.187], [-0.15, 0, 0], undefined, false));
    b.attach('spine', G(boxG(0.03, 0.018, 0.032), steel, [sx * 0.045, 0.157, 0.184], [-0.15, 0, 0], undefined, false));
  }
  b.attach('spine', G(torus(0.07, 0.004, Math.PI * 0.8), coreG, [0, 0.13, 0.19], [-0.15, 0, Math.PI * 0.1], undefined, false));
  // Gold cape clasps on the collarbones, joined by a chain.
  const goldM = M(0xe0b040, 0.3, 0.9);
  for (const sx of [-1, 1]) b.attach('spine', G(cyl(0.035, 0.035, 0.015, 16), goldM, [sx * 0.15, 0.27, 0.11], [Math.PI / 2 - 0.3, 0, 0]));
  b.attach('spine', G(cyl(0.005, 0.005, 0.3, 6), goldM, [0, 0.27, 0.12], [0, 0, Math.PI / 2], undefined, false));
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
  model: 'imp', skinDesat: 0.55, skinTint: 0x6a4a40,
  paint: {
    skin: 0x2a201c, hair: 0x1a1412, top: 0x221c19, chest: 0x2e2420, upper: 0x241d1a, sleeve: 0x221c19, hands: 0x1a1412,
    pants: 0x1e1816, calf: 0x1a1412, boots: 0x141010,
    detail: { kind: 'stone', amount: 0.4 },
    cracks: { color: 0xff5a10, amount: 2.6, scale: 8, width: 0.045, regions: ['neck', 'torso', 'upper', 'fore', 'hand', 'hips', 'thigh', 'calf', 'foot'] },
  },
};
const emberAdorn: Adorn = (b) => {
  const char = M(0x1e1a18, 0.9, 0.05), bone = M(0x3a302a, 0.7, 0.05);
  const lava = M(0xff6a1a, 0.4, 0, 0xff4a10, 1.8), flameA = M(0xff7a1a, 0.5, 0, 0xff5a10, 2.2), flameB = M(0xffc040, 0.5, 0, 0xffa020, 2.4);
  // Horns, burning eyes, a mane of fire. (The imp body brings its own horns and face; it only gets the fire.)
  let eyes: THREE.MeshStandardMaterial = lava;
  if (!b.isModel) {
    for (const s of [-1, 1]) {
      const h = horn(bone, 0.22, 0.035, 0.45);
      h.position.set(s * 0.065, 0.25, 0.02);
      h.rotation.set(0.2, 0, -s * 0.55);
      h.children.slice().forEach((o) => addOutline(o as THREE.Mesh, 1.06));
      HA(b, h);
    }
    // Demonic face: glowing slit eyes under heavy angled brows, a fanged grin of lava light.
    eyes = face2(b, { eyes: { iris: 0xffc030, glow: 3.2, full: true, slit: true, w: 0.023, h: 0.011, slant: 0.42, spread: 0.037, pupil: 0x1a0400, lash: 0x0a0604 },
      brows: { color: 0x0e0a08, angle: 0.5, thick: 0.01, w: 0.042, y: 0.66 } })!;
    onFace(b, cone(0.012, 0.04, 4), char, 0, fy(b, 0.4), 0.008).rotation.x -= 0.3;
    const grin = onFace(b, torus(0.034, 0.006, Math.PI * 0.85), lava, 0, fy(b, 0.27), -0.004, Math.PI + Math.PI * 0.075, [1, 0.55, 1]);
    const fang = M(0xe8dcc8, 0.5);
    for (const x of [-0.02, -0.007, 0.007, 0.02]) onFace(b, cone(0.0045, 0.016, 5), fang, x, fy(b, 0.17) + Math.abs(x) * 0.35, 0.006, Math.PI);
    for (const sx of [-1, 1]) onFace(b, boxG(0.003, 0.04, 0.003), lava, sx * 0.05, fy(b, 0.33), 0.003, sx * 0.25);
  }
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
  if (b.isModel) { flames.scale.setScalar(0.6); flames.position.y = -0.04; }
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
  model: 'orc_f', eyeGlow: 0x5aff4a, skinDesat: 0.6, skinTint: 0xa8c4a0,
  paint: {
    skin: 0x8aa88a, hair: 0x1a1420, top: 0x1c2e26, chest: 0x2a3e34, upper: 0x1c2e26, sleeve: 0x1c2e26, hands: 0x8aa88a,
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
  if (!b.isModel) {
    HA(b, G(sph(0.1, 14, 10), hair, [0, 0.18, -0.02], undefined, [0.98, 0.98, 1.15]));
    for (const s of [-1, 1]) HA(b, G(boxG(0.03, 0.24, 0.045), hair, [s * 0.085, 0.08, 0.035], [0, 0, s * 0.05]));
  }
  const strands = [0, 1, 2].map((i) => new THREE.Mesh(boxG(0.17 - i * 0.02, 0.18, 0.04), hair));
  strands.forEach((m) => { m.castShadow = true; });
  const sc = swayChain(strands, 0.17, { base: [0.15, 0, 0], amp: 0.08, speed: 2.5, droop: 0.05 });
  sc.position.set(0, 0.16, -0.11);
  HA(b, sc);
  HA(b, G(new THREE.OctahedronGeometry(0.014), glow, [0, 0.215, 0.118], undefined, [1, 1.4, 0.6], false));
  if (!b.isModel) face2(b, {
    eyes: { iris: 0x5aff6a, glow: 1.5, w: 0.02, h: 0.011, slant: 0.2, lash: 0x0a0610 },
    brows: { color: 0x1a1420, angle: 0.22, thick: 0.006 },
    nose: { color: 0xa87458, size: 0.85 },
    lips: { color: 0x5a2a4a, w: 0.028, full: 1.05 },
  });
  // Green rune marks under the eyes.
  for (const sx of [-1, 1]) onFace(b, boxG(0.016, 0.003, 0.003), glow, sx * 0.04, fy(b, 0.43), 0.004, sx * 0.3);
  // Robe skirt to the shins, sash across the chest with hanging ends.
  b.attach('hips', G(skirt(0.18, 0.4, 0.84, 0.7), robe, [0, 0.08, -0.01], undefined, undefined, false));
  b.attach('spine', G(boxG(0.07, 0.62, 0.02), sash, [0, 0.05, 0.16], [0.08, 0, 0.62]));
  b.attach('hips', G(boxG(0.38, 0.07, 0.26), sash, [0, 0.05, 0]));
  const ends = [0, 1].map(() => new THREE.Mesh(boxG(0.07, 0.2, 0.01), sash));
  const ec = swayChain(ends, 0.19, { base: [0.1, 0, 0.1], amp: 0.12, speed: 3.5 });
  ec.position.set(0.12, 0.03, 0.12);
  b.attach('hips', ec);
  // Embroidery: glowing rune bands on the robe hem and a rune column down the front; flared layered sleeves.
  b.attach('hips', G(skirt(0.392, 0.405, 0.04, 0.7), glow, [0, 0.08 - 0.8, -0.01], undefined, undefined, false));
  for (let i = 0; i < 8; i++) { const a = 0.7 / 2 + 0.3 + i * ((Math.PI * 2 - 0.7 - 0.6) / 7); b.attach('hips', G(boxG(0.026, 0.026, 0.004), glow, [Math.sin(a) * 0.37, -0.66, Math.cos(a) * 0.37 * 0.9], [0, a, Math.PI / 4], undefined, false)); }
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, G(cyl(0.07, 0.11, 0.16, 12, true), robe, [0, -0.04, 0], undefined, undefined, false));
    b.attach(j, G(torus(0.108, 0.006), glow, [0, -0.115, 0], [Math.PI / 2, 0, 0], undefined, false));
  }
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
