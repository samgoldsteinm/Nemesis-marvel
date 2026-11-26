import * as THREE from 'three';
import { RawState, emptyRaw, ActionName } from './input';
import type { Fighter } from './fighter';
import type { Match } from './match';
import { BOUNDS, Prop } from './arena';
import { TUNING } from './fighter';

// CPU fighter. Perceives distance, altitude, props it can lift, open edges, danger and energy,
// then commits to short plans with a human-like reaction delay. Difficulty changes decision quality
// and reaction time rather than damage.

export type Difficulty = 'easy' | 'normal' | 'hard';
const PROFILE: Record<Difficulty, { react: number; guard: number; finisher: number; aggression: number; err: number }> = {
  easy: { react: 26, guard: 0.2, finisher: 0.4, aggression: 0.45, err: 0.35 },
  normal: { react: 15, guard: 0.45, finisher: 0.8, aggression: 0.65, err: 0.15 },
  hard: { react: 8, guard: 0.75, finisher: 1, aggression: 0.85, err: 0.04 },
};

type Plan = { name: string; until: number; move?: THREE.Vector3 | (() => THREE.Vector3 | null); press?: ActionName[]; hold?: ActionName[]; tapEvery?: number };

export class CPU {
  private plan: Plan | null = null;
  private nextThink = 0;
  private tick = 0;
  private lastPress = new Set<ActionName>();
  private projStreak = 0;
  private projCooldown = 0;
  private wantProp: Prop | null = null;
  lastPlan = '';
  private dashPending = 0;
  private lastHits = 0;
  private sinceHit = 0;
  private noPropsUntil = 0;
  private lastPos = new THREE.Vector3();
  private stuckTicks = 0;
  private detourUntil = 0;
  private detourDir = new THREE.Vector3();
  constructor(public f: Fighter, public match: Match, public diff: Difficulty = 'normal') {}

  get p() {
    return PROFILE[this.diff];
  }

  read(): RawState {
    this.tick++;
    this.sinceHit++;
    if (this.projCooldown > 0) this.projCooldown--;
    const out = emptyRaw();
    const f = this.f;
    if (this.match.inputLocked && f.state !== 'finisher') return out;

    // Reflexes that don't wait for the think cycle (still gated by reaction time via `react` chance).
    const reflex = this.reflex(out);
    if (reflex) return out;

    if (this.tick >= this.nextThink || !this.plan || this.tick > this.plan.until) {
      this.think();
      this.nextThink = this.tick + this.p.react + Math.floor(Math.random() * this.p.react * 0.6);
    }
    const plan = this.plan;
    // Unstick: if we're steering but not getting anywhere (an object in the way), detour sideways.
    if (this.tick % 15 === 0) {
      const moved = f.pos.distanceTo(this.lastPos);
      const wantsMove = !!plan?.move && f.state === 'ground';
      this.stuckTicks = wantsMove && moved < 0.25 && f.pos.distanceTo(f.opp.pos) > 1.8 ? this.stuckTicks + 15 : 0;
      this.lastPos.copy(f.pos);
      if (this.stuckTicks >= 30) {
        const to = f.opp.pos.clone().sub(f.pos).setY(0).normalize();
        this.detourDir.set(to.z, 0, -to.x).multiplyScalar(Math.random() < 0.5 ? 1 : -1).addScaledVector(to, 0.3).normalize();
        this.detourUntil = this.tick + 40;
        this.stuckTicks = 0;
      }
    }
    if (this.tick < this.detourUntil && f.state === 'ground') {
      this.stick(out, this.detourDir);
      if (this.tick % 20 === 0 && f.def.lift >= 1) out.down.grab = true; // heavies may just pick the obstacle up
      return out;
    }
    // Dash power: run in, then R+A once at speed.
    if (this.dashPending > 0 && --this.dashPending === 0 && f.onGround) { out.down.power = true; out.down.attack = true; }
    if (plan) {
      const mv = typeof plan.move === 'function' ? plan.move() : plan.move;
      if (mv) this.stick(out, mv);
      for (const a of plan.hold ?? []) out.down[a] = true;
      if (plan.tapEvery) {
        if (this.tick % plan.tapEvery === 0) for (const a of plan.press ?? []) out.down[a] = true;
      } else {
        // Press = down this tick only if it wasn't down last tick.
        for (const a of plan.press ?? []) if (!this.lastPress.has(a)) out.down[a] = true;
      }
    }
    this.lastPress = new Set((Object.keys(out.down) as ActionName[]).filter((k) => out.down[k]));
    if (plan && plan.press && !plan.tapEvery) plan.press = [];
    return out;
  }

