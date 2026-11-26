import * as THREE from 'three';
import { CharacterDef, MoveDef, HitSpec, PROP_SWING, finishMaterial } from './characters';
import { SkinnedBody, hasBodyModel, ClipPlay, hasClip } from './skinned';
import { Rig, P, Pose } from './rig';
import { InputFrame, emptyFrame } from './input';
import { Prop, BOUNDS, KILL_Y, WallSeg } from './arena';
import { sfx } from './audio';
import { Ribbon, GlowMaterial } from './fx';
import type { Match } from './match';

export type FState =
  | 'ground' | 'air' | 'attack' | 'guard' | 'sblock' | 'evade' | 'charge'
  | 'grabbing' | 'grabbed' | 'lift' | 'throw' | 'lineGrab' | 'yanked'
  | 'hitstun' | 'launched' | 'down' | 'getup' | 'stunned'
  | 'swing' | 'cling' | 'fly' | 'teleport' | 'recover'
  | 'finisher' | 'finished' | 'ko' | 'out' | 'victory' | 'idleLock' | 'powerCharge' | 'pgrapple';

export const TUNING = {
  gravity: 30,
  dangerHealth: 25,
  dangerStamina: 10,
  staminaScale: 0.75, // global multiplier on ordinary (recoverable) damage
  finisherCost: 25,
  rageDuration: 8, // seconds
  recoveryCost: 20,
  superJumpCost: 15,
  superThrowCost: 20,
  staminaRegenDelay: 90, // ticks
  staminaRegen: 7, // per second
  energyRegen: 2.5,
  chargeRate: 32,
  flightDrain: 5,
  sblockDrain: 16,
  teleportCost: 12,
  rageGain: 0.6, // rage per point of damage dealt (lasting damage counts double)
  catchWindow: 14, // ticks after pressing guard
};

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();

export interface HitResult { result: 'hit' | 'block' | 'sblock' | 'miss' | 'catch' }

export class Fighter {
  rig: Rig;
  accents: THREE.MeshStandardMaterial[];
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  onGround = true;
  health = 100;
  stamina = 100;
  energy = 50;
  rage = 0;
  rageTime = 0;
  state: FState = 'ground';
  t = 0; // ticks in state
  move: MoveDef | null = null;
  moveHitDone = false;
  moveWallDone = new Set<WallSeg>();
  chainIdx = 0;
  chainQueued = false;
  heldProp: Prop | null = null;
  grabbed: Fighter | null = null;
  grabbedBy: Fighter | null = null;
  invuln = 0;
  stun = 0;
  lastHit = 999;
  guardPressedAt = -999;
  tick = 0;
  rUsed = false;
  anchor: THREE.Vector3 | null = null;
  ropeLen = 0;
  clingNormal = new THREE.Vector3();
  clingTop = 0;
  teleportTo = new THREE.Vector3();
  private dangerPrev = false;
  input: InputFrame = emptyFrame();
  outcome: 'ko' | 'ringout' | 'finisher' | null = null;
  lastAttacker: Fighter | null = null;
  runPhase = 0;
  hitFlash = 0;
  noPowerFlash = 0;
  notice = '';
  noticeT = 0;
  stats = { hits: 0, throws: 0, catches: 0, recoveries: 0 };
  lineTarget: { kind: 'fighter' | 'prop'; f?: Fighter; p?: Prop; point: THREE.Vector3 } | null = null;
  aura: THREE.Mesh;
  rageAura: THREE.Mesh;
  shadowBlob: THREE.Mesh;
  line: THREE.Line;
  private lineGeo: THREE.BufferGeometry;
  finisherData: { start: THREE.Vector3; yaw0: number } | null = null;
  lastLaunchSpeed = 0;
  hitSide = 1;

