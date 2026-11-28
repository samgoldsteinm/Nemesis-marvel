import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Rig, JointName, Proportions } from './rig';

// Rigged mannequins (Quaternius Universal Animation Library, CC0) with real animation clips.
// Each fighter plays authored clips for the moves the library covers (locomotion, punches, guard,
// roll, hits, get-up, throws, slides, dashes, victory) and blends smoothly into the procedural rig
// (retargeted onto the same skeleton) for everything else: kicks, swings, flight, finishers.

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

let maleBase: THREE.Object3D | null = null;
let femaleBase: THREE.Object3D | null = null;
/** Textured character bodies on the same skeleton (Quaternius Fantasy Races / Bestiary kits). */
export type BodyModel = 'elf_f' | 'elf_m' | 'orc_f' | 'orc_m' | 'imp';
const charBases = new Map<BodyModel, THREE.Object3D>();
/** Full replacement bodies on another skeleton, animated by retargeting from the (hidden) mannequin. */
let golemBase: THREE.Object3D | null = null;
let modelDir = '';
const clips = new Map<string, THREE.AnimationClip>();
const propModels = new Map<string, THREE.Object3D>();

export async function loadBodyModels(dir: string) {
  const [male, female, extra, motifect] = await Promise.all([
    loader.loadAsync(`${dir}/ual_male.glb`),
    loader.loadAsync(`${dir}/ual_female.glb`),
    loader.loadAsync(`${dir}/ual_anims2.glb`),
    // Martial-arts / combat clips (Motifect, retargeted onto the UAL skeleton; names prefixed M_). Optional.
    loader.loadAsync(`${dir}/ual_motifect.glb`).catch((e) => { console.warn('motifect clips failed', e); return null; }),
  ]);
  maleBase = male.scene;
  femaleBase = female.scene;
  modelDir = dir;
  // Character bodies are optional: a fighter falls back to the painted mannequin if one fails to load.
  // Head parts (faces, eyes, hair, horns) borrowed from character kits; optional per fighter.
  await Promise.all((['elf_f', 'elf_m', 'orc_f', 'imp'] as BodyModel[]).map(async (id) => {
    try { charBases.set(id, (await loader.loadAsync(`${dir}/chars/${id}_head.glb`)).scene); } catch (e) { console.warn('head parts failed', id, e); }
  }));
  // Basalt's rock golem body (optional; falls back to the painted mannequin).
  try { golemBase = (await loader.loadAsync(`${dir}/golem.glb`)).scene; } catch (e) { console.warn('golem body failed', e); }
  for (const c of [...male.animations, ...extra.animations, ...(motifect?.animations ?? [])]) {
    // Drop root translation so clips play in place; the game moves the fighter.
    c.tracks = c.tracks.filter((t) => !/^root\.position$/.test(t.name));
    clips.set(c.name, c);
  }
}

export async function loadPropModels(dir: string, names: string[]) {
  await Promise.all(names.map(async (n) => {
    try {
      const g = await loader.loadAsync(`${dir}/${n}.glb`);
      propModels.set(n, g.scene);
    } catch (e) {
      console.warn('prop model failed', n, e);
    }
  }));
}

export function propModel(name: string) {
  return propModels.get(name) ?? null;
}
export function hasBodyModel() {
  return !!maleBase;
}
export function hasClip(name: string) {
  return clips.has(name);
}

const MAP: [JointName, string, string][] = [
  ['hips', 'pelvis', 'spine_01'], ['spine', 'spine_03', 'neck_01'], ['head', 'Head', ''],
  ['lArm', 'upperarm_l', 'lowerarm_l'], ['lFore', 'lowerarm_l', 'hand_l'], ['rArm', 'upperarm_r', 'lowerarm_r'], ['rFore', 'lowerarm_r', 'hand_r'],
  ['lThigh', 'thigh_l', 'calf_l'], ['lShin', 'calf_l', 'foot_l'], ['rThigh', 'thigh_r', 'calf_r'], ['rShin', 'calf_r', 'foot_r'],
];
const LIMBS = new Set<JointName>(['lArm', 'lFore', 'rArm', 'rFore', 'lThigh', 'lShin', 'rThigh', 'rShin']);

export interface BodyLook {
  height: number;
  bulk: number;
  body: number;
  joints: number;
  jointGlow: number;
  bodyRough: number;
  bodyMetal: number;
  flat?: boolean;
  female?: boolean;
  /** Per-region vertex paint: turns the mannequin into skin, clothes, fur or stone. */
  paint?: Paint;
  /** Graft a sculpted head (face, eyes, ears, hair) from a character kit onto the mannequin (same skeleton). */
  model?: BodyModel;
  /** Multiplier on the grafted head's skin texture (recolours it to the fighter). */
  skinTint?: number;
  /** Head size relative to the kit's (default 1). */
  headScale?: number;
  /** 0..1: desaturate the model's skin texture before tinting (stone, char). */
  skinDesat?: number;
  /** Hide the model's own hair (under helmets and hoods). */
  hideHair?: boolean;
  /** Make the model's eyes glow this colour. */
  eyeGlow?: number;
  /** Replace the whole body with the rock golem model (retargeted from the mannequin's animation). */
  golem?: { emissive?: number; emissiveIntensity?: number };
  /** Talking jaw: max open angle (rad, default 0.45) and mouth line as a fraction of head height from the chin (default 0.3). */
  jaw?: { open?: number; mouth?: number; hinge?: number };
}

/** Region colours for vertex painting (hex). Unset regions fall back as noted. */
export interface Paint {
  skin: number; // face, neck, bare hands
  hair?: number; // scalp / back of head (default skin)
  hairline?: number; // head height fraction (0 chin .. 1 crown) where hair starts on the face side (default 0.74)
  mask?: { color: number; from: number; to: number }; // band across the face, in the same head height fractions
  neck?: number;
  top: number; // torso
  chest?: number; // front torso panel
  upper?: number; // upper arms (default top)
  sleeve?: number; // forearms (default upper)
  hands?: number; // default skin
  belt?: number; // waist band
  pants: number;
  calf?: number; // shins (default pants), e.g. tall boots
  boots: number;
  stripe?: number; // side stripes on torso and legs
  /** Procedural surface detail in the shader. */
  detail?: { kind: 'cloth' | 'fur' | 'stone' | 'scales' | 'skin'; amount: number };
  /** Glowing veins / cracks across the body (stone, lava, tattoos). */
  cracks?: { color: number; amount: number; scale?: number; width?: number; regions?: Region[] };
  /** Printed / woven outfit pattern: web seams, fur rosettes, tiger stripes or quilted panels. glow > 0 makes it emissive. */
  pattern?: { kind: 'web' | 'rosette' | 'tiger' | 'quilt'; color: number; amount: number; scale?: number; glow?: number; regions?: Region[] };
}
export type Region = 'head' | 'neck' | 'torso' | 'upper' | 'fore' | 'hand' | 'hips' | 'thigh' | 'calf' | 'foot';
function boneRegion(name: string): Region {
  if (name === 'Head') return 'head';
  if (name === 'neck_01') return 'neck';
  if (/^(clavicle|spine)/.test(name)) return 'torso';
  if (/^upperarm/.test(name)) return 'upper';
  if (/^lowerarm/.test(name)) return 'fore';
  if (/^(hand|index|middle|ring|pinky|thumb)/.test(name)) return 'hand';
  if (/^pelvis|^root/.test(name)) return 'hips';
  if (/^thigh/.test(name)) return 'thigh';
  if (/^calf/.test(name)) return 'calf';
  return 'foot';
}
const REGION_ID: Record<Region, number> = { head: 0, neck: 1, torso: 2, upper: 3, fore: 4, hand: 5, hips: 6, thigh: 7, calf: 8, foot: 9 };