  private stick(out: RawState, worldDir: THREE.Vector3) {
    const c = this.match.camBasis;
    const d = worldDir.clone().setY(0);
    if (d.lengthSq() < 1e-4) return;
    d.normalize();
    // Edge avoidance: never steer into an open drop unless already airborne over the roof.
    const ahead = this.f.pos.clone().addScaledVector(d, 2.2);
    if (!this.match.arena.inside(ahead.x * 1.02, ahead.z * 1.02)) {
      const toC = new THREE.Vector3(-this.f.pos.x, 0, -this.f.pos.z).normalize();
      d.lerp(toC, 0.8).normalize();
    }
    out.mx = d.dot(c.right);
    out.my = d.dot(c.fwd);
  }

  private set(name: string, dur: number, p: Partial<Plan>) {
    this.plan = { name, until: this.tick + dur, ...p };
    this.lastPlan = name;
  }

  private reflex(out: RawState): boolean {
    const f = this.f;
    const o = f.opp;
    // Recovery from a dangerous launch: L+R.
    if (f.state === 'launched' && f.t > 8 && f.hasEnergy(TUNING.recoveryCost)) {
      const future = f.pos.clone().addScaledVector(f.vel, 0.5);
      const offRoof = !this.match.arena.inside(future.x, future.z) || !this.match.arena.inside(f.pos.x, f.pos.z);
      if (offRoof && Math.random() < 1 - this.p.err) {
        out.down.mobility = true;
        out.down.power = true;
        if (this.lastPress.has('mobility') && this.lastPress.has('power')) { out.down.mobility = false; }
        this.lastPress = new Set(['power', ...(out.down.mobility ? ['mobility' as ActionName] : [])]);
        return true;
      }
    }
    // Fliers out of energy: drop down. Swingers in a recovery swing: hold L until released.
    if (f.state === 'swing' && f.recoverSwing) { out.down.mobility = true; this.lastPress = new Set(['mobility']); return true; }
    if (f.state === 'fly' && !this.match.arena.inside(f.pos.x, f.pos.z)) {
      this.stick(out, new THREE.Vector3(-f.pos.x, 0, -f.pos.z));
      return true;
    }
    if (f.state === 'down' && f.t > 15 && Math.random() < 0.1) { out.down.jump = true; return true; }
    // Incoming thrown prop: catch if able (hard AIs time it), otherwise guard.
    for (const pr of this.match.arena.props) {
      if (pr.state !== 'thrown' || pr.thrower === f) continue;
      const d = pr.pos.distanceTo(f.pos);
      const closing = pr.vel.dot(f.pos.clone().sub(pr.pos)) > 0;
      if (closing && d < 5.5 && d > 1.5 && (f.state === 'ground' || f.state === 'guard')) {
        if (Math.random() < this.p.guard * 0.15) {
          f.yaw = Math.atan2(pr.pos.x - f.pos.x, pr.pos.z - f.pos.z);
          out.down.guard = !this.lastPress.has('guard') || f.state === 'guard';
          if (f.def.lift < pr.cls && f.hasEnergy(10) && this.diff !== 'easy') out.down.power = true;
          this.lastPress = new Set((Object.keys(out.down) as ActionName[]).filter((k) => out.down[k]));
          return true;
        }
      }
    }
    // Incoming melee: guard or evade.
    if (o.state === 'attack' && o.move && o.t < o.move.startup && o.pos.distanceTo(f.pos) < 3.2 && (f.state === 'ground' || f.state === 'guard')) {
      if (f.state === 'guard' || Math.random() < this.p.guard * 0.25) {
        out.down.guard = true;
        if (f.state === 'guard' && Math.random() < 0.3 * this.p.guard) {
          const side = new THREE.Vector3(o.pos.z - f.pos.z, 0, -(o.pos.x - f.pos.x)).normalize();
          this.stick(out, side);
        }
        this.lastPress = new Set(['guard']);
        return true;
      }
    }
    if (f.state === 'evade' && o.alive && o.pos.distanceTo(f.pos) < 3 && Math.random() < this.p.guard * 0.3) { out.down.attack = !this.lastPress.has('attack'); this.lastPress = new Set(out.down.attack ? ['attack'] : []); return true; }
    if (f.state === 'grabbing') {
      // Throw toward the nearest open edge if any, else away from center.
      const edge = this.match.arena.openEdgeNear(f.pos, 10);
      const dir = edge ? edge.center.clone().sub(f.pos) : f.pos.clone().setY(0).lengthSq() > 4 ? f.pos.clone().setY(0) : f.forward;
      this.stick(out, dir);
      if (f.pummels < 2 && f.t > 7 && Math.random() < 0.5) out.down.attack = !this.lastPress.has('attack');
      else if (f.t > 14 && f.pummels >= 2) out.down.grab = !this.lastPress.has('grab');
      else if (f.t > 30) out.down.grab = !this.lastPress.has('grab');
      this.lastPress = new Set((['grab', 'attack'] as ActionName[]).filter((k) => out.down[k]));
      return true;
    }
    return false;
  }

