// Friends list + presence, on the same free relay as online play (public MQTT brokers; ?net=local = tab bus).
//
// * Every device has a permanent friend code (8 letters/digits, `bl.fid`); its topic is `breakline/v1/p/<CODE>`.
// * Friends are stored on this device (`bl.friends`: code + last known name). Adding someone sends them an
//   "added you" note so they can add you back with one tap.
// * Presence: while the game is open we publish {n, s} (name, status: menu | room | match) on our own topic every
//   HEARTBEAT ms and whenever the status changes; a friend counts as offline after STALE ms of silence (QoS 0, no
//   retained messages or last-will, so silence is the signal). On start we publish a query on each friend's topic;
//   anyone online answers at once, so the list fills in seconds instead of waiting for the next heartbeat.
// * Invite: {inv: roomCode} on the friend's topic; the game shows a Join banner. Only codes in your list can invite.
// * Privacy: anyone who knows your code can see when you are online (like a gamer tag). Nothing else is exposed.

import { openBus, NET_NS, randId } from './net';
import type { Bus } from './net';
import { cleanName } from './profile';

const HEARTBEAT = 20000;
const STALE = 50000;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type FriendStatus = 'menu' | 'room' | 'match' | 'off';
export interface Friend { id: string; name: string; status: FriendStatus; seen: number }
export interface Invite { from: string; name: string; code: string }

export function cleanCode(v: string) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
export function fmtCode(c: string) { return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c; }