/** Paint a cloned mannequin geometry by skin weights, with face/hair split, panels and stripes. */
function paintGeometry(m: THREE.SkinnedMesh, paint: Paint, model = false) {
  const geo = m.geometry.clone();
  m.geometry = geo;
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const bones = m.skeleton.bones;
  const bindPos = (name: string) => {
    const i = bones.findIndex((b) => b.name === name);
    return new THREE.Vector3().setFromMatrixPosition(m.skeleton.boneInverses[i].clone().invert());
  };
  const bm = m.bindMatrix, nm = new THREE.Matrix3().getNormalMatrix(bm);
  const head = bindPos('Head'), neck = bindPos('neck_01'), pelvis = bindPos('pelvis'), spine1 = bindPos('spine_01');
  const fwd = bindPos('ball_l').sub(bindPos('foot_l')); 
  const up = head.clone().sub(pelvis).normalize();
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  // Head extent along up (and its centre) from the head-weighted vertices.
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  let hy0 = Infinity, hy1 = -Infinity;
  const hc = new THREE.Vector3(); let hn = 0;
  for (let k = 0; k < pos.count; k++) {
    if (boneRegion(bones[si.getX(k)].name) !== 'head' || sw.getX(k) < 0.9) continue;
    v.fromBufferAttribute(pos, k).applyMatrix4(bm);
    const y = v.clone().sub(head).dot(up);
    hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y); hc.add(v); hn++;
  }
  if (hn) hc.multiplyScalar(1 / hn); else hc.copy(head);
  const hspan = Math.max(1e-6, hy1 - hy0);
  const C = (h: number | undefined, fb: number) => new THREE.Color(h ?? fb);
  const col: Record<Region, THREE.Color> = {
    head: C(paint.skin, 0), neck: C(paint.neck, paint.skin), torso: C(paint.top, 0), upper: C(paint.upper, paint.top),
    fore: C(paint.sleeve, paint.upper ?? paint.top), hand: C(paint.hands, paint.skin), hips: C(paint.pants, 0), thigh: C(paint.pants, 0),
    calf: C(paint.calf, paint.pants), foot: C(paint.boots, 0),
  };
  const hair = C(paint.hair, paint.skin), chest = paint.chest !== undefined ? C(paint.chest, 0) : null;
  const stripe = paint.stripe !== undefined ? C(paint.stripe, 0) : null;
  const belt = paint.belt !== undefined ? C(paint.belt, 0) : null, mask = paint.mask ? C(paint.mask.color, 0) : null;
  const hairline = paint.hairline ?? 0.74;
  const beltY0 = spine1.clone().sub(pelvis).dot(up);
  const out = new Float32Array(pos.count * 3);
  const reg = new Float32Array(pos.count);
  const cloth = new Float32Array(pos.count);
  // On textured models, regions painted the skin colour keep the model's own skin (face, arms...); the rest is clothing.
  const skinCol = new THREE.Color(paint.skin);
  const isSkin = (c: THREE.Color) => Math.abs(c.r - skinCol.r) + Math.abs(c.g - skinCol.g) + Math.abs(c.b - skinCol.b) < 0.01;
  const tmp = new THREE.Color(), acc = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(bm);
    n.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize();
    acc.setRGB(0, 0, 0);
    let wsum = 0, best = 0, bestR: Region = 'torso';
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(k, c);
      if (w <= 0) continue;
      const r = boneRegion(bones[si.getComponent(k, c)].name);
      if (w > best) { best = w; bestR = r; }
      tmp.copy(col[r]);
      if (r === 'head') {
        const d = v.clone().sub(hc);
        const front = d.clone().setLength(1).dot(fwd);
        const h = (v.clone().sub(head).dot(up) - hy0) / hspan; // 0 chin .. 1 crown
        const face = front > 0.05 && h < hairline;
        tmp.copy(face ? col.head : hair);
        if (mask && face && h > paint.mask!.from && h < paint.mask!.to) tmp.copy(mask);
      }
      if (r === 'torso' && chest && n.dot(fwd) > 0.55) tmp.copy(chest);
      if (belt && (r === 'hips' || r === 'torso')) { const y = v.clone().sub(pelvis).dot(up); if (y > beltY0 * 0.25 && y < beltY0 * 1.15) tmp.copy(belt); }
      if (stripe && (r === 'torso' || r === 'thigh' || r === 'calf' || r === 'upper') && Math.abs(n.dot(right)) > 0.9) tmp.copy(stripe);
      if (model) {
        // Head stays the model's own (face, ears); masks still paint over it.
        const skinHere = (r === 'head' && !(mask && tmp.equals(mask))) || isSkin(tmp);
        if (skinHere) { tmp.setRGB(1, 1, 1); } else cloth[k] += w;
      }
      acc.r += tmp.r * w; acc.g += tmp.g * w; acc.b += tmp.b * w; wsum += w;
    }
    if (wsum > 0) { acc.multiplyScalar(1 / wsum); cloth[k] /= wsum; }

    out[k * 3] = acc.r; out[k * 3 + 1] = acc.g; out[k * 3 + 2] = acc.b;
    reg[k] = REGION_ID[bestR];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  geo.setAttribute('region', new THREE.BufferAttribute(reg, 1));
  geo.setAttribute('cloth', new THREE.BufferAttribute(cloth, 1));
  geo.computeBoundingBox();
  const size = geo.boundingBox!.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z);
}

