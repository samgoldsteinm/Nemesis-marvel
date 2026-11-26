import * as THREE from 'three';
import { Rig, Proportions, Pose, P, limb, box, sphere, addOutline, torso } from './rig';
import type { SkinnedBody, BodyLook } from './skinned';

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

export type PowerGrapple = 'piledriver' | 'webSpin' | 'skyDrop' | 'displace' | 'portalDrop';

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
  height: 2.5,
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
    mobility: 'L: Sprint — L+A shoulder charge breaks walls',
    power: 'R+A: Thunderclap shockwave cone · in air: Ground Pound',
    grapple: 'Lifts every prop class, including the fuel tank. Planted heavy throw.',
    finisher: 'Quarry Drop — lifts and spikes the opponent through the roof deck',
    weakness: 'Ground recovery barely changes his trajectory; off an open edge he falls.',
    moves: [['A A A', 'Jab, cross, hammer launcher'], ['A (running)', 'Lariat'], ['R+A', 'Thunderclap cone'], ['R+A (running)', 'Avalanche Charge — smashes barriers'], ['Hold R+A', 'Tectonic Slam — huge quake'], ['R+A (air)', 'Ground Pound'], ['L+A', 'Shoulder charge'], ['R+X', 'Piledriver'], ['Grab, A', 'Knee pummel']],
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
    mobility: 'L: Line swing (hold) · sticks to walls on contact · L+A swing kick',
    power: 'R+A: Snare bolt — binds the target briefly',
    grapple: 'X at range: line-yank opponent or light prop. Lifts light props only.',
    finisher: 'Cocoon Spin — binds, spins and flings',
    weakness: 'Cannot lift medium or heavy props; low weight means long launches.',
    moves: [['A A A', 'Jab, cross, flip kick'], ['A (running)', 'Slide Trip'], ['R+A', 'Snare bolt'], ['R+A (running)', 'Line Slingshot — pulls in with a kick'], ['Hold R+A', 'Snare Spread — three bolts'], ['L+A', 'Swing kick'], ['X (range)', 'Line yank'], ['R+X', 'Line Spin — fling for a ring-out'], ['Grab, A', 'Knee pummel']],
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
      id: 'flightDash', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 12, recovery: 12, lunge: 15, airOk: true,
      hit: { fwd: 0.9, up: 1.0, radius: 0.85, stamina: 9, health: 3, kbF: 12, kbU: 4, stun: 28, launch: true, heavy: true, breaksWalls: 25 },
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
    mobility: 'L: Toggle flight (B rise, Y sink) · L+A flight dash',
    power: 'R+A: Volt bolt — lasting damage, deflectable by super block',
    grapple: 'Lifts light props only.',
    finisher: 'Skyfall — carries the opponent up and drives them down in a lightning strike',
    weakness: 'Flight burns energy; caught charging on the ground she is exposed.',
    moves: [['A A A', 'Jab, cross, uppercut'], ['A (running)', 'Gale Kick'], ['R+A', 'Volt bolt'], ['R+A (running)', 'Storm Dash'], ['Hold R+A', 'Chain Lightning — heavy bolt'], ['L', 'Flight (B up, Y down)'], ['L+A', 'Flight dash'], ['R+X', 'Skyfall Drop'], ['Grab, A', 'Knee pummel']],
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
    mobility: 'L+direction: Hop-teleport · L neutral: flank behind opponent · L+A blink strike',
    power: 'R+A: Displacement pulse — radial blast',
    grapple: 'Lifts light props only.',
    finisher: 'Scatter — a chain of teleport strikes from every side',
    weakness: 'Teleports cost energy; with an empty meter he has no way back from a launch.',
    moves: [['A A A', 'Jab, cross, uppercut'], ['A (running)', 'Phase Elbow'], ['R+A', 'Displacement pulse'], ['R+A (running)', 'Phase Lunge — blink behind and strike'], ['Hold R+A', 'Pulse Mines — three proximity charges'], ['L + dir / L', 'Hop / flank teleport'], ['L+A', 'Blink strike'], ['R+X', 'Displace — teleports the victim away (off an edge!)'], ['Grab, A', 'Knee pummel']],
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

