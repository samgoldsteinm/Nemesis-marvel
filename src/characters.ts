import * as THREE from 'three';
import { Rig, Proportions, Pose, P, limb, box, sphere, addOutline, torso } from './rig';
import type { SkinnedBody, BodyLook } from './skinned';
import { LOOKS } from './looks';

export type RecoveryFamily = 'ground' | 'swing' | 'flight' | 'teleport';
export type LiftClass = 0 | 1 | 2; // light, medium, heavy

export interface HitSpec {
  fwd: number; // hit center forward of fighter
  up: number; // height
  radius: number;
  stamina: number; // recoverable damage
  health: number; // lasting damage
  kbF: number; // knockback forward speed
  kbU: number; // knockback up speed
  stun: number; // hitstun ticks
  launch?: boolean;
  heavy?: boolean;
  breaksWalls?: number; // wall damage on contact
}

export type Special =
  | 'thunderclap' | 'groundPound' | 'bolt' | 'snare' | 'pulse' | 'blinkStrike' | 'counter' | 'dash'
  | 'quake' | 'tripleSnare' | 'bigbolt' | 'mines' | 'slingshot' | 'propSwing'
  | 'swap' | 'portalPunch' | 'riftStorm' | 'shadeRend' | 'implode' | 'fireball';

/** Which limb draws the strike swoosh. */
export type Limb = 'rh' | 'lh' | 'rf' | 'lf' | 'both';

export interface MoveDef {
  id: string;
  wind: () => Pose;
  strike: () => Pose;
  startup: number;
  active: number;
  recovery: number;
  hit?: HitSpec;
  lunge?: number; // forward speed during startup+active
  energy?: number;
  special?: Special;
  riseV?: number; // vertical velocity applied when active begins
  airOk?: boolean;
  limb?: Limb;
  name?: string; // display name for the move sheet
}

export type PowerGrapple = 'piledriver' | 'webSpin' | 'skyDrop' | 'displace' | 'portalDrop' | 'shadowShred' | 'ironMaiden' | 'furnaceSlam';

export interface CharacterDef {
  id: string;
  name: string;
  title: string;
  blurb: string;
  color: string; // UI accent
  recovery: RecoveryFamily;
  lift: LiftClass;
  speed: number;
  jumpV: number;
  weight: number; // knockback resistance (1 = normal)
  heavy: number; // 0..1 animation weight
  radius: number;
  height: number;
  durability: number; // stamina recovery multiplier
  proportions: Proportions;
  moves: {
    chain: MoveDef[];
    airRise: MoveDef;
    airDive: MoveDef;
    mobilityAtk: MoveDef;
    power: MoveDef;
    powerAir: MoveDef;
    counter: MoveDef;
    runAttack: MoveDef; // A while running
    dashPower: MoveDef; // R+A while running
    chargePower: MoveDef; // hold R+A
  };
  powerGrapple: PowerGrapple; // R+X on an opponent not in Danger
  sheet: { mobility: string; power: string; grapple: string; finisher: string; weakness: string; moves: [string, string][] };
  build: (rig: Rig) => { accents: THREE.MeshStandardMaterial[] };
  /** Rigged-body look and bone-attached decorations (used when the skinned model is loaded). */
  look?: BodyLook;
  /** X at range: pull opponents (if fighters) and props up to maxCls toward you. */
  rangedGrab?: { fighters: boolean; maxCls: LiftClass; range: number };
  lineColor?: number;
  /** Colour of teleport / phase effects (defaults to cyan). */
  fxColor?: number;
  /** Heavy hits set the target burning (damage over time). */
  burns?: boolean;
  /** Small constant flame wisps from the hands. */
  embers?: boolean;
  adorn?: (b: SkinnedBody, rig: Rig) => THREE.MeshStandardMaterial[];
}

/** Material finishing shared by procedural and skinned bodies. */
export function finishMaterial(m: THREE.MeshStandardMaterial, kind: 'body' | 'joints', _flat = false) {
  // Skinned bodies are smooth sculpts: no bump noise (it moirés on their UVs), just the rim light.
  addRim(m, kind === 'body' ? 0.3 : 0.15);
}

// ------------------------------------------------------------------ shared moves
const jab = (dmg = 5, reach = 0.95): MoveDef => ({
  id: 'jab', limb: 'rh', wind: P.jabW, strike: P.jabS, startup: 5, active: 4, recovery: 9, lunge: 2.5,
  hit: { fwd: reach, up: 1.3, radius: 0.55, stamina: dmg, health: 0, kbF: 2, kbU: 0, stun: 16 },
});
const cross = (dmg = 6, reach = 1.0): MoveDef => ({
  id: 'cross', limb: 'lh', wind: P.crossW, strike: P.crossS, startup: 6, active: 4, recovery: 11, lunge: 3,
  hit: { fwd: reach, up: 1.3, radius: 0.6, stamina: dmg, health: 0, kbF: 2.5, kbU: 0, stun: 18 },
});
const launcher = (dmg: number, reach: number, kbF: number, kbU: number, extra: Partial<MoveDef> = {}): MoveDef => ({
  id: 'launcher', limb: 'rh', wind: P.upperW, strike: P.upperS, startup: 10, active: 5, recovery: 18, lunge: 3.5,
  hit: { fwd: reach, up: 1.4, radius: 0.7, stamina: dmg, health: 2, kbF, kbU, stun: 30, launch: true, heavy: true, breaksWalls: 25 },
  ...extra,
});
const airRise = (dmg = 6): MoveDef => ({
  id: 'airRise', limb: 'lf', wind: P.upperW, strike: P.kickS, startup: 4, active: 6, recovery: 10, airOk: true,
  hit: { fwd: 0.9, up: 1.5, radius: 0.75, stamina: dmg, health: 0, kbF: 4, kbU: 9, stun: 26, launch: true },
});
const airDive = (dmg = 8): MoveDef => ({
  id: 'airDive', limb: 'both', wind: P.overheadW, strike: P.diveS, startup: 6, active: 10, recovery: 12, airOk: true, riseV: -14,
  hit: { fwd: 0.8, up: 0.6, radius: 0.85, stamina: dmg, health: 1, kbF: 6, kbU: 3, stun: 28, launch: true, heavy: true },
});
const counter = (): MoveDef => ({
  id: 'counter', limb: 'lf', wind: P.crossW, strike: P.kickS, startup: 3, active: 5, recovery: 14, lunge: 6, special: 'counter',
  hit: { fwd: 1.0, up: 1.2, radius: 0.8, stamina: 10, health: 3, kbF: 9, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 20 },
});

/** A melee swing with a held light prop (A while carrying). */
export const PROP_SWING: MoveDef = {
  id: 'propSwing', limb: 'both', wind: P.overheadW, strike: P.slamS, startup: 9, active: 5, recovery: 14, lunge: 3, special: 'propSwing',
  hit: { fwd: 1.4, up: 1.2, radius: 0.9, stamina: 7, health: 5, kbF: 8, kbU: 4, stun: 26, heavy: true, breaksWalls: 20 },
};

