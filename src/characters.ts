import * as THREE from 'three';
import { Rig, Proportions, Pose, P, limb, box, sphere, addOutline } from './rig';

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
  | 'thunderclap' | 'groundPound' | 'bolt' | 'snare' | 'pulse' | 'blinkStrike' | 'counter' | 'dash';

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
}

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
  };
  sheet: { mobility: string; power: string; grapple: string; finisher: string; weakness: string };
  build: (rig: Rig) => { accents: THREE.MeshStandardMaterial[] };
}

// ------------------------------------------------------------------ shared moves
const jab = (dmg = 5, reach = 0.95): MoveDef => ({
  id: 'jab', wind: P.jabW, strike: P.jabS, startup: 5, active: 4, recovery: 9, lunge: 2.5,
  hit: { fwd: reach, up: 1.3, radius: 0.55, stamina: dmg, health: 0, kbF: 2, kbU: 0, stun: 16 },
});
const cross = (dmg = 6, reach = 1.0): MoveDef => ({
  id: 'cross', wind: P.crossW, strike: P.crossS, startup: 6, active: 4, recovery: 11, lunge: 3,
  hit: { fwd: reach, up: 1.3, radius: 0.6, stamina: dmg, health: 0, kbF: 2.5, kbU: 0, stun: 18 },
});
const launcher = (dmg: number, reach: number, kbF: number, kbU: number, extra: Partial<MoveDef> = {}): MoveDef => ({
  id: 'launcher', wind: P.upperW, strike: P.upperS, startup: 10, active: 5, recovery: 18, lunge: 3.5,
  hit: { fwd: reach, up: 1.4, radius: 0.7, stamina: dmg, health: 2, kbF, kbU, stun: 30, launch: true, heavy: true, breaksWalls: 25 },
  ...extra,
});
const airRise = (dmg = 6): MoveDef => ({
  id: 'airRise', wind: P.upperW, strike: P.kickS, startup: 4, active: 6, recovery: 10, airOk: true,
  hit: { fwd: 0.9, up: 1.5, radius: 0.75, stamina: dmg, health: 0, kbF: 4, kbU: 9, stun: 26, launch: true },
});
const airDive = (dmg = 8): MoveDef => ({
  id: 'airDive', wind: P.overheadW, strike: P.diveS, startup: 6, active: 10, recovery: 12, airOk: true, riseV: -14,
  hit: { fwd: 0.8, up: 0.6, radius: 0.85, stamina: dmg, health: 1, kbF: 6, kbU: 3, stun: 28, launch: true, heavy: true },
});
const counter = (): MoveDef => ({
  id: 'counter', wind: P.crossW, strike: P.kickS, startup: 3, active: 5, recovery: 14, lunge: 6, special: 'counter',
  hit: { fwd: 1.0, up: 1.2, radius: 0.8, stamina: 10, health: 3, kbF: 9, kbU: 6, stun: 30, launch: true, heavy: true, breaksWalls: 20 },
});