  private think() {
    const f = this.f, o = f.opp, A = this.match.arena;
    // Anti-stall: track progress; if nothing has landed for ~10s, stop chasing props and go direct.
    if (f.stats.hits !== this.lastHits) { this.lastHits = f.stats.hits; this.sinceHit = 0; }
    const stalled = this.sinceHit > 600;
    if (stalled) this.noPropsUntil = this.tick + 300;
    const toO = o.pos.clone().sub(f.pos);
    const dist = Math.hypot(toO.x, toO.z);
    const dy = o.pos.y - f.pos.y;
    const p = this.p;
    const rnd = Math.random();
    const toward = () => o.pos.clone().sub(f.pos);
    if (!f.alive || !o.alive) { this.plan = null; return; }
    if (f.state === 'guard' && !(o.state === 'attack')) { this.set('drop-guard', 5, {}); return; }

    // 1. Finisher when available.
    if (o.danger && f.hasEnergy(TUNING.finisherCost) && rnd < p.finisher) {
      const reach = f.def.recovery === 'swing' ? 9 : f.def.radius + o.def.radius + 0.8;
      if (dist < reach && Math.abs(dy) < 1.5) { f.yaw = Math.atan2(toO.x, toO.z); this.set('finisher', 6, { hold: ['power'], press: ['grab'] }); return; }
      this.set('close-for-finisher', 20, { move: toward }); return;
    }
    // 2. Rage when ready and close.
    if (f.rage >= 100 && !f.raging && dist < 6 && f.state === 'ground') { this.set('rage', 4, { press: ['power'] }); return; }
    // 3. Holding a prop: throw it from range.
    if (f.heldProp) {
      if (dist > 3 && dist < 18 && rnd < 0.7) { f.yaw = Math.atan2(toO.x, toO.z); this.set('throw-prop', 4, { press: ['grab'] }); return; }
      this.set('carry-close', 15, { move: toward }); return;
    }
    // 4. Low energy and space: recharge (fliers land first).
    if (f.energy < 30 && !f.raging && dist > 9) {
      if (f.state === 'fly') { this.set('land', 20, { press: ['mobility'] }); return; }
      if (f.onGround) { this.set('charge', 50, { hold: ['power'] }); return; }
    }
    // 5. Stay away from open edges when the opponent is close.
    const edge = A.openEdgeNear(f.pos, 4);
    if (edge && dist < 6) { this.set('leave-edge', 18, { move: new THREE.Vector3(-f.pos.x, 0, -f.pos.z) }); return; }

    // Opponent hovering out of reach overhead: super jump into a rising attack.
    if (dy > 2.5 && dist < 6 && f.onGround && f.hasEnergy(TUNING.superJumpCost) && (stalled || rnd < 0.35)) {
      this.set('super-jump', 22, { move: toward, hold: ['power'], press: ['jump'] });
      this.dashPending = 0;
      return;
    }
    // 6. Character-specific mid-range behaviors.
    const id = f.def.id;
    if (dist > 5) {
      if (f.def.lift >= 1 && rnd < 0.65 && this.tick > this.noPropsUntil) {
        // Heavies look for something big to throw.
        const prop = this.bestProp(12);
        if (prop) {
          this.wantProp = prop;
          const dP = prop.pos.distanceTo(f.pos);
          if (dP < f.def.radius + 1.4) { f.yaw = Math.atan2(prop.pos.x - f.pos.x, prop.pos.z - f.pos.z); this.set('lift-prop', 6, { press: ['grab'] }); return; }
          this.set('go-prop', 25, { move: () => prop.state === 'rest' ? prop.pos.clone().sub(f.pos) : null }); return;
        }
      }
      if ((id === 'aerin' || id === 'magna') && this.canShoot(o)) {
        if (f.state !== 'fly' && f.energy > 45 && rnd < 0.35) { this.set('takeoff', 10, { press: ['mobility'] }); return; }
        if (f.energy > 20 && rnd < 0.6) { this.shot(); this.set('bolt', 18, { hold: ['power'], press: ['attack'] }); return; }
      }
      if (f.def.rangedGrab && dist < f.def.rangedGrab.range - 1 && rnd < 0.3 * p.aggression) { f.yaw = Math.atan2(toO.x, toO.z); this.set('ranged-pull', 8, { press: ['grab'] }); return; }
      if (id === 'tether') {
        if (dist < 10 && rnd < 0.35 * p.aggression) { f.yaw = Math.atan2(toO.x, toO.z); this.set('line-yank', 8, { press: ['grab'] }); return; }
        if (this.canShoot(o) && f.energy > 35 && rnd < 0.25) { this.shot(); this.set('snare', 14, { hold: ['power'], press: ['attack'] }); return; }
        if (rnd < 0.3) { this.set('swing-in', 40, { move: toward, hold: ['mobility'] }); return; }
      }
      if (id === 'shunt' && f.energy > 30 && rnd < 0.45) {
        // Flank: neutral L teleports behind the opponent.
        this.set('flank', 6, { press: ['mobility'] }); return;
      }
      const prop = f.def.lift === 0 && rnd < 0.25 && this.tick > this.noPropsUntil ? this.bestProp(5) : null;
      if (prop) {
        const dP = prop.pos.distanceTo(f.pos);
        if (dP < f.def.radius + 1.3) { f.yaw = Math.atan2(prop.pos.x - f.pos.x, prop.pos.z - f.pos.z); this.set('lift-light', 6, { press: ['grab'] }); return; }
        this.set('go-light', 20, { move: () => prop.state === 'rest' ? prop.pos.clone().sub(f.pos) : null }); return;
      }
      if (f.def.recovery === 'ground' && rnd < 0.4) { this.set('sprint-in', 30, { move: toward, hold: ['mobility'] }); return; }
      if (dist < 9 && f.hasEnergy(30) && rnd < 0.3 * p.aggression) { this.set('dash-power', 30, { move: toward, press: [] }); this.dashPending = 12; return; }
      this.set('approach', 25, { move: toward }); return;
    }
    // 7. Close range. Position to push them toward an open edge when possible.
    const oEdge = A.openEdgeNear(o.pos, 6);
    if (oEdge && rnd < 0.4) {
      const behind = o.pos.clone().addScaledVector(oEdge.outward, -1.8);
      if (behind.distanceTo(f.pos) > 1.2) { this.set('flank-edge', 12, { move: () => behind.clone().sub(f.pos) }); return; }
      f.yaw = Math.atan2(toO.x, toO.z);
      if (f.hasEnergy(25) && f.onGround) { this.set('power-push', 10, { hold: ['power'], press: ['attack'] }); return; }
      this.set('push-grab', 8, { press: ['grab'] }); return;
    }
    if (dist < f.def.radius + o.def.radius + 1.2 && Math.abs(dy) < 1.4) {
      if (o.state === 'down' || o.state === 'getup') { this.set('wait', 12, { move: toward().multiplyScalar(-1) }); return; }
      if (o.state === 'guard' && rnd < 0.6) { this.set('grab', 6, { press: ['grab'] }); return; }
      if (rnd < 0.12 && f.hasEnergy(20) && !o.danger) { f.yaw = Math.atan2(toO.x, toO.z); this.set('power-grapple', 6, { hold: ['power'], press: ['grab'] }); return; }
      if (rnd < 0.15 && f.hasEnergy(30) && f.onGround) { this.set('power', 14, { hold: ['power'], press: ['attack'] }); return; }
      if (rnd < 0.22 && f.hasEnergy(45) && f.onGround) { this.set('charged-power', 26, { hold: ['power', 'attack'] }); return; }
      if (rnd < 0.2) { this.set('grab', 6, { press: ['grab'] }); return; }
      if (rnd < p.aggression) { this.set('chain', 34, { press: ['attack'], tapEvery: 9 }); return; }
      this.set('guard', 16, { hold: ['guard'] }); return;
    }
    if (dy > 2 && f.onGround && rnd < 0.4) { this.set('jump-attack', 20, { move: toward, press: ['jump'] }); return; }
    this.set('close-in', 14, { move: toward });
  }

  /** Avoid repeated projectile pressure on a downed opponent; cap streaks. */
  private canShoot(o: Fighter) {
    if (this.projCooldown > 0) return false;
    if (['down', 'getup', 'launched', 'stunned'].includes(o.state)) return false;
    return true;
  }
  private shot() {
    this.projStreak++;
    if (this.projStreak >= 2) { this.projStreak = 0; this.projCooldown = 180; }
  }

  private bestProp(maxDist: number): Prop | null {
    const f = this.f;
    let best: Prop | null = null, bs = -Infinity;
    for (const p of this.match.arena.props) {
      if (p.state !== 'rest' || p.cls > f.def.lift) continue;
      const d = p.pos.distanceTo(f.pos);
      if (d > maxDist) continue;
      if (Math.abs(p.pos.x) > BOUNDS.hw - 0.5 || Math.abs(p.pos.z) > BOUNDS.hd - 0.5) continue;
      const s = p.cls * 6 + (p.explosive ? 5 : 0) - d;
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }
}
