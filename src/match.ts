import * as THREE from 'three';
import { Fighter } from './fighter';
import { Arena, Prop, BOUNDS } from './arena';
import { FX } from './fx';
import { VersusCamera } from './camera';
import { CharacterDef, MoveDef, HitSpec } from './characters';
import { sfx } from './audio';

export type EndHow = 'ko' | 'ringout' | 'finisher';

interface Projectile {
  kind: 'bolt' | 'snare';
  owner: Fighter;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  mesh: THREE.Mesh;
  alive: boolean;
}

export class Match {
  fighters: Fighter[] = [];
  camBasis: { fwd: THREE.Vector3; right: THREE.Vector3 };
  ended: { winner: Fighter; loser: Fighter; how: EndHow; tick: number } | null = null;
  tick = 0;
  projectiles: Projectile[] = [];
  private projPool: THREE.Mesh[] = [];
  introT = 0;
  resultShown = false;
  events: string[] = [];

  constructor(public scene: THREE.Scene, public arena: Arena, public fx: FX, public camera: VersusCamera, defs: [CharacterDef, CharacterDef]) {
    this.camBasis = { fwd: camera.fwd, right: camera.right };
    this.fighters = [new Fighter(defs[0], 0, this), new Fighter(defs[1], 1, this)];
    const projGeo = new THREE.SphereGeometry(0.22, 10, 8);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(projGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending }));
      m.visible = false;
      scene.add(m);
      this.projPool.push(m);
    }
    this.restart();
  }

  dispose() {
    for (const f of this.fighters) f.dispose();
    for (const m of this.projPool) this.scene.remove(m);
  }

  restart() {
    this.arena.reset();
    this.fx.clear();
    this.ended = null;
    this.resultShown = false;
    this.tick = 0;
    this.introT = 90;
    this.events = [];
    for (const p of this.projectiles) p.mesh.visible = false;
    this.projectiles = [];
    const [s0, s1] = this.arena.spawns;
    this.fighters[0].reset(s0, Math.PI / 2);
    this.fighters[1].reset(s1, -Math.PI / 2);
    this.camera.cinematic = null;
    this.camera.yaw = 0;
    this.camera.snapTo(this.fighters);
  }

  log(e: string) {
    this.events.push(`${this.tick}: ${e}`);
    if (this.events.length > 200) this.events.shift();
  }

  // ------------------------------------------------------------------ end conditions
  /** First valid end condition wins; simultaneous ones in the same tick are resolved once. */
  declare(winner: Fighter, loser: Fighter, how: EndHow) {
    if (this.ended) {
      // Same-tick double ring-out or trade: keep a single winner by remaining health.
      if (this.ended.tick === this.tick && this.ended.loser !== loser) {
        const a = this.fighters[0], b = this.fighters[1];
        const w = a.health === b.health ? this.ended.winner : a.health > b.health ? a : b;
        this.ended.winner = w;
        this.ended.loser = w === a ? b : a;
      }
      return;
    }
    this.ended = { winner, loser, how, tick: this.tick };
    this.log(`END ${how} winner=${winner.def.id}`);
    if (how === 'ko') sfx.ko();
  }

  startCinematic(att: Fighter, vic: Fighter) {
    this.camera.cinematic = {
      focus: () => att.center.clone().lerp(vic.center, 0.5),
      yaw: att.yaw + Math.PI * 0.65,
      dist: 6.5,
      h: 2.2,
      t: 0,
    };
  }

  // ------------------------------------------------------------------ combat resolution
  resolveMelee(att: Fighter, m: MoveDef) {
    const spec = m.hit!;
    const c = att.pos.clone().addScaledVector(att.forward, spec.fwd);
    c.y += spec.up * (att.def.height / 1.9);
    const o = att.opp;
    if (!att.moveHitDone && this.sphereVsFighter(c, spec.radius, o)) {
      att.moveHitDone = true;
      const dir = o.pos.clone().sub(att.pos).setY(0);
      if (dir.lengthSq() < 1e-4) dir.copy(att.forward);
      dir.normalize();
      const r = o.receiveHit(att, spec, dir, { source: 'melee' });
      if (r !== 'miss') this.log(`${att.def.id} ${m.id} -> ${r}`);
    }
    this.meleeVsScenery(att, c, spec);
  }

  resolveArea(att: Fighter, m: MoveDef, center: THREE.Vector3, groundOnly = false) {
    const spec = m.hit!;
    const o = att.opp;
    if (this.sphereVsFighter(center, spec.radius, o) && (!groundOnly || o.pos.y < center.y + 1.6)) {
      const dir = o.pos.clone().sub(att.pos).setY(0);
      if (dir.lengthSq() < 0.01) dir.copy(att.forward);
      dir.normalize();
      const r = o.receiveHit(att, spec, dir, { source: 'area' });
      this.log(`${att.def.id} ${m.id} -> ${r}`);
    }
    // Shockwaves throw loose props and crack nearby fence.
    for (const p of this.arena.props) {
      if (p.state !== 'rest') continue;
      if (p.pos.distanceTo(center) < spec.radius + 0.8 && p.cls <= 1) {
        const d = p.pos.clone().sub(att.pos).setY(0).normalize();
        p.vel.copy(d.multiplyScalar(14)).setY(6);
        p.spin.set(5, 3, 2);
        p.state = 'thrown';
        p.thrower = att;
        p.power = 1;
        p.hitIds.clear();
        p.life = 0;
      }
    }
    this.meleeVsScenery(att, center, spec);
  }

  private meleeVsScenery(att: Fighter, c: THREE.Vector3, spec: HitSpec) {
    if (!spec.breaksWalls) return;
    for (const w of this.arena.walls) {
      if (w.broken || att.moveWallDone.has(w)) continue;
      const s = w.solid;
      const cx = THREE.MathUtils.clamp(c.x, s.min.x, s.max.x), cy = THREE.MathUtils.clamp(c.y, s.min.y, s.max.y), cz = THREE.MathUtils.clamp(c.z, s.min.z, s.max.z);
      if ((c.x - cx) ** 2 + (c.y - cy) ** 2 + (c.z - cz) ** 2 < spec.radius * spec.radius) {
        att.moveWallDone.add(w);
        if (w.damage(spec.breaksWalls * (att.raging ? 1.5 : 1), this.fx, att.forward)) this.arena.spawnRubble(w.center.clone().setY(0.6).addScaledVector(w.outward, -1.2));
      }
    }
    // Sign letters can be struck from the air.
    if (c.z < -12 && c.y > 3.4) {
      const i = this.arena.letters.findIndex((L) => !L.down && Math.abs(L.x - c.x) < 1.3 + spec.radius);
      if (i >= 0) this.arena.hitLetter(i, spec.breaksWalls);
    }
  }

  sphereVsFighter(c: THREE.Vector3, r: number, f: Fighter) {
    if (!f.alive || f.state === 'teleport') return false;
    const y = THREE.MathUtils.clamp(c.y, f.pos.y, f.pos.y + f.def.height);
    const dx = c.x - f.pos.x, dy = c.y - y, dz = c.z - f.pos.z;
    const rr = r + f.def.radius;
    return dx * dx + dy * dy + dz * dz < rr * rr;
  }

  spawnProjectile(owner: Fighter, kind: 'bolt' | 'snare') {
    const mesh = this.projPool.find((m) => !m.visible);
    if (!mesh) return;
    const o = owner.opp;
    const origin = owner.hand();
    const aim = o.center.sub(origin);
    const dir = aim.lengthSq() > 0 && aim.clone().setY(0).normalize().dot(owner.forward) > 0.5 ? aim.normalize() : owner.forward.clone().setY(0);
    const speed = kind === 'bolt' ? 30 : 22;
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(kind === 'bolt' ? 0xc9a8ff : 0xeaffff);
    mesh.scale.setScalar(kind === 'bolt' ? 1.1 : 1.4);
    mesh.visible = true;
    mesh.position.copy(origin);
    this.projectiles.push({ kind, owner, pos: origin.clone(), vel: dir.multiplyScalar(speed), life: 1.3, mesh, alive: true });
    sfx.zap();
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      this.fx.trail(p.pos, p.kind === 'bolt' ? 0xa070ff : 0xeaffff, 0.1, 0.2);
      const kill = () => { p.alive = false; p.mesh.visible = false; };
      if (p.life <= 0) { kill(); continue; }
      for (const f of this.fighters) {
        if (f === p.owner || !this.sphereVsFighter(p.pos, 0.25, f)) continue;
        const dir = p.vel.clone().setY(0).normalize();
        if (f.state === 'sblock' && f.forward.dot(dir) < 0) {
          // Super block deflects projectiles back at the shooter.
          p.vel.multiplyScalar(-1.1);
          p.owner = f;
          p.life = 1.2;
          sfx.superBlock();
          this.fx.sparksAt(p.pos, 12, 0x9ff7ff, 6);
          this.log(`${f.def.id} deflects ${p.kind}`);
          break;
        }
        if (p.kind === 'bolt') {
          f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 4, health: 5, kbF: 4, kbU: f.onGround ? 0 : 5, stun: 18, launch: !f.onGround }, dir, { source: 'projectile' });
        } else {
          const r = f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 4, health: 1, kbF: 1, kbU: 0, stun: 10 }, dir, { source: 'projectile' });
          if (r === 'hit' && f.state === 'hitstun') { f.setState('stunned'); f.stun = 55; f.say('SNARED'); }
        }
        kill();
        break;
      }
      if (!p.alive) continue;
      const w = this.arena.wallAt(p.pos, 0.2);
      if (w) {
        if (w.damage(p.kind === 'bolt' ? 12 : 4, this.fx, p.vel.clone().normalize())) this.arena.spawnRubble(w.center.clone().setY(0.6).addScaledVector(w.outward, -1.2));
        this.fx.sparksAt(p.pos, 8, 0xc9a8ff, 5);
        kill();
        continue;
      }
      const g = this.arena.groundAt(p.pos.x, p.pos.z, p.pos.y, 0);
      if (p.pos.y <= g) { this.fx.sparksAt(p.pos, 6, 0xc9a8ff, 4); kill(); }
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  // ------------------------------------------------------------------ props in flight
  shatterProp(p: Prop, vel?: THREE.Vector3) {
    if (p.state === 'gone') return;
    if (p.explosive) { this.explode(p); return; }
    const colors: Record<string, number> = { panel: 0xd8d2c2, crate: 0x8a6a42, letter: 0xff7060, ac: 0xa7adb5, rubble: 0x7d7f86, tank: 0xc8401c, car: 0x8a8a90, barrel: 0x2f6a9a, barrier: 0x8b8a90 };
    this.fx.burstDebris(p.pos.clone().setY(p.pos.y + 0.4), p.cls >= 1 ? 22 : 10, colors[p.kind], 6, p.cls >= 1 ? 0.3 : 0.18, vel ? vel.clone().normalize() : undefined);
    if (p.holder) { p.holder.heldProp = null; p.holder = null; }
    this.arena.removeProp(p);
    // Aftermath: a heavy-ish prop leaves rubble that can be picked up again.
    if (p.cls >= 1) this.arena.spawnRubble(p.pos.clone());
    sfx.crack();
    sfx.hit(p.cls >= 1);
  }

  explode(p: Prop) {
    const c = p.pos.clone().setY(p.pos.y + 0.8);
    if (p.holder) { p.holder.heldProp = null; p.holder = null; }
    this.arena.removeProp(p);
    this.fx.flash(c, 4.2, 0xffa040, 0.45);
    this.fx.flash(c, 2.4, 0xffffff, 0.2);
    this.fx.ring(c.clone().setY(Math.max(0, p.pos.y)), 7, 0xff6020, 0.6);
    this.fx.burstDebris(c, 30, 0x302820, 12, 0.3);
    this.fx.sparksAt(c, 40, 0xffb040, 14, 0.14, 4);
    this.fx.shake = 1.2;
    sfx.explosion();
    this.log('explosion');
    const thrower: Fighter | null = p.thrower ?? null;
    for (const f of this.fighters) {
      const d = f.center.distanceTo(c);
      if (d > 4.5) continue;
      const dir = f.pos.clone().sub(c).setY(0);
      if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
      dir.normalize();
      const att = thrower ?? f.opp;
      f.receiveHit(att, { fwd: 0, up: 0, radius: 0, stamina: 12, health: 16 * p.power, kbF: 14, kbU: 9, stun: 40, launch: true, heavy: true }, dir, { unblockable: d < 2, source: 'explosion' });
    }
    for (const w of this.arena.walls) {
      if (w.broken) continue;
      if (w.center.distanceTo(new THREE.Vector3(c.x, 0, c.z)) < 5.5 && w.damage(90, this.fx, w.outward)) this.arena.spawnRubble(w.center.clone().setY(0.6).addScaledVector(w.outward, -1.2));
    }
    for (const q of this.arena.props) if (q !== p && q.state === 'rest' && q.pos.distanceTo(c) < 4 && q.cls <= 1) { q.state = 'thrown'; q.thrower = thrower; q.vel.copy(q.pos.clone().sub(c).setY(0).normalize().multiplyScalar(10)).setY(8); q.hitIds.clear(); }
  }

  private updateThrownProps() {
    for (const p of this.arena.props) {
      if (p.state !== 'thrown') continue;
      const r = Math.max(p.half.x, p.half.y, p.half.z) * 0.8 + 0.2;
      const c = p.pos.clone().setY(p.pos.y + p.half.y);
      // Fighters: catch, block, deflect or hit.
      for (const f of this.fighters) {
        if (p.hitIds.has(f)) continue;
        if (f === p.thrower && p.life < 0.5) continue;
        if (!this.sphereVsFighter(c, r, f)) continue;
        p.hitIds.add(f);
        const dir = p.vel.clone().setY(0).normalize();
        const facing = f.forward.dot(dir) < -0.2;
        if (facing && f.tryCatch(p)) { this.log(`${f.def.id} catches ${p.kind}`); break; }
        if (facing && f.state === 'sblock') {
          p.vel.set(-p.vel.x * 1.1, Math.max(4, p.vel.y), -p.vel.z * 1.1);
          p.thrower = f;
          p.life = 0;
          p.hitIds.clear();
          p.hitIds.add(f);
          sfx.superBlock();
          this.fx.sparksAt(c, 14, 0x9ff7ff, 6);
          this.log(`${f.def.id} deflects ${p.kind}`);
          break;
        }
        const dmg = p.damage;
        const res = f.receiveHit(p.thrower ?? f.opp, { fwd: 0, up: 0, radius: 0, stamina: dmg * 0.6, health: dmg, kbF: 6 + p.cls * 4, kbU: 4 + p.cls * 2, stun: 30, launch: p.cls >= 1 || p.power > 1, heavy: p.cls >= 1 }, dir, { source: 'prop' });
        this.log(`${p.kind} hits ${f.def.id}: ${res}`);
        this.shatterProp(p, p.vel);
        break;
      }
      if (p.state !== 'thrown') continue;
      // Fence segments: damage, possibly breaking through.
      // Test the prop's underside against the fence so overhead carries can't skim over it.
      const w = this.arena.wallAt(new THREE.Vector3(c.x, p.pos.y + 0.15, c.z), r);
      if (w) {
        const amt = [35, 70, 120][p.cls] * p.power;
        const broke = w.damage(amt, this.fx, p.vel.clone().setY(0).normalize());
        if (broke) {
          this.arena.spawnRubble(w.center.clone().setY(0.6).addScaledVector(w.outward, -1.2));
          if (p.cls === 0) this.shatterProp(p, p.vel);
          else p.vel.multiplyScalar(0.7);
        } else this.shatterProp(p, p.vel);
        continue;
      }
      // Sign letters.
      if (c.z < -12.2 && c.y > 3.4 && c.y < 7) {
        const i = this.arena.letters.findIndex((L) => !L.down && Math.abs(L.x - c.x) < 1.4);
        if (i >= 0) { this.arena.hitLetter(i, 60); this.shatterProp(p, p.vel); continue; }
      }
      // Other solids (hut, masts, resting heavy props).
      for (const s of this.arena.solids()) {
        if (s.ref === p || s.kind === 'wall') continue;
        if (c.x > s.min.x - r * 0.6 && c.x < s.max.x + r * 0.6 && c.z > s.min.z - r * 0.6 && c.z < s.max.z + r * 0.6 && c.y < s.max.y && c.y > s.min.y) {
          if (s.kind === 'prop') this.shatterProp(s.ref as Prop, p.vel);
          this.shatterProp(p, p.vel);
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ main update
  update(dt: number) {
    this.tick++;
    if (this.introT > 0) this.introT--;
    for (const f of this.fighters) f.update(dt);
    // Body separation.
    const [a, b] = this.fighters;
    const solidA = a.alive && !['grabbed', 'yanked', 'finished', 'teleport', 'out'].includes(a.state);
    const solidB = b.alive && !['grabbed', 'yanked', 'finished', 'teleport', 'out'].includes(b.state);
    if (solidA && solidB && !a.grabbed && !b.grabbed) {
      const d = new THREE.Vector3(b.pos.x - a.pos.x, 0, b.pos.z - a.pos.z);
      const overlapY = a.pos.y < b.pos.y + b.def.height && b.pos.y < a.pos.y + a.def.height;
      const min = a.def.radius + b.def.radius;
      const l = d.length();
      if (overlapY && l < min) {
        if (l < 1e-3) d.set(1, 0, 0); else d.divideScalar(l);
        const push = (min - l) / 2;
        a.pos.addScaledVector(d, -push);
        b.pos.addScaledVector(d, push);
      }
    }
    this.arena.update(dt, (p, speed) => {
      // Thrown prop hits the floor.
      if (p.explosive) this.explode(p);
      else if (speed > 6) this.shatterProp(p);
      else { p.state = 'rest'; p.vel.set(0, 0, 0); }
    });
    this.updateThrownProps();
    this.updateProjectiles(dt);
    // Post-bout poses.
    if (this.ended && this.tick - this.ended.tick > 70) {
      const w = this.ended.winner;
      if (w.alive && w.onGround && (w.state === 'ground' || w.state === 'idleLock')) { w.setState('victory'); this.camera.cinematic = { focus: () => w.center, yaw: w.yaw, dist: 5.5, h: 1.4, t: 0 }; }
    }
  }

  /** Inputs are ignored during the intro and after the bout ends (animations still run). */
  get inputLocked() {
    return this.introT > 0 || (!!this.ended && this.tick - this.ended.tick > 1);
  }

  get resultReady() {
    return !!this.ended && this.tick - this.ended.tick > 150;
  }

  /** Whether `f` currently has a valid X target, for on-screen feedback. */
  grabHint(f: Fighter) {
    if (!['ground', 'air', 'fly', 'guard'].includes(f.state) || f.heldProp) return null;
    return f.grabTarget();
  }

  inBounds(p: THREE.Vector3) {
    return Math.abs(p.x) <= BOUNDS.hw && Math.abs(p.z) <= BOUNDS.hd;
  }
}
