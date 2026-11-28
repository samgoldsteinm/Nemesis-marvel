// Online transport for 1v1 matches, using only free public infrastructure (same approach as Crust Rush):
//  * Matchmaking/signalling: public MQTT brokers over secure WebSockets. Each room has one inbox topic per side,
//    `breakline/v1/r/<CODE>/h` (host) and `.../g` (guest). Every message is sent through every connected broker and
//    de-duplicated by id, so one broker going down doesn't matter.
//  * Game traffic: a direct WebRTC data channel when one can be opened (negotiated through the relay itself, no
//    signalling server). STUN from Google/Cloudflare; Metered TURN (front-end credential key) for carrier NATs.
//  * Fallback: if no direct link opens, everything keeps flowing through the MQTT relay.
//  * Tests: `?net=local` swaps the brokers for a BroadcastChannel (two tabs of the same origin), no network needed.

export type NetMsg = Record<string, unknown> & { k: string };

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const NS = 'breakline/v1/';
/** Metered TURN credentials endpoint (Crust Rush's app; front-end key that only fetches the TURN server list). */
const TURN_URL = 'https://crustrush.metered.live/api/v1/turn/credentials?apiKey=78d3e88ec5b76283810039412758f32e2c5a';
const STUN: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];

const TE = new TextEncoder(), TD = new TextDecoder();
const qs = (k: string) => { try { return new URLSearchParams(location.search).get(k); } catch { return null; } };

// ------------------------------------------------------------------ instrumentation (console + ?netdebug overlay)
const T0 = performance.now();
export const netDebug = qs('netdebug') !== null;
export const netLogLines: string[] = [];
/** Timestamped online event (seconds since page load). Always to the console; kept for the ?netdebug overlay. */
export function netlog(ev: string) {
  const line = `+${((performance.now() - T0) / 1000).toFixed(2)}s ${ev}`;
  netLogLines.push(line);
  if (netLogLines.length > 60) netLogLines.shift();
  console.info('[net] ' + line);
}
export const randId = (n = 10) => { let s = ''; for (let i = 0; i < n; i++) s += 'abcdefghijkmnpqrstuvwxyz23456789'[(Math.random() * 32) | 0]; return s; };
/** Room codes: 5 letters/digits without look-alikes. */
export const newRoomCode = () => { let s = ''; for (let i = 0; i < 5; i++) s += 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[(Math.random() * 31) | 0]; return s; };