/** Inject procedural detail (cloth weave, fur, stone grain) and glowing cracks into a body material. */
function addSurfaceDetail(mat: THREE.MeshStandardMaterial, paint: Paint, extent: number) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey();
  const det = paint.detail ?? { kind: 'cloth', amount: 0.12 };
  const kindId = { cloth: 0, fur: 1, stone: 2, scales: 3, skin: 4 }[det.kind];
  const cr = paint.cracks;
  let regMask = 0;
  for (const r of cr?.regions ?? (Object.keys(REGION_ID) as Region[])) regMask |= 1 << REGION_ID[r];
  const pt = paint.pattern;
  let patMask = 0;
  for (const r of pt?.regions ?? (Object.keys(REGION_ID) as Region[])) patMask |= 1 << REGION_ID[r];
  const uniforms = {
    uPat: { value: pt ? { web: 1, rosette: 2, tiger: 3, quilt: 4 }[pt.kind] : 0 }, uPatColor: { value: new THREE.Color(pt?.color ?? 0) },
    uPatAmt: { value: pt?.amount ?? 0 }, uPatScale: { value: pt?.scale ?? 6 }, uPatGlow: { value: pt?.glow ?? 0 }, uPatMask: { value: patMask },
    uDetail: { value: det.amount }, uKind: { value: kindId }, uScale: { value: 1 / extent },
    uCrackColor: { value: new THREE.Color(cr?.color ?? 0) }, uCrack: { value: cr?.amount ?? 0 },
    uCrackScale: { value: cr?.scale ?? 9 }, uCrackWidth: { value: cr?.width ?? 0.06 }, uRegMask: { value: regMask },
  };
  (mat.userData as any).detailUniforms = uniforms;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'attribute float region;\nvarying vec3 vBindP;\nvarying float vRegion;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBindP = position; vRegion = region;');
    sh.fragmentShader = `uniform float uDetail, uKind, uScale, uCrack, uCrackScale, uCrackWidth; uniform int uRegMask; uniform vec3 uCrackColor;
uniform float uPat, uPatAmt, uPatScale, uPatGlow; uniform int uPatMask; uniform vec3 uPatColor;
varying vec3 vBindP; varying float vRegion;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ return 0.55*vn(p) + 0.3*vn(p*2.03) + 0.15*vn(p*4.1); }
float cellEdge(vec3 p){ vec3 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int z=-1; z<=1; z++) for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) { vec3 g = vec3(float(x),float(y),float(z));
    vec3 o = vec3(h3(i+g), h3(i+g+11.7), h3(i+g+23.1)); float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return d2 - d1; }
` + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
  { vec3 q = vBindP * uScale; float dn = 0.0;
    if (uKind < 0.5) { dn = (vn(q*vec3(160.0,160.0,160.0)) - 0.5) * 0.6 + (fbm(q*14.0) - 0.5); }
    else if (uKind < 1.5) { dn = (vn(q*vec3(220.0,40.0,220.0)) - 0.5) * 1.4 + (fbm(q*9.0) - 0.5) * 0.8; }
    else if (uKind < 2.5) { dn = (fbm(q*18.0) - 0.5) * 1.4 - (1.0 - smoothstep(0.0, 0.12, cellEdge(q*11.0))) * 0.9; }
    else if (uKind < 3.5) { dn = (smoothstep(0.0, 0.2, cellEdge(q*40.0)) - 0.6) * 0.9; }
    else { dn = (fbm(q*30.0) - 0.5) * 0.5; }
    diffuseColor.rgb *= clamp(1.0 + dn * uDetail * 2.0, 0.3, 1.6); }
  float patC = 0.0;
  if (uPat > 0.5 && ((uPatMask >> int(vRegion + 0.5)) & 1) == 1) {
    vec3 q = vBindP * uScale * uPatScale;
    if (uPat < 1.5) {
      // Web: thin cell seams plus radiating lines.
      float e = cellEdge(q * vec3(1.0, 1.6, 1.0));
      patC = 1.0 - smoothstep(0.025, 0.06, e);
    } else if (uPat < 2.5) {
      // Rosettes: dark rings with a lighter centre.
      vec3 i = floor(q * 1.6), f = fract(q * 1.6) - 0.5; float d = length(f.xy + (vec2(h3(i), h3(i + 3.1)) - 0.5) * 0.35);
      patC = smoothstep(0.16, 0.2, d) * (1.0 - smoothstep(0.26, 0.31, d)) * step(0.35, h3(i + 7.0));
    } else if (uPat < 3.5) {
      // Tiger stripes: wavy bands around the body.
      float b2 = sin(q.y * 9.0 + fbm(q * 2.5) * 5.0 + q.x * 2.0);
      patC = smoothstep(0.55, 0.85, b2);
    } else {
      // Quilted panels: diamond stitching.
      float a = abs(fract((q.x + q.y) * 2.0) - 0.5), b2 = abs(fract((q.x - q.y) * 2.0) - 0.5);
      patC = 1.0 - smoothstep(0.02, 0.05, min(a, b2));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, uPatColor, patC * uPatAmt);
  }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uCrack > 0.0 && ((uRegMask >> int(vRegion + 0.5)) & 1) == 1) {
    float e = cellEdge(vBindP * uScale * uCrackScale + vec3(fbm(vBindP * uScale * 6.0)) * 0.6);
    float c = 1.0 - smoothstep(uCrackWidth * 0.4, uCrackWidth, e);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35, c);
    totalEmissiveRadiance += uCrackColor * c * uCrack; }
  if (uPatGlow > 0.0) totalEmissiveRadiance += uPatColor * patC * uPatGlow;`);
  };
  mat.customProgramCacheKey = () => prevKey + `|detail${kindId}${cr ? 'c' : ''}${pt ? 'p' : ''}`;
}

/** Drop the mannequin's head triangles (a grafted head replaces them). */

// ------------------------------------------------------------------ talking jaw (vertex shader)
/** Shader patch: rotate jaw-weighted vertices (attribute aJaw) about a hinge, in mesh space, before skinning. */
export interface JawUniforms { uJaw: { value: number }; uJawHinge: { value: THREE.Vector3 }; uJawAxis: { value: THREE.Vector3 } }
function patchJaw(mat: THREE.Material, u: JawUniforms) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aJaw;
uniform float uJaw;
uniform vec3 uJawHinge;
uniform vec3 uJawAxis;
vec3 jawRot(vec3 v, float a) { float c = cos(a), s = sin(a); return v * c + cross(uJawAxis, v) * s + uJawAxis * dot(uJawAxis, v) * (1.0 - c); }`)
      .replace('#include <skinnormal_vertex>', `objectNormal = jawRot(objectNormal, uJaw * aJaw);
#include <skinnormal_vertex>`)
      .replace('#include <skinning_vertex>', `transformed = uJawHinge + jawRot(transformed - uJawHinge, uJaw * aJaw);
#include <skinning_vertex>`);
  };
  mat.customProgramCacheKey = () => prevKey + '|jaw';
}
const ss = (a: number, b: number, x: number) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Face frame measured from the head's vertices in the current (reference) pose, in world space (+Y up, +Z forward). */
interface JawFrame { minY: number; maxY: number; minZ: number; maxZ: number; cx: number; w: number; mouthY: number; hinge: THREE.Vector3 }
function headVerts(m: THREE.SkinnedMesh, headBones: Set<number>, minW: number, each: (i: number, p: THREE.Vector3, hw: number) => void) {
  const geo = m.geometry, pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!si || !sw) return;
  const hb = m.skeleton.bones.find((b, i) => headBones.has(i) && /head/i.test(b.name)) ?? m.skeleton.bones[[...headBones][0]];
  const hi = m.skeleton.bones.indexOf(hb);
  const M = new THREE.Matrix4().multiplyMatrices(hb.matrixWorld, m.skeleton.boneInverses[hi]).multiply(m.bindMatrix);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let hw = 0;
    for (let c = 0; c < 4; c++) if (headBones.has(si.getComponent(i, c))) hw += sw.getComponent(i, c);
    if (hw < minW) continue;
    p.fromBufferAttribute(pos, i).applyMatrix4(M);
    each(i, p, hw);
  }
}
function headBoneSet(m: THREE.SkinnedMesh, root: string): Set<number> {
  const set = new Set<number>();
  const hb = m.skeleton.bones.find((b) => b.name === root);
  if (!hb) return set;
  m.skeleton.bones.forEach((b, i) => { let o: THREE.Object3D | null = b; while (o) { if (o === hb) { set.add(i); break; } o = o.parent; } });
  return set;
}

function removeHead(m: THREE.SkinnedMesh) {
  const geo = m.geometry, idx = geo.index;
  if (!idx) return;
  const hi = m.skeleton.bones.findIndex((b) => b.name === 'Head');
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const hw = (i: number) => { let w = 0; for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === hi) w += sw.getComponent(i, c); return w; };
  const keep: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    if (hw(a) > 0.5 && hw(b) > 0.5 && hw(c) > 0.5) continue;
    keep.push(a, b, c);
  }
  const g2 = geo.clone();
  g2.setIndex(keep);
  m.geometry = g2;
  m.userData.headless = true;
}

export interface ClipPlay {
  name: string;
  loop: boolean;
  speed: number;
  key: string; // a change of key restarts / crossfades
  fade?: number; // crossfade seconds into this clip
  startAt?: number; // seconds into the clip to start from
}

export class SkinnedBody {
  model: THREE.Object3D;
  inner: THREE.Object3D;
  bones = new Map<string, THREE.Bone>();
  proportions: Proportions;
  bodyMat!: THREE.MeshStandardMaterial;
  jointMat!: THREE.MeshStandardMaterial;
  mixer: THREE.AnimationMixer;
  private links: { j: JointName; bone: THREE.Bone; C: THREE.Quaternion }[] = [];
  private hipsOffset = new THREE.Vector3();
  private rig: Rig | null = null;
  private tq = new THREE.Quaternion();
  private pq = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private current: { key: string; action: THREE.AnimationAction } | null = null;
  /** 0 = pure clip animation, 1 = pure procedural pose. */
  procW = 1;
  private procTarget = 1;

