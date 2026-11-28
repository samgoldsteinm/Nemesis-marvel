import * as THREE from 'three';
import { simRng, newSeed } from './rng';
import { Fighter } from './fighter';
import { Arena, Prop, BOUNDS } from './arena';
import { FX } from './fx';
import { VersusCamera } from './camera';
import { CharacterDef, MoveDef, HitSpec } from './characters';
import { sfx } from './audio';
import type { ProjectileHandle } from './vfx';

const PROJ: Record<ProjKind, { speed: number; color: number; scale: number; trail: number; light: number }> = {
  bolt: { speed: 30, color: 0xc9a8ff, scale: 1.1, trail: 0xa070ff, light: 0xb48cff },
  bigbolt: { speed: 24, color: 0xc9a8ff, scale: 2.6, trail: 0xa070ff, light: 0xb48cff },
  snare: { speed: 22, color: 0xeaffff, scale: 1.4, trail: 0xeaffff, light: 0xeaffff },
  fireball: { speed: 20, color: 0xffa040, scale: 2.2, trail: 0xff6a1a, light: 0xff7a2a },
  rift: { speed: 26, color: 0x9dff8a, scale: 1.3, trail: 0x5aff4a, light: 0x7dff6a },
};
const FIRE_COL = new THREE.Color(0xff7a2a);

export type EndHow = 'ko' | 'ringout' | 'finisher';