// ------------------------------------------------------------------ rigged-body looks
const deco = (obj: THREE.Mesh, outline = true) => { obj.castShadow = true; if (outline) addOutline(obj, 1.06); return obj; };
const g = (geo: THREE.BufferGeometry, m: THREE.Material, pos: [number, number, number], rot?: [number, number, number], scl?: [number, number, number], outline = true) => {
  const o = new THREE.Mesh(geo, m);
  o.position.set(...pos);
  if (rot) o.rotation.set(...rot);
  if (scl) o.scale.set(...scl);
  return deco(o, outline);
};

basalt.look = { height: 2.5, bulk: 1.22, body: 0x4e5c70, joints: 0x8a3a1a, jointGlow: 0.6, bodyRough: 0.95, bodyMetal: 0.05 };
basalt.adorn = (b) => {
  const rock = mat(0x4a586a, 0.95, 0.05, 0, 0, true);
  const rock2 = mat(0x343e4c, 0.95, 0.05, 0, 0, true);
  const magma = mat(0xff5a1a, 0.4, 0, 0xff4a10, 1.8);
  const D = (r: number) => new THREE.DodecahedronGeometry(r, 0);
  // Shoulder boulders, chest plate, back ridge, forearm and shin slabs, heavy fists.
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, g(D(0.3), rock2, [sx * 0.02, 0.02, 0], [0.4, 0.3, 0.2], [1.3, 0.9, 1.1]));
    b.attach(j, g(D(0.16), rock, [0, -0.3, 0.1], [1, 0.4, 0]));
  }
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, g(new THREE.BoxGeometry(0.3, 0.42, 0.3), rock2, [0, -0.25, 0.02], [0.1, 0.3, 0.05]));
    b.attach(j, g(D(0.2), rock, [0, -0.62, 0.04], [0.5, 0.2, 0.3], [1.1, 0.9, 1.1]));
    b.attach(j, g(new THREE.BoxGeometry(0.04, 0.3, 0.04), magma, [0.1, -0.25, 0.17], undefined, undefined, false));
  }
  b.attach('spine', g(new THREE.BoxGeometry(0.75, 0.5, 0.2), rock2, [0, 0.05, 0.2], [0.1, 0, 0]));
  b.attach('spine', g(new THREE.BoxGeometry(0.5, 0.05, 0.03), magma, [0, 0.0, 0.31], undefined, undefined, false));
  for (const [x, y] of [[0.2, 0.1], [-0.22, 0.0], [0, -0.2]]) b.attach('spine', g(D(0.2), rock, [x, y, -0.22], [x, y, 0.4], [1.2, 0.9, 0.8]));
  for (const j of ['lShin', 'rShin'] as const) b.attach(j, g(new THREE.BoxGeometry(0.28, 0.4, 0.22), rock2, [0, -0.2, 0.08], [0.1, 0, 0]));
  // Boulders over the thighs, upper arms and hips so the whole body reads as stone.
  for (const j of ['lThigh', 'rThigh'] as const) { b.attach(j, g(D(0.2), rock, [0, -0.15, 0.06], [0.3, 0.5, 0.1], [1.1, 1.3, 1])); b.attach(j, g(D(0.16), rock2, [0, -0.38, 0.05], [1.2, 0.2, 0.4])); }
  for (const j of ['lArm', 'rArm'] as const) b.attach(j, g(D(0.15), rock2, [0, -0.18, -0.06], [0.7, 0.2, 1]));
  b.attach('hips', g(new THREE.BoxGeometry(0.62, 0.22, 0.4), rock2, [0, 0.02, 0], [0, 0.1, 0]));
  b.attach('spine', g(D(0.22), rock, [0, 0.3, 0.12], [0.2, 0.6, 0], [1.4, 0.8, 1]));
  b.attach('head', g(new THREE.BoxGeometry(0.4, 0.12, 0.25), rock2, [0, 0.2, 0.1], [-0.2, 0, 0]));
  b.attach('head', g(new THREE.BoxGeometry(0.22, 0.03, 0.02), magma, [0, 0.12, 0.18], undefined, undefined, false));
  return [magma, b.jointMat];
};