// ------------------------------------------------------------------ materials
// Shared surface detail: a fine noise bump map (cloth weave / rock grain) for every body material.
let bumpTex: THREE.Texture | null = null;
function bump() {
  if (bumpTex) return bumpTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const x = (i / 4) % 128, y = Math.floor(i / 4 / 128);
    const v = 128 + 50 * Math.sin(x * 0.9) * Math.sin(y * 0.9) + (Math.random() - 0.5) * 90;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  bumpTex = new THREE.CanvasTexture(c);
  bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
  bumpTex.repeat.set(3, 3);
  return bumpTex;
}

/** Fresnel rim light so silhouettes separate from busy backgrounds. */
/** Rim light colour shared by every fighter; each venue tints it (warm roof, teal overpass). */
export const RIM_COLOR = { value: new THREE.Color(0.62, 0.78, 0.9) };
function addRim(m: THREE.MeshStandardMaterial, strength = 0.5) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = RIM_COLOR;
    sh.fragmentShader = 'uniform vec3 rimColor;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
      { float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
        float rimF = smoothstep(0.0, 1.0, pow(1.0 - ndv, 2.2));
        gl_FragColor.rgb += rimColor * rimF * ${strength.toFixed(2)}; }`);
  };
  m.customProgramCacheKey = () => `rim${strength}`;
}

function mat(color: number, rough = 0.6, metal = 0.1, emissive = 0x000000, ei = 0, flat = false) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei, flatShading: flat });
  if (ei === 0) { m.bumpMap = bump(); m.bumpScale = flat ? 3 : 1.2; }
  addRim(m, flat ? 0.22 : 0.28);
  return m;
}

// ------------------------------------------------------------------ BASALT — heavy, ground recovery
const basalt: CharacterDef = {
  id: 'basalt',
  name: 'BASALT',
  title: 'The Walking Quarry',
  blurb: 'Heavy lifter. Throws what others cannot move, but a long launch near an open edge is fatal.',
  color: '#ff7a3a',
  recovery: 'ground',
  lift: 2,
  speed: 5.6,
  jumpV: 10.5,
  weight: 1.6,
  heavy: 1,
  radius: 0.75,
  height: 2.3,
  durability: 1.35,
  proportions: { thigh: 0.55, shin: 0.5, torso: 0.95, shoulderW: 1.25, hipW: 0.55, upperArm: 0.62, foreArm: 0.62, neck: 0.12 },
  moves: {
    chain: [jab(7, 1.15), cross(8, 1.2), launcher(12, 1.25, 11, 7, { id: 'hammer', wind: P.overheadW, strike: P.slamS, startup: 13 })],
    airRise: airRise(8),
    airDive: airDive(11),
    mobilityAtk: {
      id: 'shoulder', wind: P.evade, strike: P.jabS, startup: 8, active: 12, recovery: 16, lunge: 13,
      hit: { fwd: 1.0, up: 1.2, radius: 0.95, stamina: 10, health: 4, kbF: 13, kbU: 5, stun: 30, launch: true, heavy: true, breaksWalls: 60 },
    },
    power: {
      id: 'thunderclap', wind: P.clapW, strike: P.clapS, startup: 16, active: 4, recovery: 24, energy: 25, special: 'thunderclap',
      hit: { fwd: 3.2, up: 1.2, radius: 2.6, stamina: 12, health: 8, kbF: 14, kbU: 5, stun: 34, launch: true, heavy: true, breaksWalls: 40 },
    },
    powerAir: {
      id: 'groundPound', wind: P.overheadW, strike: P.slamS, startup: 8, active: 40, recovery: 22, energy: 25, special: 'groundPound', airOk: true, riseV: -26,
      hit: { fwd: 0, up: 0.4, radius: 3.4, stamina: 12, health: 9, kbF: 10, kbU: 9, stun: 34, launch: true, heavy: true, breaksWalls: 30 },
    },
    counter: counter(),
    runAttack: {
      id: 'lariat', name: 'Lariat', limb: 'both', wind: P.crossW, strike: P.clapW, startup: 7, active: 7, recovery: 15, lunge: 9,
      hit: { fwd: 0.9, up: 1.4, radius: 1.0, stamina: 9, health: 2, kbF: 9, kbU: 5, stun: 28, launch: true, heavy: true, breaksWalls: 30 },
    },
    dashPower: {
      id: 'avalanche', name: 'Avalanche Charge', limb: 'both', wind: P.evade, strike: P.jabS, startup: 10, active: 16, recovery: 20, lunge: 15, energy: 25,
      hit: { fwd: 1.1, up: 1.2, radius: 1.1, stamina: 14, health: 10, kbF: 16, kbU: 6, stun: 36, launch: true, heavy: true, breaksWalls: 100 },
    },
    chargePower: {
      id: 'tectonic', name: 'Tectonic Slam', limb: 'both', wind: P.overheadW, strike: P.slamS, startup: 6, active: 4, recovery: 30, energy: 20, special: 'quake',
      hit: { fwd: 0, up: 0.5, radius: 4.8, stamina: 16, health: 14, kbF: 12, kbU: 11, stun: 40, launch: true, heavy: true, breaksWalls: 70 },
    },
  },
  powerGrapple: 'piledriver',
  sheet: {
    mobility: 'LB: Sprint — LB+X shoulder charge breaks walls',
    power: 'RT+X: Thunderclap shockwave cone · in air: Ground Pound',
    grapple: 'Lifts every prop class, including the fuel tank. Planted heavy throw.',
    finisher: 'Quarry Drop — lifts and spikes the opponent through the roof deck',
    weakness: 'Ground recovery only brakes a launch and hops him back a little; off a long launch near an open edge he still falls.',
    moves: [['X X X', 'Body punch, hook, hammer launcher'], ['X (running)', 'Lariat'], ['RT+X', 'Thunderclap cone'], ['RT+X (running)', 'Avalanche Charge — smashes barriers'], ['Hold RT+X', 'Tectonic Slam — huge quake'], ['RT+X (air)', 'Ground Pound'], ['LB+X', 'Shoulder charge'], ['RT+Y', 'Piledriver'], ['Grab, X', 'Knee pummel']],
  },
  build(rig) {
    const rock = mat(0x5a6a80, 0.9, 0.05, 0x000000, 0, true);
    const rock2 = mat(0x3c4757, 0.92, 0.05, 0x000000, 0, true);
    const magma = mat(0xff5a1a, 0.4, 0, 0xff4a10, 1.6);
    const j = rig.joints;
    box(j.hips, 0.75, 0.4, 0.5, rock2, [0, 0.05, 0]);
    box(j.spine, 0.95, 0.55, 0.62, rock, [0, 0.38, 0.02]);
    box(j.spine, 1.3, 0.55, 0.78, rock, [0, 0.8, 0.02]);
    box(j.spine, 0.42, 0.42, 0.42, rock2, [0.62, 1.0, 0], [0, 0, 0.3]);
    box(j.spine, 0.42, 0.42, 0.42, rock2, [-0.62, 1.0, 0], [0, 0, -0.3]);
    box(j.spine, 0.9, 0.06, 0.05, magma, [0, 0.62, 0.36], undefined, false);
    box(j.spine, 0.06, 0.6, 0.05, magma, [0.18, 0.75, 0.4], [0, 0, 0.2], false);
    box(j.spine, 0.05, 0.4, 0.05, magma, [-0.25, 0.4, 0.33], [0, 0, -0.3], false);
    box(j.head, 0.42, 0.38, 0.42, rock, [0, 0.12, 0.08]);
    box(j.head, 0.46, 0.1, 0.2, rock2, [0, 0.26, 0.22]);
    box(j.head, 0.3, 0.05, 0.03, magma, [0, 0.16, 0.3], undefined, false);
    for (const [a, f, s] of [[j.lArm, j.lFore, 1], [j.rArm, j.rFore, -1]] as const) {
      limb(a, 0.62, 0.22, 0.2, rock);
      box(a, 0.3, 0.3, 0.3, rock2, [s * 0.05, -0.3, 0.05], [0.3, 0.2, 0.2]);
      limb(f, 0.5, 0.2, 0.22, rock);
      box(f, 0.38, 0.36, 0.38, rock2, [0, -0.62, 0.02]);
      box(f, 0.04, 0.3, 0.04, magma, [s * 0.12, -0.25, 0.18], undefined, false);
    }
    for (const [t, sh] of [[j.lThigh, j.lShin], [j.rThigh, j.rShin]] as const) {
      limb(t, 0.55, 0.25, 0.21, rock);
      limb(sh, 0.45, 0.21, 0.24, rock);
      box(sh, 0.36, 0.14, 0.5, rock2, [0, -0.48, 0.08]);
    }
    // Back boulders, knuckle stones and a cracked magma core in the chest.
    for (const [x, y, z, r] of [[0.25, 0.95, -0.42, 0.22], [-0.3, 0.75, -0.4, 0.2], [0, 0.45, -0.36, 0.18]] as const) {
      const b = sphere(j.spine, r, rock2, [x, y, z]);
      b.scale.set(1.2, 0.9, 0.8);
    }
    for (const f of [j.lFore, j.rFore]) for (const x of [-0.12, 0.0, 0.12]) box(f, 0.1, 0.1, 0.1, rock, [x, -0.8, 0.17], [0.3, 0.2, 0.1]);
    sphere(j.spine, 0.11, magma, [0, 0.78, 0.4], [1.3, 1, 0.6], false);
    box(j.hips, 0.85, 0.12, 0.56, rock2, [0, 0.22, 0]);
    return { accents: [magma] };
  },
};

// ------------------------------------------------------------------ TETHER — swing recovery
const tether: CharacterDef = {
  id: 'tether',
  name: 'TETHER',
  title: 'Line Runner',
  blurb: 'Fast, light and slippery. Swings on grapple lines, sticks to walls and yanks targets from range.',
  color: '#27e0c8',
  recovery: 'swing',
  rangedGrab: { fighters: true, maxCls: 0, range: 11 },
  lift: 0,
  speed: 7.6,
  jumpV: 12.5,
  weight: 0.85,
  heavy: 0,
  radius: 0.45,
  height: 1.95,
  durability: 0.9,
  proportions: { thigh: 0.5, shin: 0.5, torso: 0.64, shoulderW: 0.6, hipW: 0.26, upperArm: 0.35, foreArm: 0.33, neck: 0.1 },
  moves: {
    chain: [jab(4, 0.9), cross(5, 0.95), launcher(8, 1.0, 7, 10, { id: 'flipkick', wind: P.upperW, strike: P.kickS, startup: 8 })],
    airRise: airRise(6),
    airDive: airDive(7),
    mobilityAtk: {
      id: 'swingKick', wind: P.swing.bind(null, 0), strike: P.kickS, startup: 4, active: 10, recovery: 12, lunge: 4, airOk: true,
      hit: { fwd: 0.9, up: 1.0, radius: 0.9, stamina: 9, health: 3, kbF: 12, kbU: 5, stun: 28, launch: true, heavy: true, breaksWalls: 25 },
    },
    power: {
      id: 'snare', wind: P.shoot, strike: P.shoot, startup: 9, active: 2, recovery: 16, energy: 20, special: 'snare', airOk: true,
    },
    powerAir: {
      id: 'snareAir', wind: P.shoot, strike: P.shoot, startup: 8, active: 2, recovery: 14, energy: 20, special: 'snare', airOk: true,
    },
    counter: counter(),
    runAttack: {
      id: 'slideKick', name: 'Slide Trip', limb: 'lf', wind: P.evade, strike: P.kickS, startup: 5, active: 8, recovery: 12, lunge: 10,
      hit: { fwd: 0.9, up: 0.5, radius: 0.8, stamina: 7, health: 1, kbF: 4, kbU: 8, stun: 26, launch: true },
    },
    dashPower: {
      id: 'slingshot', name: 'Line Slingshot', limb: 'lf', wind: P.shoot, strike: P.kickS, startup: 7, active: 10, recovery: 14, energy: 20, special: 'slingshot', airOk: true,
      hit: { fwd: 0.9, up: 1.1, radius: 0.9, stamina: 10, health: 7, kbF: 13, kbU: 7, stun: 32, launch: true, heavy: true, breaksWalls: 40 },
    },
    chargePower: { id: 'tripleSnare', name: 'Snare Spread', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 4, active: 2, recovery: 18, energy: 15, special: 'tripleSnare' },
  },
  powerGrapple: 'webSpin',
  sheet: {
    mobility: 'LB: Line swing (hold) · sticks to walls on contact · LB+X swing kick',
    power: 'RT+X: Snare bolt — binds the target briefly',
    grapple: 'Y at range: line-yank opponent or light prop. Lifts light props only.',
    finisher: 'Cocoon Spin — binds, spins and flings',
    weakness: 'Cannot lift medium or heavy props; low weight means long launches.',
    moves: [['X X X', 'Jab, roundhouse, spinning kick'], ['X (running)', 'Slide Trip'], ['RT+X', 'Snare bolt'], ['RT+X (running)', 'Line Slingshot — pulls in with a kick'], ['Hold RT+X', 'Snare Spread — three bolts'], ['LB+X', 'Swing kick'], ['Y (range)', 'Line yank'], ['RT+Y', 'Line Spin — fling for a ring-out'], ['Grab, X', 'Knee pummel']],
  },
  build(rig) {
    const suit = mat(0x109c8e, 0.45, 0.15);
    const dark = mat(0x12151c, 0.5, 0.2);
    const gold = mat(0xe8b520, 0.3, 0.8, 0x6a4800, 0.4);
    const lens = mat(0xe8fbff, 0.2, 0, 0x9ff7ff, 1.4);
    const j = rig.joints;
    box(j.hips, 0.34, 0.22, 0.24, dark, [0, 0.02, 0]);
    torso(j.spine, 0.15, 0.22, 0.66, suit, 1.3, 0.78);
    box(j.spine, 0.08, 0.55, 0.02, dark, [0, 0.35, 0.2], undefined, false);
    box(j.spine, 0.5, 0.06, 0.02, dark, [0, 0.5, 0.21], undefined, false);
    sphere(j.head, 0.17, suit, [0, 0.12, 0], [1, 1.15, 1.05]);
    sphere(j.head, 0.07, lens, [0.07, 0.15, 0.13], [1.1, 0.75, 0.5], false);
    sphere(j.head, 0.07, lens, [-0.07, 0.15, 0.13], [1.1, 0.75, 0.5], false);
    for (const [a, f] of [[j.lArm, j.lFore], [j.rArm, j.rFore]] as const) {
      limb(a, 0.33, 0.075, 0.065, suit);
      limb(f, 0.3, 0.065, 0.055, dark);
      box(f, 0.11, 0.12, 0.13, gold, [0, -0.22, 0.02]);
      sphere(f, 0.06, dark, [0, -0.35, 0]);
    }
    for (const [t, sh] of [[j.lThigh, j.lShin], [j.rThigh, j.rShin]] as const) {
      limb(t, 0.46, 0.1, 0.08, suit);
      limb(sh, 0.42, 0.08, 0.065, dark);
      box(sh, 0.11, 0.07, 0.24, dark, [0, -0.45, 0.06]);
    }
    // Chest emblem (a hooked line), belt with launcher cartridges, boots and mask seams.
    const em = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 6, 16, Math.PI * 1.4), gold);
    em.position.set(0, 0.46, 0.215);
    em.rotation.z = -0.6;
    j.spine.add(em);
    box(j.spine, 0.02, 0.2, 0.02, gold, [0.07, 0.37, 0.215], [0, 0, 0.25], false);
    box(j.hips, 0.4, 0.07, 0.27, dark, [0, 0.12, 0]);
    for (const x of [-0.14, -0.05, 0.05, 0.14]) box(j.hips, 0.05, 0.08, 0.04, gold, [x, 0.12, 0.15], undefined, false);
    for (const sh of [j.lShin, j.rShin]) box(sh, 0.13, 0.2, 0.15, dark, [0, -0.33, 0.01]);
    box(j.head, 0.02, 0.24, 0.02, dark, [0, 0.16, 0.17], [0.3, 0, 0], false);
    for (const a of [j.lArm, j.rArm]) box(a, 0.15, 0.08, 0.15, dark, [0, -0.02, 0]);
    j.head.scale.setScalar(0.86);
    return { accents: [lens, gold] };
  },
};

// ------------------------------------------------------------------ AERIN — flight recovery
const aerin: CharacterDef = {
  id: 'aerin',
  name: 'AERIN VOLT',
  title: 'Storm Kite',
  blurb: 'Sustained flight and ranged bolts. Flight drains energy, so she must land to recharge.',
  color: '#a77bff',
  recovery: 'flight',
  lift: 0,
  speed: 6.6,
  jumpV: 11.5,
  weight: 0.9,
  heavy: 0,
  radius: 0.45,
  height: 1.95,
  durability: 1.0,
  proportions: { thigh: 0.52, shin: 0.5, torso: 0.6, shoulderW: 0.5, hipW: 0.28, upperArm: 0.33, foreArm: 0.31, neck: 0.11 },
  moves: {
    chain: [jab(4, 0.9), cross(5, 0.95), launcher(8, 1.0, 8, 9)],
    airRise: airRise(6),
    airDive: airDive(7),
    mobilityAtk: {
      id: 'flightDash', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 12, recovery: 12, lunge: 15, airOk: true, energy: 12,
      hit: { fwd: 0.9, up: 1.0, radius: 0.85, stamina: 9, health: 3, kbF: 13, kbU: 4, stun: 20, launch: true, heavy: true, breaksWalls: 25 },
    },
    power: { id: 'bolt', wind: P.shoot, strike: P.shoot, startup: 7, active: 2, recovery: 12, energy: 12, special: 'bolt', airOk: true },
    powerAir: { id: 'boltAir', wind: P.shoot, strike: P.shoot, startup: 6, active: 2, recovery: 10, energy: 12, special: 'bolt', airOk: true },
    counter: counter(),
    runAttack: {
      id: 'spinKick', name: 'Gale Kick', limb: 'lf', wind: P.crossW, strike: P.kickS, startup: 6, active: 6, recovery: 12, lunge: 8,
      hit: { fwd: 0.9, up: 1.2, radius: 0.9, stamina: 8, health: 1, kbF: 8, kbU: 3, stun: 24 },
    },
    dashPower: {
      id: 'stormDash', name: 'Storm Dash', limb: 'both', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 14, recovery: 14, lunge: 18, energy: 20, airOk: true,
      hit: { fwd: 0.9, up: 1.0, radius: 1.0, stamina: 10, health: 8, kbF: 12, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 40 },
    },
    chargePower: { id: 'chainLightning', name: 'Chain Lightning', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 4, active: 2, recovery: 20, energy: 15, special: 'bigbolt', airOk: true },
  },
  powerGrapple: 'skyDrop',
  sheet: {
    mobility: 'LB: Toggle flight (A rise, B sink) · LB+X flight dash',
    power: 'RT+X: Volt bolt — lasting damage, deflectable by super block',
    grapple: 'Lifts light props only.',
    finisher: 'Skyfall — carries the opponent up and drives them down in a lightning strike',
    weakness: 'Flight burns energy; caught charging on the ground she is exposed.',
    moves: [['X X X', 'Spark palm, push kick, high kick'], ['X (running)', 'Gale Kick'], ['RT+X', 'Volt bolt'], ['RT+X (running)', 'Storm Dash'], ['Hold RT+X', 'Chain Lightning — heavy bolt'], ['LB', 'Flight (A up, B down)'], ['LB+X', 'Flight dash'], ['RT+Y', 'Skyfall Drop'], ['Grab, X', 'Knee pummel']],
  },
  build(rig) {
    const white = mat(0xe8e6f4, 0.4, 0.15);
    const violet = mat(0x6d36f0, 0.4, 0.2);
    const skin = mat(0xc68f6e, 0.7, 0);
    const hair = mat(0xf1f1ff, 0.6, 0.1);
    const glow = mat(0xc9a8ff, 0.2, 0, 0xa070ff, 1.8);
    const j = rig.joints;
    box(j.hips, 0.32, 0.2, 0.22, violet, [0, 0.02, 0]);
    torso(j.spine, 0.13, 0.19, 0.62, violet, 1.25, 0.8);
    torso(j.spine, 0.12, 0.2, 0.3, white, 1.22, 0.86, 0.34);
    box(j.spine, 0.04, 0.4, 0.02, glow, [0, 0.33, 0.18], [0, 0, 0.5], false);
    sphere(j.head, 0.15, skin, [0, 0.12, 0.01], [0.95, 1.12, 1.0]);
    sphere(j.head, 0.18, hair, [0, 0.18, -0.05], [1.05, 1.0, 1.05]);
    box(j.head, 0.2, 0.04, 0.03, glow, [0, 0.14, 0.14], undefined, false);
    for (const [a, f] of [[j.lArm, j.lFore], [j.rArm, j.rFore]] as const) {
      limb(a, 0.33, 0.07, 0.06, white);
      limb(f, 0.29, 0.06, 0.05, violet);
      sphere(f, 0.06, glow, [0, -0.33, 0], undefined, false);
    }
    for (const [t, sh] of [[j.lThigh, j.lShin], [j.rThigh, j.rShin]] as const) {
      limb(t, 0.48, 0.095, 0.075, violet);
      limb(sh, 0.44, 0.075, 0.06, white);
    }
    // Energy wings: original geometric kite shapes.
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(1.15, 0.55);
    wingShape.lineTo(0.95, -0.15);
    wingShape.lineTo(1.25, -0.65);
    wingShape.lineTo(0.15, -0.35);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ShapeGeometry(wingShape);
    const wingMat = new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const lw = new THREE.Mesh(wingGeo, wingMat);
    lw.position.set(0.08, 0.05, -0.16);
    lw.rotation.y = -0.5;
    const rw = new THREE.Mesh(wingGeo, wingMat);
    rw.scale.x = -1;
    rw.position.set(-0.08, 0.05, -0.16);
    rw.rotation.y = 0.5;
    rig.chestAnchor.add(lw, rw);
    (rig as any).wings = [lw, rw];
    // Ponytail, glowing pauldrons, belt and boots.
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 8), hair);
    tail.position.set(0, 0.05, -0.2);
    tail.rotation.x = 2.6;
    tail.castShadow = true;
    j.head.add(tail);
    for (const [a, sx] of [[j.lArm, 1], [j.rArm, -1]] as const) {
      const pad = sphere(a, 0.1, violet, [sx * 0.03, 0.02, 0]);
      pad.scale.set(1.1, 0.7, 1.1);
      box(a, 0.06, 0.02, 0.1, glow, [sx * 0.06, 0.07, 0], undefined, false);
    }
    box(j.hips, 0.36, 0.06, 0.25, glow, [0, 0.12, 0], undefined, false);
    for (const sh of [j.lShin, j.rShin]) { box(sh, 0.12, 0.22, 0.14, white, [0, -0.33, 0.01]); box(sh, 0.11, 0.06, 0.22, white, [0, -0.45, 0.05]); }
    j.head.scale.setScalar(0.86);
    return { accents: [glow] };
  },
};

// ------------------------------------------------------------------ SHUNT — teleport recovery
const shunt: CharacterDef = {
  id: 'shunt',
  name: 'SHUNT',
  title: 'The Displaced',
  blurb: 'Teleports in short hops, flanks and leaves pulse charges. Fragile if pinned down.',
  color: '#37f2ff',
  recovery: 'teleport',
  lift: 0,
  speed: 6.4,
  jumpV: 11,
  weight: 0.95,
  heavy: 0.2,
  radius: 0.5,
  height: 2.0,
  durability: 0.95,
  proportions: { thigh: 0.53, shin: 0.51, torso: 0.68, shoulderW: 0.64, hipW: 0.3, upperArm: 0.36, foreArm: 0.35, neck: 0.1 },
  moves: {
    chain: [jab(5, 0.95), cross(5, 1.0), launcher(9, 1.05, 9, 8)],
    airRise: airRise(6),
    airDive: airDive(8),
    mobilityAtk: {
      id: 'blinkStrike', wind: P.teleport, strike: P.kickS, startup: 10, active: 6, recovery: 14, special: 'blinkStrike', energy: 10,
      hit: { fwd: 1.0, up: 1.2, radius: 0.9, stamina: 9, health: 4, kbF: 11, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 25 },
    },
    power: {
      id: 'pulse', wind: P.charge.bind(null, 0), strike: P.clapW, startup: 12, active: 4, recovery: 20, energy: 22, special: 'pulse', airOk: true,
      hit: { fwd: 0, up: 1.0, radius: 2.8, stamina: 10, health: 7, kbF: 12, kbU: 7, stun: 32, launch: true, heavy: true, breaksWalls: 30 },
    },
    powerAir: {
      id: 'pulseAir', wind: P.charge.bind(null, 0), strike: P.clapW, startup: 10, active: 4, recovery: 18, energy: 22, special: 'pulse', airOk: true,
      hit: { fwd: 0, up: 1.0, radius: 2.8, stamina: 10, health: 7, kbF: 12, kbU: 7, stun: 32, launch: true, heavy: true, breaksWalls: 30 },
    },
    counter: counter(),
    runAttack: {
      id: 'phaseElbow', name: 'Phase Elbow', limb: 'rh', wind: P.crossW, strike: P.crossS, startup: 6, active: 6, recovery: 12, lunge: 9,
      hit: { fwd: 1.0, up: 1.3, radius: 0.85, stamina: 8, health: 1, kbF: 9, kbU: 2, stun: 24 },
    },
    dashPower: {
      id: 'phaseLunge', name: 'Phase Lunge', limb: 'lf', wind: P.teleport, strike: P.kickS, startup: 8, active: 6, recovery: 14, special: 'blinkStrike', energy: 20,
      hit: { fwd: 1.0, up: 1.2, radius: 0.95, stamina: 11, health: 8, kbF: 13, kbU: 7, stun: 32, launch: true, heavy: true, breaksWalls: 40 },
    },
    chargePower: { id: 'mineTrail', name: 'Pulse Mines', limb: 'both', wind: P.charge.bind(null, 0), strike: P.clapW, startup: 4, active: 2, recovery: 16, energy: 15, special: 'mines' },
  },
  powerGrapple: 'displace',
  sheet: {
    mobility: 'LB+direction: Hop-teleport · LB neutral: flank behind opponent · LB+X blink strike',
    power: 'RT+X: Displacement pulse — radial blast',
    grapple: 'Lifts light props only.',
    finisher: 'Scatter — a chain of teleport strikes from every side',
    weakness: 'Teleports cost energy; with an empty meter he has no way back from a launch.',
    moves: [['X X X', 'Blade cut, diagonal slash, sweeping slash'], ['X (running)', 'Phase Elbow'], ['RT+X', 'Displacement pulse'], ['RT+X (running)', 'Phase Lunge — blink behind and strike'], ['Hold RT+X', 'Pulse Mines — three proximity charges'], ['LB + dir / LB', 'Hop / flank teleport'], ['LB+X', 'Blink strike'], ['RT+Y', 'Displace — teleports the victim away (off an edge!)'], ['Grab, X', 'Knee pummel']],
  },
  build(rig) {
    const coat = mat(0x2b303c, 0.7, 0.2);
    const under = mat(0x171a22, 0.6, 0.25);
    const cyan = mat(0x37f2ff, 0.2, 0, 0x20e0ff, 1.6);
    const mask = mat(0xb9c3cf, 0.35, 0.6);
    const j = rig.joints;
    box(j.hips, 0.4, 0.24, 0.26, under, [0, 0.02, 0]);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 0.75, 10, 1, true), coat);
    (skirt.material as THREE.Material).side = THREE.DoubleSide;
    skirt.position.y = -0.3;
    skirt.castShadow = true;
    j.hips.add(skirt);
    torso(j.spine, 0.16, 0.24, 0.7, coat, 1.3, 0.8);
    box(j.spine, 0.05, 0.5, 0.03, cyan, [0.09, 0.35, 0.2], undefined, false);
    box(j.spine, 0.05, 0.5, 0.03, cyan, [-0.09, 0.35, 0.2], undefined, false);
    sphere(j.head, 0.17, mask, [0, 0.12, 0], [0.95, 1.15, 1.0]);
    box(j.head, 0.24, 0.05, 0.05, cyan, [0, 0.15, 0.15], undefined, false);
    const hood = sphere(j.head, 0.21, coat, [0, 0.15, -0.05], [1.05, 1.1, 1.05]);
    hood.scale.set(1.05, 1.1, 1.05);
    for (const [a, f] of [[j.lArm, j.lFore], [j.rArm, j.rFore]] as const) {
      limb(a, 0.35, 0.085, 0.075, coat);
      limb(f, 0.32, 0.07, 0.06, under);
      box(f, 0.1, 0.03, 0.12, cyan, [0, -0.2, 0.05], undefined, false);
    }
    for (const [t, sh] of [[j.lThigh, j.lShin], [j.rThigh, j.rShin]] as const) {
      limb(t, 0.5, 0.1, 0.08, under);
      limb(sh, 0.44, 0.08, 0.065, under);
      box(sh, 0.12, 0.08, 0.26, coat, [0, -0.46, 0.06]);
    }
    // Shoulder plates, a displacement core on the back, belt and boots.
    for (const [a, sx] of [[j.lArm, 1], [j.rArm, -1]] as const) {
      box(a, 0.2, 0.08, 0.22, mask, [sx * 0.04, 0.04, 0], [0, 0, sx * 0.35]);
      box(a, 0.12, 0.02, 0.18, cyan, [sx * 0.08, 0.09, 0], [0, 0, sx * 0.35], false);
    }
    const pack = box(j.spine, 0.32, 0.4, 0.16, under, [0, 0.42, -0.24]);
    pack.castShadow = true;
    sphere(j.spine, 0.08, cyan, [0, 0.42, -0.33], undefined, false);
    for (const y of [0.3, 0.54]) box(j.spine, 0.26, 0.02, 0.02, cyan, [0, y, -0.33], undefined, false);
    box(j.hips, 0.44, 0.07, 0.3, mask, [0, 0.12, 0]);
    for (const sh of [j.lShin, j.rShin]) box(sh, 0.13, 0.22, 0.15, under, [0, -0.33, 0.01]);
    j.head.scale.setScalar(0.86);
    return { accents: [cyan] };
  },
};

// ------------------------------------------------------------------ generic procedural fallback body
function genericBuild(mainC: number, trimC: number, glowC: number, bulky = false) {
  return (rig: Rig) => {
    const main = mat(mainC, 0.5, 0.2), trim = mat(trimC, 0.45, 0.4), glow = mat(glowC, 0.2, 0, glowC, 1.6);
    const j = rig.joints;
    box(j.hips, bulky ? 0.5 : 0.36, 0.22, 0.26, trim, [0, 0.02, 0]);
    torso(j.spine, bulky ? 0.2 : 0.15, bulky ? 0.3 : 0.22, 0.66, main, 1.3, 0.8);
    sphere(j.head, 0.16, main, [0, 0.12, 0], [0.95, 1.12, 1.02]);
    box(j.head, 0.2, 0.04, 0.04, glow, [0, 0.13, 0.13], undefined, false);
    for (const [a, f] of [[j.lArm, j.lFore], [j.rArm, j.rFore]] as const) { limb(a, rig.p.upperArm, 0.08, 0.07, main); limb(f, rig.p.foreArm, 0.07, 0.06, trim); }
    for (const [t, sh] of [[j.lThigh, j.lShin], [j.rThigh, j.rShin]] as const) { limb(t, rig.p.thigh, 0.1, 0.08, main); limb(sh, rig.p.shin, 0.08, 0.065, trim); }
    return { accents: [glow] };
  };
}

// ------------------------------------------------------------------ VANTA — claw striker, ground recovery
const vanta: CharacterDef = {
  id: 'vanta',
  name: 'VANTA',
  title: 'Night Claw',
  blurb: 'Blinding speed and a four-hit claw combo. Fragile, but she never stops pressing.',
  color: '#e8c040',
  recovery: 'ground',
  lift: 1,
  speed: 7.4,
  jumpV: 12.5,
  weight: 0.85,
  heavy: 0,
  radius: 0.45,
  height: 1.85,
  durability: 0.85,
  proportions: { thigh: 0.5, shin: 0.5, torso: 0.6, shoulderW: 0.5, hipW: 0.27, upperArm: 0.33, foreArm: 0.31, neck: 0.1 },
  moves: {
    chain: [jab(4, 0.95), cross(4, 1.0), { ...jab(5, 1.05), id: 'claw3', limb: 'lh' }, launcher(9, 1.1, 9, 9, { id: 'clawUp', startup: 8 })],
    airRise: airRise(6),
    airDive: airDive(8),
    mobilityAtk: {
      id: 'pounce', name: 'Pounce', limb: 'both', wind: P.evade, strike: P.diveS, startup: 5, active: 10, recovery: 12, lunge: 14,
      hit: { fwd: 0.9, up: 1.0, radius: 0.9, stamina: 9, health: 3, kbF: 11, kbU: 5, stun: 28, launch: true, heavy: true, breaksWalls: 25 },
    },
    power: {
      id: 'clawFrenzy', name: 'Claw Frenzy', limb: 'both', wind: P.crossW, strike: P.clapS, startup: 6, active: 10, recovery: 16, lunge: 7, energy: 20,
      hit: { fwd: 1.0, up: 1.2, radius: 1.0, stamina: 12, health: 7, kbF: 10, kbU: 6, stun: 32, launch: true, heavy: true, breaksWalls: 30 },
    },
    powerAir: airDive(12),
    counter: counter(),
    runAttack: {
      id: 'slashRun', name: 'Running Slash', limb: 'rh', wind: P.crossW, strike: P.jabS, startup: 4, active: 6, recovery: 10, lunge: 10,
      hit: { fwd: 1.0, up: 1.3, radius: 0.85, stamina: 7, health: 1, kbF: 7, kbU: 2, stun: 22 },
    },
    dashPower: {
      id: 'shadowRush', name: 'Shadow Rush', limb: 'both', wind: P.evade, strike: P.jabS, startup: 6, active: 14, recovery: 14, lunge: 17, energy: 20,
      hit: { fwd: 1.0, up: 1.2, radius: 1.0, stamina: 12, health: 8, kbF: 14, kbU: 6, stun: 34, launch: true, heavy: true, breaksWalls: 60 },
    },
    chargePower: {
      id: 'shadeRend', name: 'Shade Rend', limb: 'both', wind: P.evade, strike: P.jabS, startup: 6, active: 24, recovery: 16, energy: 18, special: 'shadeRend',
      hit: { fwd: 0, up: 1.0, radius: 1.0, stamina: 10, health: 8, kbF: 13, kbU: 8, stun: 36, launch: true, heavy: true, breaksWalls: 40 },
    },
  },
  powerGrapple: 'shadowShred',
  sheet: {
    mobility: 'LB: Sprint · LB+X Pounce',
    power: 'RT+X: Claw Frenzy · running RT+X: Shadow Rush · hold RT+X: Shade Rend (phases through you three times)',
    grapple: 'Lifts light and medium props. RT+Y: Shadow Shred.',
    finisher: 'Thousand Cuts — darts through the opponent from every angle in golden streaks',
    weakness: 'Light and fragile: big hits send her flying, and her ground recovery only brakes and hops her back a little.',
    moves: [['X X X X', 'Elbow cut, claw rake, knee, heel kick'], ['X (running)', 'Running Slash'], ['RT+X', 'Claw Frenzy'], ['RT+X (running)', 'Shadow Rush'], ['Hold RT+X', 'Shade Rend — phases through the opponent three times'], ['LB+X', 'Pounce'], ['RT+Y', 'Shadow Shred — pins them and rakes, then kicks them away'], ['Grab, X', 'Knee pummel']],
  },
  build: genericBuild(0x15151a, 0xc8a030, 0xffd050),
};

// ------------------------------------------------------------------ MAGNA — magnetic flier, pulls objects from range
const magna: CharacterDef = {
  id: 'magna',
  name: 'MAGNA',
  title: 'The Lodestone',
  blurb: 'Levitates on magnetism and yanks anything metal to his hands — even cars, from across the arena.',
  color: '#ff4a6a',
  recovery: 'flight',
  lift: 2,
  speed: 6.0,
  jumpV: 11,
  weight: 1.05,
  heavy: 0.2,
  radius: 0.5,
  height: 2.0,
  durability: 1.05,
  proportions: { thigh: 0.53, shin: 0.51, torso: 0.68, shoulderW: 0.62, hipW: 0.3, upperArm: 0.36, foreArm: 0.35, neck: 0.1 },
  rangedGrab: { fighters: true, maxCls: 2, range: 13 },
  lineColor: 0xff5a7a,
  moves: {
    chain: [jab(5, 0.95), cross(6, 1.0), launcher(9, 1.05, 8, 9)],
    airRise: airRise(6),
    airDive: airDive(8),
    mobilityAtk: {
      id: 'magRam', name: 'Magnet Ram', limb: 'both', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 12, recovery: 12, lunge: 15, airOk: true, energy: 12,
      hit: { fwd: 0.9, up: 1.0, radius: 0.9, stamina: 9, health: 3, kbF: 13, kbU: 4, stun: 20, launch: true, heavy: true, breaksWalls: 30 },
    },
    power: { id: 'shards', name: 'Shard Volley', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 7, active: 2, recovery: 12, energy: 12, special: 'bolt', airOk: true },
    powerAir: { id: 'shardsAir', name: 'Shard Volley', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 6, active: 2, recovery: 10, energy: 12, special: 'bolt', airOk: true },
    counter: counter(),
    runAttack: {
      id: 'ironElbow', name: 'Iron Elbow', limb: 'rh', wind: P.crossW, strike: P.crossS, startup: 6, active: 6, recovery: 12, lunge: 8,
      hit: { fwd: 1.0, up: 1.3, radius: 0.85, stamina: 8, health: 2, kbF: 9, kbU: 2, stun: 24 },
    },
    dashPower: {
      id: 'polarCharge', name: 'Polar Charge', limb: 'both', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 14, recovery: 14, lunge: 17, energy: 20, airOk: true,
      hit: { fwd: 0.9, up: 1.0, radius: 1.0, stamina: 10, health: 8, kbF: 13, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 50 },
    },
    chargePower: {
      id: 'implosion', name: 'Implosion', limb: 'both', wind: P.charge.bind(null, 0), strike: P.clapW, startup: 6, active: 34, recovery: 18, energy: 18, special: 'implode', airOk: true,
      hit: { fwd: 0, up: 1.0, radius: 3.4, stamina: 12, health: 10, kbF: 14, kbU: 9, stun: 34, launch: true, heavy: true, breaksWalls: 50 },
    },
  },
  powerGrapple: 'ironMaiden',
  sheet: {
    mobility: 'LB: Magnetic flight (A up, B down) · LB+X Magnet Ram',
    power: 'RT+X: Shard Volley · running RT+X: Polar Charge · hold RT+X: Implosion (drags you in, then blasts)',
    grapple: 'Y at range pulls opponents and ANY object to his hands — cars included.',
    finisher: 'Crush Field — floats the opponent in a shell of spinning shards, compresses it and drops them',
    weakness: 'Slow on foot; flight burns energy.',
    moves: [['X X X', 'Magnetic palm, cross, uppercut'], ['X (running)', 'Iron Elbow'], ['RT+X', 'Shard Volley'], ['RT+X (running)', 'Polar Charge'], ['Hold RT+X', 'Implosion — drags the opponent in, then blasts'], ['Y (range)', 'Magnetic pull: fighters and objects'], ['LB', 'Flight'], ['RT+Y', 'Iron Maiden — crushes them in a magnetic field and hurls them'], ['Grab, X', 'Knee pummel']],
  },
  build: genericBuild(0x8a9098, 0x8a1a28, 0xff4a6a),
};

// ------------------------------------------------------------------ EMBER — fire bruiser, burns
const ember: CharacterDef = {
  id: 'ember',
  name: 'EMBER',
  title: 'The Furnace',
  blurb: 'A walking furnace. His power hits set you burning, so every exchange keeps costing you.',
  color: '#ff6a1a',
  recovery: 'ground',
  lift: 1,
  speed: 6.4,
  jumpV: 11,
  weight: 1.2,
  heavy: 0.6,
  radius: 0.6,
  height: 2.15,
  durability: 1.15,
  proportions: { thigh: 0.53, shin: 0.51, torso: 0.72, shoulderW: 0.74, hipW: 0.34, upperArm: 0.38, foreArm: 0.37, neck: 0.1 },
  burns: true,
  embers: true,
  moves: {
    chain: [jab(6, 1.0), cross(7, 1.05), launcher(11, 1.1, 9, 8)],
    airRise: airRise(7),
    airDive: airDive(10),
    mobilityAtk: {
      id: 'blazeShoulder', name: 'Blaze Shoulder', limb: 'both', wind: P.evade, strike: P.jabS, startup: 7, active: 12, recovery: 15, lunge: 12,
      hit: { fwd: 1.0, up: 1.2, radius: 0.95, stamina: 10, health: 4, kbF: 12, kbU: 5, stun: 30, launch: true, heavy: true, breaksWalls: 50 },
    },
    power: {
      id: 'fireball', name: 'Fireball', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 9, active: 2, recovery: 16, energy: 18, special: 'fireball',
    },
    powerAir: {
      id: 'meteorDrop', name: 'Meteor Drop', limb: 'both', wind: P.overheadW, strike: P.slamS, startup: 8, active: 40, recovery: 20, energy: 22, special: 'groundPound', airOk: true, riseV: -26,
      hit: { fwd: 0, up: 0.4, radius: 3.0, stamina: 11, health: 8, kbF: 10, kbU: 9, stun: 34, launch: true, heavy: true, breaksWalls: 30 },
    },
    counter: counter(),
    runAttack: {
      id: 'searingHook', name: 'Searing Hook', limb: 'rh', wind: P.crossW, strike: P.upperS, startup: 7, active: 6, recovery: 14, lunge: 9,
      hit: { fwd: 1.0, up: 1.4, radius: 0.9, stamina: 9, health: 3, kbF: 8, kbU: 5, stun: 26, heavy: true },
    },
    dashPower: {
      id: 'flameRush', name: 'Flame Rush', limb: 'both', wind: P.evade, strike: P.jabS, startup: 8, active: 14, recovery: 18, lunge: 14, energy: 22,
      hit: { fwd: 1.1, up: 1.2, radius: 1.05, stamina: 12, health: 9, kbF: 14, kbU: 6, stun: 34, launch: true, heavy: true, breaksWalls: 80 },
    },
    chargePower: {
      id: 'eruption', name: 'Eruption', limb: 'both', wind: P.overheadW, strike: P.slamS, startup: 6, active: 4, recovery: 28, energy: 18, special: 'quake',
      hit: { fwd: 0, up: 0.5, radius: 4.2, stamina: 14, health: 12, kbF: 11, kbU: 11, stun: 38, launch: true, heavy: true, breaksWalls: 60 },
    },
  },
  powerGrapple: 'furnaceSlam',
  sheet: {
    mobility: 'LB: Sprint · LB+X Blaze Shoulder',
    power: 'RT+X: Fireball (explodes and burns) · running RT+X: Flame Rush · hold RT+X: Eruption · air: Meteor Drop',
    grapple: 'Lifts light and medium props. RT+Y: Furnace Slam.',
    finisher: 'Inferno — lifts and spikes the opponent in a pillar of fire',
    weakness: 'Big and readable; his ground recovery brakes a launch but cannot save a long one.',
    moves: [['X X X', 'Jab-cross, hook, uppercut'], ['X (running)', 'Searing Hook'], ['RT+X', 'Fireball — explodes and burns'], ['RT+X (running)', 'Flame Rush'], ['Hold RT+X', 'Eruption — burns'], ['RT+X (air)', 'Meteor Drop'], ['LB+X', 'Blaze Shoulder'], ['RT+Y', 'Furnace Slam — suplex into a pillar of fire'], ['Passive', 'Heavy hits set the target burning']],
  },
  build: genericBuild(0x2a2420, 0x6a2a10, 0xff6a1a, true),
};

vanta.fxColor = 0xe8c040;

// ------------------------------------------------------------------ RIFT — portal teleporter
const rift: CharacterDef = {
  id: 'rift',
  name: 'RIFT',
  title: 'The Gatekeeper',
  blurb: 'Opens portals at will: blinks around the arena, swaps places with you and punches through gates.',
  color: '#7dff6a',
  recovery: 'teleport',
  lift: 1,
  speed: 6.2,
  jumpV: 11,
  weight: 0.95,
  heavy: 0.2,
  radius: 0.5,
  height: 1.95,
  durability: 0.95,
  fxColor: 0x7dff6a,
  proportions: { thigh: 0.53, shin: 0.51, torso: 0.66, shoulderW: 0.6, hipW: 0.3, upperArm: 0.35, foreArm: 0.34, neck: 0.1 },
  moves: {
    chain: [jab(5, 0.95), cross(5, 1.0), launcher(9, 1.05, 9, 9, { id: 'gateKick', wind: P.upperW, strike: P.kickS, startup: 8 })],
    airRise: airRise(6),
    airDive: airDive(8),
    mobilityAtk: {
      id: 'riftStep', name: 'Rift Step', limb: 'lf', wind: P.teleport, strike: P.kickS, startup: 10, active: 6, recovery: 14, special: 'blinkStrike', energy: 10,
      hit: { fwd: 1.0, up: 1.2, radius: 0.9, stamina: 9, health: 4, kbF: 11, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 25 },
    },
    power: { id: 'swapGate', name: 'Swap Gate', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 8, active: 2, recovery: 16, energy: 22, special: 'swap', airOk: true },
    powerAir: { id: 'swapGateAir', name: 'Swap Gate', limb: 'rh', wind: P.shoot, strike: P.shoot, startup: 7, active: 2, recovery: 14, energy: 22, special: 'swap', airOk: true },
    counter: counter(),
    runAttack: {
      id: 'gateElbow', name: 'Gate Elbow', limb: 'rh', wind: P.crossW, strike: P.crossS, startup: 6, active: 6, recovery: 12, lunge: 9,
      hit: { fwd: 1.0, up: 1.3, radius: 0.85, stamina: 8, health: 2, kbF: 9, kbU: 2, stun: 24 },
    },
    dashPower: {
      id: 'portalPunch', name: 'Portal Punch', limb: 'rh', wind: P.crossW, strike: P.crossS, startup: 8, active: 2, recovery: 16, energy: 18, special: 'portalPunch',
      hit: { fwd: 0, up: 0, radius: 0, stamina: 10, health: 8, kbF: 10, kbU: 5, stun: 34, launch: true, heavy: true },
    },
    chargePower: { id: 'riftStorm', name: 'Rift Storm', limb: 'both', wind: P.charge.bind(null, 0), strike: P.shoot, startup: 6, active: 20, recovery: 14, energy: 18, special: 'riftStorm' },
  },
  powerGrapple: 'portalDrop',
  sheet: {
    mobility: 'LB+direction: Portal hop · LB neutral: step out behind the opponent · LB+X Rift Step kick',
    power: 'RT+X: Swap Gate (trade places) · running RT+X: Portal Punch · hold RT+X: Rift Storm',
    grapple: 'Lifts light and medium props. RT+Y: Portal Drop.',
    finisher: 'Gate Barrage — drops the opponent through a chain of portals, faster each time, then slams them',
    weakness: 'Every portal costs energy; with an empty meter she has no way back from a launch.',
    moves: [['X X X', 'Cross, push kick, axe kick'], ['X (running)', 'Gate Elbow'], ['RT+X', 'Swap Gate — swap places (use it near an edge!)'], ['RT+X (running)', 'Portal Punch — hits from behind at range, pulls them in'], ['Hold RT+X', 'Rift Storm — three gates fire on the opponent'], ['LB + dir / LB', 'Portal hop / step behind'], ['LB+X', 'Rift Step kick'], ['RT+Y', 'Portal Drop — drops them from the sky'], ['Grab, X', 'Knee pummel']],
  },
  build: genericBuild(0x1c2a24, 0x2e3a44, 0x7dff6a),
};

export const ROSTER: CharacterDef[] = [basalt, tether, aerin, shunt, vanta, magna, ember, rift];
// Character designs (painted bodies, clothes, hair, creatures) live in looks.ts.
for (const c of ROSTER) { const l = LOOKS[c.id]; if (l) { c.look = l.look; c.adorn = l.adorn; } }
export function charById(id: string) {
  return ROSTER.find((c) => c.id === id) ?? ROSTER[0];
}

export { addOutline };