// ------------------------------------------------------------------ minimal MQTT 3.1.1 client (QoS 0)
class Mqtt {
  ok = false;
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private pid = 1;
  private tries = 0;
  private dead = false;
  private retryT = 0;
  private lastIn = 0;
  private subs = new Set<string>();
  constructor(private url: string, private id: string, private onMsg: (topic: string, payload: string) => void) {}
  private str(s: string) { const b = TE.encode(s); const o = new Uint8Array(b.length + 2); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; }
  private raw(h: number, parts: Uint8Array[]) {
    let n = 0; for (const p of parts) n += p.length;
    const len: number[] = []; let x = n;
    do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; len.push(d); } while (x > 0);
    const o = new Uint8Array(1 + len.length + n); o[0] = h; o.set(len, 1);
    let i = 1 + len.length; for (const p of parts) { o.set(p, i); i += p.length; }
    try { if (this.ws && this.ws.readyState === 1) { this.ws.send(o); return true; } } catch { /* */ }
    return false;
  }
  connect() {
    if (this.dead) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.retry(); return; }
    this.ws = ws; this.buf = new Uint8Array(0); ws.binaryType = 'arraybuffer';
    const to = window.setTimeout(() => { try { ws.close(); } catch { /* */ } }, 9000);
    ws.onopen = () => this.raw(0x10, [Uint8Array.of(0, 4, 77, 81, 84, 84, 4, 2, 0, 30), this.str(this.id)]);
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastIn = performance.now();
      this.feed(new Uint8Array(e.data as ArrayBuffer), () => { clearTimeout(to); this.ok = true; this.tries = 0; for (const t of this.subs) this.sendSub(t); });
    };
    ws.onclose = ws.onerror = () => { clearTimeout(to); if (this.ws !== ws) return; this.ws = null; this.ok = false; this.retry(); };
  }
  private retry() { if (this.dead) return; clearTimeout(this.retryT); const w = Math.min(500 * 2 ** this.tries, 6000); this.tries++; this.retryT = window.setTimeout(() => { if (!this.ws) this.connect(); }, w); }
  private feed(chunk: Uint8Array, onAck: () => void) {
    let b = this.buf;
    if (b.length) { const n = new Uint8Array(b.length + chunk.length); n.set(b); n.set(chunk, b.length); b = n; } else b = chunk;
    let i = 0;
    for (;;) {
      if (b.length - i < 2) break;
      let len = 0, m = 1, j = i + 1, c: number;
      do { if (j >= b.length) { len = -1; break; } c = b[j++]; len += (c & 127) * m; m *= 128; } while (c & 128);
      if (len < 0 || j + len > b.length) break;
      const type = b[i] >> 4, qos = (b[i] >> 1) & 3, body = b.subarray(j, j + len);
      i = j + len;
      if (type === 2) { if (body[1] === 0) onAck(); else { this.id = 'bl-' + randId(); try { this.ws?.close(); } catch { /* */ } } }
      else if (type === 3) {
        const tl = (body[0] << 8) | body[1];
        const topic = TD.decode(body.subarray(2, 2 + tl));
        const p = 2 + tl + (qos ? 2 : 0);
        try { this.onMsg(topic, TD.decode(body.subarray(p))); } catch (e) { console.error(e); }
      }
    }
    this.buf = b.slice(i);
  }
  private sendSub(t: string) { this.pid = (this.pid % 65000) + 1; this.raw(0x82, [Uint8Array.of(this.pid >> 8, this.pid & 255), this.str(t), Uint8Array.of(0)]); }
  sub(t: string) { this.subs.add(t); if (this.ok) this.sendSub(t); }
  pub(t: string, s: string) { return this.ok && this.raw(0x30, [this.str(t), TE.encode(s)]); }
  ping() { if (this.ok) { this.raw(0xc0, []); if (performance.now() - this.lastIn > 40000) { try { this.ws?.close(); } catch { /* */ } } } else if (!this.ws) this.connect(); }
  close() { this.dead = true; clearTimeout(this.retryT); if (this.ws) { try { this.raw(0xe0, []); this.ws.close(); } catch { /* */ } } this.ws = null; this.ok = false; }
}

// ------------------------------------------------------------------ relay bus (topics): MQTT brokers or a BroadcastChannel
interface Bus { sub(topic: string): void; pub(topic: string, payload: string): void; readonly up: boolean; close(): void }

class MqttBus implements Bus {
  private cl: Mqtt[];
  private pingT: number;
  constructor(id: string, onMsg: (topic: string, payload: string) => void) {
    this.cl = BROKERS.map((u) => new Mqtt(u, 'bl-' + id + '-' + randId(4), onMsg));
    for (const c of this.cl) c.connect();
    this.pingT = window.setInterval(() => { for (const c of this.cl) c.ping(); }, 15000);
  }
  get up() { return this.cl.some((c) => c.ok); }
  sub(t: string) { for (const c of this.cl) c.sub(t); }
  pub(t: string, s: string) { for (const c of this.cl) c.pub(t, s); }
  close() { clearInterval(this.pingT); for (const c of this.cl) c.close(); }
}

/**
 * Test bus: BroadcastChannel between tabs. `?netlag=ms` adds one-way latency (±25% jitter, so messages can
 * reorder like they do across brokers) and `?netloss=0.1` drops that fraction of messages, both on send.
 */