// Tests (?net=local&fid=XXXXXXXX): two tabs share localStorage, so each tab gets its own code and list key.
const TEST_FID = (() => { try { const q = new URLSearchParams(location.search); return q.get('net') === 'local' ? cleanCode(q.get('fid') || '') : ''; } catch { return ''; } })();
const LIST_KEY = 'bl.friends' + (TEST_FID ? '.' + TEST_FID : '');
function loadId(): string {
  if (TEST_FID.length === 8) return TEST_FID;
  try {
    const v = cleanCode(localStorage.getItem('bl.fid') || '');
    if (v.length === 8) return v;
    let s = ''; for (let i = 0; i < 8; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
    localStorage.setItem('bl.fid', s);
    return s;
  } catch { let s = ''; for (let i = 0; i < 8; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0]; return s; }
}

export class Friends {
  readonly id = loadId();
  list: Friend[] = [];
  private bus: Bus | null = null;
  private status: FriendStatus = 'menu';
  private name = '';
  private hbT = 0;
  private tickT = 0;
  /** Presence or the list changed (refresh the friends screen). */
  onChange: () => void = () => {};
  /** A friend invited us to their room. */
  onInvite: (inv: Invite) => void = () => {};
  /** Someone not in our list added us. */
  onAdded: (id: string, name: string) => void = () => {};

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIST_KEY) || '[]') as { id: string; name: string }[];
      this.list = raw.filter((f) => cleanCode(f.id).length === 8).map((f) => ({ id: cleanCode(f.id), name: cleanName(f.name), status: 'off' as FriendStatus, seen: 0 }));
    } catch { /* none */ }
  }
  private save() { try { localStorage.setItem(LIST_KEY, JSON.stringify(this.list.map((f) => ({ id: f.id, name: f.name })))); } catch { /* */ } }
  private topic(id: string) { return NET_NS + 'p/' + id; }
  private send(to: string, m: Record<string, unknown>) { this.bus?.pub(this.topic(to), JSON.stringify({ ...m, f: this.id })); }
  get started() { return !!this.bus; }

  /** Connect to the relay and start announcing ourselves (after Press Start). */
  start(name: string) {
    if (this.bus) return;
    this.name = name;
    this.bus = openBus('fr-' + randId(6), (t, p) => this.onMsg(t, p));
    this.bus.sub(this.topic(this.id));
    for (const f of this.list) this.bus.sub(this.topic(f.id));
    // The brokers take a moment to connect: announce + ask a few times early on, then settle into the heartbeat.
    for (const ms of [800, 2500, 6000]) setTimeout(() => { this.announce(); this.query(); }, ms);
    this.hbT = window.setInterval(() => this.announce(), HEARTBEAT);
    this.tickT = window.setInterval(() => this.expire(), 5000);
    const bye = () => { if (document.visibilityState === 'hidden') this.announce('off'); else { this.announce(); this.query(); } };
    document.addEventListener('visibilitychange', bye);
    addEventListener('pagehide', () => this.announce('off'));
  }
  setName(n: string) { this.name = n; this.announce(); }
  setStatus(s: FriendStatus) { if (s === this.status) return; this.status = s; this.announce(); }
  private announce(s: FriendStatus = this.status) { if (this.bus) this.bus.pub(this.topic(this.id), JSON.stringify({ f: this.id, n: this.name, s, t: Date.now() })); }
  private query() { for (const f of this.list) this.send(f.id, { q: 1 }); }

  private onMsg(topic: string, payload: string) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(payload); } catch { return; }
    const from = cleanCode(String(m.f || ''));
    if (from.length !== 8 || from === this.id) return;
    const mine = topic === this.topic(this.id);
    if (mine) {
      // Messages addressed to us: a presence query, an invite or an "added you" note.
      if (m.q) { this.announce(); return; }
      const fr = this.list.find((x) => x.id === from);
      if (typeof m.inv === 'string') { if (fr) this.onInvite({ from, name: fr.name || fmtCode(from), code: String(m.inv).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }); return; }
      if (m.add) { if (fr) { this.mark(fr, 'menu', m.n); } else this.onAdded(from, cleanName(m.n)); }
      return;
    }
    // A friend's own topic: their presence.
    const fr = this.list.find((x) => topic === this.topic(x.id) && x.id === from);
    if (!fr || typeof m.s !== 'string') return;
    this.mark(fr, (['menu', 'room', 'match', 'off'].includes(m.s) ? m.s : 'menu') as FriendStatus, m.n);
  }
  private mark(fr: Friend, s: FriendStatus, n: unknown) {
    const name = cleanName(n);
    const changed = fr.status !== s || (!!name && name !== fr.name);
    fr.status = s; fr.seen = s === 'off' ? 0 : Date.now();
    if (name && name !== fr.name) { fr.name = name; this.save(); }
    if (changed) this.onChange();
  }
  private expire() {
    let ch = false;
    for (const f of this.list) if (f.status !== 'off' && Date.now() - f.seen > STALE) { f.status = 'off'; ch = true; }
    if (ch) this.onChange();
  }

  /** Add a friend by code. Returns an error message, or '' when added. */
  add(code: string, name = ''): string {
    const id = cleanCode(code);
    if (id.length !== 8) return 'A friend code has 8 letters and numbers';
    if (id === this.id) return "That's your own code";
    if (this.list.some((f) => f.id === id)) return 'Already on your list';
    if (this.list.length >= 50) return 'Your list is full (50)';
    const f: Friend = { id, name: cleanName(name), status: 'off', seen: 0 };
    this.list.push(f);
    this.save();
    if (this.bus) { this.bus.sub(this.topic(id)); this.send(id, { add: 1, n: this.name }); this.send(id, { q: 1 }); }
    this.onChange();
    return '';
  }
  remove(id: string) { this.list = this.list.filter((f) => f.id !== id); this.save(); this.onChange(); }
  /** Invite a friend into our (hosted) room. */
  invite(id: string, roomCode: string) { this.send(id, { inv: roomCode, n: this.name }); }
  /** Online friends first, then by name. */
  sorted() {
    const rank = (s: FriendStatus) => (s === 'menu' ? 0 : s === 'room' ? 1 : s === 'match' ? 2 : 3);
    return [...this.list].sort((a, b) => rank(a.status) - rank(b.status) || (a.name || a.id).localeCompare(b.name || b.id));
  }
}