tether.look = { height: 1.95, bulk: 0.98, body: 0x109c8e, joints: 0x14161c, jointGlow: 0, bodyRough: 0.45, bodyMetal: 0.15 };
tether.adorn = (b) => {
  const gold = mat(0xe8b520, 0.3, 0.8, 0x6a4800, 0.4);
  const lens = mat(0xe8fbff, 0.2, 0, 0x9ff7ff, 1.6);
  const dark = mat(0x12151c, 0.5, 0.2);
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, g(new THREE.BoxGeometry(0.1, 0.13, 0.12), gold, [0, -0.2, 0.05]));
    b.attach(j, g(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 8), dark, [0, -0.25, 0.12], [Math.PI / 2, 0, 0], undefined, false));
  }
  b.attach('head', g(new THREE.SphereGeometry(0.06, 12, 8), lens, [0.06, 0.1, 0.1], undefined, [1.2, 0.75, 0.5], false));
  b.attach('head', g(new THREE.SphereGeometry(0.06, 12, 8), lens, [-0.06, 0.1, 0.1], undefined, [1.2, 0.75, 0.5], false));
  const em = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.016, 6, 16, Math.PI * 1.4), gold);
  em.position.set(0, 0.02, 0.15);
  em.rotation.z = -0.6;
  b.attach('spine', em);
  b.attach('hips', g(new THREE.BoxGeometry(0.34, 0.06, 0.24), dark, [0, 0.02, 0]));
  for (const x of [-0.12, -0.04, 0.04, 0.12]) b.attach('hips', g(new THREE.BoxGeometry(0.05, 0.07, 0.04), gold, [x, 0.02, 0.13], undefined, undefined, false));
  return [lens, gold];
};

aerin.look = { female: true, height: 1.95, bulk: 0.96, body: 0xe6e4f2, joints: 0x8a4cff, jointGlow: 1.4, bodyRough: 0.38, bodyMetal: 0.2 };
aerin.adorn = (b, rig) => {
  const hair = mat(0xf1f1ff, 0.6, 0.1);
  const glow = mat(0xc9a8ff, 0.2, 0, 0xa070ff, 1.8);
  const tail = g(new THREE.ConeGeometry(0.07, 0.5, 8), hair, [0, 0.08, -0.16], [-2.5, 0, 0]);
  b.attach('head', tail);
  b.attach('head', g(new THREE.SphereGeometry(0.135, 14, 10), hair, [0, 0.13, -0.03], undefined, [1.02, 0.95, 1.05]));
  b.attach('head', g(new THREE.BoxGeometry(0.18, 0.03, 0.03), glow, [0, 0.1, 0.12], undefined, undefined, false));
  b.attach('hips', g(new THREE.BoxGeometry(0.33, 0.05, 0.23), glow, [0, 0.03, 0], undefined, undefined, false));
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0); wingShape.lineTo(1.15, 0.55); wingShape.lineTo(0.95, -0.15); wingShape.lineTo(1.25, -0.65); wingShape.lineTo(0.15, -0.35); wingShape.lineTo(0, 0);
  const wingGeo = new THREE.ShapeGeometry(wingShape);
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const lw = new THREE.Mesh(wingGeo, wingMat);
  lw.position.set(0.08, 0.1, -0.14);
  lw.scale.setScalar(0.72);
  const rw = new THREE.Mesh(wingGeo, wingMat);
  rw.scale.set(-0.72, 0.72, 0.72);
  rw.position.set(-0.08, 0.1, -0.14);
  b.attach('spine', lw);
  b.attach('spine', rw);
  (rig as any).wings = [lw, rw];
  return [glow, b.jointMat];
};