export type ProjKind = 'bolt' | 'snare' | 'bigbolt' | 'fireball' | 'rift';
interface Projectile {
  kind: ProjKind;
  owner: Fighter;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  mesh: THREE.Mesh;
  alive: boolean;
  vis?: ProjectileHandle;
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
  /** Lives (stocks) per fighter: losing a K.O., ring-out or finisher costs one; the last one ends the match. */
  livesMax = 1;
  lives: [number, number] = [1, 1];
  round = 1;
  setLives(n: number) { this.livesMax = Math.max(1, Math.round(n)); this.lives = [this.livesMax, this.livesMax]; this.round = 1; }
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
    for (const m of this.mines) this.scene.remove(m.mesh);
  }

  /** Remove projectiles and mines in flight (restart, new round, online resync). */
  clearShots() {
    for (const p of this.projectiles) { p.mesh.visible = false; p.vis?.stop(false); }
    for (const m of this.mines) this.scene.remove(m.mesh);
    this.mines = [];
    this.projectiles = [];
  }

  /** Seed of the current match's gameplay RNG (the host's choice online, random offline). */
  seed = 0;
  restart(seed?: number) {
    this.seed = seed ?? newSeed();
    simRng.seed(this.seed);
    this.arena.reset();
    this.fx.clear();
    this.ended = null;
    this.resultShown = false;
    this.tick = 0;
    this.introT = 90;
    this.lives = [this.livesMax, this.livesMax];
    this.round = 1;
    this.events = [];
    for (const p of this.projectiles) { p.mesh.visible = false; p.vis?.stop(false); }
    for (const m of this.mines) this.scene.remove(m.mesh);
    this.mines = [];
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

  // ------------------------------------------------------------------ proximity mines
  mines: { pos: THREE.Vector3; owner: Fighter; t: number; mesh: THREE.Mesh }[] = [];
  dropMines(owner: Fighter) {
    const base = owner.pos.clone();
    const fwd = owner.forward;
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
    for (const off of [side.clone().multiplyScalar(-1.6), fwd.clone().multiplyScalar(-1.2), side.clone().multiplyScalar(1.6)]) {
      const p = base.clone().add(off);
      p.y = Math.max(0, this.arena.groundAt(p.x, p.z, base.y + 0.5)) + 0.08;
      if (!Number.isFinite(p.y)) continue;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.12, 12), new THREE.MeshBasicMaterial({ color: 0x37f2ff }));
      mesh.position.copy(p);
      this.scene.add(mesh);
      this.mines.push({ pos: p, owner, t: 0, mesh });
    }
    this.fx.flash(owner.center, 1.2, 0x37f2ff, 0.15);
    sfx.zap();
  }
  private updateMines(dt: number) {
    for (const m of this.mines) {
      m.t += dt;
      (m.mesh.material as THREE.MeshBasicMaterial).color.setHex(m.t > 0.6 && Math.floor(m.t * 6) % 2 ? 0xffffff : 0x37f2ff);
      const o = m.owner.opp;
      const armed = m.t > 0.6;
      const near = armed && o.alive && o.pos.distanceTo(m.pos) < 1.5 && o.state !== 'teleport';
      if (near || m.t > 9) {
        if (near || m.t > 9) {
          this.fx.flash(m.pos.clone().setY(m.pos.y + 0.5), 1.6, 0x37f2ff, 0.25);
          this.fx.ring(m.pos.clone(), 3, 0x37f2ff, 0.4);
          sfx.zap(); sfx.hit(true);
          if (this.sphereVsFighter(m.pos.clone().setY(m.pos.y + 0.5), 1.6, o)) {
            const dir = o.pos.clone().sub(m.pos).setY(0);
            if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
            o.receiveHit(m.owner, { fwd: 0, up: 0, radius: 0, stamina: 6, health: 6, kbF: 6, kbU: 9, stun: 30, launch: true, heavy: true }, dir.normalize(), { unblockable: true, source: 'mine' });
            this.log(`mine hits ${o.def.id}`);
          }
        }
        this.scene.remove(m.mesh);
        m.t = -1;
      }
    }
    this.mines = this.mines.filter((m) => m.t >= 0);
  }

  spawnProjectile(owner: Fighter, kind: ProjKind, angle = 0, from?: THREE.Vector3, dirOverride?: THREE.Vector3) {
    const mesh = this.projPool.find((m) => !m.visible);
    if (!mesh) return;
    const o = owner.opp;
    const origin = from ? from.clone() : owner.handSim();
    const aim = o.center.sub(origin);
    const dir = dirOverride ? dirOverride.clone().normalize()
      : aim.lengthSq() > 0 && aim.clone().setY(0).normalize().dot(owner.forward) > 0.5 ? aim.normalize() : owner.forward.clone().setY(0);
    if (angle) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    const speed = PROJ[kind].speed;
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(PROJ[kind].color);
    mesh.scale.setScalar(PROJ[kind].scale);
    mesh.visible = true;
    mesh.position.copy(origin);
    const proj: Projectile = { kind, owner, pos: origin.clone(), vel: dir.multiplyScalar(speed), life: kind === 'fireball' ? 1.6 : 1.3, mesh, alive: true };
    const vfx = this.fx.vfx;
    if (vfx) {
      // Shader projectile replaces the plain sphere; the pooled mesh only marks the slot as used.
      (mesh.material as THREE.Material).visible = false;
      const shape = kind === 'snare' ? 'javelin' : 'basic';
      const size = kind === 'bigbolt' ? 1.1 : kind === 'fireball' ? 0.9 : kind === 'snare' ? 0.55 : 0.5;
      proj.vis = vfx.projectile(shape, PROJ[kind].color, size);
      proj.vis.set(proj.pos, proj.vel);
      vfx.muzzle(origin, proj.vel.clone().normalize(), PROJ[kind].color, kind === 'bigbolt' || kind === 'fireball' ? 1.1 : 0.7);
    } else (mesh.material as THREE.Material).visible = true;
    this.projectiles.push(proj);
    if (kind !== 'snare') this.fx.light(origin, PROJ[kind].light, kind === 'bigbolt' || kind === 'fireball' ? 14 : 6, 1.2, 6, () => (proj.alive ? proj.pos : null));
    if (kind === 'rift') sfx.ability('rift', 'projectile');
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.vis?.set(p.pos, p.vel);
      if (!p.vis) this.fx.trail(p.pos, PROJ[p.kind].trail, p.kind === 'bigbolt' || p.kind === 'fireball' ? 0.25 : 0.1, 0.2);
      if (p.kind === 'fireball' && !p.vis) { p.mesh.scale.setScalar(PROJ.fireball.scale * (0.85 + Math.random() * 0.3)); this.fx.wisp(p.pos, FIRE_COL, 0.55); }
      const kill = (impact = true) => { p.alive = false; p.mesh.visible = false; p.vis?.stop(impact); p.vis = undefined; };
      if (p.life <= 0) { kill(false); continue; }
      for (const f of this.fighters) {
        if (f === p.owner || !this.sphereVsFighter(p.pos, 0.25, f)) continue;
        const dir = p.vel.clone().setY(0).normalize();
        if ((f.state === 'sblock' || (f.state === 'guard' && f.def.id === 'rift')) && f.forward.dot(dir) < 0) {
          // Super block deflects projectiles back at the shooter.
          p.vel.multiplyScalar(-1.1);
          p.owner = f;
          p.life = 1.2;
          sfx.superBlock();
          this.fx.sparksAt(p.pos, 12, f.def.id === 'rift' && f.state === 'guard' ? 0x7dff6a : 0x9ff7ff, 6);
          if (f.def.id === 'rift' && f.state === 'guard') { this.fx.ring(p.pos.clone(), 1.0, 0x7dff6a, 0.3); f.say('PORTAL GUARD'); }
          this.log(`${f.def.id} deflects ${p.kind}`);
          break;
        }
        if (p.kind === 'fireball') {
          // Burns via the owner's passive; a small blast on contact.
          f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 8, health: 9, kbF: 9, kbU: 6, stun: 30, launch: true, heavy: true }, dir, { source: 'projectile' });
          this.fx.fireball(p.pos.clone(), 1.3);
          this.fx.vfx?.explosion(p.pos.clone(), 1.4, false);
          sfx.explosion();
        } else if (p.kind === 'rift') {
          f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 4, health: 4, kbF: 5, kbU: 4, stun: 22, launch: !f.onGround }, dir, { source: 'projectile' });
          this.fx.flash(p.pos, 0.9, 0x7dff6a, 0.15);
        } else if (p.kind === 'bigbolt') {
          f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 8, health: 12, kbF: 10, kbU: 7, stun: 34, launch: true, heavy: true }, dir, { source: 'projectile' });
          this.fx.flash(p.pos, 1.4, 0xc9a8ff, 0.2);
        } else if (p.kind === 'bolt') {
          f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 4, health: 5, kbF: 4, kbU: f.onGround ? 0 : 5, stun: 18, launch: !f.onGround }, dir, { source: 'projectile' });
        } else {
          const r = f.receiveHit(p.owner, { fwd: 0, up: 0, radius: 0, stamina: 4, health: 1, kbF: 1, kbU: 0, stun: 10 }, dir, { source: 'projectile' });
          if (r === 'hit' && f.state === 'hitstun') { f.setState('stunned'); f.stun = 55; f.snared = true; f.say('SNARED'); }
        }
        kill();
        break;
      }
      if (!p.alive) continue;
      const w = this.arena.wallAt(p.pos, 0.2);
      if (w) {
        if (p.kind === 'fireball') this.fx.fireball(p.pos.clone(), 1.2);
        if (w.damage(p.kind === 'bolt' || p.kind === 'rift' ? 12 : p.kind === 'bigbolt' || p.kind === 'fireball' ? 45 : 4, this.fx, p.vel.clone().normalize())) this.arena.spawnRubble(w.center.clone().setY(0.6).addScaledVector(w.outward, -1.2));
        this.fx.sparksAt(p.pos, 8, 0xc9a8ff, 5);
        kill();
        continue;
      }
      const g = this.arena.groundAt(p.pos.x, p.pos.z, p.pos.y, 0);
      if (p.pos.y <= g && p.kind === 'fireball') { this.fx.fireball(p.pos.clone(), 1.0); this.fx.vfx?.explosion(p.pos.clone(), 1.2, true); kill(); continue; }
      if (p.pos.y <= g) { this.fx.sparksAt(p.pos, 6, 0xc9a8ff, 4); kill(); }
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  // ------------------------------------------------------------------ props in flight
  shatterProp(p: Prop, vel?: THREE.Vector3) {
    if (p.state === 'gone') return;
    if (p.explosive) { this.explode(p); return; }
    const colors: Record<string, number> = { panel: 0xd8d2c2, crate: 0x8a6a42, letter: 0xff7060, ac: 0xa7adb5, rubble: 0x7d7f86, tank: 0xc8401c, car: 0x8a8a90, barrel: 0x2f6a9a, barrier: 0x8b8a90, wreck: 0x2a2624, cone: 0xff7a20, bin: 0x5a6a5a, pallet: 0x9a7a52, wheelie: 0x3a6a3a, barricade: 0xff8a30, mailbox: 0x2a6a3a, beams: 0x7a4a2a, lumber: 0xc89a5a, cement: 0xc8c0b0, van: 0x3a6a7a, bench: 0x5a3e28, hydrant: 0xb8241c, armchair: 0x5a3a5a, armour: 0x8a909a, cabinet: 0x4a3418, table: 0x3a2414, console: 0x2a2a36, canister: 0x5a6a5a };
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
    this.fx.fireball(c, p.kind === 'car' ? 3.6 : 3);
    this.fx.vfx?.explosion(c, p.kind === 'car' ? 3.2 : 2.6, true);
    // Aftermath: a car leaves a burning wreck that still blocks and can be thrown again.
    if (p.kind === 'car' && this.arena.inside(p.pos.x, p.pos.z) && p.pos.y > -1) {
      const w = this.arena.makeWreck();
      w.pos.set(p.pos.x, Math.max(0, p.pos.y), p.pos.z);
      w.mesh.position.copy(w.pos);
      w.mesh.rotation.y = p.mesh.rotation.y;
      w.state = 'falling';
      this.arena.props.push(w);
      this.arena.dyn.add(w.mesh);
      this.fx.burners.push({ p: w.pos, t: 9, size: 1.1 });
    }
    this.fx.shake = 1.2;
    sfx.explosion(p.kind === 'car' ? 1.5 : 1.2);
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
    this.updateMines(dt);
    // Lives left: after the K.O. beat, the loser drops a life and both reset for the next round.
    if (this.ended && !this.finalBout && this.tick - this.ended.tick > 150) { this.nextRound(); return; }
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
    return !!this.ended && this.finalBout && this.tick - this.ended.tick > 150;
  }

  /** True when the current end costs the loser their last life (the match is over). */
  get finalBout() {
    return !this.ended || this.lives[this.ended.loser.idx] <= 1;
  }

  /** The loser loses a life; fighters, projectiles and mines reset, the arena keeps its damage. */
  nextRound() {
    if (!this.ended) return;
    this.lives[this.ended.loser.idx]--;
    this.round++;
    this.ended = null;
    this.introT = 90;
    for (const p of this.projectiles) { p.mesh.visible = false; p.vis?.stop(false); }
    for (const m of this.mines) this.scene.remove(m.mesh);
    this.mines = [];
    this.projectiles = [];
    for (const p of this.arena.props) if (p.holder) { p.holder.heldProp = null; p.holder = null; }
    const [s0, s1] = this.arena.spawns;
    this.fighters[0].reset(s0, Math.PI / 2);
    this.fighters[1].reset(s1, -Math.PI / 2);
    this.camera.cinematic = null;
    this.camera.snapTo(this.fighters);
    this.log(`ROUND ${this.round} lives ${this.lives.join('/')}`);
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
