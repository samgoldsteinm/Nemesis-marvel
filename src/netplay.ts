// Online 1v1: deterministic input lockstep on top of a NetLink (src/net.ts).
//
// Both machines run the same fixed-60 Hz simulation from the same seed and feed it the same inputs:
//  * Each tick a player samples their input for tick t+delay (input delay hides the network round trip) and sends
//    it, together with every not-yet-acknowledged frame (redundancy: a lost packet is covered by the next one).
//  * Tick t is simulated only once both players' frames for t are known. If the other side is late the game stalls
//    (and shows "Waiting…") rather than guessing — no rollback, no desync by design.
//  * Inputs are quantised before use on BOTH sides (stick to 1/100, 6 action bits) so local and remote see the
//    exact same values, and the stick is expressed in a fixed world frame (not the player's camera).
//  * Safety net: every 60 ticks the host sends a checksum of the gameplay state. On mismatch the guest asks for a
//    snapshot of the host's state, applies it and re-simulates the ticks since, from its input history.
//
// Snapshot contents (see snapshot()/applySnapshot()): every fighter's own primitive/vector fields (position,
// velocity, yaw, state/timers, health, stamina, energy, rage, statuses, current move, grab/held references…), every
// prop (position, velocity, spin, state, holder, uses, power, life), every wall segment (hp, broken), match timers
// (tick, introT, ended, lives, round) and the gameplay RNG state. Not included: projectiles and mines in flight
// (cleared on resync — rare) and anything visual.

import * as THREE from 'three';
import type { Match } from './match';
import type { Fighter } from './fighter';
import type { Prop } from './arena';
import { ACTIONS, emptyRaw, RawState } from './input';
import { simRng } from './rng';
import { netlog } from './net';
import type { NetLink, NetMsg, Role } from './net';

export const TICK_MS = 1000 / 60;