  ribbon: Ribbon;
  private auraAcc = 0;
  private emberAcc = 0;
  /** World points spread over the body, for aura wisps. */
  private auraPoints(): THREE.Vector3[] {
    if (this.skinned) {
      return ['pelvis', 'spine_02', 'spine_03', 'Head', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r']
        .map((n) => this.skinned!.boneWorld(n));
    }
    const r = this.rig, v = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    return [v(r.joints.hips), v(r.joints.spine), v(r.joints.head), v(r.joints.lFore), v(r.joints.rFore), v(r.hand.l), v(r.hand.r), v(r.joints.lShin), v(r.joints.rShin), v(r.foot.l), v(r.foot.r)];
  }
  /** The fighter's own glow: accent colour normally, red in Rage, pulsing blue while charging. */
  glow: THREE.PointLight;
  contact: THREE.Mesh;
  private limbPrev = new Map<string, THREE.Vector3>();
  /** Playback speed that fits a clip's length to a number of gameplay ticks. */
  private fitSpeed(name: string, ticks: number) {
    const clip = this.skinned?.clipDuration(name) ?? 1;
    return THREE.MathUtils.clamp(clip / Math.max(0.05, ticks / 60), 0.6, 3.5);
  }
  skinned: SkinnedBody | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private flashOn = false;
  private lastStepPhase = 0;
  constructor(public def: CharacterDef, public idx: number, public match: Match) {
    // Rigged skinned body when the model is loaded; procedural body otherwise.
    const sk = hasBodyModel() && def.look && def.adorn ? new SkinnedBody(def.look, (m, k) => finishMaterial(m, k, k === 'body' && !!def.look!.flat)) : null;
    this.rig = new Rig(sk ? sk.proportions : def.proportions);
    if (sk) {
      sk.bind(this.rig);
      this.accents = def.adorn!(sk, this.rig);
      this.skinned = sk;
    } else {
      const b = def.build(this.rig);
      this.accents = b.accents;
    }
    for (const m of this.accents) m.userData.baseEI = m.emissiveIntensity;
    // All body materials, for the white impact flash.
    const seen = new Set<THREE.Material>();
    this.rig.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || o.userData.outline || !(m as any).isMeshStandardMaterial || seen.has(m)) return;
      seen.add(m);
      m.userData.baseEmissive = m.emissive.clone();
      if (m.userData.baseEI === undefined) m.userData.baseEI = m.emissiveIntensity;
      this.mats.push(m);
    });
    this.glow = new THREE.PointLight(def.color, 0, 5.5, 2);
    match.scene.add(this.glow);
    this.contact = new THREE.Mesh(new THREE.CircleGeometry(def.radius * 1.9, 24), contactMat());
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.renderOrder = 1;
    match.scene.add(this.contact);
    this.ribbon = new Ribbon(match.scene, new THREE.Color(def.color).lerp(new THREE.Color(0xffffff), 0.45).getHex());
    // Charge aura and rage aura.
    const auraGeo = new THREE.CylinderGeometry(def.radius * 1.4, def.radius * 2.1, def.height * 1.25, 32, 1, true);
    auraGeo.translate(0, def.height * 0.55, 0);
    this.aura = new THREE.Mesh(auraGeo, new GlowMaterial(0x6fc8ff, 'shell'));
    this.rageAura = new THREE.Mesh(auraGeo, new GlowMaterial(0xff3a20, 'shell'));
    this.rig.root.add(this.aura, this.rageAura);
    // Player ring marker on the ground.
    const ring = new THREE.Mesh(new THREE.RingGeometry(def.radius + 0.15, def.radius + 0.32, 32), new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x3aa0ff : 0xff4a4a, transparent: true, opacity: 0.75, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.shadowBlob = ring;
    match.scene.add(ring);
    this.lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(this.lineGeo, new THREE.LineBasicMaterial({ color: def.lineColor ?? 0xeaffff }));
    this.line.visible = false;
    this.line.frustumCulled = false;
    match.scene.add(this.line);
    match.scene.add(this.rig.root);
    this.rig.snap(P.guard(0, def.heavy));
  }

  dispose() {
    this.match.scene.remove(this.rig.root, this.shadowBlob, this.line, this.glow, this.contact);
    this.ribbon.dispose(this.match.scene);
  }

  get opp(): Fighter {
    return this.match.fighters[1 - this.idx];
  }
  get forward() {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  get center() {
    return this.pos.clone().addScaledVector(UP, this.def.height * 0.55);
  }
  /** Live Danger check: very low health OR stamina exposes the fighter to a finisher. */
  get danger() {
    return this.alive && (this.health <= TUNING.dangerHealth || this.stamina <= TUNING.dangerStamina);
  }
  get raging() {
    return this.rageTime > 0;
  }
  get airborne() {
    return !this.onGround;
  }
  get alive() {
    return this.state !== 'ko' && this.state !== 'out' && this.state !== 'finished';
  }
  hasEnergy(n: number) {
    return this.raging || this.energy >= n;
  }
  spend(n: number) {
    if (!this.raging) this.energy = Math.max(0, this.energy - n);
  }
  say(msg: string) {
    this.notice = msg;
    this.noticeT = 75;
  }

  reset(spawn: THREE.Vector3, yaw: number) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.health = 100;
    this.stamina = 100;
    this.energy = 50;
    this.rage = 0;
    this.rageTime = 0;
    this.heldProp = null;
    this.grabbed = null;
    this.grabbedBy = null;
    this.move = null;
    this.invuln = 0;
    this.stun = 0;
    this.lastHit = 999;
    this.anchor = null;
    this.outcome = null;
    this.dangerPrev = false;
    this.burnT = 0;
    this.lineTarget = null;
    this.finisherData = null;
    this.lastAttacker = null;
    this.stats = { hits: 0, throws: 0, catches: 0, recoveries: 0 };
    this.rig.root.visible = true;
    this.setState('ground');
    this.onGround = true;
    this.rig.snap(P.guard(0, this.def.heavy));
  }

  setState(s: FState) {
    this.state = s;
    this.t = 0;
    if (s !== 'swing') this.anchor = null;
    if (s !== 'lineGrab') this.lineTarget = null;
  }

  // ======================================================================== main tick
  update(dt: number) {
    this.tick++;
    this.t++;
    this.lastHit++;
    if (this.invuln > 0) this.invuln--;
    if (this.noticeT > 0) this.noticeT--;
    if (this.noPowerFlash > 0) this.noPowerFlash--;
    if (this.hitFlash > 0) this.hitFlash--;
    const inp = this.input;
    if (inp.b.guard.pressed) this.guardPressedAt = this.tick;
    if (this.landT > 0) this.landT--;
    if (this.blockT > 0) this.blockT--;
    // Input buffer: presses made during an action come out as soon as the fighter is free (within ~10 frames).
    const free = this.state === 'ground' || this.state === 'air' || this.state === 'fly';
    for (const a of ['attack', 'grab', 'jump', 'guard'] as const) {
      if (inp.b[a].pressed && !free) this.buf[a] = this.tick;
    }
    if (free) {
      for (const a of ['attack', 'grab', 'jump', 'guard'] as const) {
        const at = this.buf[a];
        if (at !== undefined && this.tick - at <= 10 && !inp.b[a].pressed) { inp.b[a].pressed = true; if (a === 'guard') inp.b[a].down = true; }
      }
      this.buf = {};
    }
    // Smooth turning toward an attack target (no instant snaps).
    if (this.turnTarget !== null) {
      let d = this.turnTarget - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const step = 0.55;
      if (Math.abs(d) <= step || (this.state !== 'attack' && this.state !== 'throw')) { this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step; this.turnTarget = Math.abs(d) <= step ? null : this.turnTarget; if (this.state !== 'attack' && this.state !== 'throw') this.turnTarget = null; }
      else this.yaw += Math.sign(d) * step;
    }
    if (inp.b.power.pressed) this.rUsed = false;

    this.updateResources(dt);

    switch (this.state) {
      case 'ground': case 'air': this.stFree(dt); break;
      case 'fly': this.stFly(dt); break;
      case 'attack': this.stAttack(dt); break;
      case 'guard': case 'sblock': this.stGuard(dt); break;
      case 'evade': this.stEvade(dt); break;
      case 'charge': this.stCharge(dt); break;
      case 'grabbing': this.stGrabbing(dt); break;
      case 'grabbed': case 'finished': case 'yanked': break; // positioned by holder
      case 'lift': this.stLift(dt); break;
      case 'throw': this.stThrow(dt); break;
      case 'lineGrab': this.stLineGrab(dt); break;
      case 'hitstun': this.stHitstun(dt); break;
      case 'stunned': this.stStunned(dt); break;
      case 'launched': this.stLaunched(dt); break;
      case 'down': this.stDown(dt); break;
      case 'getup': if (this.t > 38) this.setState('ground'); this.friction(dt, 20); break;
      case 'swing': this.stSwing(dt); break;
      case 'cling': this.stCling(dt); break;
      case 'teleport': this.stTeleport(dt); break;
      case 'recover': if (this.t > 10) this.setState(this.onGround ? 'ground' : 'air'); break;
      case 'finisher': this.stFinisher(dt); break;
      case 'powerCharge': this.stPowerCharge(dt); break;
      case 'pgrapple': this.stPGrapple(dt); break;
      case 'ko': this.stKO(dt); break;
      case 'out': break;
      case 'victory': case 'idleLock': this.friction(dt, 20); break;
    }

    if (!['grabbed', 'finished', 'yanked', 'teleport', 'out', 'finisher', 'cling', 'pgrapple'].includes(this.state)) this.physics(dt);
    if (this.heldProp) this.positionHeldProp();
    if (this.pos.y < KILL_Y && this.state !== 'out') this.ringOut();
  }

  burnT = 0;
  private updateResources(dt: number) {
    if (this.burnT > 0 && this.alive) {
      this.burnT--;
      // Damage over time: mostly stamina, a little lasting health. Never finishes a fighter off on its own.
      this.stamina = Math.max(0, this.stamina - 4 * dt);
      this.health = Math.max(1, this.health - 1.2 * dt);
      this.stamina = Math.min(this.stamina, this.health);
      this.lastHit = 0;
      if (this.tick % 3 === 0) {
        const p = this.center.add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.6));
        this.match.fx.wisp(p, new THREE.Color(Math.random() < 0.5 ? 0xff5a10 : 0xffb030).multiplyScalar(0.8), 0.4);
      }
    }
    if (this.lastHit > TUNING.staminaRegenDelay && this.alive && this.stamina < this.health) {
      this.stamina = Math.min(this.health, this.stamina + TUNING.staminaRegen * this.def.durability * dt);
    }
    if (this.state !== 'charge' && this.state !== 'fly' && this.state !== 'sblock') this.energy = Math.min(100, this.energy + TUNING.energyRegen * dt);
    if (this.rageTime > 0) {
      this.energy = 100;
      this.rageTime -= dt;
      if (this.rageTime <= 0) {
        this.rageTime = 0;
        this.rage = 0;
        sfx.rageOff();
        this.say('RAGE OVER');
      }
    }
    const d = this.danger;
    if (d && !this.dangerPrev) sfx.danger();
    this.dangerPrev = d;
  }

  // ======================================================================== movement helpers
  private wishDir(): THREE.Vector3 {
    const c = this.match.camBasis;
    const d = new THREE.Vector3().addScaledVector(c.right, this.input.mx).addScaledVector(c.fwd, this.input.my);
    d.y = 0;
    return d;
  }
  private stickMag() {
    return Math.hypot(this.input.mx, this.input.my);
  }
  private faceToward(dir: THREE.Vector3, rate: number, dt: number) {
    if (dir.lengthSq() < 1e-4) return;
    const target = Math.atan2(dir.x, dir.z);
    let d = target - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = rate * dt;
    this.yaw += Math.abs(d) < step ? d : Math.sign(d) * step;
  }
  private faceOpp(maxDist = 6) {
    const o = this.opp;
    const d = o.pos.clone().sub(this.pos).setY(0);
    if (d.length() < maxDist && o.alive) this.yaw = Math.atan2(d.x, d.z);
  }
  private friction(dt: number, k: number) {
    const f = Math.exp(-k * dt);
    this.vel.x *= f;
    this.vel.z *= f;
  }
  private accelTo(target: THREE.Vector3, rate: number, dt: number) {
    const k = 1 - Math.exp(-rate * dt);
    this.vel.x += (target.x - this.vel.x) * k;
    this.vel.z += (target.z - this.vel.z) * k;
  }

  // ======================================================================== physics
  private physics(dt: number) {
    const gravityOn = !(this.state === 'fly' || this.state === 'swing' || this.state === 'pgrapple' && this.def.powerGrapple === 'skyDrop' || (this.state === 'attack' && (this.move?.id === 'flightDash' || this.move?.id === 'stormDash')));
    if (gravityOn && !this.onGround) this.vel.y -= TUNING.gravity * dt;
    if (this.state === 'swing' && !this.recoverSwing) this.vel.y -= TUNING.gravity * dt;
    const prev = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    // Collisions with scenery.
    const pre = this.pos.clone();
    const contacts = this.match.arena.pushOut(this.pos, this.def.radius, this.def.height);
    for (const c of contacts) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const into = -(this.vel.x * c.n.x + this.vel.z * c.n.z);
      // A launched body slamming into the fence damages it; if it breaks, the body carries through.
      if (c.s.kind === 'wall' && this.state === 'launched' && into > 6) {
        const w = c.s.ref as WallSeg;
        const broke = w.damage(into * 7 * (this.lastAttacker?.raging ? 1.3 : 1), this.match.fx, this.vel.clone().setY(0).normalize());
        if (broke) {
          this.pos.copy(pre);
          this.vel.multiplyScalar(0.85);
          this.match.arena.spawnRubble(w.center.clone().setY(0.5).addScaledVector(w.outward, -1.2));
          continue;
        }
        this.applyDamage(4, 0);
        this.vel.x += c.n.x * into * 1.3;
        this.vel.z += c.n.z * into * 1.3;
        this.match.fx.shake = Math.max(this.match.fx.shake, 0.35);
        sfx.hit(true);
      } else if (c.s.kind === 'prop' && this.state === 'launched' && into > 9) {
        this.match.shatterProp(c.s.ref as Prop, this.vel.clone());
      } else if (into > 0) {
        this.vel.x += c.n.x * into;
        this.vel.z += c.n.z * into;
      }
      // Wall contact for line runners: stick on contact while airborne.
      if (this.def.recovery === 'swing' && c.s.clingable && (this.state === 'air' || this.state === 'swing') && hs > 2 && into > 1) {
        this.startCling(c.n, c.s.max.y);
      }
    }
    // Sign letters are knocked loose by bodies flying through them.
    if (this.state === 'launched' && this.pos.z < -12.3 && this.pos.y > 2.6 && this.pos.y < 7) {
      const i = this.match.arena.letters.findIndex((L) => !L.down && Math.abs(L.x - this.pos.x) < 1.6);
      if (i >= 0) this.match.arena.hitLetter(i, 60);
    }
    // Ground.
    const g = this.match.arena.groundAt(this.pos.x, this.pos.z, Math.max(prev.y, this.pos.y));
    if (this.pos.y <= g && this.vel.y <= 0.01) {
      const impact = -this.vel.y;
      this.pos.y = g;
      this.vel.y = 0;
      if (!this.onGround) this.onLand(impact);
      this.onGround = true;
    } else if (this.pos.y > g + 0.05) {
      if (this.onGround && this.state === 'ground') this.state = 'air';
      this.onGround = false;
    }
  }

  private onLand(impact: number) {
    if (impact > 6) sfx.land();
    if (impact > 4) this.match.fx.dust(this.pos, this.def.heavy ? 8 : 4, this.def.heavy ? 0.55 : 0.35, impact * 0.15);
    if (impact > 8 && this.def.heavy) this.match.fx.shake = Math.max(this.match.fx.shake, 0.25);
    switch (this.state) {
      case 'air': this.setState('ground'); this.landT = 12; this.landSerial++; break;
      case 'launched':
        if (this.health <= 0) { this.setState('ko'); break; }
        this.match.fx.burstDebris(this.pos.clone(), 6, 0x777777, 3, 0.15);
        this.match.fx.dust(this.pos, 8, 0.5, 2.2);
        this.setState('down');
        break;
      case 'attack':
        if (this.move?.special === 'groundPound') this.groundPoundImpact();
        else if (this.move?.airOk && !['bolt', 'snare', 'pulse', 'blinkStrike', 'implode', 'swap', 'riftStorm'].includes(this.move.special ?? '') && this.move.id !== 'flightDash') { this.move = null; this.setState('recover'); }
        break;
      case 'swing': this.setState('ground'); break;
      case 'ko': break;
    }
  }

  // ======================================================================== free state: ground & air
  private stFree(dt: number) {
    const inp = this.input;
    const b = inp.b;
    const ground = this.onGround;
    if (ground && this.state !== 'ground') this.state = 'ground';
    if (!ground && this.state !== 'air') this.state = 'air';
    const wish = this.wishDir();
    const sprint = this.def.recovery === 'ground' && b.mobility.down && ground && !this.heldProp;
    let speed = this.def.speed * (sprint ? 1.55 : 1);
    if (this.heldProp) speed *= [0.85, 0.7, 0.55][this.heldProp.cls];

    if (this.tryActions()) return;

    if (ground) {
      this.accelTo(wish.clone().multiplyScalar(speed), this.def.heavy ? 14 : 20, dt);
      this.faceToward(wish, 13, dt);
      const hs = Math.hypot(this.vel.x, this.vel.z);
      this.runPhase += hs * dt * (this.def.heavy ? 1.6 : 2.1);
      // Charging: hold R stationary.
      if (b.power.down && b.power.held > 12 && this.stickMag() < 0.2 && !this.heldProp && !this.rUsed && !this.raging) {
        this.setState('charge');
        return;
      }
    } else {
      this.accelTo(wish.clone().multiplyScalar(speed * 0.85), 5, dt);
      this.faceToward(wish, 6, dt);
    }
  }

  /** Resolve this tick's action from the input. Each branch is exclusive so a chord resolves once. */
  private tryActions(): boolean {
    const b = this.input.b;
    const ground = this.onGround;
    const R = b.power.down;
    const mark = () => { if (R) this.rUsed = true; };

    // R+X: super grapple / super throw / finisher.
    if ((b.grab.pressed && R) || (b.power.pressed && b.grab.down)) { mark(); this.superGrab(); return true; }
    // R+A: powered attack.
    if ((b.attack.pressed && R) || (b.power.pressed && b.attack.down)) {
      mark();
      if (this.heldProp) { this.startThrow(true); return true; }
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const running = ground && hs > this.def.speed * 0.7 && this.stickMag() > 0.6;
      const m = !ground ? this.def.moves.powerAir : running ? this.def.moves.dashPower : this.def.moves.power;
      if (!this.hasEnergy(m.energy ?? 0)) { this.noPower(); return true; }
      this.spend(m.energy ?? 0);
      // Standing R+A: keep A held to charge into the character's charged power.
      if (ground && !running) { this.vel.set(0, this.vel.y, 0); this.setState('powerCharge'); return true; }
      this.startMove(m);
      return true;
    }
    // R+B: super jump.
    if ((b.jump.pressed && R) && ground) {
      mark();
      if (!this.hasEnergy(TUNING.superJumpCost)) { this.noPower(); return true; }
      this.spend(TUNING.superJumpCost);
      this.vel.y = this.def.jumpV * 1.7;
      this.onGround = false;
      this.setState('air');
      this.match.fx.ring(this.pos, 2.2, 0xa0d8ff, 0.35);
      sfx.jump();
      return true;
    }
    // R+Y: super block.
    if ((b.guard.pressed && R) || (b.power.pressed && b.guard.down)) {
      mark();
      if (!this.hasEnergy(5)) { this.noPower(); return true; }
      this.setState('sblock');
      return true;
    }
    // L+A: mobility attack.
    if (b.attack.pressed && b.mobility.down && !this.heldProp) {
      const m = this.def.moves.mobilityAtk;
      if (m.energy && !this.hasEnergy(m.energy)) { this.noPower(); return true; }
      if (m.energy) this.spend(m.energy);
      this.startMove(m);
      return true;
    }
    // A: attack chain / air attacks / throw held prop.
    if (b.attack.pressed) {
      if (this.heldProp) {
        // Light props are swung as weapons; anything heavier is thrown.
        if (this.heldProp.cls === 0) { this.startMove(PROP_SWING); return true; }
        this.startThrow(false);
        return true;
      }
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (ground && hs > this.def.speed * 0.75 && this.stickMag() > 0.6) { this.startMove(this.def.moves.runAttack); return true; }
      if (ground) { this.chainIdx = 0; this.startMove(this.def.moves.chain[0]); }
      else this.startMove(this.vel.y > 0 ? this.def.moves.airRise : this.def.moves.airDive);
      return true;
    }
    // X: grapple, pick up, or throw.
    if (b.grab.pressed) { this.grabAction(); return true; }
    // B: jump.
    if (b.jump.pressed && ground) {
      this.vel.y = this.def.jumpV;
      this.jumpSerial++;
      this.onGround = false;
      this.setState('air');
      sfx.jump();
      return true;
    }
    // Y: guard (or drop prop).
    if (b.guard.pressed && !R) {
      if (this.heldProp) { this.dropProp(); return true; }
      this.setState('guard');
      return true;
    }
    // L: mobility.
    if (this.mobility()) return true;
    // Neutral R tap: Rage.
    if (b.power.released && b.power.lastHeld <= 14 && !this.rUsed && this.rage >= 100 && !this.raging && this.stickMag() < 0.3) {
      this.activateRage();
      return true;
    }
    return false;
  }

  private noPower() {
    this.noPowerFlash = 40;
    this.say('NO POWER');
    sfx.noPower();
  }

  activateRage() {
    this.rageTime = TUNING.rageDuration;
    this.rage = 100;
    this.energy = 100;
    sfx.rageOn();
    this.say('RAGE!');
    this.match.fx.ring(this.pos, 4, 0xff3a20, 0.6);
    this.match.fx.flash(this.center, 1.6, 0xff4020, 0.3);
  }

  // ======================================================================== mobility per family
  private mobility(): boolean {
    const b = this.input.b;
    const fam = this.def.recovery;
    if (fam === 'swing' && b.mobility.pressed && !this.heldProp) {
      return this.startSwing(false);
    }
    if (fam === 'flight' && b.mobility.pressed && !this.heldProp) {
      if (!this.hasEnergy(5)) { this.noPower(); return true; }
      this.setState('fly');
      this.onGround = false;
      if (this.vel.y < 4) this.vel.y = 4;
      this.pos.y += 0.05;
      return true;
    }
    if (fam === 'teleport' && b.mobility.pressed && !this.heldProp) {
      if (!this.hasEnergy(TUNING.teleportCost)) { this.noPower(); return true; }
      this.spend(TUNING.teleportCost);
      const wish = this.wishDir();
      let target: THREE.Vector3;
      if (wish.lengthSq() > 0.1) target = this.pos.clone().addScaledVector(wish.normalize(), 7);
      else {
        const o = this.opp;
        target = o.pos.clone().addScaledVector(o.forward, -2.2);
      }
      this.beginTeleport(target, true);
      return true;
    }
    return false;
  }

  /** Colour of this fighter's teleport / phase effects. */
  get tpColor(): number { return this.def.fxColor ?? 0x37f2ff; }

  beginTeleport(target: THREE.Vector3, clampToRoof: boolean) {
    if (clampToRoof) {
      target.x = THREE.MathUtils.clamp(target.x, -BOUNDS.hw + 1, BOUNDS.hw - 1);
      target.z = THREE.MathUtils.clamp(target.z, -BOUNDS.hd + 1, BOUNDS.hd - 1);
    }
    const g = this.match.arena.groundAt(target.x, target.z, 50, 0);
    target.y = Number.isFinite(g) ? Math.max(g, Math.min(target.y, g + 3)) : target.y;
    this.match.arena.pushOut(target, this.def.radius, this.def.height);
    this.teleportTo.copy(target);
    this.match.fx.sparksAt(this.center, 18, this.tpColor, 5);
    this.match.fx.flash(this.center, 0.9, this.tpColor, 0.2);
    sfx.teleport();
    this.setState('teleport');
    this.invuln = 14;
  }

  private stTeleport(_dt: number) {
    this.rig.root.visible = this.t % 4 < 1 && this.t > 6;
    if (this.t >= 9) {
      this.pos.copy(this.teleportTo);
      this.vel.set(0, 0, 0);
      this.rig.root.visible = true;
      this.match.fx.flash(this.center, 0.9, this.tpColor, 0.2);
      this.match.fx.sparksAt(this.center, 14, this.tpColor, 5);
      const g = this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.1);
      this.onGround = this.pos.y <= g + 0.05;
      this.faceOpp(40);
      this.setState(this.onGround ? 'ground' : 'air');
    }
  }

  startSwing(recovery: boolean): boolean {
    const fwd = this.forward;
    const wish = this.wishDir();
    const dir = wish.lengthSq() > 0.1 ? wish.normalize() : fwd;
    let anchor: THREE.Vector3 | null;
    if (recovery) {
      anchor = this.match.arena.recoveryAnchor(this.pos);
    } else {
      // Real anchors ahead are preferred; otherwise a virtual line into the skyline above and ahead.
      anchor = null;
      for (const a of this.match.arena.anchors) {
        const to = a.clone().sub(this.pos);
        if (to.y < 3 || to.length() > 16) continue;
        if (to.clone().setY(0).normalize().dot(dir) > 0.5) { anchor = a; break; }
      }
      if (!anchor) anchor = this.pos.clone().addScaledVector(dir, 6).add(new THREE.Vector3(0, 9, 0));
    }
    if (!anchor) return false;
    this.anchor = anchor.clone();
    this.ropeLen = Math.max(3, this.pos.distanceTo(anchor) * 0.97);
    if (this.onGround) { this.vel.y = 6; this.onGround = false; }
    this.vel.addScaledVector(dir, 3);
    this.setState('swing');
    this.anchor = anchor.clone();
    sfx.line();
    return true;
  }

  private stSwing(dt: number) {
    const b = this.input.b;
    if (!this.anchor) { this.setState('air'); return; }
    if (this.recoverSwing) {
      // Recovery line: reel in hard toward the roof-side anchor, then vault back onto the roof.
      const to = this.anchor.clone().sub(this.pos);
      const d = to.length();
      this.vel.lerp(to.normalize().multiplyScalar(17), 1 - Math.exp(-10 * dt));
      this.faceToward(this.vel.clone().setY(0), 10, dt);
      const safelyInside = Math.abs(this.pos.x) < BOUNDS.hw - 0.6 && Math.abs(this.pos.z) < BOUNDS.hd - 0.6;
      if (d < 1.6 || (safelyInside && this.t > 6) || this.t > 120) {
        this.recoverSwing = false;
        const toC = new THREE.Vector3(-this.pos.x, 0, -this.pos.z).normalize();
        this.vel.copy(toC.multiplyScalar(6.5));
        this.vel.y = 7;
        this.setState('air');
      }
      return;
    }
    // Steering force plus forward pump.
    const wish = this.wishDir();
    this.vel.addScaledVector(wish, 10 * dt);
    // Rope constraint.
    const to = this.pos.clone().sub(this.anchor);
    const d = to.length();
    if (d > this.ropeLen) {
      to.divideScalar(d);
      this.pos.copy(this.anchor).addScaledVector(to, this.ropeLen);
      const radial = this.vel.dot(to);
      if (radial > 0) this.vel.addScaledVector(to, -radial);
    }
    this.ropeLen = Math.max(2.5, this.ropeLen - 1.5 * dt);
    const hv = this.vel.clone().setY(0);
    this.faceToward(hv, 8, dt);
    // Release: let go of L (or after a while).
    if (!b.mobility.down || this.t > 240) {
      this.vel.y += 4;
      this.setState('air');
      return;
    }
    if (b.attack.pressed) { this.startMove(this.def.moves.mobilityAtk); return; }
    if (b.jump.pressed) { this.vel.y = Math.max(this.vel.y, 0) + 8; this.setState('air'); return; }
  }
  recoverSwing = false;

  private startCling(n: THREE.Vector3, top: number) {
    this.clingNormal.copy(n);
    this.clingTop = top;
    this.vel.set(0, 0, 0);
    this.yaw = Math.atan2(-n.x, -n.z);
    this.recoverSwing = false;
    this.setState('cling');
    this.match.fx.sparksAt(this.center, 6, 0xffffff, 2);
  }

  private stCling(dt: number) {
    const b = this.input.b;
    // Climb with stick-up/down relative to the wall (any input with a component into the wall climbs).
    const wish = this.wishDir();
    const climb = wish.lengthSq() > 0.1 ? -wish.dot(this.clingNormal) : 0;
    const side = wish.clone().addScaledVector(this.clingNormal, -wish.dot(this.clingNormal));
    this.pos.y += climb * 3.0 * dt;
    this.pos.addScaledVector(side, 2.5 * dt);
    if (this.pos.y > this.clingTop - 0.4) {
      // Mantle onto the top.
      this.pos.y = this.clingTop + 0.05;
      this.pos.addScaledVector(this.clingNormal, -0.7);
      this.onGround = this.pos.y <= this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.1) + 0.06;
      this.setState(this.onGround ? 'ground' : 'air');
      return;
    }
    const g = this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= g) { this.pos.y = g; this.onGround = true; this.setState('ground'); return; }
    // Still touching the wall?
    const probe = this.pos.clone().addScaledVector(this.clingNormal, -0.2);
    const touching = this.match.arena.solids().some((s) => s.clingable && probe.x >= s.min.x - this.def.radius && probe.x <= s.max.x + this.def.radius && probe.z >= s.min.z - this.def.radius && probe.z <= s.max.z + this.def.radius && this.pos.y < s.max.y);
    if (!touching || this.t > 300) { this.setState('air'); return; }
    if (b.jump.pressed) {
      this.vel.copy(this.clingNormal).multiplyScalar(7.5);
      this.vel.y = 10;
      this.yaw = Math.atan2(this.clingNormal.x, this.clingNormal.z);
      this.setState('air');
      sfx.jump();
      return;
    }
    if (b.mobility.pressed) { this.yaw = Math.atan2(this.clingNormal.x, this.clingNormal.z); this.startSwing(false); return; }
    if (b.attack.pressed) {
      this.yaw = Math.atan2(this.clingNormal.x, this.clingNormal.z);
      this.vel.copy(this.clingNormal).multiplyScalar(8);
      this.vel.y = 3;
      this.setState('air');
      this.startMove(this.def.moves.mobilityAtk);
    }
  }

  private stFly(dt: number) {
    const b = this.input.b;
    this.spend(TUNING.flightDrain * dt);
    if (!this.raging) this.energy = Math.max(0, this.energy - 0); // drain applied via spend
    if (this.energy <= 0 && !this.raging) { this.say('FLIGHT SPENT'); this.setState('air'); return; }
    if (b.mobility.pressed) { this.setState('air'); return; }
    const wish = this.wishDir();
    this.accelTo(wish.clone().multiplyScalar(this.def.speed * 1.2), 6, dt);
    const vy = (b.jump.down ? 6 : 0) - (b.guard.down ? 6 : 0);
    this.vel.y += (vy - this.vel.y) * (1 - Math.exp(-6 * dt));
    if (this.pos.y > this.match.arena.ceiling) this.vel.y = Math.min(this.vel.y, 0);
    this.faceToward(wish.lengthSq() > 0.1 ? wish : this.opp.pos.clone().sub(this.pos).setY(0), 8, dt);
    this.match.fx.trail(this.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), 0xa070ff, 0.12, 0.3);
    // Attacks in flight.
    const R = b.power.down;
    if ((b.attack.pressed && R) || (b.power.pressed && b.attack.down)) {
      this.rUsed = true;
      const m = this.def.moves.powerAir;
      if (!this.hasEnergy(m.energy ?? 0)) { this.noPower(); return; }
      this.spend(m.energy ?? 0);
      this.startMove(m, true);
      return;
    }
    if (b.grab.pressed && R) { this.rUsed = true; this.superGrab(); return; }
    if (b.attack.pressed && b.mobility.down) { this.startMove(this.def.moves.mobilityAtk, true); return; }
    if (b.attack.pressed) { this.startMove(this.def.moves.airRise, true); return; }
    if (b.grab.pressed) { this.grabAction(); return; }
    if (this.onGround && this.vel.y <= 0 && vy <= 0 && this.t > 20) { this.setState('ground'); }
  }
  flyAfterMove = false;

  // ======================================================================== attacks
  startMove(m: MoveDef, fromFlight = false) {
    this.move = m;
    this.moveHitDone = false;
    this.moveWallDone.clear();
    this.chainQueued = false;
    this.flyAfterMove = fromFlight;
    // Soft lock-on: face the opponent if they're reasonably close or the stick is neutral.
    const o = this.opp;
    const to = o.pos.clone().sub(this.pos).setY(0);
    if (to.length() < 7 || this.stickMag() < 0.2 || m.special === 'bolt' || m.special === 'snare') {
      if (o.alive && to.length() < 40) this.turnTarget = Math.atan2(to.x, to.z);
    }
    this.setState('attack');
    if (m.special === 'blinkStrike') {
      sfx.teleport();
    }
  }

  private stAttack(dt: number) {
    const m = this.move!;
    const b = this.input.b;
    const t = this.t;
    const activeStart = m.startup;
    const activeEnd = m.startup + m.active;
    const total = activeEnd + m.recovery;
    // Chord upgrade: R pressed within 3 ticks of a plain jab becomes the powered attack (resolves once).
    if (t <= 3 && m === this.def.moves.chain[0] && b.power.pressed) {
      const pm = this.onGround ? this.def.moves.power : this.def.moves.powerAir;
      this.rUsed = true;
      if (this.hasEnergy(pm.energy ?? 0)) { this.spend(pm.energy ?? 0); this.startMove(pm); return; }
    }
    if (b.attack.pressed && t > 2 && this.chainIdx < this.def.moves.chain.length - 1 && m === this.def.moves.chain[this.chainIdx]) this.chainQueued = true;

    // Movement during move.
    if (m.lunge && t < activeEnd) {
      const f = this.forward.multiplyScalar(m.lunge);
      if (m.special !== 'slingshot' && (this.onGround || m.id === 'flightDash' || m.id === 'stormDash' || m.id === 'swingKick' || m.id === 'shoulder')) { this.vel.x = f.x; this.vel.z = f.z; }
    } else if (this.onGround) this.friction(dt, 14);
    if (m.id === 'flightDash' || m.id === 'stormDash') this.vel.y = 0;
    // Speed smear on dashes.
    if (m.lunge && m.lunge >= 12 && t >= m.startup && t < activeEnd) this.match.fx.blur = Math.max(this.match.fx.blur, 0.45);

    if (t === activeStart) this.onActiveStart(m);
    if (m.special === 'blinkStrike' && t === 5) {
      const o = this.opp;
      const target = o.pos.clone().addScaledVector(o.forward, -1.6);
      target.x = THREE.MathUtils.clamp(target.x, -BOUNDS.hw + 0.8, BOUNDS.hw - 0.8);
      target.z = THREE.MathUtils.clamp(target.z, -BOUNDS.hd + 0.8, BOUNDS.hd - 0.8);
      this.match.fx.flash(this.center, 0.8, this.tpColor, 0.15);
      this.pos.copy(target);
      this.faceOpp(10);
      this.match.fx.flash(this.center, 0.8, this.tpColor, 0.15);
      this.invuln = 6;
    }
    if (m.special === 'blinkStrike') this.rig.root.visible = !(t > 2 && t < 6);
    if (m.special === 'slingshot' && t === 3) {
      const o = this.opp;
      const to = o.center.sub(this.pos);
      if (to.length() < 13 && o.alive) { this.anchor = o.center; this.yaw = Math.atan2(to.x, to.z); this.vel.copy(to.normalize().multiplyScalar(22)); this.vel.y = Math.max(this.vel.y, 3); this.onGround = false; sfx.line(); }
      else { this.vel.copy(this.forward.multiplyScalar(14)); }
    }
    if (m.special === 'slingshot' && t > 3 && t < activeEnd && this.vel.length() > 2) {
      const o = this.opp;
      if (o.pos.distanceTo(this.pos) < 1.6) this.vel.multiplyScalar(0.3);
    }
    if (m.special === 'shadeRend' || m.special === 'implode' || m.special === 'riftStorm') this.tickSpecial(m, t, activeStart, activeEnd);
    // Ground pound continues until it lands.
    if (m.special === 'groundPound') {
      if (!this.onGround && t >= activeStart) { this.vel.y = Math.min(this.vel.y, m.riseV ?? -20); this.vel.x *= 0.9; this.vel.z *= 0.9; this.t = Math.min(this.t, activeStart + 1); }
      if (t < activeStart) { this.vel.set(0, Math.max(this.vel.y, 3), 0); }
    }
    if (t >= activeStart && t < activeEnd && m.hit && !['groundPound', 'thunderclap', 'pulse', 'shadeRend', 'implode', 'portalPunch', 'swap'].includes(m.special ?? '')) {
      this.match.resolveMelee(this, m);
    }
    // Cancel windows: ordinary attacks can be cancelled into jump, guard/evade or mobility once the hit is out.
    const cancellable = this.def.moves.chain.includes(m) || m === this.def.moves.runAttack || m.id === 'airRise';
    if (cancellable && t >= activeEnd + 3 && !this.chainQueued) {
      if (b.jump.pressed && this.onGround) { this.move = null; this.setState('ground'); this.vel.y = this.def.jumpV; this.onGround = false; this.setState('air'); this.jumpSerial++; sfx.jump(); return; }
      if (b.guard.pressed && this.onGround) { this.move = null; this.setState('guard'); return; }
      if (b.mobility.pressed) { this.move = null; this.setState(this.onGround ? 'ground' : 'air'); return; }
    }
    if (t >= activeEnd + 2 && this.chainQueued && m === this.def.moves.chain[this.chainIdx]) {
      this.chainIdx++;
      this.startMove(this.def.moves.chain[this.chainIdx]);
      return;
    }
    if (t === activeEnd && m.special === 'propSwing' && this.heldProp && this.heldProp.uses >= 3) {
      this.match.shatterProp(this.heldProp, this.forward);
      this.heldProp = null;
    }
    if (t >= total) {
      this.move = null;
      this.rig.root.visible = true;
      if (this.flyAfterMove && this.hasEnergy(1)) { this.setState('fly'); return; }
      this.setState(this.onGround ? 'ground' : 'air');
    }
  }

  private onActiveStart(m: MoveDef) {
    sfx.whiff();
    if (m.riseV !== undefined && !this.onGround) this.vel.y = m.riseV;
    if (m.special === 'thunderclap') {
      const c = this.pos.clone().addScaledVector(this.forward, m.hit!.fwd);
      this.match.fx.ring(c.clone(), m.hit!.radius * 1.6, 0xffb070, 0.4);
      this.match.fx.flash(this.pos.clone().addScaledVector(this.forward, 1).setY(this.pos.y + 1.5), 0.8, 0xffd0a0, 0.15);
      this.match.fx.shake = Math.max(this.match.fx.shake, 0.5);
      sfx.shock();
      this.match.resolveArea(this, m, c);
    }
    if (m.special === 'pulse') {
      const c = this.center;
      this.match.fx.ring(this.pos.clone(), m.hit!.radius * 1.3, this.tpColor, 0.35);
      this.match.fx.flash(c, 2.2, this.tpColor, 0.2);
      sfx.zap();
      this.match.resolveArea(this, m, c);
    }
    if (m.special === 'bolt') this.match.spawnProjectile(this, 'bolt');
    if (m.special === 'bigbolt') { this.match.spawnProjectile(this, 'bigbolt'); this.match.fx.flash(this.hand(), 1, 0xc9a8ff, 0.15); }
    if (m.special === 'tripleSnare') for (const a of [-0.28, 0, 0.28]) this.match.spawnProjectile(this, 'snare', a);
    if (m.special === 'mines') this.match.dropMines(this);
    if (m.special === 'quake') {
      this.match.fx.ring(this.pos.clone(), m.hit!.radius * 1.3, 0xff8040, 0.6);
      this.match.fx.ring(this.pos.clone(), m.hit!.radius * 0.7, 0xffd0a0, 0.4);
      this.match.fx.burstDebris(this.pos.clone(), 30, 0x6a6a72, 10, 0.35);
      this.match.fx.shake = 1.2;
      sfx.shock(); sfx.explosion();
      this.match.resolveArea(this, m, this.pos.clone().setY(this.pos.y + 0.5), true);
    }
    if (m.special === 'propSwing' && this.heldProp) {
      this.heldProp.uses++;
    }
    if (m.special === 'snare') this.match.spawnProjectile(this, 'snare');
    if (m.special === 'fireball') {
      this.match.spawnProjectile(this, 'fireball');
      this.match.fx.flash(this.hand(), 1.2, 0xff8a30, 0.15);
      this.match.fx.light(this.hand(), 0xff7a2a, 30, 0.3, 8);
    }
    if (m.special === 'swap') this.swapGate();
    if (m.special === 'portalPunch') this.portalPunch(m);
  }

  // ======================================================================== signature specials
  /** Swap Gate: trade places with the opponent — turns your own edge danger into theirs. */
  private swapGate() {
    const o = this.opp;
    const fx = this.match.fx;
    const c = this.tpColor;
    const blocked = !o.alive || o.invuln > 0 || ['teleport', 'grabbed', 'finished', 'yanked', 'out', 'ko'].includes(o.state);
    if (blocked || o.pos.distanceTo(this.pos) > 16) { fx.ring(this.pos.clone(), 1.6, c, 0.3); fx.sparksAt(this.hand(), 8, c, 4); return; }
    fx.ring(this.pos.clone(), 2.2, c, 0.4); fx.ring(o.pos.clone(), 2.2, c, 0.4);
    fx.flash(this.center, 0.6, c, 0.15); fx.flash(o.center, 0.6, c, 0.15);
    const a = this.pos.clone(), b = o.pos.clone();
    for (let i = 0; i <= 8; i++) fx.trail(a.clone().lerp(b, i / 8).setY(a.y + 1 + Math.sin((i / 8) * Math.PI) * 1.2), c, 0.18, 0.4);
    this.pos.copy(b); o.pos.copy(a);
    this.vel.set(0, 0, 0); o.vel.set(0, 0, 0);
    this.match.arena.pushOut(this.pos, this.def.radius, this.def.height);
    this.match.arena.pushOut(o.pos, o.def.radius, o.def.height);
    o.yaw += Math.PI;
    this.faceOpp(40);
    sfx.teleport();
    const dir = o.pos.clone().sub(this.pos).setY(0).normalize();
    o.receiveHit(this, { fwd: 0, up: 0, radius: 0, stamina: 5, health: 3, kbF: 2, kbU: 0, stun: 30 }, dir, { unblockable: true, source: 'projectile' });
    o.say('SWAPPED');
    this.invuln = 6;
  }

  /** Portal Punch: the fist goes through a gate and hits the opponent from behind, pulling them in. */
  private portalPunch(m: MoveDef) {
    const o = this.opp;
    const fx = this.match.fx;
    const c = this.tpColor;
    const to = o.pos.clone().sub(this.pos).setY(0);
    const d = to.length();
    fx.ring(this.hand(), 0.9, c, 0.25);
    if (!o.alive || d > 14 || d < 0.1 || o.invuln > 0) return;
    const dir = to.normalize();
    const gate = o.center.addScaledVector(dir, 1.0);
    fx.ring(gate.clone().setY(o.pos.y), 1.4, c, 0.35);
    fx.flash(gate, 0.7, c, 0.15);
    fx.sparksAt(gate, 14, c, 6);
    const r = o.receiveHit(this, m.hit!, dir.clone().negate(), { unblockable: true, source: 'melee' });
    if (r === 'hit') sfx.hit(true);
  }

  /** Multi-tick specials: Shade Rend (dash through three times), Implosion (pull then blast), Rift Storm (gates fire). */
  private tickSpecial(m: MoveDef, t: number, a0: number, a1: number) {
    const o = this.opp;
    const fx = this.match.fx;
    if (m.special === 'shadeRend') {
      const k = t - a0;
      this.vel.x = 0; this.vel.z = 0;
      this.rig.root.visible = !(k >= 0 && k % 9 < 2);
      if (k >= 0 && k % 9 === 0 && k <= 18) {
        const last = k === 18;
        const to = o.pos.clone().sub(this.pos).setY(0);
        if (!o.alive || to.length() > 9 || o.invuln > 0 || to.lengthSq() < 0.01) { if (k === 0) { this.vel.copy(this.forward.multiplyScalar(14)); } return; }
        const dir = to.normalize();
        const from = this.pos.clone();
        const dest = o.pos.clone().addScaledVector(dir, 1.7);
        dest.x = THREE.MathUtils.clamp(dest.x, -BOUNDS.hw + 0.8, BOUNDS.hw - 0.8);
        dest.z = THREE.MathUtils.clamp(dest.z, -BOUNDS.hd + 0.8, BOUNDS.hd - 0.8);
        dest.y = this.pos.y;
        for (let i = 0; i <= 10; i++) fx.trail(from.clone().lerp(dest, i / 10).setY(from.y + 1.1), this.tpColor, 0.16, 0.35);
        this.pos.copy(dest);
        this.match.arena.pushOut(this.pos, this.def.radius, this.def.height);
        this.yaw = Math.atan2(-dir.x, -dir.z);
        this.invuln = 5;
        fx.blur = Math.max(fx.blur, 0.5);
        fx.sparksAt(o.center, 12, this.tpColor, 7);
        const spec = last ? m.hit! : { fwd: 0, up: 0, radius: 0, stamina: 5, health: 3, kbF: 1, kbU: 0, stun: 20 };
        const r = o.receiveHit(this, spec, last ? dir.clone().negate() : dir, { source: 'melee' });
        if (r === 'hit') sfx.hit(last); else sfx.block();
      }
    }
    if (m.special === 'implode') {
      const c = this.center;
      if (t >= a0 && t < a1) {
        const f = (t - a0) / (a1 - a0);
        const r = 5.5 * (1 - f) + 0.6;
        for (let i = 0; i < 5; i++) {
          const ang = t * 0.35 + (i / 5) * Math.PI * 2;
          fx.trail(c.clone().add(new THREE.Vector3(Math.cos(ang) * r, Math.sin(ang * 1.7) * 0.6, Math.sin(ang) * r)), 0xff5a7a, 0.14, 0.25);
        }
        const to = c.clone().sub(o.center).setY(0);
        if (o.alive && to.length() < 10 && to.length() > 1.3 && ['ground', 'air', 'guard', 'hitstun', 'stunned', 'attack', 'fly', 'charge', 'evade'].includes(o.state)) {
          o.pos.addScaledVector(to.normalize(), 0.13);
          this.match.arena.pushOut(o.pos, o.def.radius, o.def.height);
        }
      }
      if (t === a1 - 1) {
        fx.flash(c, 1.6, 0xff5a7a, 0.25);
        fx.ring(this.pos.clone(), m.hit!.radius * 1.5, 0xff5a7a, 0.5);
        fx.ring(this.pos.clone(), m.hit!.radius * 0.8, 0xffffff, 0.3);
        fx.shake = Math.max(fx.shake, 1);
        fx.screenFlash = Math.max(fx.screenFlash, 0.4);
        sfx.shock(); sfx.zap();
        this.match.resolveArea(this, m, c);
      }
    }
    if (m.special === 'riftStorm') {
      const k = t - a0;
      if (k >= 0 && k <= 16 && k % 8 === 0 && o.alive) {
        const ang = this.yaw + Math.PI * 0.5 + (k / 8) * (Math.PI * 0.5);
        const gate = o.center.add(new THREE.Vector3(Math.sin(ang) * 4, 1.4, Math.cos(ang) * 4));
        fx.ring(gate.clone(), 0.8, this.tpColor, 0.4);
        fx.flash(gate, 0.55, this.tpColor, 0.15);
        this.match.spawnProjectile(this, 'rift', 0, gate, o.center.sub(gate));
      }
    }
  }

  private groundPoundImpact() {
    const m = this.move!;
    this.match.fx.ring(this.pos.clone(), m.hit!.radius * 1.4, 0xff8040, 0.5);
    this.match.fx.burstDebris(this.pos.clone(), 18, 0x6a6a72, 8, 0.3);
    this.match.fx.shake = Math.max(this.match.fx.shake, 0.9);
    sfx.shock();
    this.match.resolveArea(this, m, this.pos.clone().setY(this.pos.y + 0.5), true);
    this.t = m.startup + m.active; // into recovery
  }

  // ======================================================================== guard & evade
  private stGuard(dt: number) {
    const b = this.input.b;
    this.friction(dt, 16);
    const sblock = this.state === 'sblock';
    if (sblock) {
      this.spend(TUNING.sblockDrain * dt);
      if (!b.power.down || !b.guard.down || !this.hasEnergy(0.5)) { this.setState(b.guard.down ? 'guard' : this.onGround ? 'ground' : 'air'); return; }
    } else {
      if (!b.guard.down) { this.setState(this.onGround ? 'ground' : 'air'); return; }
      if (b.power.pressed) { this.rUsed = true; if (this.hasEnergy(5)) { this.setState('sblock'); return; } this.noPower(); }
      // Guard + direction: evade.
      if (this.stickMag() > 0.6 && this.t > 1 && this.onGround) {
        const d = this.wishDir().normalize();
        this.vel.copy(d.multiplyScalar(this.def.heavy ? 9 : 12));
        this.invuln = 10;
        this.setState('evade');
        this.evadeSerial++;
        sfx.jump();
        return;
      }
      if (b.grab.pressed) { this.setState('ground'); this.grabAction(); return; }
    }
  }

  private stEvade(dt: number) {
    if (this.input.b.attack.pressed && this.t > 2) {
      this.startMove(this.def.moves.counter);
      this.invuln = 4;
      return;
    }
    this.friction(dt, this.t < 12 ? 2.5 : 10);
    if (this.t > 26) this.setState(this.onGround ? 'ground' : 'air');
  }

  private stCharge(dt: number) {
    const b = this.input.b;
    this.friction(dt, 20);
    this.energy = Math.min(100, this.energy + TUNING.chargeRate * dt);
    if (this.t % 10 === 0) sfx.charge();
    if (this.t % 3 === 0) this.match.fx.trail(this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 0.3, (Math.random() - 0.5) * 1.2)), 0x6fc8ff, 0.15, 0.5);
    if (!b.power.down || this.stickMag() > 0.3 || b.attack.pressed || b.jump.pressed || b.grab.pressed || b.guard.pressed) {
      this.rUsed = true;
      this.setState('ground');
      if (b.power.down) this.tryActions();
    }
  }

  // ======================================================================== grapple & props
  /** X: choose between an opponent in reach and a prop in reach using facing, range and eligibility. */
  grabTarget(): { kind: 'fighter'; f: Fighter } | { kind: 'prop'; p: Prop } | { kind: 'line-fighter'; f: Fighter } | { kind: 'line-prop'; p: Prop } | null {
    const fwd = this.forward;
    const o = this.opp;
    const to = o.pos.clone().sub(this.pos);
    const dO = Math.hypot(to.x, to.z);
    const facingO = dO > 0.01 ? (to.x * fwd.x + to.z * fwd.z) / dO : 1;
    const reach = this.def.radius + o.def.radius + 0.9;
    const oGrabbable = o.alive && !['launched', 'down', 'getup', 'teleport', 'grabbed', 'finished', 'yanked'].includes(o.state) && o.invuln <= 0 && Math.abs(to.y) < 1.6;
    if (oGrabbable && dO < reach && facingO > 0.3) return { kind: 'fighter', f: o };
    let best: Prop | null = null;
    let bestScore = Infinity;
    for (const p of this.match.arena.props) {
      if (p.state !== 'rest' || p.cls > this.def.lift) continue;
      const tp = p.pos.clone().sub(this.pos);
      const d = Math.hypot(tp.x, tp.z) - Math.max(p.half.x, p.half.z) * 0.7;
      if (d > this.def.radius + 1.0 || Math.abs(tp.y) > 1.5) continue;
      const facing = (tp.x * fwd.x + tp.z * fwd.z) / Math.max(0.01, Math.hypot(tp.x, tp.z));
      if (facing < -0.2) continue;
      const score = d - facing;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) return { kind: 'prop', p: best };
    const rg = this.def.rangedGrab;
    if (rg) {
      if (rg.fighters && oGrabbable && dO > reach && dO < rg.range && facingO > 0.8) return { kind: 'line-fighter', f: o };
      let lp: Prop | null = null;
      let ld = Infinity;
      for (const p of this.match.arena.props) {
        if (p.state !== 'rest' || p.cls > rg.maxCls || p.cls > this.def.lift) continue;
        const tp = p.pos.clone().sub(this.pos);
        const d = tp.length();
        if (d > rg.range) continue;
        if ((tp.x * fwd.x + tp.z * fwd.z) / Math.max(0.01, Math.hypot(tp.x, tp.z)) < 0.85) continue;
        if (d < ld) { ld = d; lp = p; }
      }
      if (lp) return { kind: 'line-prop', p: lp };
    }
    return null;
  }

  private grabAction() {
    if (this.heldProp) { this.startThrow(false); return; }
    const tgt = this.grabTarget();
    sfx.grab();
    if (!tgt) { this.startMove({ id: 'whiffGrab', wind: P.grab, strike: P.grab, startup: 6, active: 2, recovery: 12 }); return; }
    if (tgt.kind === 'fighter') { this.grabFighter(tgt.f, false); return; }
    if (tgt.kind === 'prop') { this.liftProp(tgt.p); return; }
    if (tgt.kind === 'line-fighter') { this.lineTarget = { kind: 'fighter', f: tgt.f, point: this.center }; this.setState('lineGrab'); this.lineTarget = { kind: 'fighter', f: tgt.f, point: this.center }; sfx.line(); return; }
    if (tgt.kind === 'line-prop') { this.setState('lineGrab'); this.lineTarget = { kind: 'prop', p: tgt.p, point: this.center }; sfx.line(); return; }
  }

  private grabFighter(o: Fighter, superGrab: boolean) {
    if (o.heldProp) o.dropProp();
    if (o.grabbed) o.releaseGrabbed();
    o.move = null;
    o.setState('grabbed');
    o.grabbedBy = this;
    o.rig.root.visible = true;
    this.grabbed = o;
    this.faceOpp(5);
    this.setState('grabbing');
    this.superGrabbing = superGrab;
    this.pummels = 0;
  }
  superGrabbing = false;

  releaseGrabbed() {
    if (this.grabbed) {
      const o = this.grabbed;
      o.grabbedBy = null;
      if (o.state === 'grabbed' || o.state === 'yanked') { o.setState('air'); o.onGround = false; }
      this.grabbed = null;
    }
  }

  private stGrabbing(dt: number) {
    const o = this.grabbed;
    this.friction(dt, 20);
    if (!o || o.state !== 'grabbed') { this.grabbed = null; this.setState('ground'); return; }
    // Hold the victim in front.
    const hold = this.pos.clone().addScaledVector(this.forward, this.def.radius + o.def.radius + 0.15);
    hold.y = this.pos.y + (this.t > 8 ? 0.25 : 0);
    o.pos.copy(hold);
    o.vel.set(0, 0, 0);
    o.yaw = this.yaw + Math.PI;
    const b = this.input.b;
    const wish = this.wishDir();
    if (wish.lengthSq() > 0.3) this.faceToward(wish, 6, dt);
    // A: knee pummel (up to three), each extends the hold. X or timeout: throw.
    if (b.attack.pressed && this.t > 6 && this.pummels < 3 && !this.superGrabbing) {
      this.pummels++;
      o.applyDamage(4 * TUNING.staminaScale, 1);
      o.hitFlash = 6;
      this.rage = Math.min(100, this.rage + 4);
      this.match.fx.sparksAt(o.center, 8, 0xffffff, 5);
      this.match.fx.hitstop = 0.04;
      sfx.hit(false);
      this.t = Math.max(8, this.t - 12);
      this.pummelT = 8;
      if (o.health <= 0) { this.throwFighter(o, false); return; }
    }
    if (this.pummelT > 0) this.pummelT--;
    if (this.t > 10 && b.grab.pressed || this.t > 42 || this.superGrabbing && this.t > 10) {
      this.throwFighter(o, this.superGrabbing);
    }
  }

  pummels = 0;
  pummelT = 0;
  pgT = 0;
  private throwFighter(o: Fighter, superThrow: boolean) {
    if (superThrow) { this.startPowerGrapple(o); return; }
    this.grabbed = null;
    o.grabbedBy = null;
    const dir = this.forward;
    const heavy = this.def.lift === 2;
    const spec: HitSpec = superThrow
      ? { fwd: 0, up: 0, radius: 0, stamina: 12, health: 16, kbF: heavy ? 17 : 14, kbU: 8, stun: 40, launch: true, heavy: true, breaksWalls: 60 }
      : { fwd: 0, up: 0, radius: 0, stamina: 8, health: 7, kbF: heavy ? 13 : 10, kbU: 6, stun: 34, launch: true, heavy: true, breaksWalls: 40 };
    o.setState('air');
    o.receiveHit(this, spec, dir, { unblockable: true, source: 'throw' });
    this.stats.throws++;
    this.startMove({ id: 'throwFighter', wind: P.throwW, strike: P.throwS, startup: 1, active: 4, recovery: heavy ? 18 : 12 });
    sfx.throwIt();
  }

  // ======================================================================== charged power & power grapples
  private stPowerCharge(dt: number) {
    const b = this.input.b;
    this.friction(dt, 25);
    const full = 18;
    if (this.t >= full && this.t % 3 === 0) this.match.fx.trail(this.hand(), 0xfff0a0, 0.16, 0.3);
    if (this.t === full) { this.match.fx.flash(this.center, 0.8, 0xfff0a0, 0.12); sfx.charge(); }
    if (!b.attack.down || this.t >= 45) {
      const cm = this.def.moves.chargePower;
      if (this.t >= full && this.hasEnergy(cm.energy ?? 0)) { this.spend(cm.energy ?? 0); this.startMove(cm); }
      else this.startMove(this.def.moves.power);
    }
  }

  /** R+X on an opponent who is not in Danger: each fighter's own power grapple. */
  private startPowerGrapple(o: Fighter) {
    this.grabbed = o;
    o.setState('grabbed');
    o.grabbedBy = this;
    this.setState('pgrapple');
    this.pgT = 0;
    this.finisherData = { start: this.pos.clone(), yaw0: this.yaw };
    sfx.grab();
  }

  private stPGrapple(_dt: number) {
    const o = this.grabbed;
    const d = this.finisherData;
    if (!o || !d || o.state !== 'grabbed') { this.grabbed = null; this.setState(this.onGround ? 'ground' : 'air'); return; }
    const t = this.t;
    const fwd = new THREE.Vector3(Math.sin(d.yaw0), 0, Math.cos(d.yaw0));
    const fx = this.match.fx;
    const release = (dir: THREE.Vector3, spec: HitSpec, after?: () => void) => {
      this.grabbed = null;
      o.grabbedBy = null;
      o.setState('air');
      o.receiveHit(this, spec, dir, { unblockable: true, source: 'throw' });
      after?.();
      this.stats.throws++;
      sfx.throwIt();
      this.startMove({ id: 'pgEnd', wind: P.throwS, strike: P.throwS, startup: 1, active: 2, recovery: 16 });
    };
    o.vel.set(0, 0, 0);
    switch (this.def.powerGrapple) {
      case 'piledriver': {
        // Lift overhead, then drive them into the deck.
        if (t < 22) o.pos.lerp(this.pos.clone().add(new THREE.Vector3(0, this.def.height + 0.4, 0)), 0.25);
        else o.pos.lerp(this.pos.clone().addScaledVector(fwd, 1.4), 0.6);
        o.yaw = this.yaw;
        if (t === 28) {
          fx.ring(this.pos.clone().addScaledVector(fwd, 1.4), 4, 0xff7a3a, 0.5);
          fx.burstDebris(o.pos.clone(), 20, 0x6a6a72, 8, 0.3);
          fx.shake = 1;
          sfx.shock();
          release(fwd, { fwd: 0, up: 0, radius: 0, stamina: 14, health: 18, kbF: 5, kbU: 9, stun: 44, launch: true, heavy: true, breaksWalls: 40 });
        }
        break;
      }
      case 'webSpin': {
        // Spin on the line, then fling: the ring-out tool.
        this.yaw = d.yaw0 + t * 0.32;
        const r = 2.2;
        o.pos.copy(this.pos).add(new THREE.Vector3(Math.sin(this.yaw) * r, 1.0, Math.cos(this.yaw) * r));
        if (t % 3 === 0) fx.trail(o.center, 0xeaffff, 0.18, 0.4);
        this.anchor = o.center;
        if (t === 34) {
          const wish = this.wishDir();
          const dir = wish.lengthSq() > 0.2 ? wish.normalize() : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          this.yaw = Math.atan2(dir.x, dir.z);
          release(dir, { fwd: 0, up: 0, radius: 0, stamina: 10, health: 12, kbF: 19, kbU: 7, stun: 40, launch: true, heavy: true, breaksWalls: 90 });
        }
        break;
      }
      case 'skyDrop': {
        // Carry them up, then spike them down.
        if (t < 30) {
          this.pos.y += 0.22;
          o.pos.copy(this.pos).addScaledVector(fwd, 0.8).add(new THREE.Vector3(0, -0.4, 0));
          if (t % 2 === 0) fx.trail(this.pos, 0xa070ff, 0.2, 0.4);
        }
        if (t === 30) {
          fx.flash(o.center, 1.6, 0xc9a8ff, 0.2);
          sfx.zap();
          release(fwd, { fwd: 0, up: 0, radius: 0, stamina: 12, health: 16, kbF: 6, kbU: 3, stun: 44, launch: true, heavy: true }, () => { o.vel.y = -20; });
          this.vel.set(0, 2, 0);
          this.onGround = false;
        }
        break;
      }
      case 'portalDrop': {
        // Open a gate under the victim, drop them through, and spike them down from the sky.
        const c = this.tpColor;
        if (t < 12) { o.pos.copy(this.pos).addScaledVector(fwd, 1.2); o.pos.y = this.pos.y - t * 0.14; if (t % 3 === 0) fx.ring(this.pos.clone().addScaledVector(fwd, 1.2), 1.8, c, 0.3); }
        if (t === 2) { fx.flash(o.center, 1.2, c, 0.2); sfx.teleport(); }
        o.rig.root.visible = t < 12 || t >= 26;
        if (t === 26) {
          o.pos.copy(this.pos).addScaledVector(fwd, 2.2).setY(this.pos.y + 9);
          fx.ring(o.pos.clone().setY(o.pos.y + 1.5), 2.2, c, 0.5);
          fx.flash(o.center, 0.9, c, 0.2);
          release(fwd, { fwd: 0, up: 0, radius: 0, stamina: 12, health: 16, kbF: 3, kbU: 0, stun: 46, launch: true, heavy: true }, () => { o.vel.set(fwd.x * 2, -28, fwd.z * 2); });
        }
        break;
      }
      case 'displace': {
        // Vanish with the victim and drop them nine metres away — off an open edge if aimed there.
        o.rig.root.visible = t < 6;
        this.rig.root.visible = t < 6 || t > 16;
        if (t === 6) { fx.flash(o.center, 1.2, this.tpColor, 0.2); sfx.teleport(); }
        if (t === 18) {
          const wish = this.wishDir();
          const dir = wish.lengthSq() > 0.2 ? wish.normalize() : fwd;
          o.pos.copy(this.pos).addScaledVector(dir, 9).setY(this.pos.y + 3);
          o.rig.root.visible = true;
          fx.flash(o.center, 1.4, this.tpColor, 0.25);
          fx.sparksAt(o.center, 16, this.tpColor, 6);
          release(dir, { fwd: 0, up: 0, radius: 0, stamina: 10, health: 10, kbF: 6, kbU: 4, stun: 40, launch: true, heavy: true });
        }
        break;
      }
    }
    if (this.state === 'pgrapple' && t > 60) { this.releaseGrabbed(); this.setState('air'); }
  }

  private superGrab() {
    if (this.heldProp) { this.startThrow(true); return; }
    const o = this.opp;
    const tgt = this.grabTarget();
    const close = tgt && (tgt.kind === 'fighter' || tgt.kind === 'line-fighter');
    const canFinish = o.danger && this.hasEnergy(TUNING.finisherCost);
    if (!close) {
      if (tgt && tgt.kind === 'prop') { this.liftProp(tgt.p); return; }
      this.startMove({ id: 'whiffGrab', wind: P.grab, strike: P.grab, startup: 6, active: 2, recovery: 14 });
      return;
    }
    if (o.danger && !canFinish) {
      // Failed finisher: not enough power — becomes an ordinary grab.
      this.noPower();
      this.say('NEED 1/4 POWER');
      if (tgt!.kind === 'fighter') this.grabFighter(o, false);
      else { this.setState('lineGrab'); this.lineTarget = { kind: 'fighter', f: o, point: this.center }; }
      return;
    }
    if (canFinish) {
      if (tgt!.kind === 'line-fighter') {
        this.setState('lineGrab');
        this.lineTarget = { kind: 'fighter', f: o, point: this.center };
        this.pendingFinisher = true;
        return;
      }
      this.beginFinisher(o);
      return;
    }
    if (!this.hasEnergy(TUNING.superThrowCost)) { this.noPower(); if (tgt!.kind === 'fighter') this.grabFighter(o, false); return; }
    this.spend(TUNING.superThrowCost);
    if (tgt!.kind === 'fighter') this.grabFighter(o, true);
    else { this.setState('lineGrab'); this.lineTarget = { kind: 'fighter', f: o, point: this.center }; this.superGrabbing = true; }
  }
  pendingFinisher = false;

  private stLineGrab(dt: number) {
    this.friction(dt, 20);
    const lt = this.lineTarget;
    if (!lt) { this.setState('ground'); return; }
    const travel = 6;
    if (this.t === travel) {
      // Connect?
      if (lt.kind === 'fighter' && lt.f) {
        const o = lt.f;
        const d = o.pos.distanceTo(this.pos);
        const evading = o.invuln > 0 || ['teleport', 'launched', 'down', 'getup', 'finished', 'grabbed'].includes(o.state);
        if (d < 13 && !evading) {
          if (o.state === 'sblock') { o.match.fx.sparksAt(o.center, 10, 0xffffff, 5); sfx.superBlock(); this.setState('recover'); this.stun = 20; return; }
          o.move = null;
          if (o.heldProp) o.dropProp();
          o.setState('yanked');
          o.grabbedBy = this;
          sfx.grab();
        } else { this.setState('recover'); return; }
      }
      if (lt.kind === 'prop' && lt.p) {
        if (lt.p.state !== 'rest') { this.setState('recover'); return; }
        lt.p.state = 'held';
        lt.p.holder = this;
      }
    }
    if (this.t > travel && this.t <= travel + 12) {
      const k = (this.t - travel) / 12;
      if (lt.kind === 'fighter' && lt.f && lt.f.state === 'yanked') {
        const target = this.pos.clone().addScaledVector(this.forward, this.def.radius + lt.f.def.radius + 0.15);
        lt.f.pos.lerp(target, k);
        lt.f.vel.set(0, 0, 0);
      }
      if (lt.kind === 'prop' && lt.p) {
        const target = this.pos.clone().add(new THREE.Vector3(0, 1.4, 0)).addScaledVector(this.forward, 0.6);
        lt.p.pos.lerp(target, k);
        lt.p.mesh.position.copy(lt.p.pos);
      }
    }
    if (this.t >= travel + 12) {
      if (lt.kind === 'fighter' && lt.f && lt.f.state === 'yanked') {
        const o = lt.f;
        o.setState('grabbed');
        this.lineTarget = null;
        if (this.pendingFinisher) { this.pendingFinisher = false; this.beginFinisher(o); return; }
        this.grabFighter(o, this.superGrabbing);
        return;
      }
      if (lt.kind === 'prop' && lt.p) {
        this.heldProp = lt.p;
        this.lineTarget = null;
        this.setState('ground');
        return;
      }
      this.setState('ground');
    }
    if (this.lineTarget) {
      const tgtPos = lt.kind === 'fighter' && lt.f ? lt.f.center : lt.p ? lt.p.pos.clone().setY(lt.p.pos.y + 0.3) : this.center;
      const k = Math.min(1, this.t / travel);
      lt.point.copy(this.hand()).lerp(tgtPos, k);
    }
  }

  hand() {
    const v = new THREE.Vector3();
    if (this.skinned) return this.skinned.boneWorld('hand_r', v);
    this.rig.hand.r.getWorldPosition(v);
    return v;
  }

  // ======================================================================== authored clips
  private moveSerial = 0;
  private lastMoveRef: MoveDef | null = null;
  /** Pick the authored clip for the current state, or null to use the procedural pose. */
  private clipFor(): ClipPlay | null {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const st = STYLE[this.def.id] ?? STYLE.default;
    const sc = (this.def.height / 1.8) * (st.locoScale ?? 1);
    const loop = (name: string, speed = 1, fade = 0.22): ClipPlay => ({ name, loop: true, speed, key: name, fade });
    // One-shot clip time-fitted to `ticks`, aligned so the clip's impact lands on the hit frame when known.
    const once = (name: string, ticks: number, tag: string, impactTicks?: number, fade = 0.1): ClipPlay | null => {
      if (!hasClip(name)) return null;
      const dur = this.skinned!.clipDuration(name);
      const impact = CLIP_IMPACT[name];
      let speed: number;
      if (impact !== undefined && impactTicks !== undefined) speed = THREE.MathUtils.clamp(impact / Math.max(0.05, impactTicks / 60), 0.85, 2.3);
      else speed = THREE.MathUtils.clamp(dur / Math.max(0.05, ticks / 60), 0.85, 2.3);
      return { name, loop: false, speed, key: `${name}#${tag}`, fade };
    };
    if (this.move !== this.lastMoveRef) { this.lastMoveRef = this.move; this.moveSerial++; }
    const ms = String(this.moveSerial);
    switch (this.state) {
      case 'ground':
      case 'idleLock': {
        if (this.heldProp) return loop('Walk_Carry_Loop', Math.max(0.25, hs / (1.5 * sc)));
        if (this.landT > 0 && st.land) return once(st.land, 14, 'land' + this.landSerial, undefined, 0.08);
        if (hs < 0.5) return loop(st.idle, st.idleSpeed ?? 1, 0.3);
        if (hs < 3.2) return loop(st.walk ?? 'Walk_Loop', hs / (1.5 * sc), 0.25);
        if (hs < 6.8) return loop('Jog_Fwd_Loop', hs / (3.8 * sc), 0.25);
        return loop('Sprint_Loop', hs / (6.2 * sc), 0.25);
      }
      case 'air': return this.heldProp ? null : this.vel.y > 2 && this.t < 16 ? once(st.jumpStart ?? 'Jump_Start', 16, 's' + this.jumpSerial, undefined, 0.08) : loop('Jump_Loop', 1, 0.3);
      case 'recover': return once(st.land ?? 'Jump_Land', 10, 'l' + this.landSerial);
      case 'guard': case 'sblock': return this.blockT > 0 ? once('Idle_Shield_Break', 16, 'b' + this.blockSerial, undefined, 0.06) : loop('Idle_Shield_Loop', 1, 0.12);
      case 'evade': return once('Roll', 28, 'r' + this.evadeSerial, undefined, 0.08);
      case 'charge': return loop('Spell_Simple_Idle_Loop', 1, 0.2);
      case 'powerCharge': return once('Spell_Simple_Enter', 18, 'pc' + ms);
      case 'lift': return once('PickUp_Table', this.heldProp?.cls === 2 ? 26 : 14, 'lift' + ms, undefined, 0.12);
      case 'throw': return once('OverhandThrow', this.throwWind + 14, 'th' + ms, this.throwWind);
      case 'grabbing': return this.pummelT > 0 ? once('Melee_Hook', 10, 'pm' + this.pummels, 4, 0.06) : loop('Push_Loop', 0.5, 0.15);
      case 'hitstun': return once(this.hitSide > 0 ? 'Hit_Chest' : 'Hit_Head', Math.max(16, this.stun), 'h' + this.lastHitSerial, undefined, 0.05);
      case 'stunned': return loop('Hit_Head', 0.35);
      case 'launched': return this.lastLaunchSpeed < 11 && this.t < 40 ? once('Hit_Knockback', 50, 'kb' + this.lastHitSerial, undefined, 0.05) : null;
      case 'getup': return once('LayToIdle', 40, 'gu' + this.lastHitSerial, undefined, 0.12);
      case 'victory': return loop(st.victory, 1, 0.3);
      case 'attack': {
        const m = this.move;
        if (!m) return null;
        const dur = m.startup + m.active + m.recovery;
        let name: string | undefined;
        const ci = this.def.moves.chain.indexOf(m);
        if (ci >= 0) name = st.chain[ci] || undefined;
        else if (m === this.def.moves.runAttack) name = st.run;
        else if (m === this.def.moves.dashPower) name = st.dash;
        else name = MOVE_CLIP[m.id];
        if (!name || (!this.onGround && !m.special && ci < 0)) return null;
        return once(name, dur, 'm' + ms, m.startup + 1, 0.07);
      }
      default: return null;
    }
  }
  lastHitSerial = 0;
  landT = 0; landSerial = 0; jumpSerial = 0; evadeSerial = 0; blockT = 0; blockSerial = 0;
  /** Buffered button presses (tick pressed) so inputs made slightly early still come out. */
  private buf: Partial<Record<'attack' | 'grab' | 'jump' | 'guard', number>> = {};
  /** Smooth turn target for attacks (radians) — no instant snaps. */
  turnTarget: number | null = null;
  private leanZ = 0;
  private leanX = 0;
  private prevVel = new THREE.Vector3();

  private liftProp(p: Prop) {
    p.state = 'held';
    p.holder = this;
    this.heldProp = p;
    this.vel.set(0, 0, 0);
    this.setState('lift');
    sfx.grab();
  }

  private stLift(dt: number) {
    this.friction(dt, 25);
    const p = this.heldProp;
    const dur = p && p.cls === 2 ? 26 : p && p.cls === 1 ? 16 : 6;
    if (!p) { this.setState('ground'); return; }
    if (this.t >= dur) this.setState('ground');
  }

  positionHeldProp() {
    const p = this.heldProp!;
    if (p.state !== 'held' || p.holder !== this) { this.heldProp = null; return; }
    let lift = 1;
    if (this.state === 'lift') {
      const dur = p.cls === 2 ? 26 : p.cls === 1 ? 16 : 6;
      lift = Math.min(1, this.t / dur);
    }
    const overhead = p.cls >= 1;
    const h = this.def.height;
    const target = this.pos.clone();
    if (overhead) {
      target.y += (0.3 + (h + 0.1 - 0.3) * lift);
      target.addScaledVector(this.forward, 0.1);
    } else {
      target.y += h * 0.5;
      target.addScaledVector(this.forward, this.def.radius + 0.35);
    }
    if (this.state === 'throw') {
      const k = Math.min(1, this.t / this.throwWind);
      target.addScaledVector(this.forward, -0.6 * k);
      target.y += 0.3 * k;
    }
    p.pos.copy(target);
    p.mesh.position.copy(target);
    p.mesh.rotation.set(0, this.yaw, 0);
  }

  throwWind = 8;
  superThrowing = false;
  private startThrow(superThrow: boolean) {
    const p = this.heldProp;
    if (!p) return;
    if (superThrow) {
      if (!this.hasEnergy(TUNING.superThrowCost)) { this.noPower(); superThrow = false; }
      else this.spend(TUNING.superThrowCost);
    }
    this.superThrowing = superThrow;
    // Heavy throws are planted with a long, readable windup.
    this.throwWind = p.cls === 2 ? 20 : p.cls === 1 ? 13 : 7;
    if (superThrow) this.throwWind = Math.round(this.throwWind * 0.7);
    this.vel.set(0, this.vel.y, 0);
    this.setState('throw');
  }

  private stThrow(dt: number) {
    this.friction(dt, 30);
    const p = this.heldProp;
    // Aim at the opponent if roughly in front; otherwise straight ahead.
    const o = this.opp;
    const to = o.center.sub(this.pos);
    const ah = to.clone().setY(0);
    if (ah.length() < 40 && ah.normalize().dot(this.forward) > 0.3 && this.t < this.throwWind) this.faceToward(ah, 10, dt);
    if (p && this.t === this.throwWind) {
      const speed = (p.cls === 2 ? 21 : p.cls === 1 ? 23 : 26) * (this.superThrowing ? 1.35 : 1);
      const origin = p.pos.clone();
      const aimAt = ah.length() > 0 && ah.dot(this.forward) > 0.3 ? o.center : origin.clone().addScaledVector(this.forward, 14).setY(1);
      const dx = aimAt.clone().sub(origin);
      const hd = Math.hypot(dx.x, dx.z);
      const tt = Math.max(0.15, hd / speed);
      const vy = (dx.y + 0.5 * 26 * tt * tt) / tt;
      const hdir = new THREE.Vector3(dx.x, 0, dx.z).normalize();
      if (hd < 0.1) hdir.copy(this.forward);
      p.vel.copy(hdir.multiplyScalar(speed));
      p.vel.y = THREE.MathUtils.clamp(vy, -5, 14);
      p.spin.set(Math.random() * 6, Math.random() * 4, Math.random() * 3);
      p.state = 'thrown';
      p.thrower = this;
      p.holder = null;
      p.life = 0;
      p.power = this.superThrowing ? 1.5 : 1;
      p.hitIds.clear();
      this.heldProp = null;
      this.stats.throws++;
      sfx.throwIt();
      if (p.cls === 2) this.match.fx.shake = Math.max(this.match.fx.shake, 0.25);
    }
    if (this.t >= this.throwWind + (p?.cls === 2 ? 16 : 10)) this.setState(this.onGround ? 'ground' : 'air');
  }

  dropProp() {
    const p = this.heldProp;
    if (!p) return;
    p.state = 'falling';
    p.holder = null;
    p.vel.set(this.vel.x * 0.5, 1, this.vel.z * 0.5);
    this.heldProp = null;
  }

  /** Called by the match when a thrown prop reaches this fighter. Returns true if it was caught. */
  tryCatch(p: Prop): boolean {
    if (this.heldProp || p.cls > this.def.lift) return false;
    if (!(this.state === 'guard' || this.state === 'ground' || this.state === 'sblock')) return false;
    if (this.tick - this.guardPressedAt > TUNING.catchWindow) return false;
    p.state = 'held';
    p.holder = this;
    p.thrower = null;
    this.heldProp = p;
    this.setState('lift');
    this.t = 100;
    this.stats.catches++;
    this.rage = Math.min(100, this.rage + 12);
    this.say('CATCH!');
    sfx.catch();
    this.match.fx.sparksAt(p.pos, 12, 0xffffff, 4);
    return true;
  }

  // ======================================================================== taking hits
  applyDamage(stamina: number, health: number) {
    this.stamina -= stamina;
    this.health -= health;
    if (this.stamina < 0) {
      this.health += this.stamina * 0.5; // overflow spills into lasting health
      this.stamina = 0;
    }
    this.health = Math.max(0, this.health);
    this.stamina = Math.min(this.stamina, this.health);
    this.lastHit = 0;
  }

  receiveHit(att: Fighter, spec: HitSpec, dir: THREE.Vector3, opts: { unblockable?: boolean; source?: string; noLaunchOnBlock?: boolean } = {}): HitResult['result'] {
    if (!this.alive || this.invuln > 0 || this.state === 'teleport' || this.state === 'finisher' || this.state === 'grabbed' && opts.source !== 'throw' && this.grabbedBy !== att) return 'miss';
    const frontal = this.forward.dot(dir) < -0.1;
    if (!opts.unblockable && frontal && (this.state === 'guard' || this.state === 'sblock')) {
      if (this.state === 'sblock') {
        sfx.superBlock();
        this.match.fx.sparksAt(this.center.addScaledVector(dir, -0.5), 14, 0x9ff7ff, 6);
        if (opts.source === 'melee' && att.state === 'attack') { att.move = null; att.setState('hitstun'); att.stun = 24; att.vel.copy(dir).multiplyScalar(-5); }
        return 'sblock';
      }
      this.applyDamage(spec.stamina * 0.2, 0);
      this.vel.addScaledVector(dir, spec.kbF * 0.35 / this.def.weight);
      sfx.block();
      this.blockT = 14; this.blockSerial++;
      this.match.fx.sparksAt(this.center.addScaledVector(dir, -0.5), 6, 0xffffff, 4);
      att.rage = Math.min(100, att.rage + 2);
      return 'block';
    }
    // Hit.
    if (this.heldProp) this.dropProp();
    if (this.grabbed) this.releaseGrabbed();
    const vuln = this.state === 'charge' ? 1.25 : 1;
    const rageMul = att.raging ? 1.2 : 1;
    const staminaBefore = this.stamina;
    this.applyDamage(spec.stamina * TUNING.staminaScale * vuln * rageMul / Math.sqrt(this.def.durability), spec.health * vuln * rageMul);
    att.rage = Math.min(100, att.rage + (spec.stamina + spec.health * 2) * TUNING.rageGain);
    this.rage = Math.min(100, this.rage + spec.stamina * 0.3);
    att.stats.hits++;
    this.lastAttacker = att;
    this.move = null;
    this.hitFlash = 8;
    this.rig.root.visible = true;
    const brokeStamina = staminaBefore > 0 && this.stamina <= 0;
    const kb = dir.clone().setY(0).normalize().multiplyScalar(spec.kbF * (att.raging ? 1.15 : 1) / this.def.weight);
    const launch = spec.launch || brokeStamina || this.health <= 0 || !this.onGround && spec.kbU > 0;
    this.hitSide = Math.random() < 0.5 ? 1 : -1;
    this.lastHitSerial++;
    if (launch) {
      this.vel.copy(kb);
      this.vel.y = Math.max(spec.kbU, brokeStamina ? 6 : 3) / Math.sqrt(this.def.weight);
      this.onGround = false;
      this.pos.y += 0.05;
      this.setState('launched');
      this.lastLaunchSpeed = this.vel.length();
    } else {
      this.vel.copy(kb);
      this.stun = spec.stun;
      this.setState('hitstun');
    }
    this.yaw = Math.atan2(-dir.x, -dir.z);
    sfx.hit(!!spec.heavy);
    this.match.fx.hitstop = spec.heavy ? 0.085 : 0.045;
    if (att.def.burns && spec.heavy && this.health > 0) { this.burnT = 150; this.say('BURNING'); }
    if (spec.heavy) { this.match.camera.punch = 1; this.match.fx.blur = Math.max(this.match.fx.blur, 0.35); }
    this.match.fx.shake = Math.max(this.match.fx.shake, spec.heavy ? 0.45 : 0.15);
    this.match.fx.sparksAt(this.center.addScaledVector(dir, -0.4), spec.heavy ? 16 : 8, spec.heavy ? 0xffc060 : 0xffffff, spec.heavy ? 9 : 6);
    if (spec.heavy) this.match.fx.flash(this.center, 0.7, 0xfff0d0, 0.1);
    if (brokeStamina) this.say('STAMINA BREAK');
    if (this.health <= 0) this.match.declare(att, this, 'ko');
    return 'hit';
  }

  private stHitstun(dt: number) {
    this.friction(dt, 8);
    if (this.t >= this.stun) this.setState(this.onGround ? 'ground' : 'air');
  }
  private stStunned(dt: number) {
    this.friction(dt, 12);
    if (this.t % 6 === 0) this.match.fx.trail(this.center, 0xeaffff, 0.12, 0.4);
    if (this.t >= this.stun) this.setState(this.onGround ? 'ground' : 'air');
  }

  private stLaunched(_dt: number) {
    const b = this.input.b;
    // L+R: energy-consuming recovery, resolved by family.
    const chord = (b.mobility.pressed && b.power.down) || (b.power.pressed && b.mobility.down);
    if (chord && this.t > 6 && this.health > 0) {
      if (!this.hasEnergy(TUNING.recoveryCost)) { this.noPower(); return; }
      this.spend(TUNING.recoveryCost);
      this.rUsed = true;
      this.recover();
    }
  }

  recover() {
    this.stats.recoveries++;
    this.say('RECOVER');
    this.match.fx.flash(this.center, 1.0, 0xffffff, 0.15);
    this.invuln = 12;
    switch (this.def.recovery) {
      case 'ground':
        // A ground fighter can only kill some momentum: it needs a surface to land on.
        this.vel.x *= 0.45;
        this.vel.z *= 0.45;
        this.vel.y = Math.max(this.vel.y, 5);
        this.setState('air');
        break;
      case 'swing':
        this.recoverSwing = true;
        if (!this.startSwing(true)) { this.recoverSwing = false; this.setState('air'); }
        else { this.vel.multiplyScalar(0.5); }
        break;
      case 'flight':
        this.vel.multiplyScalar(0.15);
        this.setState('fly');
        break;
      case 'teleport': {
        const toC = new THREE.Vector3(-this.pos.x, 0, -this.pos.z);
        const d = Math.min(14, toC.length());
        const target = this.pos.clone().addScaledVector(toC.normalize(), d);
        target.y = Math.max(this.pos.y, 1);
        this.beginTeleport(target, false);
        break;
      }
    }
  }

  private stDown(dt: number) {
    this.friction(dt, 10);
    if (this.health <= 0) { this.setState('ko'); return; }
    const b = this.input.b;
    const quick = this.t > 14 && (b.jump.pressed || b.guard.pressed || b.attack.pressed);
    if (this.t > 40 || quick) { this.setState('getup'); this.invuln = 34; }
  }

  private stKO(dt: number) {
    this.friction(dt, 6);
  }

  ringOut() {
    this.setState('out');
    this.vel.set(0, 0, 0);
    this.rig.root.visible = false;
    if (this.heldProp) { this.match.arena.removeProp(this.heldProp); this.heldProp = null; }
    sfx.ringout();
    const winner = this.opp;
    this.match.declare(winner, this, 'ringout');
  }

  // ======================================================================== finisher
  beginFinisher(o: Fighter) {
    this.spend(TUNING.finisherCost);
    if (o.heldProp) o.dropProp();
    o.move = null;
    o.grabbedBy = this;
    o.setState('finished');
    this.grabbed = o;
    this.faceOpp(20);
    this.setState('finisher');
    this.finisherData = { start: this.pos.clone(), yaw0: this.yaw };
    this.match.startCinematic(this, o);
    sfx.finisher();
    this.say('FINISHER!');
  }

  private stFinisher(_dt: number) {
    const o = this.grabbed;
    if (!o || !this.finisherData) { this.setState('ground'); return; }
    const t = this.t;
    const fx = this.match.fx;
    const s = this.finisherData.start;
    const fwd = new THREE.Vector3(Math.sin(this.finisherData.yaw0), 0, Math.cos(this.finisherData.yaw0));
    const front = (d: number, h: number) => s.clone().addScaledVector(fwd, d).add(new THREE.Vector3(0, h, 0));
    const id = this.def.id;
    if (t < 30) {
      o.pos.lerp(front(this.def.radius + o.def.radius + 0.2, 0.3), 0.3);
    } else if (id === 'basalt' || id === 'ember') {
      if (t < 70) o.pos.lerp(s.clone().add(new THREE.Vector3(0, this.def.height + 0.6, 0)), 0.15);
      else if (t < 82) o.pos.lerp(front(1.6, 0), 0.5);
      if (t === 82) { fx.ring(front(1.6, 0), 6, 0xff7a3a, 0.6); fx.burstDebris(front(1.6, 0.2), 40, 0x6a6a72, 10, 0.4); fx.shake = 1.2; fx.screenFlash = 0.7; fx.blur = 0.6; sfx.explosion(); }
    } else if (id === 'tether') {
      const ang = (t - 30) * 0.25;
      const r = 2.2;
      this.yaw = this.finisherData.yaw0 + ang;
      if (t < 90) { o.pos.copy(s).add(new THREE.Vector3(Math.sin(this.yaw) * r, 1.2 + Math.sin(t * 0.2) * 0.3, Math.cos(this.yaw) * r)); if (t % 4 === 0) fx.trail(o.center, 0xeaffff, 0.2, 0.6); }
      if (t === 90) { o.vel.copy(fwd).multiplyScalar(14); o.vel.y = 8; fx.flash(o.center, 1.2, 0xffffff, 0.2); sfx.hit(true); }
      if (t > 90 && t < 120) { o.pos.addScaledVector(o.vel, 1 / 60); o.vel.y -= 0.5; if (o.pos.y < s.y) { o.pos.y = s.y; o.vel.set(0, 0, 0); } }
    } else if (id === 'aerin' || id === 'magna') {
      if (t < 75) { this.pos.lerp(s.clone().add(new THREE.Vector3(0, 7, 0)), 0.05); o.pos.lerp(this.pos.clone().addScaledVector(fwd, 0.9).add(new THREE.Vector3(0, 0.2, 0)), 0.3); if (t % 2 === 0) fx.trail(this.pos, 0xa070ff, 0.25, 0.5); }
      else if (t < 88) o.pos.lerp(front(2, 0), 0.4);
      if (t === 88) { fx.flash(front(2, 1), 3, 0xc9a8ff, 0.35); fx.ring(front(2, 0), 6, 0xa070ff, 0.6); fx.shake = 1.1; fx.screenFlash = 0.7; fx.blur = 0.6; sfx.explosion(); sfx.zap(); }
      if (t > 95) this.pos.lerp(s, 0.08);
    } else {
      // Shunt: scatter strikes from every side.
      if (t < 100 && t % 14 === 0) {
        const a = Math.random() * Math.PI * 2;
        this.pos.copy(o.pos).add(new THREE.Vector3(Math.sin(a) * 1.4, 0, Math.cos(a) * 1.4));
        this.yaw = Math.atan2(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
        fx.flash(o.center, 0.9, this.tpColor, 0.12);
        fx.sparksAt(o.center, 10, this.tpColor, 7);
        sfx.hit(true);
      }
      if (t === 100) { this.pos.copy(s); fx.flash(o.center, 2.2, this.tpColor, 0.3); fx.ring(o.pos.clone(), 5, this.tpColor, 0.5); sfx.explosion(); }
    }
    o.vel.set(0, 0, 0);
    if (t === 105) {
      o.health = 0;
      o.stamina = 0;
      o.grabbedBy = null;
      this.grabbed = null;
      o.pos.y = Math.max(o.pos.y, this.match.arena.groundAt(o.pos.x, o.pos.z, o.pos.y + 3));
      o.setState('ko');
      o.vel.set(0, 0, 0);
      this.match.declare(this, o, 'finisher');
      this.setState('idleLock');
      this.pos.y = this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5);
    }
  }

  // ======================================================================== animation
  animate(dt: number, time: number) {
    const r = this.rig;
    r.root.position.copy(this.pos);
    r.root.rotation.y = this.yaw;
    const h = this.def.heavy;
    let pose: Pose;
    let rate = 18;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    switch (this.state) {
      case 'ground':
        if (this.heldProp) pose = this.heldProp.cls >= 1 ? P.holdOver() : P.carry();
        else if (hs > 0.6) pose = P.run(this.runPhase, hs > this.def.speed * 1.2 ? 0.35 : 0, h);
        else pose = P.guard(time, h);
        if (this.heldProp && hs > 0.6) { const rp = P.run(this.runPhase, 0, h); pose.j.lThigh = rp.j.lThigh; pose.j.rThigh = rp.j.rThigh; pose.j.lShin = rp.j.lShin; pose.j.rShin = rp.j.rShin; }
        break;
      case 'air': pose = this.heldProp ? (this.heldProp.cls >= 1 ? P.holdOver() : P.carry()) : P.air(this.vel.y); break;
      case 'attack': {
        const m = this.move;
        if (!m) { pose = P.guard(time, h); break; }
        if (this.t < m.startup) { pose = m.wind(); rate = 16; }
        else { pose = m.strike(); rate = 38; }
        if (m.id === 'flightDash') pose.pitch = 1.2;
        if (m.id === 'swingKick') pose.pitch = 0.2;
        break;
      }
      case 'guard': pose = P.block(); rate = 30; break;
      case 'sblock': pose = P.block(); rate = 30; break;
      case 'evade': pose = P.evade(); rate = 30; break;
      case 'charge': pose = P.charge(time); break;
      case 'grabbing': pose = this.pummelT > 0 ? P.kickS() : this.t < 8 ? P.grab() : (this.def.lift === 2 ? P.holdOver() : P.grab()); if (this.pummelT > 0) { pose.j.lThigh = [-1.3, 0, 0]; pose.j.lShin = [1.4, 0, 0]; pose.j.spine = [0.3, 0, 0]; } rate = this.pummelT > 0 ? 40 : 18; break;
      case 'grabbed': case 'yanked': pose = P.heldVictim(); break;
      case 'lift': pose = this.heldProp && this.heldProp.cls >= 1 ? (this.t < 10 ? P.slamS() : P.holdOver()) : P.carry(); rate = 12; break;
      case 'throw': pose = this.t < this.throwWind ? P.throwW() : P.throwS(); rate = this.t < this.throwWind ? 14 : 40; break;
      case 'lineGrab': pose = P.shoot(); rate = 30; break;
      case 'hitstun': pose = P.hit(this.hitSide); rate = 40; break;
      case 'stunned': pose = P.hit(this.hitSide); pose.j.lArm = [0, 0, 0.1]; pose.j.rArm = [0, 0, -0.1]; break;
      case 'launched': pose = P.launched(); rate = 14; break;
      case 'down': pose = P.down(); rate = 14; break;
      case 'getup': pose = P.getup(); break;
      case 'swing': pose = P.swing(time); break;
      case 'cling': pose = P.cling(); break;
      case 'fly': pose = P.fly(hs); break;
      case 'teleport': pose = P.teleport(); rate = 40; break;
      case 'recover': pose = P.air(2); break;
      case 'finisher': pose = this.t < 30 ? P.grab() : this.t < 80 ? P.holdOver() : P.slamS(); rate = 20; break;
      case 'powerCharge': pose = this.t < 18 ? P.charge(time) : P.clapW(); rate = 14; break;
      case 'pgrapple': pose = this.def.powerGrapple === 'piledriver' ? (this.t < 22 ? P.holdOver() : P.slamS()) : this.def.powerGrapple === 'webSpin' ? P.swing(time) : this.def.powerGrapple === 'skyDrop' ? P.fly(4) : this.def.powerGrapple === 'portalDrop' ? P.shoot() : P.teleport(); rate = 20; break;
      case 'finished': pose = P.launched(); break;
      case 'ko': pose = this.onGround ? P.down() : P.launched(); rate = 10; break;
      case 'victory': pose = P.victory(time); break;
      case 'idleLock': pose = P.guard(time, h); break;
      default: pose = P.guard(time, h);
    }
    if (this.state === 'grabbed' || this.state === 'finished') { r.root.rotation.y = this.yaw; }
    r.apply(pose, rate, dt);
    // Big launches tumble end over end.
    if ((this.state === 'launched' || this.state === 'ko' && !this.onGround) && this.lastLaunchSpeed > 11) r.body.rotation.x = -0.7 - this.t * 0.22;
    if (this.skinned) {
      const play = this.clipFor() as (ClipPlay & { durTicks?: number }) | null;
      // One-shot clips are time-fitted to the gameplay duration of the state.
      this.skinned.drive(play ? { ...play, speed: play.durTicks ? this.fitSpeed(play.name, play.durTicks) : play.speed } : null);
      this.skinned.update(dt);
      // Weight: lean into acceleration and turns, tip forward at speed.
      if (dt > 0) {
        const acc = this.vel.clone().sub(this.prevVel).divideScalar(Math.max(dt, 1 / 120));
        const fwd = this.forward, right = new THREE.Vector3(fwd.z, 0, -fwd.x);
        const grounded = this.onGround && (this.state === 'ground' || this.state === 'attack');
        const latA = grounded ? acc.dot(right) : 0, fwdA = grounded ? acc.dot(fwd) : 0;
        const hsp = Math.hypot(this.vel.x, this.vel.z);
        const targetZ = THREE.MathUtils.clamp(-latA * 0.006, -0.2, 0.2);
        const targetX = THREE.MathUtils.clamp(fwdA * 0.004 + (grounded ? (hsp / this.def.speed) * 0.05 : 0), -0.14, 0.18);
        const k = 1 - Math.exp(-dt * 7);
        this.leanZ += (targetZ - this.leanZ) * k;
        this.leanX += (targetX - this.leanX) * k;
        this.skinned.model.rotation.set(this.leanX, 0, this.leanZ);
        this.prevVel.copy(this.vel);
      }
    }
    // Strike swoosh along the attacking limb during the active window.
    const m = this.state === 'attack' ? this.move : null;
    if (m && m.hit && this.skinned && this.skinned.procW < 0.5 && this.t >= m.startup - 1 && this.t <= m.startup + m.active + 1) {
      // Authored clip: trail whichever hand or foot is actually moving fastest.
      const sk = this.skinned;
      let best: [string, string] = ['hand_r', 'lowerarm_r'], bestV = -1;
      for (const pair of [['hand_r', 'lowerarm_r'], ['hand_l', 'lowerarm_l'], ['foot_r', 'calf_r'], ['foot_l', 'calf_l']] as [string, string][]) {
        const p = sk.boneWorld(pair[0]);
        const prev = this.limbPrev.get(pair[0]);
        const v = prev ? p.distanceTo(prev) : 0;
        this.limbPrev.set(pair[0], p);
        if (v > bestV) { bestV = v; best = pair; }
      }
      this.ribbon.push(sk.boneWorld(best[0]), sk.boneWorld(best[1]));
    } else if (m && m.hit && this.t >= m.startup - 1 && this.t <= m.startup + m.active + 1) {
      const limb = m.limb ?? 'rh';
      const tip = new THREE.Vector3(), mid = new THREE.Vector3();
      const [endObj, midObj] = limb === 'lh' ? [r.hand.l, r.joints.lFore] : limb === 'rf' ? [r.foot.r, r.joints.rShin] : limb === 'lf' ? [r.foot.l, r.joints.lShin] : [r.hand.r, r.joints.rFore];
      endObj.getWorldPosition(tip);
      midObj.getWorldPosition(mid);
      this.ribbon.push(tip, mid);
      if (limb === 'both') { r.hand.l.getWorldPosition(tip); r.joints.lFore.getWorldPosition(mid); this.ribbon.push(tip, mid); }
    }
    this.ribbon.update(dt);
    // Footfalls: dust (and a little weight in the camera for the heavy).
    if (this.state === 'ground' && this.onGround) {
      const hsp = Math.hypot(this.vel.x, this.vel.z);
      const step = Math.floor(this.runPhase / Math.PI);
      if (step !== this.lastStepPhase && hsp > 3) {
        const foot = new THREE.Vector3();
        (step % 2 ? r.foot.l : r.foot.r).getWorldPosition(foot);
        foot.y = this.pos.y;
        this.match.fx.dust(foot, this.def.heavy ? 2 : 1, this.def.heavy ? 0.35 : 0.2, 0.6);
        if (this.def.heavy && hsp > 6) this.match.fx.shake = Math.max(this.match.fx.shake, 0.08);
      }
      this.lastStepPhase = step;
    }
    if ((this.state === 'hitstun' || this.state === 'evade') && this.onGround && Math.hypot(this.vel.x, this.vel.z) > 4 && this.t % 3 === 0) this.match.fx.dust(this.pos, 1, 0.3, 0.4);

    // Wings shimmer when flying.
    const wings = (r as any).wings as THREE.Mesh[] | undefined;
    if (wings) {
      const open = this.state === 'fly' || this.state === 'attack' && this.flyAfterMove ? 1 : 0.35;
      const flap = Math.sin(time * 9) * 0.15 * open;
      wings[0].rotation.y = -0.5 - open * 0.6 + flap;
      wings[1].rotation.y = 0.5 + open * 0.6 - flap;
      (wings[0].material as THREE.MeshBasicMaterial).opacity = 0.25 + open * 0.4;
    }
    // Rage and charge feedback.
    const charge = this.state === 'charge' ? 0.25 + Math.sin(time * 20) * 0.08 : 0;
    (this.aura.material as GlowMaterial).level += (charge * 2.2 - (this.aura.material as GlowMaterial).level) * 0.3;
    this.aura.rotation.y += dt * 4;
    // Ember: hands always smoulder. Magna: shards orbit the waist.
    if (this.def.embers && this.rig.root.visible && this.state !== 'out') {
      this.emberAcc += 24 * dt * this.match.fx.quality;
      while (this.emberAcc >= 1) {
        this.emberAcc -= 1;
        const hp = this.skinned ? this.skinned.boneWorld(Math.random() < 0.5 ? 'hand_l' : 'hand_r') : this.hand();
        this.match.fx.wisp(hp, new THREE.Color(Math.random() < 0.6 ? 0xff5a10 : 0xffb040).multiplyScalar(0.75), 0.28);
      }
    }
    const orbit = (r as any).orbit as THREE.Group | undefined;
    if (orbit) orbit.rotation.y += dt * (this.state === 'fly' ? 4 : 2.2);
    // Auras are particle wisps that hug the body (the old shells stay hidden).
    this.aura.visible = this.rageAura.visible = false;
    const charging = this.state === 'charge' || this.state === 'powerCharge';
    if ((this.raging || charging) && this.rig.root.visible && this.state !== 'out') {
      const rate = (this.raging ? 95 : 32) * this.match.fx.quality;
      this.auraAcc += rate * dt;
      const pts = this.auraPoints();
      while (this.auraAcc >= 1) {
        this.auraAcc -= 1;
        const p = pts[Math.floor(Math.random() * pts.length)].clone();
        p.x += (Math.random() - 0.5) * 0.3; p.y += (Math.random() - 0.5) * 0.2; p.z += (Math.random() - 0.5) * 0.3;
        const col = this.raging
          ? new THREE.Color(Math.random() < 0.6 ? 0xff3a10 : 0xffa030)
          : new THREE.Color(Math.random() < 0.7 ? 0x2a78ff : 0x6fc0ff);
        this.match.fx.wisp(p, col.multiplyScalar(this.raging ? 0.8 : 0.6), (this.raging ? 0.45 : 0.3) * (0.7 + Math.random() * 0.6) * (this.def.height / 1.9));
      }
    }
    const ra = this.raging ? 0.06 + Math.sin(time * 14) * 0.03 : 0;
    (this.rageAura.material as GlowMaterial).level += (ra * 5 - (this.rageAura.material as GlowMaterial).level) * 0.3;
    this.rageAura.rotation.y -= dt * 6;
    for (const m of this.accents) {
      const base = m.userData.baseEI ?? 1;
      m.emissiveIntensity = base * (this.raging ? 2.2 + Math.sin(time * 18) * 0.5 : 1) + (this.hitFlash > 0 ? 1 : 0);
    }
    // Character glow light.
    {
      const base = new THREE.Color(this.def.color);
      let inten = 2.2, col = base;
      if (this.raging) { col = new THREE.Color(0xff4a1c); inten = 4 + Math.sin(time * 11) * 1.2; }
      else if (this.state === 'charge' || this.state === 'powerCharge') { col = new THREE.Color(0x6fc8ff); inten = 5 + Math.sin(time * 18) * 2; }
      if (this.hitFlash > 4) { col = new THREE.Color(0xffffff); inten = 6; }
      if (!this.rig.root.visible || this.state === 'out') inten = 0;
      this.glow.color.lerp(col, 0.35);
      this.glow.intensity += (inten - this.glow.intensity) * 0.3;
      this.glow.position.copy(this.center).add(new THREE.Vector3(0, 0.1, 0)).addScaledVector(this.forward, 0.35);
    }
    // White impact flash across the whole body.
    const flash = this.hitFlash > 4;
    if (flash || this.flashOn) {
      for (const mt of this.mats) {
        if (flash) { mt.emissive.setRGB(1, 1, 1); mt.emissiveIntensity = 0.85; }
        else { mt.emissive.copy(mt.userData.baseEmissive); if (!this.accents.includes(mt)) mt.emissiveIntensity = mt.userData.baseEI; }
      }
      this.flashOn = flash;
    }
    // Ground marker: projected onto the surface below.
    const g = this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.1);
    this.shadowBlob.visible = Number.isFinite(g) && this.state !== 'out' && this.rig.root.visible;
    this.contact.visible = false;
    if (this.shadowBlob.visible) {
      this.shadowBlob.position.set(this.pos.x, g + 0.03, this.pos.z);
      // Soft contact shadow: darker and tighter the closer the body is to the ground.
      const hh = Math.max(0, this.pos.y - g);
      this.contact.visible = true;
      this.contact.position.set(this.pos.x, g + 0.02, this.pos.z);
      this.contact.scale.setScalar(1 + hh * 0.15);
      (this.contact.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.55 - hh * 0.12);
      const hgt = this.pos.y - g;
      this.shadowBlob.scale.setScalar(Math.max(0.5, 1 - hgt * 0.05));
    }
    // Grapple line.
    const showLine = ((this.state === 'swing' || this.state === 'pgrapple' && this.def.powerGrapple === 'webSpin' || this.state === 'attack' && this.move?.special === 'slingshot' && this.t < (this.move?.startup ?? 0) + 6) && this.anchor) || (this.state === 'lineGrab' && this.lineTarget);
    this.line.visible = !!showLine;
    if (showLine) {
      const a = this.hand();
      const b = this.state === 'lineGrab' ? this.lineTarget!.point : this.anchor!;
      const pos = this.lineGeo.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
    }
  }
}