  constructor(public look: BodyLook, decorate: (m: THREE.MeshStandardMaterial, kind: 'body' | 'joints') => void) {
    // inner holds the mannequin; model (outer) is what the fighter rig owns.
    const headKit = look.model ? charBases.get(look.model) : undefined;
    this.isModel = !!headKit;
    this.inner = SkeletonUtils.clone((look.female ? femaleBase : maleBase) ?? maleBase!);
    this.model = new THREE.Group();
    this.model.add(this.inner);
    this.inner.traverse((o) => { if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone); });
    const meshes: THREE.SkinnedMesh[] = [];
    this.inner.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
    const noOutline = new Set<THREE.SkinnedMesh>();
    for (const m of meshes) {
      const src = m.material as THREE.MeshStandardMaterial;
      const isJoints = /joint/i.test(src.name);
      const painted = !!look.paint;
      // Painted bodies: the joint discs take the paint of whatever they sit on, unless joints glow.
      const paintJoints = painted && look.jointGlow <= 0;
      const usePaint = painted && (!isJoints || paintJoints);
      const extent = usePaint ? paintGeometry(m, look.paint!) : 1;
      const mat = new THREE.MeshStandardMaterial({
        color: usePaint ? 0xffffff : isJoints ? look.joints : look.body,
        vertexColors: usePaint,
        roughness: isJoints && !paintJoints ? 0.35 : look.bodyRough,
        metalness: isJoints && !paintJoints ? 0.5 : look.bodyMetal,
        emissive: isJoints && !paintJoints ? look.joints : 0x000000,
        emissiveIntensity: isJoints && !paintJoints ? look.jointGlow : 0,
        flatShading: !isJoints && !!look.flat,
      });
      decorate(mat, isJoints ? 'joints' : 'body');
      if (usePaint) addSurfaceDetail(mat, look.paint!, extent);
      if (isJoints) this.jointMat = mat; else this.bodyMat = mat;
      m.material = mat;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
    }
    this.mixer = new THREE.AnimationMixer(this.inner);
    // Reference pose: the library's T-pose clip if present, else the bind pose.
    const tpose = clips.get('A_TPose');
    if (tpose) { const a = this.mixer.clipAction(tpose); a.play(); this.mixer.update(0); a.stop(); }
    this.inner.updateMatrixWorld(true);
    // Face +Z: use the foot-to-toe direction.
    const foot = this.wp('foot_l'), toe = this.wp('ball_l');
    const fwd = toe.sub(foot).setY(0).normalize();
    this.inner.rotation.y = Math.atan2(-fwd.x, fwd.z) + this.inner.rotation.y;
    this.inner.updateMatrixWorld(true);
    // Scale to target height (precise skinned bounds in the reference pose).
    const box = new THREE.Box3();
    for (const m of meshes) { m.computeBoundingBox(); box.union(m.boundingBox!.clone().applyMatrix4(m.matrixWorld)); }
    const h = box.max.y - box.min.y;
    const s = look.height / h;
    this.model.scale.set(s * look.bulk, s, s * look.bulk);
    this.inner.position.y = -box.min.y;
    this.model.updateMatrixWorld(true);
    if (headKit) {
      // Remove the mannequin's own head, then bind the kit's head parts to our bones (same names).
      for (const m of meshes) removeHead(m);
      headKit.traverse((o) => {
        const km = o as THREE.SkinnedMesh;
        if (!km.isSkinnedMesh) return;
        const bones = km.skeleton.bones.map((kb) => this.bones.get(kb.name) ?? this.bones.get('Head')!);
        const inv = km.skeleton.boneInverses.map((x) => x.clone());
        const hs = look.headScale ?? 1;
        if (hs !== 1 || look.bulk !== 1) {
          // Scale the head about the Head bone's bind position. The body's bulk widens the model in X/Z; undo
          // that on the head so a broad fighter doesn't get a squashed face.
          const hi = km.skeleton.bones.findIndex((b) => b.name === 'Head');
          const hb = km.skeleton.boneInverses[hi].clone().invert();
          const c = new THREE.Vector3().setFromMatrixPosition(hb);
          const hxz = hs / look.bulk;
          const S = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(1 / hxz, 1 / hs, 1 / hxz)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
          for (const x of inv) x.multiply(S);
        }
        const mesh = new THREE.SkinnedMesh(km.geometry, km.material as THREE.Material);
        mesh.name = km.name;
        meshes[0].parent!.add(mesh);
        mesh.bind(new THREE.Skeleton(bones, inv), km.bindMatrix);
        this.modelMaterial(mesh, km.material as THREE.MeshStandardMaterial, look, decorate, noOutline);
        if (!noOutline.has(mesh)) this.addOutline(mesh, s);
        mesh.userData.headPart = true;
      });
    }
    if (look.golem && golemBase) {
      // The mannequin stays as the invisible animation driver; the golem is what's seen.
      for (const m of meshes) { m.visible = false; m.castShadow = false; noOutline.add(m); }
      this.setupGolem(look, decorate, s);
    }
    // Talking jaw: weights + shader on whatever shows the face (grafted head, painted mannequin head or golem).
    const faceMeshes: THREE.SkinnedMesh[] = [];
    this.model.traverse((o) => {
      const k = o as THREE.SkinnedMesh;
      if (!k.isSkinnedMesh || k.userData.outline || !k.visible) return;
      if (this.isGolem ? meshes.includes(k) : this.isModel ? !k.userData.headPart : false) return;
      faceMeshes.push(k);
    });
    this.setupJaw(faceMeshes, look);
    for (const m of meshes) if (!noOutline.has(m)) this.addOutline(m, s);
    if (!this.jointMat) this.jointMat = this.bodyMat;
    this.proportions = this.measure();
  }

  // ------------------------------------------------------------------ golem body (retargeted)
  isGolem = false;
  private gBones = new Map<string, THREE.Bone>();
  /** UAL bone → golem bone, with the rest-pose correction: golemWorld = driverWorld · pre · post. */
  private gPairs: { d: THREE.Bone; g: THREE.Bone; pre: THREE.Quaternion; post: THREE.Quaternion }[] = [];
  private gHip: { bone: THREE.Bone; d0: THREE.Vector3; g0: THREE.Vector3; k: number } | null = null;
  private gTwist: { fa: THREE.Bone; hand: THREE.Bone; axis: THREE.Vector3; rest: THREE.Quaternion; t1: THREE.Bone; r1: THREE.Quaternion; t2: THREE.Bone; r2: THREE.Quaternion }[] = [];
  private setupGolem(look: BodyLook, decorate: (m: THREE.MeshStandardMaterial, kind: 'body' | 'joints') => void, s: number) {
    const g = SkeletonUtils.clone(golemBase!);
    let mesh: THREE.SkinnedMesh | null = null;
    g.traverse((o) => { if ((o as THREE.Bone).isBone) this.gBones.set(o.name, o as THREE.Bone); if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    if (!mesh) return;
    const gm = mesh as THREE.SkinnedMesh;
    // Skinned bounds in the bind pose (meshopt quantisation folds scale into the bind matrices, so raw
    // geometry bounds are not metres).
    g.updateMatrixWorld(true);
    gm.computeBoundingBox();
    const gb = gm.boundingBox!.clone().applyMatrix4(gm.matrixWorld);
    const gh = gb.max.y - gb.min.y;
    // True proportions at the fighter's height: undo the outer model's height scale and bulk widening.
    const k = look.height / gh;
    g.scale.set(k / (s * look.bulk), k / s, k / (s * look.bulk));
    g.position.y = -gb.min.y * (k / s);
    this.model.add(g);
    const src = gm.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({
      // Matte stone: the kit's roughness/metal maps read as wet chrome under our sky reflections.
      map: src.map, normalMap: src.normalMap, roughness: 0.92, metalness: 0.04, envMapIntensity: 0.35,
      emissiveMap: src.emissiveMap, emissive: look.golem?.emissive ?? 0xffffff,
      emissiveIntensity: look.golem?.emissiveIntensity ?? 1.4,
    });
    mat.normalScale.set(0.6, 0.6);
    decorate(mat, 'body');
    // Rim from the smooth surface normal, not the craggy normal-mapped one: otherwise every crack edge in the
    // normal map catches the rim light and the rock reads as wet silver veins.
    const prevRim = mat.onBeforeCompile, prevRimKey = mat.customProgramCacheKey();
    mat.onBeforeCompile = (sh, r) => {
      prevRim.call(mat, sh, r);
      // abs(): some of the model's vertex normals are inverted (inner arms); clamping them to 0 gave a full-strength rim.
      sh.fragmentShader = sh.fragmentShader.replace('clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0)', 'abs(dot(normalize(vNormal), normalize(vViewPosition)))');
    };
    mat.customProgramCacheKey = () => prevRimKey + '|geoRim';
    gm.material = mat;
    gm.castShadow = true; gm.receiveShadow = true; gm.frustumCulled = false;
    this.bodyMat = mat; this.jointMat = mat;
    this.addOutline(gm, k);
    this.isGolem = true;
    // Retarget pairs, calibrated now while the driver holds its reference pose and the golem its bind pose.
    this.model.updateMatrixWorld(true);
    const P: [string, string, string?][] = [
      ['pelvis', 'CC_Base_Hip'], ['spine_01', 'CC_Base_Waist', 'spine_02'], ['spine_02', 'CC_Base_Spine01', 'spine_03'], ['spine_03', 'CC_Base_Spine02', 'neck_01'],
      ['neck_01', 'CC_Base_NeckTwist01', 'Head'], ['Head', 'CC_Base_Head'],
    ];
    for (const [sd, sg] of [['l', 'L'], ['r', 'R']]) {
      P.push([`clavicle_${sd}`, `CC_Base_${sg}_Clavicle`, `upperarm_${sd}`], [`upperarm_${sd}`, `CC_Base_${sg}_Upperarm`, `lowerarm_${sd}`],
        [`lowerarm_${sd}`, `CC_Base_${sg}_Forearm`, `hand_${sd}`], [`hand_${sd}`, `CC_Base_${sg}_Hand`, `middle_01_${sd}`],
        [`thigh_${sd}`, `CC_Base_${sg}_Thigh`, `calf_${sd}`], [`calf_${sd}`, `CC_Base_${sg}_Calf`, `foot_${sd}`],
        [`foot_${sd}`, `CC_Base_${sg}_Foot`, `ball_${sd}`], [`ball_${sd}`, `CC_Base_${sg}_ToeBase`]);
      for (const [f, F] of [['thumb', 'Thumb'], ['index', 'Index'], ['pinky', 'Pinky']]) for (let i = 1; i <= 3; i++) P.push([`${f}_0${i}_${sd}`, `CC_Base_${sg}_${F}${i}`, i < 3 ? `${f}_0${i + 1}_${sd}` : undefined]);
    }
    // Mapped children on the golem side (for the hand, aim at the middle of the index and pinky roots).
    const gChild: Record<string, () => THREE.Vector3> = {};
    for (const sg of ['L', 'R']) gChild[`CC_Base_${sg}_Hand`] = () => this.gwp(`CC_Base_${sg}_Index1`).add(this.gwp(`CC_Base_${sg}_Pinky1`)).multiplyScalar(0.5);
    const map = new Map(P.map(([d, gg]) => [d, gg]));
    const wq = (b: THREE.Object3D) => b.getWorldQuaternion(new THREE.Quaternion());
    for (const [dn, gn, dc] of P) {
      const d = this.bones.get(dn), gbn = this.gBones.get(gn);
      if (!d || !gbn) continue;
      let align = new THREE.Quaternion();
      const gc = dc ? map.get(dc) : undefined;
      if (dc && this.bones.get(dc) && (gChild[gn] || (gc && this.gBones.get(gc)))) {
        const dd = this.wp(dc).sub(this.wp(dn)).normalize();
        const gp = this.gwp(gn), gcp = gChild[gn] ? gChild[gn]() : this.gwp(gc!);
        const gd = gcp.sub(gp).normalize();
        align = new THREE.Quaternion().setFromUnitVectors(gd, dd);
      }
      this.gPairs.push({ d, g: gbn, pre: wq(d).invert(), post: align.multiply(wq(gbn)) });
    }
    // Forearm roll is carried by the twist bones (as the CC rig expects), not the forearm itself: the
    // forearm takes only the bend, ForearmTwist01/02 take ¼ / ¾ of the roll and the hand takes all of it.
    for (const sg of ['L', 'R']) {
      const fa = this.gBones.get(`CC_Base_${sg}_Forearm`), hand = this.gBones.get(`CC_Base_${sg}_Hand`);
      const t1 = this.gBones.get(`CC_Base_${sg}_ForearmTwist01`), t2 = this.gBones.get(`CC_Base_${sg}_ForearmTwist02`);
      if (fa && hand && t1 && t2) this.gTwist.push({ fa, hand, axis: hand.position.clone().normalize(), rest: fa.quaternion.clone(), t1, r1: t1.quaternion.clone(), t2, r2: t2.quaternion.clone() });
    }
    // Hips: follow the driver pelvis' motion (scaled by the hip-height ratio), in model space.
    const hip = this.gBones.get('CC_Base_Hip')!;
    const d0 = this.model.worldToLocal(this.wp('pelvis')), g0 = this.model.worldToLocal(this.gwp('CC_Base_Hip'));
    this.gHip = { bone: hip, d0, g0, k: g0.y / Math.max(0.01, d0.y) };
  }
  private gwp(name: string) { return this.gBones.get(name)!.getWorldPosition(new THREE.Vector3()); }
  /** Pose the golem from the driver mannequin (call after the driver's final pose). */
  private retarget() {
    if (!this.isGolem) return;
    this.inner.updateMatrixWorld(true);
    const h = this.gHip!;
    const dp = this.model.worldToLocal(this.wp('pelvis'));
    const want = h.g0.clone().add(dp.sub(h.d0).multiplyScalar(h.k));
    h.bone.position.copy(h.bone.parent!.worldToLocal(this.model.localToWorld(want)));
    h.bone.updateMatrixWorld(true);
    for (const p of this.gPairs) {
      p.d.getWorldQuaternion(this.tq).multiply(p.pre).multiply(p.post);
      p.g.parent!.getWorldQuaternion(this.pq);
      p.g.quaternion.copy(this.pq.invert().multiply(this.tq));
      const tw = this.gTwist.find((x) => x.fa === p.g);
      if (tw) this.splitTwist(tw);
      p.g.updateMatrixWorld(true);
    }
  }
  private sq = new THREE.Quaternion();
  private swq = new THREE.Quaternion();
  /** Keep only the bend on the forearm; hand its roll to the twist bones (¼ near the elbow, ¾ near the wrist). */
  private splitTwist(tw: SkinnedBody['gTwist'][number]) {
    // delta from rest in the forearm's rest-local frame, decomposed into swing · twist about the bone axis.
    const delta = this.sq.copy(tw.rest).invert().multiply(tw.fa.quaternion);
    const a = tw.axis, d = a.x * delta.x + a.y * delta.y + a.z * delta.z;
    const twist = this.swq.set(a.x * d, a.y * d, a.z * d, delta.w);
    if (twist.lengthSq() < 1e-8) return;
    twist.normalize();
    const angle = 2 * Math.atan2(d, delta.w);
    const swing = delta.multiply(twist.clone().invert());
    tw.fa.quaternion.copy(tw.rest).multiply(swing);
    // The twist bones sit along the forearm axis: rotate them about the same axis in their own frames.
    // Express the forearm axis in each twist bone's rest frame (t2 sits under t1).
    const local = (b: THREE.Bone, r: THREE.Quaternion, chain: THREE.Quaternion, frac: number) => {
      const ax = a.clone().applyQuaternion(chain.clone().invert()).normalize();
      b.quaternion.copy(r).multiply(new THREE.Quaternion().setFromAxisAngle(ax, angle * frac));
    };
    local(tw.t1, tw.r1, tw.r1, 0.25);
    local(tw.t2, tw.r2, tw.r1.clone().multiply(tw.r2), 0.5);
  }

  isModel = false;
  /** Materials for a textured character body: skin texture with painted clothing, tinted hair, shaded eyes. */
  private modelMaterial(m: THREE.SkinnedMesh, src: THREE.MeshStandardMaterial, look: BodyLook, decorate: (m: THREE.MeshStandardMaterial, kind: 'body' | 'joints') => void, noOutline: Set<THREE.SkinnedMesh>) {
    const name = `${m.name} ${src.name}`;
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    if (/eye/i.test(name)) {
      const mat = new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.25, metalness: 0, emissive: look.eyeGlow ?? 0, emissiveIntensity: look.eyeGlow !== undefined ? 1.6 : 0 });
      m.material = mat; noOutline.add(m); m.castShadow = false;
      return;
    }
    if (/hair/i.test(name)) {
      if (look.hideHair) { m.visible = false; noOutline.add(m); return; }
      const mat = new THREE.MeshStandardMaterial({ map: src.map, color: look.paint?.hair ?? 0xffffff, roughness: 0.6, metalness: 0 });
      decorate(mat, 'body');
      // Hair strands keep their texture's shading but take the fighter's hair colour (chained after the rim light).
      const prevH = mat.onBeforeCompile, prevHKey = mat.customProgramCacheKey();
      mat.onBeforeCompile = (sh, r) => {
        prevH.call(mat, sh, r);
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 hairTex = texture2D(map, vMapUv);
  diffuseColor.rgb *= 0.45 + 1.1 * dot(hairTex.rgb, vec3(0.299, 0.587, 0.114));
#endif`);
      };
      mat.customProgramCacheKey = () => prevHKey + '|hairTint';
      m.material = mat;
      return;
    }
    const isHead = /body/i.test(name);
    const mat = new THREE.MeshStandardMaterial({
      map: src.map, color: isHead ? (look.skinTint ?? 0xffffff) : 0xffffff, roughness: isHead ? 0.55 : 0.5, metalness: isHead ? 0 : 0.3,
      emissiveMap: src.emissiveMap ?? null, emissive: src.emissiveMap ? 0xffffff : 0x000000, emissiveIntensity: src.emissiveMap ? 1.2 : 0,
    });
    decorate(mat, 'body');
    if (isHead && look.skinDesat) {
      // Desaturate the kit's skin before tinting, so the face takes the fighter's own skin colour.
      const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey(), d = look.skinDesat.toFixed(3);
      mat.onBeforeCompile = (sh, r) => {
        prev.call(mat, sh, r);
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114))) * diffuse * 1.25, ${d});
#endif`);
      };
      mat.customProgramCacheKey = () => prevKey + '|desat' + d;
    }
    m.material = mat;
  }


  // ------------------------------------------------------------------ talking jaw
  readonly jawU: JawUniforms['uJaw'] = { value: 0 };
  private jawMax = 0.26;
  /** Hinge point and left-right axis in the head bone's local frame (for moving lip/jaw pieces with the chin). */
  private jawBone: THREE.Bone | null = null;
  private jawHinge = new THREE.Vector3();
  private jawAxis = new THREE.Vector3(1, 0, 0);
  private jawGlow: THREE.Mesh | null = null;
  private setupJaw(meshes: THREE.SkinnedMesh[], look: BodyLook) {
    const allMeshes = meshes;
    this.model.updateMatrixWorld(true);
    const root = this.isGolem ? 'CC_Base_Head' : 'Head';
    const sets = new Map(allMeshes.map((m) => [m, headBoneSet(m, root)]));
    // Hair and eyes never take jaw weights (and don't define the face frame).
    meshes = meshes.filter((m) => !/hair|eye/i.test(`${m.name} ${(m.material as THREE.Material).name ?? ''}`));
    // Face frame from the mesh with the most head vertices.
    let best: THREE.SkinnedMesh | null = null, bestN = 0;
    for (const m of meshes) { let n = 0; headVerts(m, sets.get(m)!, 0.6, () => n++); if (n > bestN) { bestN = n; best = m; } }
    if (!best || bestN < 50) return;
    const mn = new THREE.Vector3(1e9, 1e9, 1e9), mx = new THREE.Vector3(-1e9, -1e9, -1e9);
    const pts: number[] = [];
    headVerts(best, sets.get(best)!, 0.6, (_i, p) => { mn.min(p); mx.max(p); pts.push(p.x, p.y, p.z); });
    const cx = (mn.x + mx.x) / 2, W = mx.x - mn.x;
    // Face profile down the midline: the nose is the most forward point; the chin is the lowest point that is
    // still part of the face front (below it the front recedes into the neck).
    let noseY = mx.y, noseZ = -1e9;
    for (let i = 0; i < pts.length; i += 3) if (Math.abs(pts[i] - cx) < W * 0.12 && pts[i + 2] > noseZ && pts[i + 1] > mn.y + (mx.y - mn.y) * 0.3) { noseZ = pts[i + 2]; noseY = pts[i + 1]; }
    const D0 = mx.z - mn.z;
    let chinY = noseY;
    for (let i = 0; i < pts.length; i += 3) if (Math.abs(pts[i] - cx) < W * 0.15 && pts[i + 1] < noseY && pts[i + 2] > noseZ - D0 * 0.42) chinY = Math.min(chinY, pts[i + 1]);
    const F = Math.max(0.02, noseY - chinY);
    let minZ = 1e9;
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] > chinY) minZ = Math.min(minZ, pts[i + 2]);
    const D = noseZ - minZ;
    const H = F * 2.2; // used for band widths
    const mouthY = chinY + F * (look.jaw?.mouth ?? 0.42);
    mn.y = chinY;
    const hinge = new THREE.Vector3(cx, chinY + F * 1.05, minZ + D * (look.jaw?.hinge ?? 0.45));
    this.jawMax = look.jaw?.open ?? 0.45;
    for (const m of meshes) {
      const set = sets.get(m)!;
      const w = new Float32Array(m.geometry.attributes.position.count);
      let any = 0;
      headVerts(m, set, 0.2, (i, p, hw) => {
        // Below the mouth line, in front of the hinge, fading toward the sides (cheeks move partly) and up the neck.
        const below = ss(mouthY + F * 0.03, mouthY - F * 0.04, p.y);
        const front = ss(hinge.z - D * 0.15, hinge.z + D * 0.15, p.z);
        const side = 1 - 0.5 * ss(W * 0.2, W * 0.48, Math.abs(p.x - cx));
        const neck = ss(chinY - F * 0.45, chinY - F * 0.05, p.y);
        const v = Math.min(1, hw) * below * front * side * neck;
        if (v > 0.001) { w[i] = v; any++; }
      });
      if (!any) continue;
      m.geometry = m.geometry.clone();
      m.geometry.setAttribute('aJaw', new THREE.BufferAttribute(w, 1));
      // Hinge and axis in this mesh's geometry space (the same for its outline, which shares geometry and bind).
      const hb = m.skeleton.bones.find((b, i) => set.has(i) && b.name === root)!;
      const hi = m.skeleton.bones.indexOf(hb);
      const Mw = new THREE.Matrix4().multiplyMatrices(hb.matrixWorld, m.skeleton.boneInverses[hi]).multiply(m.bindMatrix);
      const inv = Mw.clone().invert();
      const uu: JawUniforms = { uJaw: this.jawU, uJawHinge: { value: hinge.clone().applyMatrix4(inv) }, uJawAxis: { value: new THREE.Vector3(1, 0, 0).transformDirection(inv) } };
      // A mirrored bind flips the rotation direction: flip the axis to keep "chin down".
      if (new THREE.Matrix3().setFromMatrix4(Mw).determinant() < 0) uu.uJawAxis.value.negate();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) patchJaw(mt, uu);
      m.parent?.children.forEach((o) => { const k = o as THREE.SkinnedMesh; if (k.userData.outline && k.geometry === m.userData.preJawGeo) { k.geometry = m.geometry; patchJaw(k.material as THREE.Material, uu); } });
      m.userData.jaw = uu;
    }
    // Hinge/axis in the head bone's frame, for the bone-attached lip and mouth pieces.
    const bone = this.isGolem ? this.gBones.get('CC_Base_Head')! : this.bones.get('Head')!;
    this.jawBone = bone;
    this.jawHinge.copy(bone.worldToLocal(hinge.clone()));
    this.jawAxis.set(1, 0, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
    if (this.isGolem) {
      // Magma inside the golem's mouth: glows through the opening as the jaw drops.
      const fz = (() => { let z = -1e9; headVerts(best!, sets.get(best!)!, 0.6, (_i, p) => { if (Math.abs(p.y - mouthY) < F * 0.1 && Math.abs(p.x - cx) < W * 0.15) z = Math.max(z, p.z); }); return z > -1e8 ? z : mx.z; })();
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff7a24, toneMapped: false }));
      const at = new THREE.Vector3(cx, mouthY - H * 0.02, fz - D * 0.12);
      bone.add(glow);
      glow.position.copy(bone.worldToLocal(at.clone()));
      const sc = new THREE.Vector3(W * 0.2, H * 0.05, D * 0.1);
      const ws = bone.getWorldScale(new THREE.Vector3());
      glow.scale.set(sc.x / ws.x, sc.y / ws.y, sc.z / ws.z);
      glow.visible = false;
      this.jawGlow = glow;
    }
  }
  private jq = new THREE.Quaternion();
  /** Move the jaw: shader angle, lower lip/jaw pieces rotated about the hinge, golem mouth glow. */
  private applyJaw(s: number) {
    const a = s * this.jawMax;
    this.jawU.value = a;
    if (this.jawGlow) { this.jawGlow.visible = s > 0.03; (this.jawGlow.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.42 + 0.3 * s, 0.12); }
    if (!this.jawBone) return;
    for (const p of this.talkParts) {
      if (p.kind !== 'down') continue;
      const parent = p.o.parent;
      if (!parent) continue;
      // Hinge and axis in the piece's parent frame.
      const hW = this.jawBone.localToWorld(this.tv.copy(this.jawHinge));
      const hP = parent.worldToLocal(hW.clone());
      const axW = this.jawAxis.clone().applyQuaternion(this.jawBone.getWorldQuaternion(this.pq));
      const axP = axW.applyQuaternion(parent.getWorldQuaternion(this.tq).invert()).normalize();
      this.jq.setFromAxisAngle(axP, a);
      p.o.position.copy(p.p0).sub(hP).applyQuaternion(this.jq).add(hP);
      if (!p.q0) p.q0 = p.o.quaternion.clone();
      p.o.quaternion.copy(this.jq).multiply(p.q0);
    }
  }

  bone(name: string) {
    return this.bones.get(name);
  }
  private wp(name: string) {
    return this.bone(name)!.getWorldPosition(new THREE.Vector3());
  }

  private measure(): Proportions {
    const hips = this.wp('pelvis'), lUp = this.wp('thigh_l'), rUp = this.wp('thigh_r'), lLeg = this.wp('calf_l'), lFoot = this.wp('foot_l');
    const lArm = this.wp('upperarm_l'), rArm = this.wp('upperarm_r'), lFore = this.wp('lowerarm_l'), lHand = this.wp('hand_l'), head = this.wp('Head');
    const thigh = lUp.distanceTo(lLeg);
    return {
      thigh,
      shin: Math.max(lLeg.distanceTo(lFoot) + lFoot.y, hips.y - thigh),
      torso: lArm.y - hips.y,
      shoulderW: lArm.distanceTo(rArm),
      hipW: lUp.distanceTo(rUp),
      upperArm: lArm.distanceTo(lFore),
      foreArm: lFore.distanceTo(lHand),
      neck: Math.max(0.05, head.y - lArm.y),
    };
  }

  private addOutline(m: THREE.SkinnedMesh, s: number) {
    const t = 0.011 / Math.max(1e-6, s);
    const mat = new THREE.MeshBasicMaterial({ color: 0x07070c, side: THREE.BackSide });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = vec3(position) + normal * ${t.toFixed(5)};`);
    };
    mat.customProgramCacheKey = () => `skinOutline${t.toFixed(5)}`;
    const o = new THREE.SkinnedMesh(m.geometry, mat);
    m.userData.preJawGeo = m.geometry;
    if (m.userData.jaw) patchJaw(mat, m.userData.jaw);
    o.bind(m.skeleton, m.bindMatrix);
    o.position.copy(m.position);
    o.quaternion.copy(m.quaternion);
    o.scale.copy(m.scale);
    o.frustumCulled = false;
    o.userData.outline = true;
    m.parent!.add(o);
  }

  /** Attach under the rig root and calibrate the driver rig to the model's reference pose. */
  bind(rig: Rig) {
    this.rig = rig;
    rig.root.add(this.model);
    const saved = new Map<JointName, THREE.Euler>();
    for (const [j] of MAP) saved.set(j, rig.joints[j].rotation.clone());
    const bodyRot = rig.body.rotation.clone();
    const rootPos = rig.root.position.clone(), rootRot = rig.root.rotation.clone();
    for (const [j] of MAP) rig.joints[j].rotation.set(0, 0, 0);
    rig.body.rotation.set(0, 0, 0);
    rig.root.position.set(0, 0, 0);
    rig.root.rotation.set(0, 0, 0);
    rig.root.updateMatrixWorld(true);
    this.model.updateMatrixWorld(true);
    // Point each driver limb along the model's matching bone so both share one reference pose.
    const down = new THREE.Vector3(0, -1, 0);
    for (const [j, b, child] of MAP) {
      if (!LIMBS.has(j)) continue;
      const jt = rig.joints[j];
      const want = this.wp(child).sub(this.wp(b)).normalize();
      const cur = jt.getWorldQuaternion(new THREE.Quaternion());
      const curDir = down.clone().applyQuaternion(cur);
      const newWorld = new THREE.Quaternion().setFromUnitVectors(curDir, want).multiply(cur);
      const parentWorld = jt.parent!.getWorldQuaternion(new THREE.Quaternion());
      jt.quaternion.copy(parentWorld.invert().multiply(newWorld));
      jt.updateMatrixWorld(true);
    }
    for (const [j, name] of MAP) {
      const bone = this.bone(name);
      if (!bone) continue;
      const qD = rig.joints[j].getWorldQuaternion(new THREE.Quaternion());
      const qB = bone.getWorldQuaternion(new THREE.Quaternion());
      this.links.push({ j, bone, C: qD.invert().multiply(qB) });
    }
    this.hipsOffset = rig.joints.hips.worldToLocal(this.wp('pelvis'));
    for (const [j, e] of saved) rig.joints[j].rotation.copy(e);
    rig.body.rotation.copy(bodyRot);
    rig.root.position.copy(rootPos);
    rig.root.rotation.copy(rootRot);
    rig.root.updateMatrixWorld(true);
  }

  /** Attach a decoration to the bone driven by `j`, in the driver joint's frame and metres. */
  attach(j: JointName, obj: THREE.Object3D) {
    const link = this.links.find((l) => l.j === j);
    if (!link) return;
    const holder = new THREE.Group();
    holder.quaternion.copy(link.C).invert();
    const ws = link.bone.getWorldScale(new THREE.Vector3());
    holder.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
    holder.add(obj);
    link.bone.add(holder);
  }

  clipDuration(name: string) {
    return clips.get(name)?.duration ?? 1;
  }

  /** Golem bone standing in for a UAL bone name (hands, feet, head... for effects that follow the visible body). */
  private gFor(name: string) {
    if (!this.isGolem) return undefined;
    const p = this.gPairs.find((x) => x.d.name === name);
    return p?.g;
  }
  boneWorld(name: string, out = new THREE.Vector3()) {
    const b = this.gFor(name) ?? this.bone(name);
    return b ? b.getWorldPosition(out) : out;
  }

  /** Choose what drives the body this frame: an authored clip, or the procedural rig (null). */
  drive(play: ClipPlay | null) {
    if (!play || !clips.has(play.name)) { this.procTarget = 1; return; }
    this.procTarget = 0;
    if (this.current && this.current.key === play.key) {
      this.current.action.setEffectiveTimeScale(play.speed);
      return;
    }
    const clip = clips.get(play.name)!;
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(play.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !play.loop;
    action.setEffectiveTimeScale(play.speed);
    action.setEffectiveWeight(1);
    if (play.startAt) action.time = play.startAt;
    action.play();
    const fade = play.fade ?? 0.15;
    if (this.current && this.current.action !== action) this.current.action.crossFadeTo(action, fade, true);
    else if (this.procW > 0.5) action.fadeIn(fade * 0.8);
    this.current = { key: play.key, action };
  }

  /** Advance clips and blend in the procedural pose by procW (call after the rig pose is applied). */
  update(dt: number) {
    this.updateDriver(dt);
    this.applyTalk(dt);
    if (this.headTurn) {
      // Portrait-only: turn/tilt the head (and a little of the neck) in world space on top of the pose.
      const { yaw, pitch, roll } = this.headTurn;
      const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0), fwd = new THREE.Vector3(0, 0, 1);
      if (this.model.parent) { const q = this.model.parent.getWorldQuaternion(new THREE.Quaternion()); side.applyQuaternion(q); fwd.applyQuaternion(q); }
      this.rotWorld('neck_01', up, yaw * 0.4); this.rotWorld('Head', up, yaw * 0.6);
      this.rotWorld('Head', side, pitch);
      this.rotWorld('Head', fwd, roll);
    }
    this.retarget();
  }
  /** Extra head turn for studio portraits (radians); unset in play. */
  headTurn: { yaw: number; pitch: number; roll: number } | null = null;

  // ------------------------------------------------------------------ talking (fight intro lines)
  /** Face pieces that move with speech: lips part, the mouth line opens. Registered by looks.ts. */
  talkParts: { o: THREE.Object3D; kind: 'up' | 'down' | 'open' | 'mouth'; p0: THREE.Vector3; s0: THREE.Vector3; q0?: THREE.Quaternion }[] = [];
  private talkTarget = 0;
  /** Smoothed mouth openness 0..1 (read by the fighter to pulse glow accents). */
  talkLevel = 0;
  private talkClock = 0;
  /** Mouth openness for this frame (0..1); call every frame while speaking, 0 when done. */
  setTalk(level: number) { this.talkTarget = THREE.MathUtils.clamp(level, 0, 1); }
  private rotWorld(name: string, axis: THREE.Vector3, angle: number) {
    const b = this.bone(name);
    if (!b || !b.parent || angle === 0) return;
    b.parent.getWorldQuaternion(this.pq);
    b.getWorldQuaternion(this.tq);
    this.sq.setFromAxisAngle(axis, angle).multiply(this.tq);
    b.quaternion.copy(this.pq.invert().multiply(this.sq));
    b.updateMatrixWorld(true);
  }
  private talkAxis = new THREE.Vector3();
  private applyTalk(dt: number) {
    const open = this.talkTarget > this.talkLevel;
    this.talkLevel += (this.talkTarget - this.talkLevel) * Math.min(1, dt * (open ? 28 : 14));
    const s = this.talkLevel;
    if (s < 0.002 && this.talkTarget === 0) {
      if (this.talkClock !== 0) { this.talkClock = 0; for (const p of this.talkParts) { p.o.position.copy(p.p0); p.o.scale.copy(p.s0); if (p.q0) p.o.quaternion.copy(p.q0); if (p.kind === 'mouth') p.o.visible = false; } this.jawU.value = 0; if (this.jawGlow) this.jawGlow.visible = false; }
      return;
    }
    this.talkClock += dt;
    const t = this.talkClock;
    // Gestures on top of whatever clip or pose is playing: nods on emphasis, a little head tilt and torso sway.
    this.model.updateMatrixWorld(true);
    const right = this.talkAxis.set(1, 0, 0).transformDirection(this.model.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(this.model.matrixWorld);
    const up = new THREE.Vector3(0, 1, 0);
    this.rotWorld('spine_03', up, 0.05 * Math.sin(t * 1.7) * Math.min(1, s * 3));
    this.rotWorld('neck_01', right, 0.05 * s + 0.03 * Math.sin(t * 3.1) * s);
    this.rotWorld('Head', right, 0.09 * s * Math.sin(t * 5.2 + 0.6) + 0.04 * s);
    this.rotWorld('Head', fwd, 0.05 * Math.sin(t * 1.9) * Math.min(1, s * 3));
    for (const p of this.talkParts) {
      if (p.kind === 'up') p.o.position.set(p.p0.x, p.p0.y + 0.0035 * s, p.p0.z);
      else if (p.kind === 'mouth') { p.o.visible = s > 0.04; p.o.scale.set(p.s0.x * (0.75 + 0.25 * s), p.s0.y * (0.15 + 1.1 * s), p.s0.z); }
      else if (p.kind !== 'down') p.o.scale.set(p.s0.x * (1 - 0.15 * s), p.s0.y * (1 + 2.5 * s), p.s0.z);
    }
    this.applyJaw(s);
  }

  private updateDriver(dt: number) {
    const rig = this.rig;
    if (!rig) return;
    const k = 1 - Math.exp(-dt / 0.085);
    this.procW += (this.procTarget - this.procW) * k;
    if (Math.abs(this.procW - this.procTarget) < 0.01) this.procW = this.procTarget;
    if (this.procW < 1) this.mixer.update(dt);
    else if (this.current) { this.current.action.stop(); this.current = null; }
    if (this.procW <= 0) return;
    rig.root.updateMatrixWorld(true);
    this.model.updateMatrixWorld(true);
    const w = this.procW;
    const hb = this.bone('pelvis')!;
    const target = rig.joints.hips.localToWorld(this.tv.copy(this.hipsOffset));
    const local = hb.parent!.worldToLocal(target);
    hb.position.lerp(local, w);
    for (const l of this.links) {
      rig.joints[l.j].getWorldQuaternion(this.tq).multiply(l.C);
      l.bone.parent!.getWorldQuaternion(this.pq);
      const want = this.pq.invert().multiply(this.tq);
      if (w >= 1) l.bone.quaternion.copy(want);
      else l.bone.quaternion.slerp(want, w);
      l.bone.updateMatrixWorld(true);
    }
  }
}