// ------------------------------------------------------------------ input frames
/** [stickX*100, stickY*100, action bits] — bit i = ACTIONS[i]. */
export type Frame = [number, number, number];
export const NEUTRAL: Frame = [0, 0, 0];
export function encodeRaw(r: RawState): Frame {
  let bits = 0;
  ACTIONS.forEach((a, i) => { if (r.down[a]) bits |= 1 << i; });
  const q = (v: number) => Math.max(-100, Math.min(100, Math.round(v * 100)));
  return [q(r.mx), q(r.my), bits];
}
export function decodeRaw(f: Frame): RawState {
  const r = emptyRaw();
  r.mx = f[0] / 100; r.my = f[1] / 100;
  ACTIONS.forEach((a, i) => { r.down[a] = !!(f[2] & (1 << i)); });
  return r;
}
/** Canonical world frame for online sticks (both machines use it as the match's camera basis). */
export const CANON = { fwd: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
/** Re-express a stick read relative to the local camera in the canonical frame. */
export function toCanonical(r: RawState, camFwd: THREE.Vector3, camRight: THREE.Vector3): RawState {
  const wx = camRight.x * r.mx + camFwd.x * r.my, wz = camRight.z * r.mx + camFwd.z * r.my;
  const out = { ...r, down: { ...r.down } };
  out.mx = wx * CANON.right.x + wz * CANON.right.z;
  out.my = wx * CANON.fwd.x + wz * CANON.fwd.z;
  const l = Math.hypot(out.mx, out.my);
  if (l > 1) { out.mx /= l; out.my /= l; }
  return out;
}

// ------------------------------------------------------------------ checksum & snapshot
const r3 = (v: number) => Math.round(v * 1000);
export function checksum(m: Match): number {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => { h ^= v & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; };
  for (const f of m.fighters) {
    mix(r3(f.pos.x)); mix(r3(f.pos.y)); mix(r3(f.pos.z)); mix(r3(f.vel.x)); mix(r3(f.vel.z)); mix(r3(f.yaw));
    mix(r3(f.health)); mix(r3(f.stamina)); mix(r3(f.energy)); mix(r3(f.rage)); mix(f.t);
    for (let i = 0; i < f.state.length; i++) mix(f.state.charCodeAt(i));
  }
  for (const p of m.arena.props) { mix(r3(p.pos.x)); mix(r3(p.pos.y)); mix(r3(p.pos.z)); }
  for (const w of m.arena.walls) mix(w.broken ? 1 : 0);
  mix(m.tick); mix(simRng.state);
  return h >>> 0;
}

type Enc = unknown;
interface Ctx { m: Match; fighters: Fighter[]; props: Prop[] }
function isV3(v: unknown): v is THREE.Vector3 { return !!v && (v as THREE.Vector3).isVector3 === true; }
function plainObj(v: unknown) { return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype; }
const FIGHTER_SKIP = new Set(['match', 'def', 'rig', 'skinned', 'input', 'statusFx']);
function enc(v: unknown, c: Ctx, depth = 0): Enc | undefined {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v === undefined ? { u: 1 } : v;
  if (depth > 4) return undefined;
  if (isV3(v)) return { v3: [v.x, v.y, v.z] };
  const fi = c.fighters.indexOf(v as Fighter); if (fi >= 0) return { fi };
  const pi = c.props.indexOf(v as Prop); if (pi >= 0) return { pr: pi };
  if (v && typeof v === 'object' && 'startup' in v && 'active' in v && 'recovery' in v) {
    // A move: by reference into the owner's move set when possible, else its data.
    const mv = v as Record<string, unknown>;
    return { mv: mv.id, d: { ...Object.fromEntries(Object.entries(mv).filter(([, x]) => typeof x !== 'function')) } };
  }
  if (Array.isArray(v)) { const out: Enc[] = []; for (const x of v) { const e = enc(x, c, depth + 1); if (e === undefined) return undefined; out.push(e); } return out; }
  if (plainObj(v)) { const out: Record<string, Enc> = {}; for (const [k, x] of Object.entries(v as object)) { const e = enc(x, c, depth + 1); if (e === undefined) return undefined; out[k] = e; } return out; }
  if (v instanceof Set || v instanceof Map) return undefined;
  return undefined;
}
function findMove(f: Fighter, id: unknown) {
  const mv = f.def.moves as unknown as Record<string, unknown>;
  for (const k of Object.keys(mv)) {
    const v = mv[k];
    if (Array.isArray(v)) { for (const x of v) if ((x as { id: string }).id === id) return x; }
    else if ((v as { id: string }).id === id) return v;
  }
  return null;
}
function dec(e: Enc, c: Ctx, owner: Fighter | null, cur: unknown): unknown {
  if (e === null || typeof e !== 'object') return e;
  const o = e as Record<string, unknown>;
  if ('u' in o && Object.keys(o).length === 1) return undefined;
  if ('v3' in o) { const a = o.v3 as number[]; if (isV3(cur)) { cur.set(a[0], a[1], a[2]); return cur; } return new THREE.Vector3(a[0], a[1], a[2]); }
  if ('fi' in o) return c.fighters[o.fi as number];
  if ('pr' in o) return c.props[o.pr as number] ?? null;
  if ('mv' in o) {
    const ref = owner ? findMove(owner, o.mv) : null;
    if (ref) return ref;
    const d = o.d as Record<string, unknown>;
    // Ad-hoc moves (whiff grab, throw recovery…): rebuild with a neutral pose (poses are visual only).
    const pose = () => ({ j: {} });
    return { ...d, wind: pose, strike: pose };
  }
  if (Array.isArray(e)) return e.map((x, i) => dec(x, c, owner, Array.isArray(cur) ? cur[i] : undefined));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = dec(x, c, owner, cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined);
  return out;
}
function encObject(obj: object, c: Ctx, skip: Set<string>) {
  const out: Record<string, Enc> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    const e = enc(v, c);
    if (e !== undefined) out[k] = e;
  }
  return out;
}
function applyObject(obj: Record<string, unknown>, data: Record<string, Enc>, c: Ctx, owner: Fighter | null) {
  for (const [k, e] of Object.entries(data)) {
    try { obj[k] = dec(e, c, owner, obj[k]); } catch { /* read-only/getter: skip */ }
  }
}