class LocalBus implements Bus {
  private bc = new BroadcastChannel('breakline-net');
  private subs = new Set<string>();
  private lag = Number(qs('netlag')) || 0;
  private loss = Number(qs('netloss')) || 0;
  up = true;
  constructor(onMsg: (topic: string, payload: string) => void) {
    this.bc.onmessage = (e) => { const { t, s } = e.data as { t: string; s: string }; if (this.subs.has(t)) onMsg(t, s); };
  }
  sub(t: string) { this.subs.add(t); }
  pub(t: string, s: string) {
    if (this.loss && Math.random() < this.loss) return;
    if (!this.lag) { this.bc.postMessage({ t, s }); return; }
    setTimeout(() => { try { this.bc.postMessage({ t, s }); } catch { /* closed */ } }, this.lag * (0.75 + Math.random() * 0.5));
  }
  close() { this.bc.close(); }
}

/** Silence before a link counts as lost (ms). Tests on slow machines can raise it with ?nettimeout=. */
const LOST_MS = Number(qs('nettimeout')) || 20000;
const useLocal = () => qs('net') === 'local';

// ------------------------------------------------------------------ TURN credentials (cached)
let turnCache: RTCIceServer[] | null = null, turnAt = 0;
async function iceServers(): Promise<RTCIceServer[]> {
  if (turnCache && performance.now() - turnAt < 20 * 60000) return STUN.concat(turnCache);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(TURN_URL, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) { turnCache = j as RTCIceServer[]; turnAt = performance.now(); } }
  } catch { /* STUN only */ }
  return STUN.concat(turnCache ?? []);
}

// ------------------------------------------------------------------ the link to the other player
type Handler = (m: NetMsg) => void;
export type Role = 'host' | 'guest';

/**
 * One connection to the opponent. `send` is reliable+ordered (control); `sendFast` may drop (inputs carry their own
 * redundancy). Uses the direct WebRTC channels when open, else the relay.
 */
