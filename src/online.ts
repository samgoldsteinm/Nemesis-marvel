// Online play controller: owns the NetLink, the lobby session and the lockstep, and talks to the game (main.ts)
// through a small interface so the menus and the match loop stay in main.ts.

import type { RawState } from './input';
import type { Match } from './match';
import { NetLink, netlog, newRoomCode } from './net';
import { Lockstep, OnlineSession, MatchCfg } from './netplay';
import { playerName } from './profile';

export interface OnlineGame {
  /** Show a menu screen by name ('online' | 'select' | 'title' | 'none' | …). */
  show(screen: string): void;
  rerender(): void;
  toast(msg: string): void;
  /** Build the match for this config (seeded, fighters, arena, lives), without the intro yet. */
  startMatch(cfg: MatchCfg): void;
  /** Compile shaders / fetch voice clips for the built match without blocking (resolves when done). */
  warmup(): Promise<void>;
  /** Start the fight intro now; false if intros are off (then this side is ready at once). */
  playIntro(): boolean;
  /** End the local intro early (the opponent is already waiting). */
  cutIntro(): void;
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

export type OnlinePhase = 'idle' | 'connecting' | 'lobby' | 'loading' | 'intro' | 'fight' | 'over';

/** Once the opponent is ready, our own intro may run at most this much longer before it is cut. */
const INTRO_GRACE_MS = 2000;

export class Online {
  phase: OnlinePhase = 'idle';
  link: NetLink | null = null;
  session: OnlineSession | null = null;
  lock: Lockstep | null = null;
  code = '';
  error = '';
  /** performance.now() when the current wait (loading / opponent) began; 0 = not waiting. */
  private waitSince = 0;
  private waitKey = '';
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
    s.me.name = playerName;
    this.session = s;
    s.onChange = () => this.g.rerender();
    s.onStart = (cfg) => this.beginMatch(cfg);
    s.onBothLoaded = () => this.beginIntro();
    s.onBothReady = () => this.beginFight();
    s.onLobby = () => this.backToLobby();
    link.onOpen(() => { this.phase = 'lobby'; this.g.show('select'); });
    link.onClose(() => {
      const why = link.why || 'Disconnected.';
      const wasPlaying = this.phase === 'fight' || this.phase === 'intro' || this.phase === 'over' || this.phase === 'loading';
      this.close(false);
      this.error = why;
      if (wasPlaying) this.g.leave();
      this.g.toast(why === 'Opponent left.' ? 'Your opponent left the match' : why);
      this.g.show('online');
    });
    this.g.show('online');
  }

  private beginMatch(cfg: MatchCfg) {
    this.phase = 'loading';
    this.lock?.dispose();
    this.lock = null;
    const t = performance.now();
    this.g.startMatch(cfg);
    netlog(`match built in ${Math.round(performance.now() - t)} ms (arena ${cfg.arena}, delay ${cfg.delay})`);
    const s = this.session, seed = cfg.seed;
    const t2 = performance.now();
    void this.g.warmup().catch(() => {}).then(() => {
      if (this.session !== s || s?.cfg?.seed !== seed || this.phase !== 'loading') return;
      netlog(`warm-up done in ${Math.round(performance.now() - t2)} ms, loaded sent`);
      s.loaded();
    });
  }
  /** Both sides loaded: intros start together (within one-way latency). */
  private beginIntro() {
    if (this.phase !== 'loading') return;
    this.phase = 'intro';
    netlog('both loaded, intro starts');
    if (!this.g.playIntro()) this.introDone();
  }
  /** Called by the game when this side's intro has finished (or was skipped). */
  introDone() { if (this.phase === 'intro' && this.session && !this.session.readyMine) { netlog('intro done, ready sent'); this.session.ready(); } }
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
    netlog('fight starts (lockstep running)');
    this.g.onFight();
  }
  /** Both players back on fighter select, still connected (from the results or pause menu). */
  private backToLobby() {
    this.lock?.dispose(); this.lock = null;
    this.phase = 'lobby';
    netlog('back to fighter select');
    this.g.leave();
    this.g.show('select');
  }
  /** Ask both sides to go back to fighter select. */
  changeFighters() { this.session?.toLobby(); }
  /** The match is paused because one side has its pause menu open (only during the fight). */
  get paused() { const s = this.session; return this.phase === 'fight' && !!s && (s.pausedMine || s.pausedTheirs); }
  get pausedByThem() { return this.phase === 'fight' && !!this.session?.pausedTheirs; }
  private wasPaused = false;
  setPaused(on: boolean) { this.session?.setPaused(on); }
  /** Each animation frame while online. */
  pump(dtMs: number) {
    const s = this.session;
    const p = this.paused;
    if (p !== this.wasPaused) { this.wasPaused = p; netlog(p ? 'paused' : 'resumed'); if (!p) this.lock?.resume(); }
    if (p) return;
    // Opponent already through the intro: don't make them sit through the rest of ours.
    if (this.phase === 'intro' && s && !s.readyMine && s.readyTheirsAt && performance.now() - s.readyTheirsAt > INTRO_GRACE_MS) {
      netlog('opponent waiting, cutting intro short');
      this.g.cutIntro();
      this.introDone();
    }
    if (this.phase === 'fight' || this.phase === 'over') this.lock?.pump(dtMs, () => this.g.sample());
    const m = this.g.match();
    if (this.phase === 'fight' && m?.resultReady) this.phase = 'over';
  }
  /**
   * What the player is waiting for right now (null = nothing): drives the start-up overlay. `long` is true once
   * the wait has gone on long enough to offer Retry / Leave.
   */
  get wait(): { text: string; sub: string; long: boolean; secs: number } | null {
    const s = this.session;
    let text = '', sub = '';
    if (this.phase === 'loading') {
      if (!s?.loadedMine) { text = 'Loading arena…'; sub = 'Preparing fighters and effects'; }
      else { text = 'Waiting for opponent…'; sub = 'They are still loading the arena'; }
    } else if (this.phase === 'intro' && s?.readyMine && !s.readyTheirs) { text = 'Waiting for opponent…'; sub = 'They are finishing the intro'; }
    else if (this.pausedByThem && !this.session?.pausedMine) { text = 'Paused'; sub = 'Your opponent opened the pause menu'; }
    else if (this.phase === 'fight' && !this.paused && this.lock?.waiting) { text = 'Waiting for opponent…'; sub = this.connected ? 'Their inputs are late (connection hiccup)' : 'Reconnecting…'; }
    const key = text && this.phase + text;
    if (key !== this.waitKey) { this.waitKey = key; this.waitSince = key ? performance.now() : 0; }
    if (!text) return null;
    const secs = (performance.now() - this.waitSince) / 1000;
    return { text, sub, long: secs > 10 && text !== 'Paused', secs };
  }
  /** Retry button: re-send this side's start-up messages and restart the wait timer. */
  retry() { netlog('retry pressed'); this.session?.resendStage(); this.waitSince = performance.now(); }
  /** Opponent is through the intro and waiting on us (prompt to skip). */
  get opponentWaiting() { return this.phase === 'intro' && !!this.session?.readyTheirs && !this.session.readyMine; }
  /** Opponent's name ('' until they send one). */
  get theirName() { return this.session?.them.name || ''; }
  rematch() { this.session?.rematch(); }
  /** Leave online play entirely. */
  close(tell = true) {
    if (this.link) { if (tell) this.link.close(); }
    this.lock?.dispose();
    this.link = null; this.session = null; this.lock = null;
    this.phase = 'idle';
  }
}