shunt.look = { height: 2.0, bulk: 1.02, body: 0x2b303c, joints: 0x37f2ff, jointGlow: 1.5, bodyRough: 0.7, bodyMetal: 0.2 };
shunt.adorn = (b) => {
  const coat = mat(0x2b303c, 0.7, 0.2);
  coat.side = THREE.DoubleSide;
  const cyan = mat(0x37f2ff, 0.2, 0, 0x20e0ff, 1.6);
  const plate = mat(0xb9c3cf, 0.35, 0.6);
  const skirt = g(new THREE.CylinderGeometry(0.22, 0.42, 0.8, 12, 1, true), coat, [0, -0.32, 0], undefined, undefined, false);
  b.attach('hips', skirt);
  b.attach('head', g(new THREE.SphereGeometry(0.16, 14, 10), coat, [0, 0.12, -0.04], undefined, [1.05, 1.12, 1.08]));
  b.attach('head', g(new THREE.BoxGeometry(0.2, 0.04, 0.05), cyan, [0, 0.1, 0.11], undefined, undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, g(new THREE.BoxGeometry(0.2, 0.07, 0.22), plate, [sx * 0.03, 0.03, 0], [0, 0, sx * 0.35]));
    b.attach(j, g(new THREE.BoxGeometry(0.12, 0.02, 0.18), cyan, [sx * 0.07, 0.075, 0], [0, 0, sx * 0.35], undefined, false));
  }
  b.attach('spine', g(new THREE.BoxGeometry(0.3, 0.38, 0.14), coat, [0, 0, -0.2]));
  b.attach('spine', g(new THREE.SphereGeometry(0.07, 10, 8), cyan, [0, 0, -0.28], undefined, undefined, false));
  return [cyan, b.jointMat];
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
  powerGrapple: 'webSpin',
  sheet: {
    mobility: 'L: Sprint · L+A Pounce',
    power: 'R+A: Claw Frenzy · running R+A: Shadow Rush · hold R+A: Shade Rend (phases through you three times)',
    grapple: 'Lifts light and medium props. R+X: Spiral Toss.',
    finisher: 'Nightfall — a blur of claw strikes from every side',
    weakness: 'Light and fragile: big hits send her flying, and ground recovery is short.',
    moves: [['A A A A', 'Four-hit claw combo'], ['A (running)', 'Running Slash'], ['R+A', 'Claw Frenzy'], ['R+A (running)', 'Shadow Rush'], ['Hold R+A', 'Shade Rend — phases through the opponent three times'], ['L+A', 'Pounce'], ['R+X', 'Spiral Toss — fling for a ring-out'], ['Grab, A', 'Knee pummel']],
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
      id: 'magRam', name: 'Magnet Ram', limb: 'both', wind: P.fly.bind(null, 12), strike: P.diveS, startup: 5, active: 12, recovery: 12, lunge: 15, airOk: true,
      hit: { fwd: 0.9, up: 1.0, radius: 0.9, stamina: 9, health: 3, kbF: 12, kbU: 4, stun: 28, launch: true, heavy: true, breaksWalls: 30 },
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
  powerGrapple: 'skyDrop',
  sheet: {
    mobility: 'L: Magnetic flight (B up, Y down) · L+A Magnet Ram',
    power: 'R+A: Shard Volley · running R+A: Polar Charge · hold R+A: Implosion (drags you in, then blasts)',
    grapple: 'X at range pulls opponents and ANY object to his hands — cars included.',
    finisher: 'Crush Field — lifts the opponent and slams them down',
    weakness: 'Slow on foot; flight burns energy.',
    moves: [['A A A', 'Jab, cross, uppercut'], ['A (running)', 'Iron Elbow'], ['R+A', 'Shard Volley'], ['R+A (running)', 'Polar Charge'], ['Hold R+A', 'Implosion — drags the opponent in, then blasts'], ['X (range)', 'Magnetic pull: fighters and objects'], ['L', 'Flight'], ['R+X', 'Skyfall Drop'], ['Grab, A', 'Knee pummel']],
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
  powerGrapple: 'piledriver',
  sheet: {
    mobility: 'L: Sprint · L+A Blaze Shoulder',
    power: 'R+A: Fireball (explodes and burns) · running R+A: Flame Rush · hold R+A: Eruption · air: Meteor Drop',
    grapple: 'Lifts light and medium props. R+X: Furnace Slam.',
    finisher: 'Inferno — lifts and spikes the opponent in a pillar of fire',
    weakness: 'Big and readable; no way back from a long launch.',
    moves: [['A A A', 'Jab, cross, rising hook'], ['A (running)', 'Searing Hook'], ['R+A', 'Fireball — explodes and burns'], ['R+A (running)', 'Flame Rush'], ['Hold R+A', 'Eruption — burns'], ['R+A (air)', 'Meteor Drop'], ['L+A', 'Blaze Shoulder'], ['R+X', 'Furnace Slam'], ['Passive', 'Heavy hits set the target burning']],
  },
  build: genericBuild(0x2a2420, 0x6a2a10, 0xff6a1a, true),
};

// ------------------------------------------------------------------ rigged looks for the new fighters
vanta.fxColor = 0xe8c040;
vanta.look = { female: true, height: 1.85, bulk: 0.95, body: 0x17171c, joints: 0xe8c040, jointGlow: 0.9, bodyRough: 0.35, bodyMetal: 0.35 };
vanta.adorn = (b) => {
  const gold = mat(0xe8c040, 0.25, 0.8, 0x6a4800, 0.5);
  const blade = mat(0xdfe4ea, 0.15, 1.0);
  const visor = mat(0xffe08a, 0.2, 0, 0xffc040, 1.8);
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, g(new THREE.BoxGeometry(0.1, 0.16, 0.12), gold, [0, -0.18, 0.04]));
    for (const dx of [-0.04, 0, 0.04]) b.attach(j, g(new THREE.ConeGeometry(0.018, 0.34, 6), blade, [dx, -0.42, 0.1], [Math.PI, 0, 0], undefined, false));
  }
  b.attach('head', g(new THREE.BoxGeometry(0.2, 0.04, 0.05), visor, [0, 0.1, 0.12], undefined, undefined, false));
  for (const sx of [-1, 1]) b.attach('head', g(new THREE.ConeGeometry(0.04, 0.16, 6), gold, [sx * 0.08, 0.26, -0.02], [0, 0, -sx * 0.4]));
  b.attach('hips', g(new THREE.BoxGeometry(0.32, 0.05, 0.22), gold, [0, 0.03, 0], undefined, undefined, false));
  return [visor, gold, b.jointMat];
};