export class NetLink {
  readonly id = randId();
  peer = '';
  open = false;
  closed = false;
  why = '';
  rtt = 0;
  private bus: Bus;
  private inbox: string;
  private outbox: string;
  private handlers: Handler[] = [];
  private closeHandlers: (() => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private seen = new Map<string, number>();
  private seq = 0;
  private pc: RTCPeerConnection | null = null;
  private dcC: RTCDataChannel | null = null;
  private dcF: RTCDataChannel | null = null;
  private lastIn = performance.now();
  private hbT = 0;
  private helloT = 0;
  private rtxT = 0;
  // Reliable, ordered control messages: every `send` gets a sequence number and is retransmitted until the
  // other side acknowledges it (cumulative acks). The relay is fire-and-forget (MQTT QoS 0), so without this a
  // single lost 'start' or 'ready' froze the match start forever.
  private rOut = 0;
  private rUnacked = new Map<number, { m: NetMsg; at: number; n: number }>();
  private rIn = 1;
  private rBuf = new Map<number, NetMsg>();
  /** Reliable messages sent but not yet acknowledged (debug overlay). */
  get pending() { return this.rUnacked.size; }
  retransmits = 0;

  constructor(readonly role: Role, readonly code: string) {
    const room = NS + 'r/' + code.toUpperCase() + '/';
    this.inbox = room + (role === 'host' ? 'h' : 'g');
    this.outbox = room + (role === 'host' ? 'g' : 'h');
    const onMsg = (_t: string, s: string) => this.onRelay(s);
    this.bus = useLocal() ? new LocalBus(onMsg) : new MqttBus(this.id, onMsg);
    this.bus.sub(this.inbox);
    if (role === 'guest') {
      // Knock until the host answers.
      const knock = () => this.relay({ k: 'hello' });
      knock();
      this.helloT = window.setInterval(() => { if (!this.open) knock(); else clearInterval(this.helloT); }, 700);
    }
    this.hbT = window.setInterval(() => this.heartbeat(), 1000);
    this.rtxT = window.setInterval(() => this.retransmit(), 150);
  }

  get relayUp() { return this.bus.up; }
  get direct() { return !!this.dcC && this.dcC.readyState === 'open'; }
  /** Subscribe to messages; returns an unsubscribe function. */
  on(fn: Handler) { this.handlers.push(fn); return () => { this.handlers = this.handlers.filter((h) => h !== fn); }; }
  onOpen(fn: () => void) { this.openHandlers.push(fn); if (this.open) fn(); }
  onClose(fn: () => void) { this.closeHandlers.push(fn); }

  /** Reliable, ordered control message (retransmitted until acknowledged; delivered once, in order). */
  send(m: NetMsg) {
    if (this.closed) return;
    const r = ++this.rOut;
    this.rUnacked.set(r, { m, at: performance.now(), n: 0 });
    this.sendRaw({ k: 'R', r, d: m });
  }
  /** Best effort over the control channel (or relay). */
  private sendRaw(m: NetMsg) {
    if (this.closed) return;
    if (this.direct) { try { this.dcC!.send(JSON.stringify(m)); return; } catch { /* fall back */ } }
    this.relay(m);
  }
  /** Fast, may drop (inputs carry their own redundancy). */
  sendFast(m: NetMsg) {
    if (this.closed) return;
    if (this.dcF && this.dcF.readyState === 'open') { try { this.dcF.send(JSON.stringify(m)); return; } catch { /* */ } }
    this.sendRaw(m);
  }
  private retransmit() {
    if (this.closed || !this.rUnacked.size) return;
    const now = performance.now(), wait = Math.max(300, Math.min(2000, this.rtt * 1.5));
    let n = 0;
    for (const [r, e] of this.rUnacked) {
      if (now - e.at < wait) continue;
      e.at = now; e.n++; this.retransmits++;
      // Over the relay too: a direct channel that is silently dead shouldn't hold control messages hostage.
      const pkt = { k: 'R', r, d: e.m };
      this.relay(pkt);
      if (this.direct) { try { this.dcC!.send(JSON.stringify(pkt)); } catch { /* */ } }
      if (e.n === 3) netlog(`resending '${e.m.k}' (#${r}, no ack yet)`);
      if (++n >= 8) break; // pace big backlogs
    }
  }

  private relay(m: NetMsg) {
    this.seq++;
    this.bus.pub(this.outbox, JSON.stringify({ f: this.id, i: this.id + ':' + this.seq, d: m }));
  }
  private onRelay(s: string) {
    let env: { f: string; i: string; d: NetMsg };
    try { env = JSON.parse(s); } catch { return; }
    if (!env || env.f === this.id) return;
    if (this.seen.has(env.i)) return;
    this.seen.set(env.i, performance.now());
    if (this.seen.size > 4000) { const cut = performance.now() - 30000; for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k); }
    const m = env.d;
    if (this.role === 'host') {
      if (m.k === 'hello') {
        if (this.peer && this.peer !== env.f) { this.bus.pub(this.outbox, JSON.stringify({ f: this.id, i: this.id + ':full' + randId(4), d: { k: 'full', to: env.f } })); return; }
        if (!this.peer) { this.peer = env.f; this.markOpen(); void this.startRtc(); }
        this.relay({ k: 'welcome', to: env.f });
        return;
      }
      if (env.f !== this.peer) return;
    } else {
      if (m.k === 'full' && m.to === this.id) { this.fail('That room is full.'); return; }
      if (m.k === 'welcome') { if (m.to !== this.id) return; if (!this.peer) { this.peer = env.f; this.markOpen(); } return; }
      if (this.peer && env.f !== this.peer) return;
    }
    this.deliver(m);
  }
  private deliver(m: NetMsg) {
    this.lastIn = performance.now();
    if (m.k === 'R') {
      const r = m.r as number;
      if (r >= this.rIn && !this.rBuf.has(r)) this.rBuf.set(r, m.d as NetMsg);
      const ready: NetMsg[] = [];
      while (this.rBuf.has(this.rIn)) { ready.push(this.rBuf.get(this.rIn)!); this.rBuf.delete(this.rIn); this.rIn++; }
      this.sendRaw({ k: 'A', a: this.rIn - 1 }); // cumulative ack (also re-acks duplicates)
      for (const d of ready) this.handle(d);
      return;
    }
    if (m.k === 'A') { const a = m.a as number; for (const r of this.rUnacked.keys()) if (r <= a) this.rUnacked.delete(r); return; }
    this.handle(m);
  }
  private handle(m: NetMsg) {
    if (this.closed) return;
    if (m.k === 'sdp' || m.k === 'ice') { void this.onSignal(m); return; }
    if (m.k === 'hb') { this.sendRaw({ k: 'hbr', t: m.t }); return; }
    if (m.k === 'hbr') { const r = performance.now() - (m.t as number); this.rtt = this.rtt ? this.rtt * 0.7 + r * 0.3 : r; return; }
    if (m.k === 'bye') { this.fail('Opponent left.'); return; }
    for (const h of [...this.handlers]) { try { h(m); } catch (e) { console.error(e); } }
  }
  private markOpen() {
    if (this.open) return;
    netlog(`link open (${this.role}, room ${this.code})`);
    this.open = true;
    this.lastIn = performance.now();
    for (const h of this.openHandlers) h();
  }
  private heartbeat() {
    if (this.closed || !this.open) return;
    this.sendRaw({ k: 'hb', t: performance.now() });
    if (performance.now() - this.lastIn > LOST_MS) this.fail('Connection lost.');
  }

