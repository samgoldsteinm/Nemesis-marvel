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
function paintGeometry(m: THREE.SkinnedMesh, paint: Paint) {
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
      acc.r += tmp.r * w; acc.g += tmp.g * w; acc.b += tmp.b * w; wsum += w;
    }
    if (wsum > 0) acc.multiplyScalar(1 / wsum);
    out[k * 3] = acc.r; out[k * 3 + 1] = acc.g; out[k * 3 + 2] = acc.b;
    reg[k] = REGION_ID[bestR];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  geo.setAttribute('region', new THREE.BufferAttribute(reg, 1));
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
  const uniforms = {
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
    diffuseColor.rgb *= clamp(1.0 + dn * uDetail * 2.0, 0.3, 1.6); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uCrack > 0.0 && ((uRegMask >> int(vRegion + 0.5)) & 1) == 1) {
    float e = cellEdge(vBindP * uScale * uCrackScale + vec3(fbm(vBindP * uScale * 6.0)) * 0.6);
    float c = 1.0 - smoothstep(uCrackWidth * 0.4, uCrackWidth, e);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35, c);
    totalEmissiveRadiance += uCrackColor * c * uCrack; }`);
  };
  mat.customProgramCacheKey = () => prevKey + `|detail${kindId}${cr ? 'c' : ''}`;
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
    this.inner = SkeletonUtils.clone((look.female ? femaleBase : maleBase) ?? maleBase!);
    this.model = new THREE.Group();
    this.model.add(this.inner);
    this.inner.traverse((o) => { if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone); });
    const meshes: THREE.SkinnedMesh[] = [];
    this.inner.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
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
    for (const m of meshes) this.addOutline(m, s);
    this.proportions = this.measure();
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

  boneWorld(name: string, out = new THREE.Vector3()) {
    const b = this.bone(name);
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
