import * as THREE from 'three';
import { CharacterDef, MoveDef, HitSpec } from './characters';
import { Rig, P, Pose } from './rig';
import { InputFrame, emptyFrame } from './input';
import { Prop, HW, HD, KILL_Y, WallSeg } from './arena';
import { sfx } from './audio';
import type { Match } from './match';

export type FState =
  | 'ground' | 'air' | 'attack' | 'guard' | 'sblock' | 'evade' | 'charge'
  | 'grabbing' | 'grabbed' | 'lift' | 'throw' | 'lineGrab' | 'yanked'
  | 'hitstun' | 'launched' | 'down' | 'getup' | 'stunned'
  | 'swing' | 'cling' | 'fly' | 'teleport' | 'recover'
  | 'finisher' | 'finished' | 'ko' | 'out' | 'victory' | 'idleLock';

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

  constructor(public def: CharacterDef, public idx: number, public match: Match) {
    this.rig = new Rig(def.proportions);
    const b = def.build(this.rig);
    this.accents = b.accents;
    for (const m of this.accents) m.userData.baseEI = m.emissiveIntensity;
    // Charge aura and rage aura.
    const auraGeo = new THREE.CylinderGeometry(def.radius * 1.6, def.radius * 1.9, def.height * 1.15, 18, 1, true);
    auraGeo.translate(0, def.height * 0.55, 0);
    this.aura = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({ color: 0x6fc8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.rageAura = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({ color: 0xff3a20, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.rig.root.add(this.aura, this.rageAura);
    // Player ring marker on the ground.
    const ring = new THREE.Mesh(new THREE.RingGeometry(def.radius + 0.15, def.radius + 0.32, 32), new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x3aa0ff : 0xff4a4a, transparent: true, opacity: 0.75, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.shadowBlob = ring;
    match.scene.add(ring);
    this.lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(this.lineGeo, new THREE.LineBasicMaterial({ color: 0xeaffff }));
    this.line.visible = false;
    this.line.frustumCulled = false;
    match.scene.add(this.line);
    match.scene.add(this.rig.root);
    this.rig.snap(P.guard(0, def.heavy));
  }

  dispose() {
    this.match.scene.remove(this.rig.root, this.shadowBlob, this.line);
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
      case 'getup': if (this.t > 18) this.setState('ground'); this.friction(dt, 20); break;
      case 'swing': this.stSwing(dt); break;
      case 'cling': this.stCling(dt); break;
      case 'teleport': this.stTeleport(dt); break;
      case 'recover': if (this.t > 10) this.setState(this.onGround ? 'ground' : 'air'); break;
      case 'finisher': this.stFinisher(dt); break;
      case 'ko': this.stKO(dt); break;
      case 'out': break;
      case 'victory': case 'idleLock': this.friction(dt, 20); break;
    }

    if (!['grabbed', 'finished', 'yanked', 'teleport', 'out', 'finisher', 'cling'].includes(this.state)) this.physics(dt);
    if (this.heldProp) this.positionHeldProp();
    if (this.pos.y < KILL_Y && this.state !== 'out') this.ringOut();
  }

  private updateResources(dt: number) {
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
    const gravityOn = !(this.state === 'fly' || this.state === 'swing' || (this.state === 'attack' && this.move?.id === 'flightDash'));
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
    switch (this.state) {
      case 'air': this.setState('ground'); break;
      case 'launched':
        if (this.health <= 0) { this.setState('ko'); break; }
        this.match.fx.burstDebris(this.pos.clone(), 6, 0x777777, 3, 0.15);
        this.setState('down');
        break;
      case 'attack':
        if (this.move?.special === 'groundPound') this.groundPoundImpact();
        else if (this.move?.airOk && !['bolt', 'snare', 'pulse', 'blinkStrike'].includes(this.move.special ?? '') && this.move.id !== 'flightDash') { this.move = null; this.setState('recover'); }
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
      const m = ground ? this.def.moves.power : this.def.moves.powerAir;
      if (!this.hasEnergy(m.energy ?? 0)) { this.noPower(); return true; }
      this.spend(m.energy ?? 0);
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
      if (this.heldProp) { this.startThrow(false); return true; }
      if (ground) { this.chainIdx = 0; this.startMove(this.def.moves.chain[0]); }
      else this.startMove(this.vel.y > 0 ? this.def.moves.airRise : this.def.moves.airDive);
      return true;
    }
    // X: grapple, pick up, or throw.
    if (b.grab.pressed) { this.grabAction(); return true; }
    // B: jump.
    if (b.jump.pressed && ground) {
      this.vel.y = this.def.jumpV;
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

  beginTeleport(target: THREE.Vector3, clampToRoof: boolean) {
    if (clampToRoof) {
      target.x = THREE.MathUtils.clamp(target.x, -HW + 1, HW - 1);
      target.z = THREE.MathUtils.clamp(target.z, -HD + 1, HD - 1);
    }
    const g = this.match.arena.groundAt(target.x, target.z, 50, 0);
    target.y = Number.isFinite(g) ? Math.max(g, Math.min(target.y, g + 3)) : target.y;
    this.match.arena.pushOut(target, this.def.radius, this.def.height);
    this.teleportTo.copy(target);
    this.match.fx.sparksAt(this.center, 18, 0x37f2ff, 5);
    this.match.fx.flash(this.center, 0.9, 0x37f2ff, 0.2);
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
      this.match.fx.flash(this.center, 0.9, 0x37f2ff, 0.2);
      this.match.fx.sparksAt(this.center, 14, 0x37f2ff, 5);
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
      const safelyInside = Math.abs(this.pos.x) < HW - 0.6 && Math.abs(this.pos.z) < HD - 0.6;
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
    if (this.pos.y > 14) this.vel.y = Math.min(this.vel.y, 0);
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
      if (o.alive && to.length() < 40) this.yaw = Math.atan2(to.x, to.z);
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
      if (this.onGround || m.id === 'flightDash' || m.id === 'swingKick' || m.id === 'shoulder') { this.vel.x = f.x; this.vel.z = f.z; }
    } else if (this.onGround) this.friction(dt, 14);
    if (m.id === 'flightDash') this.vel.y = 0;

    if (t === activeStart) this.onActiveStart(m);
    if (m.special === 'blinkStrike' && t === 5) {
      const o = this.opp;
      const target = o.pos.clone().addScaledVector(o.forward, -1.6);
      target.x = THREE.MathUtils.clamp(target.x, -HW + 0.8, HW - 0.8);
      target.z = THREE.MathUtils.clamp(target.z, -HD + 0.8, HD - 0.8);
      this.match.fx.flash(this.center, 0.8, 0x37f2ff, 0.15);
      this.pos.copy(target);
      this.faceOpp(10);
      this.match.fx.flash(this.center, 0.8, 0x37f2ff, 0.15);
      this.invuln = 6;
    }
    if (m.special === 'blinkStrike') this.rig.root.visible = !(t > 2 && t < 6);
    // Ground pound continues until it lands.
    if (m.special === 'groundPound') {
      if (!this.onGround && t >= activeStart) { this.vel.y = Math.min(this.vel.y, m.riseV ?? -20); this.vel.x *= 0.9; this.vel.z *= 0.9; this.t = Math.min(this.t, activeStart + 1); }
      if (t < activeStart) { this.vel.set(0, Math.max(this.vel.y, 3), 0); }
    }
    if (t >= activeStart && t < activeEnd && m.hit && !['groundPound', 'thunderclap', 'pulse'].includes(m.special ?? '')) {
      this.match.resolveMelee(this, m);
    }
    if (t >= activeEnd + 2 && this.chainQueued && m === this.def.moves.chain[this.chainIdx]) {
      this.chainIdx++;
      this.startMove(this.def.moves.chain[this.chainIdx]);
      return;
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
      this.match.fx.ring(this.pos.clone(), m.hit!.radius * 1.3, 0x37f2ff, 0.35);
      this.match.fx.flash(c, 2.2, 0x37f2ff, 0.2);
      sfx.zap();
      this.match.resolveArea(this, m, c);
    }
    if (m.special === 'bolt') this.match.spawnProjectile(this, 'bolt');
    if (m.special === 'snare') this.match.spawnProjectile(this, 'snare');
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
    this.friction(dt, this.t < 8 ? 2 : 14);
    if (this.t > 16) this.setState(this.onGround ? 'ground' : 'air');
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
    if (this.def.recovery === 'swing') {
      if (oGrabbable && dO > reach && dO < 11 && facingO > 0.8) return { kind: 'line-fighter', f: o };
      let lp: Prop | null = null;
      let ld = Infinity;
      for (const p of this.match.arena.props) {
        if (p.state !== 'rest' || p.cls > 0) continue;
        const tp = p.pos.clone().sub(this.pos);
        const d = tp.length();
        if (d > 11) continue;
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
    if (this.t > 10 && (b.grab.pressed || b.attack.pressed) || this.t > 42) {
      this.throwFighter(o, this.superGrabbing);
    }
  }

  private throwFighter(o: Fighter, superThrow: boolean) {
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
    this.rig.hand.r.getWorldPosition(v);
    return v;
  }

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
    if (this.t > 40 || quick) { this.setState('getup'); this.invuln = 22; }
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
    } else if (id === 'basalt') {
      if (t < 70) o.pos.lerp(s.clone().add(new THREE.Vector3(0, this.def.height + 0.6, 0)), 0.15);
      else if (t < 82) o.pos.lerp(front(1.6, 0), 0.5);
      if (t === 82) { fx.ring(front(1.6, 0), 6, 0xff7a3a, 0.6); fx.burstDebris(front(1.6, 0.2), 40, 0x6a6a72, 10, 0.4); fx.shake = 1.2; sfx.explosion(); }
    } else if (id === 'tether') {
      const ang = (t - 30) * 0.25;
      const r = 2.2;
      this.yaw = this.finisherData.yaw0 + ang;
      if (t < 90) { o.pos.copy(s).add(new THREE.Vector3(Math.sin(this.yaw) * r, 1.2 + Math.sin(t * 0.2) * 0.3, Math.cos(this.yaw) * r)); if (t % 4 === 0) fx.trail(o.center, 0xeaffff, 0.2, 0.6); }
      if (t === 90) { o.vel.copy(fwd).multiplyScalar(14); o.vel.y = 8; fx.flash(o.center, 1.2, 0xffffff, 0.2); sfx.hit(true); }
      if (t > 90 && t < 120) { o.pos.addScaledVector(o.vel, 1 / 60); o.vel.y -= 0.5; if (o.pos.y < s.y) { o.pos.y = s.y; o.vel.set(0, 0, 0); } }
    } else if (id === 'aerin') {
      if (t < 75) { this.pos.lerp(s.clone().add(new THREE.Vector3(0, 7, 0)), 0.05); o.pos.lerp(this.pos.clone().addScaledVector(fwd, 0.9).add(new THREE.Vector3(0, 0.2, 0)), 0.3); if (t % 2 === 0) fx.trail(this.pos, 0xa070ff, 0.25, 0.5); }
      else if (t < 88) o.pos.lerp(front(2, 0), 0.4);
      if (t === 88) { fx.flash(front(2, 1), 3, 0xc9a8ff, 0.35); fx.ring(front(2, 0), 6, 0xa070ff, 0.6); fx.shake = 1.1; sfx.explosion(); sfx.zap(); }
      if (t > 95) this.pos.lerp(s, 0.08);
    } else {
      // Shunt: scatter strikes from every side.
      if (t < 100 && t % 14 === 0) {
        const a = Math.random() * Math.PI * 2;
        this.pos.copy(o.pos).add(new THREE.Vector3(Math.sin(a) * 1.4, 0, Math.cos(a) * 1.4));
        this.yaw = Math.atan2(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
        fx.flash(o.center, 0.9, 0x37f2ff, 0.12);
        fx.sparksAt(o.center, 10, 0x37f2ff, 7);
        sfx.hit(true);
      }
      if (t === 100) { this.pos.copy(s); fx.flash(o.center, 2.2, 0x37f2ff, 0.3); fx.ring(o.pos.clone(), 5, 0x37f2ff, 0.5); sfx.explosion(); }
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
      case 'grabbing': pose = this.t < 8 ? P.grab() : (this.def.lift === 2 ? P.holdOver() : P.grab()); break;
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
      case 'finished': pose = P.launched(); break;
      case 'ko': pose = this.onGround ? P.down() : P.launched(); rate = 10; break;
      case 'victory': pose = P.victory(time); break;
      case 'idleLock': pose = P.guard(time, h); break;
      default: pose = P.guard(time, h);
    }
    if (this.state === 'grabbed' || this.state === 'finished') { r.root.rotation.y = this.yaw; }
    r.apply(pose, rate, dt);

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
    (this.aura.material as THREE.MeshBasicMaterial).opacity += (charge - (this.aura.material as THREE.MeshBasicMaterial).opacity) * 0.3;
    this.aura.rotation.y += dt * 4;
    const ra = this.raging ? 0.18 + Math.sin(time * 14) * 0.06 : 0;
    (this.rageAura.material as THREE.MeshBasicMaterial).opacity += (ra - (this.rageAura.material as THREE.MeshBasicMaterial).opacity) * 0.3;
    this.rageAura.rotation.y -= dt * 6;
    for (const m of this.accents) {
      const base = m.userData.baseEI ?? 1;
      m.emissiveIntensity = base * (this.raging ? 2.2 + Math.sin(time * 18) * 0.5 : 1) + (this.hitFlash > 0 ? 1 : 0);
    }
    // Ground marker: projected onto the surface below.
    const g = this.match.arena.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.1);
    this.shadowBlob.visible = Number.isFinite(g) && this.state !== 'out' && this.rig.root.visible;
    if (this.shadowBlob.visible) {
      this.shadowBlob.position.set(this.pos.x, g + 0.03, this.pos.z);
      const hgt = this.pos.y - g;
      this.shadowBlob.scale.setScalar(Math.max(0.5, 1 - hgt * 0.05));
    }
    // Grapple line.
    const showLine = (this.state === 'swing' && this.anchor) || (this.state === 'lineGrab' && this.lineTarget);
    this.line.visible = !!showLine;
    if (showLine) {
      const a = this.hand();
      const b = this.state === 'swing' ? this.anchor! : this.lineTarget!.point;
      const pos = this.lineGeo.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
    }
  }
}

export { tmpV };
