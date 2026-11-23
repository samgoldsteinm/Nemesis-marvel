import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Rig, JointName, Proportions } from './rig';

// Rigged character bodies. The procedural Rig stays the animation driver (every fighting pose is
// authored there); each frame its joint rotations are retargeted onto a skinned humanoid skeleton
// by copying world-space orientation through a per-bone calibration taken in a shared T-pose.

let base: THREE.Object3D | null = null;

export async function loadBodyModel(url: string) {
  const gltf = await new GLTFLoader().loadAsync(url);
  base = gltf.scene;
}
export function hasBodyModel() {
  return !!base;
}

const MAP: [JointName, string][] = [
  ['hips', 'Hips'], ['spine', 'Spine2'], ['head', 'Head'],
  ['lArm', 'LeftArm'], ['lFore', 'LeftForeArm'], ['rArm', 'RightArm'], ['rFore', 'RightForeArm'],
  ['lThigh', 'LeftUpLeg'], ['lShin', 'LeftLeg'], ['rThigh', 'RightUpLeg'], ['rShin', 'RightLeg'],
];

export interface BodyLook {
  height: number; // target height (top of head)
  bulk: number; // extra width/depth multiplier
  body: number; // body colour
  joints: number; // joint/trim colour
  jointGlow: number; // emissive intensity on the joint material
  bodyRough: number;
  bodyMetal: number;
  flat?: boolean; // faceted shading (rock)
}

export class SkinnedBody {
  model: THREE.Object3D;
  bones = new Map<string, THREE.Bone>();
  proportions: Proportions;
  bodyMat!: THREE.MeshStandardMaterial;
  jointMat!: THREE.MeshStandardMaterial;
  private links: { j: JointName; bone: THREE.Bone; C: THREE.Quaternion }[] = [];
  private hipsOffset = new THREE.Vector3();
  private rig: Rig | null = null;
  private tq = new THREE.Quaternion();
  private pq = new THREE.Quaternion();
  private tv = new THREE.Vector3();

  constructor(public look: BodyLook, decorate: (m: THREE.MeshStandardMaterial, kind: 'body' | 'joints') => void) {
    this.model = SkeletonUtils.clone(base!);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        const name = o.name.replace(/^mixamorig:?/, '');
        this.bones.set(name, o as THREE.Bone);
      }
    });
    // Recolour the two materials per fighter, and give every skinned mesh an outline hull.
    const meshes: THREE.SkinnedMesh[] = [];
    this.model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
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
    // Scale to the target height, with bulk on the horizontal axes.
    this.model.updateMatrixWorld(true);
    const top = this.bone('HeadTop_End') ?? this.bone('Head')!;
    const h = top.getWorldPosition(new THREE.Vector3()).y;
    const s = look.height / h;
    this.model.scale.set(s * look.bulk, s, s * look.bulk);
    this.model.updateMatrixWorld(true);
    for (const m of meshes) this.addOutline(m);
    this.proportions = this.measure();
  }

  bone(name: string) {
    return this.bones.get(name);
  }

  private wp(name: string) {
    return this.bone(name)!.getWorldPosition(new THREE.Vector3());
  }

  /** Rig proportions taken from the model's bind pose so driver hands and feet land on the skin. */
  private measure(): Proportions {
    const hips = this.wp('Hips'), lUp = this.wp('LeftUpLeg'), rUp = this.wp('RightUpLeg'), lLeg = this.wp('LeftLeg'), lFoot = this.wp('LeftFoot');
    const lArm = this.wp('LeftArm'), rArm = this.wp('RightArm'), lFore = this.wp('LeftForeArm'), lHand = this.wp('LeftHand'), head = this.wp('Head');
    const thigh = lUp.distanceTo(lLeg);
    const shin = lLeg.distanceTo(lFoot) + lFoot.y;
    return {
      thigh,
      shin: Math.max(shin, hips.y - thigh) ,
      torso: lArm.y - hips.y,
      shoulderW: lArm.distanceTo(rArm),
      hipW: lUp.distanceTo(rUp),
      upperArm: lArm.distanceTo(lFore),
      foreArm: lFore.distanceTo(lHand),
      neck: Math.max(0.05, head.y - lArm.y),
    };
  }

  private addOutline(m: THREE.SkinnedMesh) {
    // Skinning maps bind-space geometry (metres here) through the bone matrices, so the push is
    // in the model's own units: divide only by the character scale, not the armature's 0.01.
    const sc = this.model.scale;
    const t = 0.011 / Math.max(1e-6, (sc.x + sc.y + sc.z) / 3);
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

  /** Attach the model under the rig root and calibrate against the rig in a T-pose. */
  bind(rig: Rig) {
    this.rig = rig;
    rig.root.add(this.model);
    // Driver T-pose: arms straight out to the sides, everything else neutral.
    const saved = new Map<JointName, THREE.Euler>();
    for (const [j] of MAP) saved.set(j, rig.joints[j].rotation.clone());
    const bodyRot = rig.body.rotation.clone();
    for (const [j] of MAP) rig.joints[j].rotation.set(0, 0, 0);
    rig.joints.lArm.rotation.set(0, 0, Math.PI / 2);
    rig.joints.rArm.rotation.set(0, 0, -Math.PI / 2);
    rig.body.rotation.set(0, 0, 0);
    const rootPos = rig.root.position.clone(), rootRot = rig.root.rotation.clone();
    rig.root.position.set(0, 0, 0);
    rig.root.rotation.set(0, 0, 0);
    rig.root.updateMatrixWorld(true);
    this.model.updateMatrixWorld(true);
    for (const [j, name] of MAP) {
      const bone = this.bone(name);
      if (!bone) continue;
      const qD = rig.joints[j].getWorldQuaternion(new THREE.Quaternion());
      const qB = bone.getWorldQuaternion(new THREE.Quaternion());
      this.links.push({ j, bone, C: qD.invert().multiply(qB) });
    }
    const hb = this.bone('Hips')!;
    this.hipsOffset = rig.joints.hips.worldToLocal(hb.getWorldPosition(new THREE.Vector3()));
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

  /** Copy the driver pose onto the skeleton (call after the rig pose is applied each frame). */
  sync() {
    const rig = this.rig;
    if (!rig) return;
    rig.root.updateMatrixWorld(true);
    // Hips position follows the driver (including lying down and tumbling).
    const hb = this.bone('Hips')!;
    const target = rig.joints.hips.localToWorld(this.tv.copy(this.hipsOffset));
    hb.position.copy(hb.parent!.worldToLocal(target));
    for (const l of this.links) {
      rig.joints[l.j].getWorldQuaternion(this.tq).multiply(l.C);
      l.bone.parent!.getWorldQuaternion(this.pq);
      l.bone.quaternion.copy(this.pq.invert().multiply(this.tq));
      l.bone.updateMatrixWorld(true);
    }
  }
}