magna.look = { height: 2.0, bulk: 1.05, body: 0x9aa2ac, joints: 0xd02040, jointGlow: 0.8, bodyRough: 0.25, bodyMetal: 0.85 };
magna.adorn = (b, rig) => {
  const red = mat(0xb01a30, 0.35, 0.5);
  const steel = mat(0xc8ced6, 0.2, 0.95);
  const glow = mat(0xff5a7a, 0.2, 0, 0xff3a5a, 1.8);
  b.attach('head', g(new THREE.SphereGeometry(0.15, 14, 10), red, [0, 0.12, 0.01], undefined, [1.05, 1.08, 1.1]));
  b.attach('head', g(new THREE.BoxGeometry(0.04, 0.16, 0.3), red, [0, 0.27, -0.02]));
  b.attach('head', g(new THREE.BoxGeometry(0.2, 0.035, 0.04), glow, [0, 0.1, 0.14], undefined, undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) b.attach(j, g(new THREE.SphereGeometry(0.13, 12, 8), red, [sx * 0.03, 0.02, 0], undefined, [1.2, 0.7, 1.2]));
  // Orbiting shards around the waist (spun in Fighter.animate via rig.orbit).
  const orbit = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const shard = g(new THREE.OctahedronGeometry(0.06, 0), steel, [Math.cos(a) * 0.55, Math.sin(i * 1.7) * 0.12, Math.sin(a) * 0.55], [a, a * 0.5, 0], [1, 1.8, 1], false);
    orbit.add(shard);
  }
  b.attach('hips', orbit);
  (rig as any).orbit = orbit;
  return [glow, b.jointMat];
};