// ------------------------------------------------------------------ materials
function mat(color: number, rough = 0.6, metal = 0.1, emissive = 0x000000, ei = 0, flat = false) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei, flatShading: flat });
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
  },
  sheet: {
    mobility: 'L: Sprint — L+A shoulder charge breaks walls',
    power: 'R+A: Thunderclap shockwave cone · in air: Ground Pound',
    grapple: 'Lifts every prop class, including the fuel tank. Planted heavy throw.',
    finisher: 'Quarry Drop — lifts and spikes the opponent through the roof deck',
    weakness: 'Ground recovery barely changes his trajectory; off an open edge he falls.',
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
  lift: 0,
  speed: 7.6,
  jumpV: 12.5,
  weight: 0.85,
  heavy: 0,
  radius: 0.45,
  height: 1.85,
  durability: 0.9,
  proportions: { thigh: 0.46, shin: 0.46, torso: 0.62, shoulderW: 0.56, hipW: 0.26, upperArm: 0.33, foreArm: 0.32, neck: 0.1 },
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
  },
  sheet: {
    mobility: 'L: Line swing (hold) · sticks to walls on contact · L+A swing kick',
    power: 'R+A: Snare bolt — binds the target briefly',
    grapple: 'X at range: line-yank opponent or light prop. Lifts light props only.',
    finisher: 'Cocoon Spin — binds, spins and flings',
    weakness: 'Cannot lift medium or heavy props; low weight means long launches.',
  },
  build(rig) {
    const suit = mat(0x109c8e, 0.45, 0.15);
    const dark = mat(0x12151c, 0.5, 0.2);
    const gold = mat(0xe8b520, 0.3, 0.8, 0x6a4800, 0.4);
    const lens = mat(0xe8fbff, 0.2, 0, 0x9ff7ff, 1.4);
    const j = rig.joints;
    box(j.hips, 0.34, 0.22, 0.24, dark, [0, 0.02, 0]);
    sphere(j.spine, 0.22, suit, [0, 0.22, 0], [1.05, 1.2, 0.8]);
    sphere(j.spine, 0.26, suit, [0, 0.48, 0.0], [1.25, 0.9, 0.8]);
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
  height: 1.9,
  durability: 1.0,
  proportions: { thigh: 0.48, shin: 0.47, torso: 0.62, shoulderW: 0.52, hipW: 0.27, upperArm: 0.33, foreArm: 0.31, neck: 0.11 },
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
  },
  sheet: {
    mobility: 'L: Toggle flight (B rise, Y sink) · L+A flight dash',
    power: 'R+A: Volt bolt — lasting damage, deflectable by super block',
    grapple: 'Lifts light props only.',
    finisher: 'Skyfall — carries the opponent up and drives them down in a lightning strike',
    weakness: 'Flight burns energy; caught charging on the ground she is exposed.',
  },
  build(rig) {
    const white = mat(0xe8e6f4, 0.4, 0.15);
    const violet = mat(0x6d36f0, 0.4, 0.2);
    const skin = mat(0xc68f6e, 0.7, 0);
    const hair = mat(0xf1f1ff, 0.6, 0.1);
    const glow = mat(0xc9a8ff, 0.2, 0, 0xa070ff, 1.8);
    const j = rig.joints;
    box(j.hips, 0.32, 0.2, 0.22, violet, [0, 0.02, 0]);
    sphere(j.spine, 0.2, violet, [0, 0.22, 0], [1.0, 1.25, 0.75]);
    sphere(j.spine, 0.23, white, [0, 0.48, 0], [1.2, 0.85, 0.78]);
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
  height: 1.95,
  durability: 0.95,
  proportions: { thigh: 0.5, shin: 0.48, torso: 0.66, shoulderW: 0.62, hipW: 0.3, upperArm: 0.35, foreArm: 0.34, neck: 0.1 },
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
  },
  sheet: {
    mobility: 'L+direction: Hop-teleport · L neutral: flank behind opponent · L+A blink strike',
    power: 'R+A: Displacement pulse — radial blast',
    grapple: 'Lifts light props only.',
    finisher: 'Scatter — a chain of teleport strikes from every side',
    weakness: 'Teleports cost energy; with an empty meter he has no way back from a launch.',
  },
  build(rig) {
    const coat = mat(0x4b5468, 0.65, 0.2);
    const under = mat(0x252a36, 0.55, 0.25);
    const cyan = mat(0x37f2ff, 0.2, 0, 0x20e0ff, 1.6);
    const mask = mat(0xb9c3cf, 0.35, 0.6);
    const j = rig.joints;
    box(j.hips, 0.4, 0.24, 0.26, under, [0, 0.02, 0]);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 0.75, 10, 1, true), coat);
    (skirt.material as THREE.Material).side = THREE.DoubleSide;
    skirt.position.y = -0.3;
    skirt.castShadow = true;
    j.hips.add(skirt);
    sphere(j.spine, 0.22, coat, [0, 0.25, 0], [1.05, 1.3, 0.8]);
    sphere(j.spine, 0.26, coat, [0, 0.5, 0], [1.25, 0.9, 0.85]);
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
    return { accents: [cyan] };
  },
};

export const ROSTER: CharacterDef[] = [basalt, tether, aerin, shunt];
export function charById(id: string) {
  return ROSTER.find((c) => c.id === id) ?? ROSTER[0];
}

export { addOutline };