  // ---------------------------------------------------------------- WebRTC through the relay
  private async makePc() {
    if (useLocal() && !new URLSearchParams(location.search).has('rtc')) return null;
    if (typeof RTCPeerConnection === 'undefined') return null;
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ k: 'ice', c: e.candidate.toJSON() as unknown as Record<string, unknown> }); };
    pc.ondatachannel = (e) => this.takeChannel(e.channel);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { try { pc.close(); } catch { /* */ } if (this.pc === pc) this.pc = null; } };
    this.pc = pc;
    return pc;
  }
  private takeChannel(ch: RTCDataChannel) {
    if (ch.label === 'c') this.dcC = ch; else this.dcF = ch;
    ch.addEventListener('open', () => netlog(`direct channel '${ch.label}' open`));
    ch.addEventListener('close', () => netlog(`direct channel '${ch.label}' closed`));
    ch.onmessage = (e) => { let m: NetMsg; try { m = JSON.parse(e.data as string); } catch { return; } this.deliver(m); };
  }
  private async startRtc() {
    try {
      const pc = await this.makePc();
      if (!pc) return;
      this.takeChannel(pc.createDataChannel('c', { ordered: true }));
      this.takeChannel(pc.createDataChannel('f', { ordered: false, maxRetransmits: 0 }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ k: 'sdp', s: pc.localDescription!.toJSON() as unknown as Record<string, unknown> });
    } catch (e) { console.warn('direct link unavailable, using relay', e); }
  }
  private pendingIce: RTCIceCandidateInit[] = [];
  private async onSignal(m: NetMsg) {
    try {
      if (m.k === 'sdp') {
        const d = m.s as unknown as RTCSessionDescriptionInit;
        if (d.type === 'offer') {
          const pc = this.pc ?? (await this.makePc());
          if (!pc) return;
          await pc.setRemoteDescription(d);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.send({ k: 'sdp', s: pc.localDescription!.toJSON() as unknown as Record<string, unknown> });
        } else if (this.pc) await this.pc.setRemoteDescription(d);
        for (const c of this.pendingIce.splice(0)) await this.pc?.addIceCandidate(c);
      } else if (m.k === 'ice') {
        const c = m.c as unknown as RTCIceCandidateInit;
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(c); else this.pendingIce.push(c);
      }
    } catch (e) { console.warn('signal error', e); }
  }

  private fail(why: string) {
    if (this.closed) return;
    netlog('link failed: ' + why);
    this.why = why;
    this.shutdown();
    for (const h of this.closeHandlers) h();
  }
  private shutdown() {
    this.closed = true;
    clearInterval(this.hbT); clearInterval(this.helloT); clearInterval(this.rtxT);
    try { this.dcC?.close(); this.dcF?.close(); this.pc?.close(); } catch { /* */ }
    setTimeout(() => this.bus.close(), 400);
  }
  /** Leave on purpose (tells the other side). */
  close() {
    if (this.closed) return;
    try { this.relay({ k: 'bye' }); if (this.direct) this.dcC!.send(JSON.stringify({ k: 'bye' })); } catch { /* */ }
    this.shutdown();
  }
}
