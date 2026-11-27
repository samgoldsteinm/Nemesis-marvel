// Online play controller: owns the NetLink, the lobby session and the lockstep, and talks to the game (main.ts)
// through a small interface so the menus and the match loop stay in main.ts.

import type { RawState } from './input';
import type { Match } from './match';
import { NetLink, newRoomCode } from './net';
import { Lockstep, OnlineSession, MatchCfg } from './netplay';

export interface OnlineGame {
  /** Show a menu screen by name ('online' | 'select' | 'title' | 'none' | …). */
  show(screen: string): void;
  rerender(): void;
  toast(msg: string): void;
  /** Build the match for this config (seeded, fighters, arena, lives) and play the intro; call ready() when done. */
  startMatch(cfg: MatchCfg): void;
  match(): Match | null;
  /** Simulate one tick with these inputs (P1, P2), canonical stick frame. */
  simulate(pair: [RawState, RawState]): void;
  /** Local player's raw input for this tick, stick already in the canonical frame. */
  sample(): RawState;
  /** The synced fight is starting (reset input edge trackers, close menus). */
  onFight(): void;
  /** Leave the match (back to menus, clean up). */
  leave(): void;
}

export type OnlinePhase = 'idle' | 'connecting' | 'lobby' | 'intro' | 'fight' | 'over';

export class Online {
  phase: OnlinePhase = 'idle';
  link: NetLink | null = null;
  session: OnlineSession | null = null;
  lock: Lockstep | null = null;
  code = '';
  error = '';
  constructor(private g: OnlineGame) {}

  get active() { return this.phase !== 'idle'; }
  get isHost() { return this.link?.role === 'host'; }
  get side(): 0 | 1 { return this.isHost ? 0 : 1; }
  get ping() { return Math.round(this.link?.rtt ?? 0); }
  get direct() { return !!this.link?.direct; }
  get waiting() { return !!this.lock?.waiting; }
  get connected() { return !!this.link?.open && !this.link.closed; }

  host() { this.open('host', newRoomCode()); }
  join(code: string) {
    const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) { this.g.toast('Enter the room code'); return; }
    this.open('guest', c);
  }
  /** Shareable link that opens the game straight into this room. */
  get shareUrl() { const u = new URL(location.href); u.search = ''; u.searchParams.set('room', this.code); if (new URLSearchParams(location.search).get('net') === 'local') u.searchParams.set('net', 'local'); return u.toString(); }

  private open(role: 'host' | 'guest', code: string) {
    this.close(false);
    this.code = code;
    this.error = '';
    this.phase = 'connecting';
    const link = new NetLink(role, code);
    this.link = link;
    const s = new OnlineSession(link);
    this.session = s;
    s.onChange = () => this.g.rerender();
    s.onStart = (cfg) => this.beginMatch(cfg);
    s.onBothReady = () => this.beginFight();
    link.onOpen(() => { this.phase = 'lobby'; this.g.show('select'); });
    link.onClose(() => {
      const why = link.why || 'Disconnected.';
      const wasPlaying = this.phase === 'fight' || this.phase === 'intro' || this.phase === 'over';
      this.close(false);
      this.error = why;
      if (wasPlaying) this.g.leave();
      this.g.toast(why === 'Opponent left.' ? 'Your opponent left the match' : why);
      this.g.show('online');
    });
    this.g.show('online');
  }

  private beginMatch(cfg: MatchCfg) {
    this.phase = 'intro';
    this.lock?.dispose();
    this.lock = null;
    this.g.startMatch(cfg);
  }
  /** Called by the game when this side's intro has finished (or was skipped). */
  introDone() { if (this.phase === 'intro' && this.session && !this.session.readyMine) this.session.ready(); }
  private beginFight() {
    const m = this.g.match(), s = this.session, link = this.link;
    if (!m || !s || !link || !s.cfg) return;
    // Fresh, seeded start on both machines: whatever the intro did locally is discarded.
    m.restart(s.cfg.seed);
    m.setLives(s.cfg.lives);
    const lock = new Lockstep(this.side, link, s.cfg.delay, this.isHost);
    lock.match = m;
    lock.simulate = (pair) => this.g.simulate(pair);
    lock.running = true;
    this.lock = lock;
    this.phase = 'fight';
    this.g.onFight();
  }
  /** Each animation frame while online. */
  pump(dtMs: number) {
    if (this.phase === 'fight' || this.phase === 'over') this.lock?.pump(dtMs, () => this.g.sample());
    const m = this.g.match();
    if (this.phase === 'fight' && m?.resultReady) this.phase = 'over';
  }
  rematch() { this.session?.rematch(); }
  /** Leave online play entirely. */
  close(tell = true) {
    if (this.link) { if (tell) this.link.close(); }
    this.lock?.dispose();
    this.link = null; this.session = null; this.lock = null;
    this.phase = 'idle';
  }
}