ember.look = { height: 2.15, bulk: 1.12, body: 0x2c2622, joints: 0xff5a10, jointGlow: 1.4, bodyRough: 0.8, bodyMetal: 0.15 };
ember.adorn = (b) => {
  const char = mat(0x1e1a18, 0.9, 0.1, 0, 0, true);
  const lava = mat(0xff6a1a, 0.4, 0, 0xff4a10, 1.8);
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) {
    b.attach(j, g(new THREE.DodecahedronGeometry(0.17, 0), char, [sx * 0.03, 0.02, 0], [0.3, 0.2, 0], [1.2, 0.8, 1.1]));
  }
  for (const j of ['lFore', 'rFore'] as const) b.attach(j, g(new THREE.BoxGeometry(0.16, 0.3, 0.16), char, [0, -0.2, 0.02], [0.1, 0.2, 0]));
  b.attach('spine', g(new THREE.BoxGeometry(0.42, 0.06, 0.04), lava, [0, 0.05, 0.2], undefined, undefined, false));
  b.attach('spine', g(new THREE.BoxGeometry(0.05, 0.3, 0.04), lava, [0.08, -0.05, 0.2], [0, 0, 0.3], undefined, false));
  b.attach('head', g(new THREE.BoxGeometry(0.22, 0.04, 0.04), lava, [0, 0.1, 0.13], undefined, undefined, false));
  b.attach('head', g(new THREE.ConeGeometry(0.12, 0.22, 7), char, [0, 0.3, -0.02]));
  return [lava, b.jointMat];
};

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
    mobility: 'L+direction: Portal hop · L neutral: step out behind the opponent · L+A Rift Step kick',
    power: 'R+A: Swap Gate (trade places) · running R+A: Portal Punch · hold R+A: Rift Storm',
    grapple: 'Lifts light and medium props. R+X: Portal Drop.',
    finisher: 'Gate Barrage — strikes from portals on every side',
    weakness: 'Every portal costs energy; with an empty meter she has no way back from a launch.',
    moves: [['A A A', 'Jab, cross, gate kick'], ['A (running)', 'Gate Elbow'], ['R+A', 'Swap Gate — swap places (use it near an edge!)'], ['R+A (running)', 'Portal Punch — hits from behind at range, pulls them in'], ['Hold R+A', 'Rift Storm — three gates fire on the opponent'], ['L + dir / L', 'Portal hop / step behind'], ['L+A', 'Rift Step kick'], ['R+X', 'Portal Drop — drops them from the sky'], ['Grab, A', 'Knee pummel']],
  },
  build: genericBuild(0x1c2a24, 0x2e3a44, 0x7dff6a),
};
rift.look = { female: true, height: 1.95, bulk: 0.96, body: 0x22302c, joints: 0x7dff6a, jointGlow: 1.4, bodyRough: 0.4, bodyMetal: 0.4 };
rift.adorn = (b) => {
  const dark = mat(0x18201c, 0.5, 0.4);
  const glow = mat(0x9dff8a, 0.2, 0, 0x5aff4a, 1.8);
  const silver = mat(0xc8d2cc, 0.25, 0.9);
  // Hood, visor, portal rings on the wrists and a halo ring on the back.
  b.attach('head', g(new THREE.SphereGeometry(0.15, 14, 10), dark, [0, 0.13, -0.03], undefined, [1.05, 1.1, 1.1]));
  b.attach('head', g(new THREE.BoxGeometry(0.19, 0.035, 0.04), glow, [0, 0.1, 0.12], undefined, undefined, false));
  for (const j of ['lFore', 'rFore'] as const) {
    b.attach(j, g(new THREE.TorusGeometry(0.09, 0.018, 8, 20), glow, [0, -0.2, 0], [Math.PI / 2, 0, 0], undefined, false));
    b.attach(j, g(new THREE.CylinderGeometry(0.075, 0.07, 0.16, 10), silver, [0, -0.12, 0]));
  }
  b.attach('spine', g(new THREE.TorusGeometry(0.3, 0.025, 8, 32), glow, [0, 0.1, -0.24], undefined, undefined, false));
  b.attach('spine', g(new THREE.TorusGeometry(0.22, 0.012, 6, 28), silver, [0, 0.1, -0.24], undefined, undefined, false));
  for (const [j, sx] of [['lArm', 1], ['rArm', -1]] as const) b.attach(j, g(new THREE.BoxGeometry(0.18, 0.06, 0.2), silver, [sx * 0.03, 0.03, 0], [0, 0, sx * 0.35]));
  b.attach('hips', g(new THREE.BoxGeometry(0.33, 0.05, 0.23), glow, [0, 0.03, 0], undefined, undefined, false));
  return [glow, b.jointMat];
};

export const ROSTER: CharacterDef[] = [basalt, tether, aerin, shunt, vanta, magna, ember, rift];
export function charById(id: string) {
  return ROSTER.find((c) => c.id === id) ?? ROSTER[0];
}

export { addOutline };