export { tmpV };

let _contact: THREE.MeshBasicMaterial | null = null;
function contactMat() {
  if (!_contact) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    _contact = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -1 });
  }
  return _contact.clone();
}


/** Per-fighter animation style: stance, combo clips, dash, landing and victory. */
interface AnimStyle { idle: string; idleSpeed?: number; walk?: string; chain: string[]; run?: string; dash?: string; victory: string; jumpStart?: string; land?: string; locoScale?: number }
const STYLE: Record<string, AnimStyle> = {
  default: { idle: 'Idle_Loop', chain: ['Punch_Jab', 'Punch_Cross', 'Melee_Hook'], victory: 'Yes' },
  basalt: { idle: 'Idle_Loop', idleSpeed: 0.7, chain: ['Shield_OneShot', 'Melee_Hook', 'Sword_Attack'], run: 'Melee_Hook', dash: 'Shield_Dash', victory: 'Idle_FoldArms_Loop', locoScale: 0.85 },
  tether: { idle: 'NinjaJump_Idle_Loop', chain: ['Punch_Jab', 'Punch_Cross', ''], run: 'Slide_Start', dash: '', victory: 'Dance_Loop', jumpStart: 'NinjaJump_Start', land: 'NinjaJump_Land' },
  aerin: { idle: 'Spell_Simple_Idle_Loop', chain: ['Spell_Simple_Shoot', 'Sword_Regular_A', 'Melee_Hook'], run: 'Sword_Regular_B', victory: 'Yes' },
  shunt: { idle: 'Sword_Idle', chain: ['Sword_Regular_A', 'Sword_Regular_B', 'Sword_Regular_C'], run: 'Sword_Regular_A', dash: 'Sword_Dash', victory: 'Idle_FoldArms_Loop' },
  vanta: { idle: 'Crouch_Idle_Loop', walk: 'Crouch_Fwd_Loop', chain: ['Sword_Regular_A', 'Sword_Regular_B', 'Zombie_Scratch', 'Melee_Hook'], run: 'Sword_Regular_B', dash: 'Sword_Dash', victory: 'Dance_Loop', jumpStart: 'NinjaJump_Start', land: 'NinjaJump_Land' },
  magna: { idle: 'Idle_FoldArms_Loop', chain: ['Spell_Simple_Shoot', 'Punch_Cross', 'Melee_Hook'], run: 'Punch_Cross', victory: 'Idle_FoldArms_Loop' },
  ember: { idle: 'Idle_Loop', idleSpeed: 0.85, chain: ['Punch_Jab', 'Melee_Hook', 'Shield_OneShot'], run: 'Melee_Hook', dash: 'Shield_Dash', victory: 'Yes', locoScale: 0.92 },
  rift: { idle: 'Spell_Simple_Idle_Loop', idleSpeed: 0.7, chain: ['Punch_Jab', 'Spell_Simple_Shoot', ''], run: 'Melee_Hook', dash: 'Punch_Cross', victory: 'Dance_Loop', jumpStart: 'NinjaJump_Start', land: 'NinjaJump_Land' },
};
/** Clips for non-chain moves shared across fighters. */
const MOVE_CLIP: Record<string, string> = {
  propSwing: 'Sword_Attack', throwFighter: 'OverhandThrow', pgEnd: 'OverhandThrow', shoulder: 'Shield_Dash', blazeShoulder: 'Shield_Dash',
  whiffGrab: 'Push_Loop', bolt: 'Spell_Simple_Shoot', boltAir: 'Spell_Simple_Shoot', shards: 'Spell_Simple_Shoot', shardsAir: 'Spell_Simple_Shoot',
  snare: 'Spell_Simple_Shoot', snareAir: 'Spell_Simple_Shoot', chainLightning: 'Spell_Simple_Shoot', tripleSnare: 'Spell_Simple_Shoot', mineTrail: 'Spell_Simple_Shoot',
  clawFrenzy: 'Zombie_Scratch', pounce: 'Sword_Dash', counter: 'Melee_Hook',
  fireball: 'Spell_Simple_Shoot', swapGate: 'Spell_Simple_Shoot', swapGateAir: 'Spell_Simple_Shoot', riftStorm: 'Spell_Simple_Shoot', shadeRend: 'Zombie_Scratch',
};
/** Seconds into each clip where the blow lands (estimated by eye); used to align clips to hit frames. */
const CLIP_IMPACT: Record<string, number> = {
  Punch_Jab: 0.22, Punch_Cross: 0.3, Melee_Hook: 0.2, Sword_Regular_A: 0.18, Sword_Regular_B: 0.22, Sword_Regular_C: 0.5, Shield_OneShot: 0.32,
  Sword_Attack: 0.6, Zombie_Scratch: 0.42, Spell_Simple_Shoot: 0.2, OverhandThrow: 0.55, Shield_Dash: 0.25, Sword_Dash: 0.35, Slide_Start: 0.3,
};
