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
  const [male, female, extra] = await Promise.all([
    loader.loadAsync(`${dir}/ual_male.glb`),
    loader.loadAsync(`${dir}/ual_female.glb`),
    loader.loadAsync(`${dir}/ual_anims2.glb`),
  ]);
  maleBase = male.scene;
  femaleBase = female.scene;
  for (const c of [...male.animations, ...extra.animations]) {
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
}

export interface ClipPlay {
  name: string;
  loop: boolean;
  speed: number;
  key: string; // a change of key restarts / crossfades
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
      const mat = new THREE.MeshStandardMaterial({
        color: isJoints ? look.joints : look.body,
        roughness: isJoints ? 0.35 : look.bodyRough,
        metalness: isJoints ? 0.5 : look.bodyMetal,
        emissive: isJoints ? look.joints : 0x000000,
        emissiveIntensity: isJoints ? look.jointGlow : 0,
        flatShading: !isJoints && !!look.flat,
      });
      decorate(mat, isJoints ? 'joints' : 'body');
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
    action.play();
    if (this.current && this.current.action !== action) this.current.action.crossFadeTo(action, 0.12, false);
    else if (this.procW > 0.5) action.fadeIn(0.1);
    this.current = { key: play.key, action };
  }

  /** Advance clips and blend in the procedural pose by procW (call after the rig pose is applied). */
  update(dt: number) {
    const rig = this.rig;
    if (!rig) return;
    const k = 1 - Math.exp(-dt / 0.06);
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