export function snapshot(m: Match) {
  const c: Ctx = { m, fighters: m.fighters, props: m.arena.props };
  return {
    tick: m.tick,
    rng: simRng.state,
    match: { introT: m.introT, lives: [...m.lives], round: m.round, ended: m.ended ? { w: m.ended.winner.idx, l: m.ended.loser.idx, how: m.ended.how, tick: m.ended.tick } : null },
    fighters: m.fighters.map((f) => encObject(f, c, FIGHTER_SKIP)),
    props: m.arena.props.map((p) => encObject(p, c, new Set(['mesh', 'solid', 'hitIds', 'half', 'kind', 'cls', 'explosive']))),
    walls: m.arena.walls.map((w) => ({ hp: w.hp, broken: w.broken })),
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

export function applySnapshot(m: Match, s: Snapshot) {
  const c: Ctx = { m, fighters: m.fighters, props: m.arena.props };
  m.tick = s.tick;
  simRng.state = s.rng;
  m.introT = s.match.introT;
  m.lives = [s.match.lives[0], s.match.lives[1]];
  m.round = s.match.round;
  m.ended = s.match.ended ? { winner: m.fighters[s.match.ended.w], loser: m.fighters[s.match.ended.l], how: s.match.ended.how, tick: s.match.ended.tick } : null;
  s.fighters.forEach((d, i) => applyObject(m.fighters[i] as unknown as Record<string, unknown>, d, c, m.fighters[i]));
  if (s.props.length === m.arena.props.length) {
    s.props.forEach((d, i) => {
      const p = m.arena.props[i];
      applyObject(p as unknown as Record<string, unknown>, d, c, null);
      p.mesh.visible = p.state !== 'gone';
      p.mesh.position.copy(p.pos);
    });
  } else console.warn('[net] resync: prop count differs', s.props.length, m.arena.props.length);
  s.walls.forEach((w, i) => {
    const seg = m.arena.walls[i];
    if (!seg) return;
    if (w.broken && !seg.broken) seg.damage(1e6, m.fx);
    seg.hp = w.hp;
  });
  m.clearShots();
}

// ------------------------------------------------------------------ lockstep
export class Lockstep {
  /** Next tick to simulate. */
  tick = 0;
  /** Local player's side (0 = P1 / host, 1 = P2 / guest). */
  /**
   * This side's input delay in ticks. It adapts to the measured round trip (see adaptDelay): each side only
   * ever schedules its own inputs, so growing it just fills more slots ahead and shrinking it just pauses
   * production until the tick catches up; inputs already sent are never rewritten.
   */
  delay: number;
  private delayCheckAt = 0;
  private shrinkSince = 0;
  constructor(readonly side: 0 | 1, readonly link: NetLink, delay: number, readonly isHost: boolean) {
    this.delay = delay;
    for (let t = 0; t < delay; t++) { this.local.set(t, NEUTRAL); this.remote.set(t, NEUTRAL); }
    this.nextLocal = delay;
    this.off = link.on((m) => this.onMsg(m));
  }
  private off: () => void;
  /** Stop listening (a new match replaces this lockstep). */
  dispose() { this.running = false; this.off(); }
  private local = new Map<number, Frame>();
  private remote = new Map<number, Frame>();
  private nextLocal: number;
  private remoteNext = 0; // first remote tick we don't have yet (contiguous)
  private ackedByRemote = -1;
  private acc = 0;
  private lastSend = 0;
  private stallSince = 0;
  /** Input pairs of recently simulated ticks, for re-simulation after a resync. */
  private history = new Map<number, [RawState, RawState]>();
  private myHashes = new Map<number, number>();
  private hostHashes = new Map<number, number>();
  private pendingSnap: Snapshot | null = null;
  private resyncAsked = 0;
  desyncs = 0;
  /** Set by the game: simulate one tick with these inputs (P1, P2). */
  simulate: (pair: [RawState, RawState]) => void = () => {};
  match: Match | null = null;
  running = false;

  get waiting() { return this.stallSince > 0 && performance.now() - this.stallSince > 500; }

  private onMsg(m: NetMsg) {
    if (m.k === 'in') {
      const s = m.s as number, fr = m.f as Frame[];
      fr.forEach((f, i) => { const t = s + i; if (t >= this.tick && !this.remote.has(t)) this.remote.set(t, f); });
      while (this.remote.has(this.remoteNext)) this.remoteNext++;
      this.ackedByRemote = Math.max(this.ackedByRemote, m.a as number);
    } else if (m.k === 'ck' && !this.isHost) {
      const t = m.t as number, h = m.h as number;
      const mine = this.myHashes.get(t);
      if (mine === undefined) this.hostHashes.set(t, h);
      else if (mine !== h) this.onDesync(t);
    } else if (m.k === 'rs' && this.isHost && this.match) {
      this.link.send({ k: 'sn', d: snapshot(this.match) as unknown as Record<string, unknown> });
    } else if (m.k === 'sn' && !this.isHost) {
      this.pendingSnap = m.d as unknown as Snapshot;
      this.tryApplySnap();
    }
  }
  private onDesync(t: number) {
    this.desyncs++;
    console.warn(`[net] desync at tick ${t}; requesting snapshot`);
    if (performance.now() - this.resyncAsked > 1000) { this.resyncAsked = performance.now(); this.link.send({ k: 'rs', t }); }
  }
  private tryApplySnap() {
    const s = this.pendingSnap, m = this.match;
    if (!s || !m) return;
    // Snapshot is the host's state after simulating tick s.tick-1 (m.tick counts simulated ticks).
    if (this.tick < s.tick) return; // not there yet: apply when we reach it
    this.pendingSnap = null;
    applySnapshot(m, s);
    // Re-simulate from the snapshot to where we are, with the recorded inputs.
    for (let t = s.tick; t < this.tick; t++) { const p = this.history.get(t); if (p) this.simulate(p); }
    console.warn(`[net] resynced from host snapshot @${s.tick}, re-simulated ${this.tick - s.tick} ticks`);
  }

  /** Match the input delay to the latency: one-way trip in ticks plus a margin for jitter, 2-10 ticks. */
  private adaptDelay(now: number) {
    if (now - this.delayCheckAt < 500 || !this.link.rtt) return;
    this.delayCheckAt = now;
    const target = Math.max(2, Math.min(MAX_DELAY, Math.ceil(this.link.rtt / 2 / TICK_MS) + 2));
    if (target > this.delay) { netlog(`input delay ${this.delay} → ${target} ticks (rtt ${Math.round(this.link.rtt)} ms)`); this.delay = target; this.shrinkSince = 0; }
    else if (target < this.delay - 1) {
      if (!this.shrinkSince) this.shrinkSince = now;
      else if (now - this.shrinkSince > 3000) { this.delay--; this.shrinkSince = now; netlog(`input delay → ${this.delay} ticks (rtt ${Math.round(this.link.rtt)} ms)`); }
    } else this.shrinkSince = 0;
  }
  /** Advance by real time; samples local input and simulates every tick both inputs are known for. */
  pump(dtMs: number, sample: () => RawState) {
    if (!this.running) return;
    this.adaptDelay(performance.now());
    this.acc = Math.min(this.acc + dtMs, 250);
    while (this.acc >= TICK_MS) {
      // Keep the local input queue full (tick+delay). Producing only one per loop pass meant a side that had been
      // stalled could only catch up one tick per animation frame (seconds on a slow phone).
      if (this.nextLocal <= this.tick + this.delay) { const f = encodeRaw(sample()); while (this.nextLocal <= this.tick + this.delay) { this.local.set(this.nextLocal, f); this.nextLocal++; } }
      const a = this.local.get(this.tick), b = this.remote.get(this.tick);
      if (!a || !b) { if (!this.stallSince) this.stallSince = performance.now(); this.acc = Math.min(this.acc, TICK_MS * 2); break; }
      if (this.stallSince) { const ms = performance.now() - this.stallSince; if (ms > 300) netlog(`stalled ${Math.round(ms)} ms at tick ${this.tick} waiting for ${a ? 'opponent' : 'local'} input`); }
      this.stallSince = 0;
      if (this.tick === 0) netlog('first tick simulated');
      const mine = decodeRaw(a), theirs = decodeRaw(b);
      const pair: [RawState, RawState] = this.side === 0 ? [mine, theirs] : [theirs, mine];
      this.history.set(this.tick, pair);
      this.history.delete(this.tick - 240);
      this.local.delete(this.tick - 60); this.remote.delete(this.tick - 60);
      this.simulate(pair);
      this.tick++;
      this.afterTick();
      this.acc -= TICK_MS;
    }
    const now = performance.now();
    if (now - this.lastSend > 15 || this.nextLocal - 1 > this.ackedByRemote) this.sendInputs(now);
  }
  private sendInputs(now: number) {
    const from = Math.max(this.ackedByRemote + 1, this.nextLocal - 30, 0);
    const f: Frame[] = [];
    for (let t = from; t < this.nextLocal; t++) f.push(this.local.get(t) ?? NEUTRAL);
    this.link.sendFast({ k: 'in', s: from, f, a: this.remoteNext - 1 });
    this.lastSend = now;
  }
  private afterTick() {
    const m = this.match;
    if (!m) return;
    const t = this.tick;
    if (t % 60 === 0) {
      const h = checksum(m);
      if (this.isHost) this.link.send({ k: 'ck', t, h });
      else {
        this.myHashes.set(t, h); this.myHashes.delete(t - 600);
        const host = this.hostHashes.get(t);
        if (host !== undefined) { this.hostHashes.delete(t); if (host !== h) this.onDesync(t); }
      }
    }
    if (this.pendingSnap) this.tryApplySnap();
  }
}

/** Starting input delay from round-trip time: ~half the RTT in ticks plus one, between 2 and 6 (then adapts, up to MAX_DELAY). */
export function delayFor(rttMs: number) { return Math.max(2, Math.min(6, Math.ceil(rttMs / 2 / TICK_MS) + 1)); }
const MAX_DELAY = 10;

// ------------------------------------------------------------------ lobby session
export interface SideState { pick: string; locked: boolean }
export interface MatchCfg { seed: number; p1: string; p2: string; arena: string; lives: number; delay: number }
/**
 * Lobby protocol (all reliable + ordered, see NetLink.send): 'pick' {pick, locked} from either side; 'cfg'
 * {arena, lives} from the host; 'start' {cfg} from the host when it confirms the arena (both locked in);
 * 'loaded' {seed} once a side has built the match and compiled its shaders (both intros start when both are
 * loaded); 'ready' {seed} when a side's intro is over (the simulation starts when both are ready); 'rematch'.
 * Plus the lockstep's 'in' (fast) and 'ck'/'rs'/'sn'.
 */
export class OnlineSession {
  me: SideState = { pick: 'tether', locked: false };
  them: SideState = { pick: 'basalt', locked: false };
  arena = 'rooftop';
  lives = 1;
  cfg: MatchCfg | null = null;
  readyMine = false;
  readyTheirs = false;
  loadedMine = false;
  loadedTheirs = false;
  /** performance.now() when the opponent reported ready (0 = not yet). */
  readyTheirsAt = 0;
  onBothLoaded: () => void = () => {};
  rematchMine = false;
  rematchTheirs = false;
  onChange: () => void = () => {};
  onStart: (cfg: MatchCfg) => void = () => {};
  onBothReady: () => void = () => {};
  constructor(readonly link: NetLink) {
    link.on((m) => this.onMsg(m));
    link.onOpen(() => { this.sendPick(); if (this.isHost) this.sendCfg(); this.onChange(); });
  }
  get role(): Role { return this.link.role; }
  get isHost() { return this.link.role === 'host'; }
  get side(): 0 | 1 { return this.isHost ? 0 : 1; }
  private onMsg(m: NetMsg) {
    switch (m.k) {
      case 'pick': this.them = { pick: String(m.pick), locked: !!m.locked }; this.onChange(); break;
      case 'cfg': if (!this.isHost) { this.arena = String(m.arena); this.lives = Number(m.lives); this.onChange(); } break;
      case 'start': {
        if (this.isHost) break;
        const cfg = m.cfg as unknown as MatchCfg;
        if (this.cfg && this.cfg.seed === cfg.seed) { netlog('start repeated (already handled)'); this.resendStage(); break; }
        netlog('start received');
        this.cfg = cfg; this.resetStage(); this.onStart(cfg);
        break;
      }
      case 'loaded': if (this.cfg && m.seed === this.cfg.seed && !this.loadedTheirs) { netlog('opponent loaded'); this.loadedTheirs = true; this.onChange(); this.checkLoaded(); } break;
      case 'ready': if (this.cfg && m.seed === this.cfg.seed && !this.readyTheirs) { netlog('opponent ready'); this.readyTheirs = true; this.readyTheirsAt = performance.now(); this.onChange(); this.checkReady(); } break;
      case 'rematch': this.rematchTheirs = true; this.onChange(); this.maybeRematch(); break;
    }
  }
  sendPick() { this.link.send({ k: 'pick', pick: this.me.pick, locked: this.me.locked }); }
  sendCfg() { if (this.isHost) this.link.send({ k: 'cfg', arena: this.arena, lives: this.lives }); }
  setPick(id: string, locked: boolean) { this.me = { pick: id, locked }; this.sendPick(); this.onChange(); }
  setCfg(arena: string, lives: number) { this.arena = arena; this.lives = lives; this.sendCfg(); this.onChange(); }
  /** Host only: start the match on the chosen arena (after both sides locked in their fighters). */
  go() {
    if (!this.isHost || !this.me.locked || !this.them.locked || !this.link.open) return;
    this.startMatch(this.me.pick, this.them.pick);
  }
  private startMatch(p1: string, p2: string) {
    const cfg: MatchCfg = { seed: (Math.random() * 0xffffffff) >>> 0, p1, p2, arena: this.arena, lives: this.lives, delay: delayFor(this.link.rtt || 80) };
    this.cfg = cfg;
    this.resetStage();
    this.rematchMine = this.rematchTheirs = false;
    netlog('start sent');
    this.link.send({ k: 'start', cfg: cfg as unknown as Record<string, unknown> });
    this.onStart(cfg);
  }
  private resetStage() { this.loadedMine = this.loadedTheirs = this.readyMine = this.readyTheirs = false; this.readyTheirsAt = 0; }
  /** This side built the match and warmed its shaders: both intros start once both are loaded. */
  loaded() { if (!this.cfg || this.loadedMine) return; this.loadedMine = true; this.link.send({ k: 'loaded', seed: this.cfg.seed }); this.checkLoaded(); }
  private checkLoaded() { if (this.loadedMine && this.loadedTheirs) this.onBothLoaded(); }
  /** This side's intro is over: the fight starts when both are. */
  ready() { if (!this.cfg || this.readyMine) return; this.readyMine = true; this.link.send({ k: 'ready', seed: this.cfg.seed }); this.checkReady(); }
  private checkReady() { if (this.readyMine && this.readyTheirs) this.onBothReady(); }
  /** Retry button / duplicate start: send this side's start-up messages again (all idempotent). */
  resendStage() {
    if (!this.cfg) return;
    if (this.isHost) this.link.send({ k: 'start', cfg: this.cfg as unknown as Record<string, unknown> });
    if (this.loadedMine) this.link.send({ k: 'loaded', seed: this.cfg.seed });
    if (this.readyMine) this.link.send({ k: 'ready', seed: this.cfg.seed });
  }
  rematch() { this.rematchMine = true; this.link.send({ k: 'rematch' }); this.onChange(); this.maybeRematch(); }
  private maybeRematch() {
    if (!this.rematchMine || !this.rematchTheirs) return;
    this.rematchMine = this.rematchTheirs = false;
    if (this.isHost && this.cfg) this.startMatch(this.cfg.p1, this.cfg.p2);
  }
}
