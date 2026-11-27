// BREAKLINE sound design — everything is synthesized with Web Audio (no audio files).
//
// One sonic world: every sound and the music run through the same mix (sfx / music / voice buses ->
// glue compressor -> limiter), share one generated concrete-room reverb and one tube-ish distortion
// curve, and all tonal material sits in D Phrygian (D Eb F G A Bb C) — the flat second gives the
// grungy, tense colour. Fighters each have a sonic palette (rock, line, static, phase, claw, metal,
// fire, portal) used for their hits, moves, specials and abilities.

type Ctx = BaseAudioContext;
let ctx: Ctx | null = null;
let live: AudioContext | null = null;
export let muted = false;

interface Graph {
  out: GainNode; // master (mute lives here)
  sfx: GainNode; music: GainNode; duck: GainNode; voice: GainNode;
  verb: ConvolverNode; verbIn: GainNode;
  crunch: WaveShaperNode; crunchIn: GainNode; // shared distortion send for sfx
  noise: AudioBuffer; curve: Float32Array; softCurve: Float32Array;
}
let G: Graph | null = null;
const MASTER = 0.8;

// ---------------------------------------------------------------- tonal centre: D Phrygian
const D1 = 36.708;
const SCALE = [0, 1, 3, 5, 7, 8, 10];
/** Frequency of a D-Phrygian scale degree (0 = D) at an octave above D1. */
const deg = (d: number, oct = 1) => D1 * 2 ** (oct + (SCALE[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7)) / 12);
const semi = (s: number, oct = 1) => D1 * 2 ** (oct + s / 12);

function distCurve(k: number, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return c;
}

function buildGraph(c: Ctx): Graph {
  // Glue compressor then a brick-wall-ish limiter so nothing clips.
  const glue = c.createDynamicsCompressor();
  glue.threshold.value = -16; glue.knee.value = 8; glue.ratio.value = 4; glue.attack.value = 0.006; glue.release.value = 0.18;
  const lim = c.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
  const out = c.createGain(); out.gain.value = muted ? 0 : MASTER;
  glue.connect(lim).connect(out).connect(c.destination);

  const sfx = c.createGain(); sfx.gain.value = 1; sfx.connect(glue);
  const music = c.createGain(); music.gain.value = 0.42;
  const duck = c.createGain(); duck.gain.value = 1;
  music.connect(duck).connect(glue);
  const voice = c.createGain(); voice.gain.value = 1; voice.connect(glue);

  // Shared reverb: a dark concrete room (filtered, exponentially decaying stereo noise impulse).
  const len = Math.floor(c.sampleRate * 2.2);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.35 - t * 0.25); // darker as it decays
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < c.sampleRate * 0.012 ? i / (c.sampleRate * 0.012) : 1);
    }
  }
  const verb = c.createConvolver(); verb.buffer = ir;
  const verbIn = c.createGain(); verbIn.gain.value = 1;
  const verbOut = c.createGain(); verbOut.gain.value = 0.55;
  verbIn.connect(verb).connect(verbOut).connect(glue);

  const curve = distCurve(18), softCurve = distCurve(4);
  const crunchIn = c.createGain(); crunchIn.gain.value = 1;
  const crunch = c.createWaveShaper(); crunch.curve = curve as any; crunch.oversample = '2x';
  const crunchTone = c.createBiquadFilter(); crunchTone.type = 'lowpass'; crunchTone.frequency.value = 3200;
  const crunchOut = c.createGain(); crunchOut.gain.value = 0.35;
  crunchIn.connect(crunch).connect(crunchTone).connect(crunchOut).connect(sfx);

  const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  return { out, sfx, music, duck, voice, verb, verbIn, crunch, crunchIn, noise, curve, softCurve };
}

export function initAudio() {
  if (live) { if (live.state === 'suspended') live.resume(); if (wantMusic && !cur) startMusic(wantMusic.kind, wantMusic.variant); return; }
  try {
    live = new AudioContext({ latencyHint: 'interactive' });
    ctx = live;
    G = buildGraph(live);
    if (wantMusic) startMusic(wantMusic.kind, wantMusic.variant);
  } catch {
    live = null; ctx = null; G = null;
  }
}

export function setMuted(m: boolean) {
  muted = m;
  if (G && ctx) G.out.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.02);
}

/** The audio context and the voice bus (for spoken intro lines), or null before audio is unlocked. */
export function audioCtx() { return live; }
export function voiceBus(): AudioNode | null { return G ? G.voice : null; }
/** Duck the music by `amount` (0..1) for `seconds`, recovering smoothly afterwards. */
export function duckMusic(amount: number, seconds: number) {
  if (!G || !ctx) return;
  const t = ctx.currentTime, g = G.duck.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(Math.max(0.05, 1 - amount), t + 0.12);
  g.setValueAtTime(Math.max(0.05, 1 - amount), t + Math.max(0.12, seconds));
  g.linearRampToValueAtTime(1, t + Math.max(0.12, seconds) + 0.6);
}

// ---------------------------------------------------------------- voice primitives (time-addressed)
let sfxTime: number | null = null; // offline rendering pins sfx to a timeline
const T = () => (sfxTime ?? (ctx ? ctx.currentTime : 0)) + 0.005;
const free = (n: AudioScheduledSourceNode, ...rest: AudioNode[]) => { n.onended = () => { n.disconnect(); for (const r of rest) r.disconnect(); }; };

interface ToneOpts { type?: OscillatorType; detune?: number; attack?: number; dest?: AudioNode; send?: number; drive?: number; filter?: [BiquadFilterType, number, number?, number?]; curve?: 'exp' | 'lin' }
/** An enveloped oscillator gliding f0 -> f1. */
function tone(t: number, f0: number, f1: number, dur: number, vol: number, o: ToneOpts = {}) {
  if (!ctx || !G) return;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) {
    if (o.curve === 'lin') osc.frequency.linearRampToValueAtTime(f1, t + dur);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(18, f1), t + dur);
  }
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  let head: AudioNode = osc;
  const extra: AudioNode[] = [g];
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter[0]; f.frequency.setValueAtTime(o.filter[1], t); f.Q.value = o.filter[2] ?? 0.8;
    if (o.filter[3]) f.frequency.exponentialRampToValueAtTime(o.filter[3], t + a + dur);
    head.connect(f); head = f; extra.push(f);
  }
  head.connect(g);
  g.connect(o.dest ?? G.sfx);
  if (o.send) { const s = ctx.createGain(); s.gain.value = o.send; g.connect(s).connect(G.verbIn); extra.push(s); }
  if (o.drive) { const s = ctx.createGain(); s.gain.value = o.drive; g.connect(s).connect(G.crunchIn); extra.push(s); }
  osc.start(t); osc.stop(t + a + dur + 0.03);
  free(osc, ...extra);
}

interface NoiseOpts { dest?: AudioNode; send?: number; drive?: number; f1?: number; attack?: number; rate?: number }
/** An enveloped, filtered noise burst (filter can sweep freq -> f1). */
function noise(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, vol: number, o: NoiseOpts = {}) {
  if (!ctx || !G) return;
  const src = ctx.createBufferSource();
  src.buffer = G.noise;
  if (o.rate) src.playbackRate.value = o.rate;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur);
  const g = ctx.createGain();
  const a = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  src.connect(f).connect(g).connect(o.dest ?? G.sfx);
  const extra: AudioNode[] = [f, g];
  if (o.send) { const s = ctx.createGain(); s.gain.value = o.send; g.connect(s).connect(G.verbIn); extra.push(s); }
  if (o.drive) { const s = ctx.createGain(); s.gain.value = o.drive; g.connect(s).connect(G.crunchIn); extra.push(s); }
  src.start(t, Math.random() * 1.5);
  src.stop(t + a + dur + 0.03);
  free(src, ...extra);
}

/** Metallic hit: inharmonic partials (the industrial "clank" shared by sfx and drums). */
function metal(t: number, base: number, dur: number, vol: number, dest?: AudioNode, send = 0.3) {
  for (const [r, v] of [[1, 1], [2.76, 0.6], [5.4, 0.4], [8.93, 0.25]] as const) tone(t, base * r, base * r * 0.995, dur * (1.1 - v * 0.3), vol * v * 0.5, { type: 'sine', dest, send });
  noise(t, 0.03, 'highpass', 4000, 0.7, vol * 0.5, { dest });
}

const last: Record<string, number> = {};
function throttle(name: string, ms: number) {
  if (sfxTime !== null) return true;
  const now = performance.now();
  if (last[name] && now - last[name] < ms) return false;
  last[name] = now;
  return true;
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- per-fighter palettes
type Palette = (t: number, s: number) => void;
/** Short texture layered onto that fighter's hits and moves (strength s 0..1). */
const TEXTURE: Record<string, Palette> = {
  basalt: (t, s) => { noise(t, 0.12 + s * 0.15, 'lowpass', 700, 0.6, 0.35 + s * 0.3, { drive: 0.6 }); for (let i = 0; i < 3; i++) noise(t + rnd(0.01, 0.09), 0.03, 'bandpass', rnd(1500, 3500), 3, 0.12); },
  tether: (t, s) => { noise(t, 0.07, 'bandpass', 3200, 4, 0.2 + s * 0.1, { f1: 900 }); },
  aerin: (t, s) => { for (let i = 0; i < 3 + s * 3; i++) noise(t + i * rnd(0.008, 0.02), 0.012, 'highpass', 3500, 0.7, 0.18); tone(t, 1800, 700, 0.06, 0.06, { type: 'sawtooth', drive: 0.5 }); },
  shunt: (t, s) => { tone(t, 900, 300 + s * 200, 0.09, 0.12, { type: 'sine', send: 0.3 }); },
  vanta: (t, s) => { noise(t, 0.05, 'bandpass', 6000, 2, 0.22 + s * 0.12, { f1: 2200 }); noise(t + 0.03, 0.05, 'bandpass', 5000, 2, 0.15, { f1: 1800 }); },
  magna: (t, s) => { metal(t, 330 + s * 80, 0.25 + s * 0.2, 0.22 + s * 0.15); },
  ember: (t, s) => { noise(t, 0.2 + s * 0.2, 'bandpass', 900, 0.7, 0.2 + s * 0.2, { f1: 300, drive: 0.5 }); for (let i = 0; i < 4; i++) noise(t + rnd(0.02, 0.2), 0.01, 'highpass', 5000, 1, 0.12); },
  rift: (t, s) => { tone(t, 220, 660, 0.1, 0.1, { type: 'triangle', send: 0.5 }); noise(t, 0.1, 'bandpass', 1200, 3, 0.1 + s * 0.08, { f1: 3000, send: 0.4 }); },
};

/** Signature sounds for each fighter's mobility, powers and specials. */
const ABILITY: Record<string, Partial<Record<AbilityKind, Palette>>> = {
  basalt: {
    power: (t, s) => { tone(t, 70, 32, 0.6 + s * 0.4, 0.8, { type: 'sine' }); noise(t, 0.7, 'lowpass', 500, 0.5, 0.6, { drive: 1, send: 0.4, f1: 120 }); },
    dash: (t) => { noise(t, 0.5, 'lowpass', 300, 0.6, 0.45, { drive: 0.8, attack: 0.08 }); for (let i = 0; i < 6; i++) noise(t + i * 0.07, 0.05, 'lowpass', 220, 1, 0.3); },
    charged: (t) => { tone(t, 55, 24, 1.4, 0.9, { type: 'sine' }); noise(t, 1.3, 'lowpass', 400, 0.5, 0.8, { drive: 1.2, send: 0.6, f1: 60 }); for (let i = 0; i < 10; i++) noise(t + rnd(0.05, 0.8), 0.06, 'bandpass', rnd(800, 2500), 2, 0.18); },
    mobility: (t) => { noise(t, 0.25, 'lowpass', 400, 0.7, 0.35, { drive: 0.5 }); },
  },
  tether: {
    power: (t) => { noise(t, 0.12, 'bandpass', 4200, 5, 0.35, { f1: 700 }); tone(t, 2200, 500, 0.12, 0.12, { type: 'triangle' }); },
    projectile: (t) => { noise(t, 0.1, 'bandpass', 4500, 6, 0.3, { f1: 900 }); tone(t, 2600, 700, 0.09, 0.1, { type: 'triangle' }); },
    dash: (t) => { noise(t, 0.25, 'bandpass', 1200, 3, 0.3, { f1: 4200 }); tone(t, 500, 1800, 0.2, 0.1, { type: 'triangle' }); },
    mobility: (t) => { noise(t, 0.16, 'bandpass', 3800, 6, 0.28, { f1: 900 }); tone(t + 0.02, 1900, 600, 0.1, 0.08, { type: 'triangle' }); },
    charged: (t) => { for (let i = 0; i < 3; i++) { noise(t + i * 0.06, 0.1, 'bandpass', 4400, 6, 0.28, { f1: 900 }); } },
  },
  aerin: {
    power: (t) => { tone(t, deg(4, 4), deg(4, 3), 0.16, 0.12, { type: 'sawtooth', drive: 0.8 }); for (let i = 0; i < 8; i++) noise(t + i * 0.012, 0.012, 'highpass', 3000, 0.7, 0.2); },
    projectile: (t) => { tone(t, 2400, 600, 0.18, 0.12, { type: 'sawtooth', drive: 0.9, send: 0.3 }); for (let i = 0; i < 10; i++) noise(t + i * rnd(0.01, 0.025), 0.01, 'highpass', 3500, 0.7, 0.2); },
    charged: (t) => { tone(t, 120, 40, 0.9, 0.6, { type: 'sawtooth', drive: 1.2 }); noise(t, 0.08, 'highpass', 2000, 0.7, 0.6, { send: 0.6 }); for (let i = 0; i < 22; i++) noise(t + rnd(0, 0.6), 0.012, 'highpass', 3500, 0.7, 0.22); },
    dash: (t) => { noise(t, 0.3, 'bandpass', 800, 1, 0.3, { f1: 3500 }); for (let i = 0; i < 8; i++) noise(t + i * 0.03, 0.01, 'highpass', 4000, 0.7, 0.15); },
    mobility: (t) => { noise(t, 0.35, 'bandpass', 500, 1.2, 0.22, { f1: 1600, attack: 0.08 }); },
  },
  shunt: {
    mobility: (t) => { tone(t, 220, 1600, 0.14, 0.18, { type: 'sine', send: 0.5 }); tone(t + 0.1, 1600, 220, 0.14, 0.12, { type: 'sine', send: 0.5 }); noise(t, 0.2, 'bandpass', 2000, 4, 0.1, { f1: 6000 }); },
    power: (t) => { tone(t, deg(0, 2), deg(0, 1), 0.5, 0.55, { type: 'sine' }); tone(t, deg(1, 3), deg(1, 2), 0.4, 0.15, { type: 'square', filter: ['lowpass', 1500], send: 0.5 }); noise(t, 0.4, 'bandpass', 600, 1, 0.3, { f1: 3000, send: 0.4 }); },
    dash: (t) => { tone(t, 300, 2000, 0.1, 0.18, { type: 'sine', send: 0.5 }); noise(t + 0.08, 0.06, 'highpass', 3000, 1, 0.2); },
    charged: (t) => { for (let i = 0; i < 3; i++) { tone(t + i * 0.08, 1200, 400, 0.12, 0.15, { type: 'square', filter: ['lowpass', 2500] }); } },
  },
  vanta: {
    power: (t) => { for (let i = 0; i < 5; i++) noise(t + i * 0.045, 0.06, 'bandpass', rnd(5000, 7000), 2.5, 0.25, { f1: 1800 }); },
    dash: (t) => { noise(t, 0.35, 'bandpass', 400, 1.5, 0.35, { f1: 2500, attack: 0.05, send: 0.3 }); tone(t, 80, 160, 0.3, 0.2, { type: 'sawtooth', filter: ['lowpass', 400] }); },
    charged: (t) => { for (let i = 0; i < 3; i++) { noise(t + i * 0.15, 0.12, 'bandpass', 900, 1.2, 0.3, { f1: 5000 }); noise(t + i * 0.15 + 0.08, 0.06, 'bandpass', 6000, 2, 0.3, { f1: 2000 }); } },
    mobility: (t) => { noise(t, 0.2, 'bandpass', 700, 1, 0.3, { f1: 2600 }); },
  },
  magna: {
    power: (t) => { metal(t, deg(4, 4), 0.5, 0.35); tone(t, deg(0, 2), deg(0, 2), 0.4, 0.2, { type: 'square', filter: ['bandpass', 600, 4] }); },
    projectile: (t) => { for (let i = 0; i < 3; i++) metal(t + i * 0.035, deg(4, 5) * (1 + i * 0.07), 0.18, 0.18); },
    dash: (t) => { tone(t, deg(0, 2), deg(4, 3), 0.35, 0.3, { type: 'square', filter: ['bandpass', 900, 5] }); tone(t, deg(1, 2), deg(5, 3), 0.35, 0.15, { type: 'square', filter: ['bandpass', 900, 5] }); },
    charged: (t) => { // implosion: suck in (reverse swell), then a metal-laden blast
      noise(t, 0.6, 'bandpass', 3000, 1.5, 0.5, { f1: 200, attack: 0.5 });
      tone(t, deg(0, 3), deg(0, 1), 0.55, 0.3, { type: 'sawtooth', attack: 0.45, drive: 0.6 });
      metal(t + 0.55, deg(0, 3), 1.2, 0.5, undefined, 0.6); tone(t + 0.55, 70, 30, 0.8, 0.8); noise(t + 0.55, 0.6, 'lowpass', 900, 0.6, 0.6, { drive: 0.8 });
    },
    mobility: (t) => { tone(t, deg(0, 2), deg(0, 2) * 1.01, 0.5, 0.12, { type: 'square', filter: ['bandpass', 500, 6], attack: 0.1 }); },
  },
  ember: {
    power: (t) => { noise(t, 0.45, 'bandpass', 400, 0.8, 0.5, { f1: 1800, drive: 0.9, attack: 0.04 }); for (let i = 0; i < 8; i++) noise(t + rnd(0.05, 0.4), 0.01, 'highpass', 5000, 1, 0.15); },
    projectile: (t) => { noise(t, 0.5, 'bandpass', 500, 0.7, 0.5, { f1: 1400, drive: 1, attack: 0.03 }); tone(t, 90, 60, 0.4, 0.3, { type: 'sawtooth', filter: ['lowpass', 500] }); },
    dash: (t) => { noise(t, 0.6, 'bandpass', 300, 0.7, 0.55, { f1: 1500, drive: 1, attack: 0.05 }); },
    charged: (t) => { tone(t, 60, 26, 1.2, 0.9); noise(t, 1.2, 'lowpass', 1200, 0.5, 0.8, { drive: 1.4, send: 0.5, f1: 200 }); for (let i = 0; i < 16; i++) noise(t + rnd(0.05, 1), 0.012, 'highpass', 4500, 1, 0.2); },
    mobility: (t) => { noise(t, 0.3, 'bandpass', 600, 0.8, 0.3, { f1: 1600, drive: 0.6 }); },
  },
  rift: {
    mobility: (t) => { tone(t, 90, 520, 0.22, 0.3, { type: 'sine', send: 0.6 }); noise(t, 0.25, 'bandpass', 800, 2, 0.2, { f1: 3500, send: 0.5 }); tone(t + 0.2, 400, 90, 0.18, 0.2, { type: 'triangle', send: 0.6 }); },
    power: (t) => { // swap gate: two portals and a pop
      for (const d of [0, 0.12]) { tone(t + d, 110, 700, 0.18, 0.22, { type: 'sine', send: 0.6 }); noise(t + d, 0.2, 'bandpass', 900, 2.5, 0.18, { f1: 4000, send: 0.5 }); }
      tone(t + 0.3, deg(4, 4), deg(0, 3), 0.25, 0.15, { type: 'triangle', send: 0.6 });
    },
    dash: (t) => { tone(t, 120, 800, 0.15, 0.25, { type: 'sine', send: 0.5 }); noise(t + 0.12, 0.08, 'lowpass', 600, 1, 0.5, { drive: 0.5 }); },
    projectile: (t) => { tone(t, 300, 1400, 0.12, 0.12, { type: 'triangle', send: 0.5 }); },
    charged: (t) => { for (let i = 0; i < 3; i++) { tone(t + i * 0.13, 100, 600, 0.2, 0.2, { type: 'sine', send: 0.6 }); noise(t + i * 0.13, 0.15, 'bandpass', 1000, 2, 0.15, { f1: 4000, send: 0.5 }); } },
  },
};

export type AbilityKind = 'power' | 'dash' | 'charged' | 'mobility' | 'projectile';

// ---------------------------------------------------------------- SFX API
export const sfx = {
  // ---- combat
  /** Whoosh scaled by the move's weight (0 = jab, 1 = heavy swing). */
  whiff(weight = 0.4) {
    if (!throttle('whiff', 40)) return;
    const t = T(), w = Math.min(1, Math.max(0, weight));
    noise(t, 0.08 + w * 0.12, 'bandpass', 2400 - w * 1200, 1.2, 0.12 + w * 0.12, { f1: 700 - w * 300, attack: 0.02 + w * 0.03 });
  },
  /** Generic hit (kept for older call sites). */
  hit(heavy = false) { sfx.impact(heavy ? 0.9 : 0.4); },
  /** A hit landing: body thump + crack + transient, flavoured by the attacker's palette. */
  impact(strength = 0.5, attacker?: string, kick = false) {
    if (!throttle('impact', 25)) return;
    const t = T(), s = Math.min(1, Math.max(0, strength));
    tone(t, 150 + s * 40 - (kick ? 30 : 0), 45, 0.12 + s * 0.2, 0.45 + s * 0.45, { type: 'sine' });
    noise(t, 0.04 + s * 0.05, 'bandpass', 1800 + (1 - s) * 1500, 0.9, 0.35 + s * 0.3, { drive: s * 0.8 });
    noise(t, 0.012, 'highpass', 3000, 0.7, 0.35);
    if (s > 0.6) { noise(t + 0.01, 0.25 + s * 0.2, 'lowpass', 500, 0.6, 0.3 * s, { send: 0.35, drive: 0.5 }); tone(t, 70, 32, 0.35, 0.5 * s); }
    if (attacker && TEXTURE[attacker]) TEXTURE[attacker](t, s);
  },
  block() { const t = T(); tone(t, 720, 560, 0.06, 0.22, { type: 'square', filter: ['bandpass', 1200, 2] }); noise(t, 0.05, 'highpass', 3500, 1, 0.22); tone(t, 110, 70, 0.08, 0.25); },
  superBlock() { const t = T(); metal(t, deg(4, 5), 0.5, 0.35, undefined, 0.5); tone(t, deg(0, 4), deg(0, 5), 0.18, 0.18, { type: 'sawtooth', drive: 0.6, send: 0.4 }); },
  catch() { const t = T(); tone(t, deg(0, 4), deg(4, 4), 0.07, 0.25, { type: 'triangle' }); tone(t + 0.06, deg(4, 4), deg(0, 5), 0.09, 0.22, { type: 'triangle', send: 0.3 }); },
  grab() { const t = T(); noise(t, 0.1, 'lowpass', 900, 1, 0.35); tone(t, 140, 90, 0.08, 0.3); },
  throwIt() { const t = T(); noise(t, 0.3, 'bandpass', 600, 0.8, 0.35, { f1: 1800, attack: 0.04 }); },
  land() { if (!throttle('land', 80)) return; const t = T(); tone(t, 95, 45, 0.12, 0.35); noise(t, 0.06, 'lowpass', 500, 0.8, 0.2); },
  jump() { if (!throttle('jump', 60)) return; const t = T(); noise(t, 0.1, 'bandpass', 900, 1, 0.12, { f1: 2400 }); },
  wallBreak() { const t = T(); noise(t, 0.8, 'lowpass', 900, 0.5, 0.8, { drive: 1, send: 0.5, f1: 200 }); tone(t, 75, 28, 0.6, 0.8); for (let i = 0; i < 10; i++) noise(t + rnd(0.02, 0.5), 0.04, 'bandpass', rnd(1500, 5000), 2, 0.2); metal(t + 0.05, 420, 0.6, 0.25); },
  crack() { const t = T(); noise(t, 0.12, 'bandpass', 1500, 1, 0.35, { drive: 0.4 }); for (let i = 0; i < 4; i++) noise(t + rnd(0, 0.1), 0.02, 'bandpass', rnd(2000, 5000), 3, 0.12); },
  explosion(size = 1) {
    if (!throttle('boom', 70)) return;
    const t = T(), s = Math.min(1.6, size);
    tone(t, 90, 24, 1.2 * s, 0.95, { type: 'sine' });
    noise(t, 0.08, 'highpass', 1500, 0.7, 0.7);
    noise(t, 1.4 * s, 'lowpass', 1500, 0.5, 0.9, { f1: 120, drive: 1.2, send: 0.6 });
    noise(t + 0.15, 1.8 * s, 'lowpass', 400, 0.5, 0.35, { attack: 0.2, send: 0.5 });
    for (let i = 0; i < 12; i++) noise(t + rnd(0.1, 1.2), 0.03, 'bandpass', rnd(1500, 5000), 2, 0.12);
  },
  shock() { const t = T(); tone(t, 85, 30, 0.6, 0.8, { type: 'sine' }); noise(t, 0.6, 'lowpass', 600, 0.6, 0.6, { drive: 0.9, send: 0.4, f1: 150 }); },
  zap() { if (!throttle('zap', 35)) return; const t = T(); tone(t, 1600, 380, 0.14, 0.16, { type: 'sawtooth', drive: 0.7 }); for (let i = 0; i < 5; i++) noise(t + i * 0.015, 0.01, 'highpass', 3500, 0.7, 0.15); },
  line() { const t = T(); noise(t, 0.12, 'bandpass', 4000, 6, 0.25, { f1: 900 }); tone(t, 2200, 600, 0.1, 0.08, { type: 'triangle' }); },
  teleport() { const t = T(); tone(t, 260, 1700, 0.13, 0.18, { type: 'sine', send: 0.5 }); tone(t + 0.09, 1700, 260, 0.15, 0.12, { type: 'sine', send: 0.5 }); noise(t, 0.16, 'bandpass', 2000, 4, 0.08, { f1: 6000 }); },
  charge() { if (!throttle('charge', 160)) return; const t = T(); tone(t, deg(0, 3), deg(4, 3), 0.18, 0.07, { type: 'sawtooth', filter: ['lowpass', 900] }); },
  noPower() { const t = T(); tone(t, deg(1, 3), deg(0, 3), 0.16, 0.22, { type: 'square', filter: ['lowpass', 1400] }); tone(t + 0.12, deg(0, 3), deg(-1, 3), 0.18, 0.18, { type: 'square', filter: ['lowpass', 1200] }); },
  danger() { const t = T(); for (let i = 0; i < 2; i++) { tone(t + i * 0.16, deg(1, 5), deg(1, 5), 0.09, 0.2, { type: 'square', filter: ['lowpass', 3000] }); tone(t + i * 0.16, deg(0, 5), deg(0, 5), 0.09, 0.14, { type: 'square', filter: ['lowpass', 3000] }); } },
  staminaBreak() { const t = T(); noise(t, 0.4, 'bandpass', 2500, 1, 0.4, { f1: 500, send: 0.5 }); tone(t, deg(4, 4), deg(0, 2), 0.5, 0.3, { type: 'sawtooth', drive: 0.6 }); for (let i = 0; i < 8; i++) noise(t + rnd(0, 0.25), 0.02, 'bandpass', rnd(4000, 8000), 3, 0.15); },
  ko() { const t = T(); tone(t, 60, 20, 1.6, 0.9); noise(t, 1.4, 'lowpass', 700, 0.5, 0.6, { drive: 1, send: 0.7, f1: 80 }); tone(t, deg(0, 4), deg(0, 1), 1.6, 0.25, { type: 'sawtooth', drive: 0.8, send: 0.5 }); },
  ringout() { const t = T(); tone(t, 900, 70, 1.8, 0.35, { type: 'sine', send: 0.6 }); noise(t, 1.6, 'bandpass', 2000, 1, 0.25, { f1: 200, send: 0.4 }); },
  finisher() {
    const t = T();
    tone(t, 48, 48, 1.6, 0.8, { type: 'sawtooth', filter: ['lowpass', 300], drive: 0.6 });
    for (const d of [0, 1, 4]) tone(t, deg(d, 2), deg(d, 2), 1.8, 0.16, { type: 'sawtooth', drive: 0.8, send: 0.6, attack: 0.05 });
    noise(t, 1.4, 'lowpass', 300, 0.4, 0.6, { send: 0.6 });
    metal(t + 0.02, deg(0, 4), 1.4, 0.4, undefined, 0.7);
  },
  // ---- rage & powers
  rageOn() {
    const t = T();
    // Distorted riser into an impact and a growl, all on D.
    noise(t, 0.55, 'bandpass', 300, 1.2, 0.5, { f1: 5000, attack: 0.45, drive: 0.8 });
    tone(t, deg(0, 1), deg(0, 3), 0.55, 0.35, { type: 'sawtooth', drive: 1.2, attack: 0.4 });
    tone(t + 0.55, 80, 28, 1.0, 1.0);
    noise(t + 0.55, 0.9, 'lowpass', 1800, 0.5, 0.8, { f1: 150, drive: 1.4, send: 0.7 });
    for (const d of [0, 1, 4]) tone(t + 0.55, deg(d, 2), deg(d, 2) * 0.985, 1.1, 0.2, { type: 'sawtooth', drive: 1, send: 0.5, filter: ['lowpass', 2400, 1, 600] });
    metal(t + 0.55, deg(0, 4), 0.9, 0.35, undefined, 0.7);
  },
  rageOff() { const t = T(); tone(t, deg(0, 3), deg(0, 1), 0.6, 0.25, { type: 'sawtooth', drive: 0.6, filter: ['lowpass', 1500, 1, 200] }); noise(t, 0.6, 'bandpass', 2000, 1, 0.15, { f1: 300 }); },
  /** Short "power" stinger in the fighter's palette, played as a power/special move starts. */
  power(id?: string) {
    if (!throttle('power', 120)) return;
    const t = T();
    tone(t, deg(0, 2), deg(0, 2), 0.25, 0.28, { type: 'sawtooth', drive: 0.7, filter: ['lowpass', 2600, 1, 500] });
    tone(t, deg(4, 3), deg(4, 3), 0.22, 0.12, { type: 'square', filter: ['lowpass', 2000], send: 0.4 });
    noise(t, 0.18, 'bandpass', 600, 1, 0.22, { f1: 4000, attack: 0.03 });
    if (id && TEXTURE[id]) TEXTURE[id](t + 0.02, 0.6);
  },
  /** A fighter's signature ability sound (falls back to the generic power stinger). */
  ability(id: string, kind: AbilityKind, strength = 0.7) {
    if (!throttle('ab_' + id + kind, 60)) return;
    const p = ABILITY[id]?.[kind];
    if (p) p(T(), strength); else sfx.power(id);
  },
  /** Power grapple / finisher start: the stinger plus the fighter's texture, heavier. */
  special(id?: string) {
    const t = T();
    tone(t, deg(0, 1), deg(0, 2), 0.5, 0.45, { type: 'sawtooth', drive: 1, attack: 0.25 });
    noise(t, 0.4, 'bandpass', 300, 1, 0.35, { f1: 3000, attack: 0.3, send: 0.4 });
    metal(t + 0.3, deg(0, 4), 0.6, 0.25, undefined, 0.6);
    if (id && TEXTURE[id]) TEXTURE[id](t + 0.3, 1);
  },
  // ---- menus
  menu() { if (!throttle('menu', 45)) return; const t = T(); tone(t, deg(4, 5), deg(4, 5), 0.04, 0.08, { type: 'triangle' }); noise(t, 0.01, 'highpass', 6000, 1, 0.05); },
  select() { const t = T(); tone(t, deg(0, 4), deg(0, 4), 0.07, 0.2, { type: 'triangle', send: 0.2 }); tone(t + 0.05, deg(4, 4), deg(4, 4), 0.1, 0.16, { type: 'triangle', send: 0.3 }); },
  back() { const t = T(); tone(t, deg(4, 4), deg(1, 4), 0.1, 0.16, { type: 'triangle', send: 0.2 }); },
  lockIn() { const t = T(); metal(t, deg(0, 4), 0.5, 0.3, undefined, 0.5); tone(t, deg(0, 2), deg(0, 2), 0.3, 0.3, { type: 'sawtooth', drive: 0.7, filter: ['lowpass', 1800, 1, 400] }); },
  fightStart() { const t = T(); tone(t, 70, 30, 0.8, 0.9); noise(t, 0.9, 'lowpass', 2000, 0.5, 0.7, { f1: 150, drive: 1.2, send: 0.6 }); for (const d of [0, 4, 7]) tone(t, deg(d, 3), deg(d, 3), 0.8, 0.14, { type: 'sawtooth', drive: 0.8, send: 0.5, filter: ['lowpass', 3000, 1, 500] }); metal(t, deg(0, 4), 0.9, 0.3, undefined, 0.6); },
};

// ---------------------------------------------------------------- music
type Kind = 'menu' | 'fight';
let wantMusic: { kind: Kind; variant?: string } | null = null;
let intensity = 0;

/** A procedural track scheduled ahead on the audio clock (tempo-accurate, no timer drift). */
class Track {
  out: GainNode;
  hot: GainNode; // intensity layer
  grit: GainNode; // distortion bus
  step = 0; nextT = 0; bar = 0;
  drones: AudioScheduledSourceNode[] = [];
  droneF: BiquadFilterNode | null = null;
  alive = true;
  readonly spb: number; // seconds per 16th
  constructor(public kind: Kind, public variant: string, bpm: number, start: number) {
    this.out = ctx!.createGain(); this.out.gain.value = 0.0001;
    this.out.connect(G!.music);
    this.hot = ctx!.createGain(); this.hot.gain.value = 0; this.hot.connect(this.out);
    // Grunge: bass and stabs go through the shared distortion curve, then a dark cab-style filter.
    this.grit = ctx!.createGain(); this.grit.gain.value = 0.9;
    const sh = ctx!.createWaveShaper(); sh.curve = G!.curve as any; sh.oversample = '2x';
    const cab = ctx!.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = kind === 'menu' ? 1400 : 2400; cab.Q.value = 0.9;
    const post = ctx!.createGain(); post.gain.value = 0.22;
    this.grit.connect(sh).connect(cab).connect(post).connect(this.out);
    this.spb = 60 / bpm / 4;
    this.nextT = start;
    this.out.gain.setValueAtTime(0.0001, start);
    this.out.gain.exponentialRampToValueAtTime(1, start + 1.6);
    if (kind === 'menu') this.startDrone(start);
  }
  // Menu: a distorted D sub drone whose filter breathes, under everything.
  private startDrone(t: number) {
    const c = ctx!, gD = G!;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220; f.Q.value = 4;
    const sh = c.createWaveShaper(); sh.curve = gD.softCurve as any;
    const g = c.createGain(); g.gain.value = 0.1;
    for (const [fr, dt] of [[deg(0, 1), -7], [deg(0, 1), 8], [deg(0, 0), 0]] as const) {
      const o = c.createOscillator(); o.type = fr < 40 ? 'sine' : 'sawtooth'; o.frequency.value = fr; o.detune.value = dt;
      o.connect(sh); o.start(t); this.drones.push(o);
    }
    sh.connect(f).connect(g).connect(this.out);
    const gs = c.createGain(); gs.gain.value = 0.35; g.connect(gs).connect(this.grit);
    this.droneF = f;
  }
  /** Schedule all steps up to `until` (audio time). */
  schedule(until: number) {
    while (this.alive && this.nextT < until) {
      if (this.kind === 'menu') this.menuStep(this.nextT, this.step); else this.fightStep(this.nextT, this.step);
      this.nextT += this.spb;
      this.step++;
      if (this.step % 16 === 0) this.bar++;
    }
  }
  stop(at: number, fade = 1.2) {
    this.alive = false;
    const g = this.out.gain;
    g.cancelScheduledValues(at); g.setValueAtTime(Math.max(0.0001, g.value), at); g.exponentialRampToValueAtTime(0.0001, at + fade);
    for (const d of this.drones) d.stop(at + fade + 0.05);
    const out = this.out;
    setTimeout(() => out.disconnect(), (fade + 0.5) * 1000);
  }

  // ---- drums & instruments (all routed to this.out / this.hot)
  private kick(t: number, v = 1, dest: AudioNode = this.out) { tone(t, 140, 38, 0.32, 0.9 * v, { dest }); tone(t, 60, 40, 0.22, 0.4 * v, { dest, type: 'sine' }); noise(t, 0.01, 'lowpass', 2500, 0.7, 0.25 * v, { dest }); }
  private snare(t: number, v = 1, dest: AudioNode = this.out) { noise(t, 0.16, 'bandpass', 1800, 0.8, 0.55 * v, { dest, send: 0.3, drive: 0 }); tone(t, 230, 160, 0.08, 0.25 * v, { dest, type: 'triangle' }); noise(t, 0.05, 'highpass', 4000, 0.7, 0.2 * v, { dest }); }
  private hat(t: number, v = 1, open = false, dest: AudioNode = this.out) { noise(t, open ? 0.14 : 0.03, 'highpass', 7000, 0.8, 0.13 * v, { dest }); }
  private bass(t: number, f: number, dur: number, v = 1) {
    // Gritty saw bass through the shared distortion, filtered per note.
    tone(t, f, f, dur, 0.5 * v, { type: 'sawtooth', dest: this.grit, filter: ['lowpass', 1400, 3, 200] });
    tone(t, f, f, dur, 0.3 * v, { type: 'square', dest: this.grit, detune: 9, filter: ['lowpass', 700, 1] });
    tone(t, f / 2, f / 2, dur, 0.22 * v, { type: 'sine', dest: this.out });
  }
  private stab(t: number, notes: number[], dur: number, v = 1, dest: AudioNode = this.out) {
    for (const f of notes) { tone(t, f, f * 0.995, dur, 0.07 * v, { type: 'sawtooth', dest, send: 0.5, filter: ['lowpass', 2600, 1, 700] }); tone(t, f, f, dur, 0.1 * v, { type: 'sawtooth', dest: dest === this.out ? this.grit : dest, detune: 14, filter: ['lowpass', 2000] }); }
  }
  private pad(t: number, notes: number[], dur: number, v = 1) {
    for (const f of notes) for (const d of [-9, 9]) tone(t, f, f, dur, 0.035 * v, { type: 'sawtooth', dest: this.out, detune: d, attack: dur * 0.4, send: 0.6, filter: ['lowpass', 1100] });
  }

  private menuStep(t: number, s: number) {
    const st = s % 16, bar = Math.floor(s / 16), phrase = bar % 8;
    // Filter breathing on the drone, one swell per two bars.
    if (st === 0 && this.droneF) {
      const f = this.droneF.frequency;
      f.setValueAtTime(f.value, t); f.linearRampToValueAtTime(phrase % 2 ? 180 : 520 + (phrase === 6 ? 500 : 0), t + this.spb * 16);
    }
    // Pad: Dm -> Eb (the phrygian lurch) every two bars.
    if (st === 0 && bar % 2 === 0) this.pad(t, bar % 4 === 0 ? [deg(0, 3), deg(2, 3), deg(4, 3)] : [deg(1, 3), deg(3, 3), deg(5, 3)], this.spb * 30, 1);
    // Sparse industrial kit.
    if (st === 0 || (st === 10 && bar % 2 === 1)) this.kick(t, 0.8);
    if (st === 8) this.snare(t, phrase % 4 === 3 ? 1 : 0.7);
    if (st % 4 === 2 && Math.random() < 0.6) this.hat(t, 0.6);
    if (st === 14 && bar % 2 === 0) metal(t, deg(0, 4) * (bar % 4 === 0 ? 1 : 1.059), 0.6, 0.12, this.out, 0.6);
    // Dissonant stab at the end of every 4 bars.
    if (st === 12 && bar % 4 === 3) this.stab(t, [deg(0, 3), deg(1, 3), deg(4, 3)], this.spb * 6, 1.2);
    // Low pulse in the drone rhythm.
    if (st % 8 === 0) tone(t, deg(0, 1), deg(0, 1), this.spb * 3, 0.18, { type: 'sine', dest: this.out });
  }

  private fightStep(t: number, s: number) {
    const st = s % 16, bar = Math.floor(s / 16), sect = Math.floor(bar / 4) % 4; // A A B A, 4 bars each
    const over = this.variant === 'overpass' || this.variant === 'helipad';
    // Riff in D phrygian (degrees; -1 = rest). Section B moves up to Bb/C for lift.
    const A = over ? [0, -1, 0, 0, 1, -1, 0, -1, 0, 0, 3, -1, 1, -1, 0, 6 - 7] : [0, -1, 0, 1, -1, 0, -1, 0, 0, -1, 3, -1, 2, 1, -1, 0];
    const B = over ? [5 - 7, -1, 5 - 7, 5 - 7, 6 - 7, -1, 5 - 7, -1, 3, -1, 3, 1, -1, 1, 0, -1] : [5 - 7, -1, 5 - 7, 6 - 7, -1, 5 - 7, 6 - 7, -1, 3, -1, 3, 4, -1, 3, 1, -1];
    const riff = sect === 2 ? B : A;
    const n = riff[st];
    const drop = bar % 16 === 15 && st >= 8; // a half-bar gap before the turnaround
    if (n !== -1 && !drop) this.bass(t, deg(n, 1), this.spb * (riff[(st + 1) % 16] === -1 ? 1.7 : 0.9), st % 4 === 0 ? 1 : 0.8);
    // Kick: four-ish with syncopation; snare 2 & 4; hats 8ths (16ths when hot).
    const kicks = over ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 10];
    if (!drop && kicks.includes(st)) this.kick(t, st % 8 === 0 ? 1 : 0.75);
    if (!drop && (st === 4 || st === 12)) this.snare(t, 1);
    if (st % 2 === 0) this.hat(t, st % 4 === 2 ? 0.8 : 0.5, st === 14);
    else this.hat(t, 0.45, false, this.hot);
    if (st === 14 && bar % 2 === 1) metal(t, deg(1, 4), 0.35, 0.14, this.out, 0.4);
    // Tension riser over the last bar of every 8.
    if (bar % 8 === 7 && st === 0) { noise(t, this.spb * 16, 'bandpass', 300, 1.5, 0.12, { dest: this.out, f1: 6000, attack: this.spb * 15 }); tone(t, deg(0, 2), deg(0, 4), this.spb * 16, 0.06, { type: 'sawtooth', dest: this.out, attack: this.spb * 15, filter: ['lowpass', 3000] }); }
    if (bar % 8 === 0 && st === 0 && bar > 0) { metal(t, deg(0, 4), 1, 0.18, this.out, 0.6); noise(t, 0.6, 'lowpass', 1200, 0.5, 0.2, { dest: this.out, send: 0.4 }); }
    // Intensity layer (Danger / Rage): stabs on the off-beats and a high octave pedal.
    if (st === 2 || st === 10) this.stab(t, sect === 2 ? [deg(5, 3), deg(0, 4)] : [deg(0, 3), deg(1, 3)], this.spb * 1.5, 1, this.hot);
    if (st % 4 === 0) tone(t, deg(0, 4), deg(0, 4), this.spb * 0.8, 0.05, { type: 'square', dest: this.hot, filter: ['lowpass', 2500] });
    if (st === 0 && bar % 2 === 0) this.kick(t, 0.6, this.hot);
  }
}

let cur: Track | null = null;
let timer: number | null = null;

function pump() {
  if (!ctx || !cur) return;
  cur.schedule(ctx.currentTime + 0.18);
}

/** Fight tempo per arena: the overpass and helipad drive harder, the docks drag. */
const TEMPO: Record<string, number> = { rooftop: 128, overpass: 136, construction: 132, docks: 120, helipad: 140 };

/** Start (or crossfade to) a music track: 'menu' or 'fight' (variant: arena id for flavour). */
export function startMusic(kind: Kind = 'fight', variant = '') {
  wantMusic = { kind, variant };
  if (!ctx || !G || !live) return; // begins once audio is unlocked
  if (cur && cur.kind === kind && cur.variant === variant && cur.alive) return;
  const t = ctx.currentTime + 0.05;
  if (cur) cur.stop(t, 1.0);
  cur = new Track(kind, variant, kind === 'menu' ? 84 : TEMPO[variant] ?? 128, t);
  cur.hot.gain.value = 0;
  setIntensity(intensity);
  if (timer === null) timer = window.setInterval(pump, 30);
  pump();
}

export function stopMusic(fade = 1.2) {
  wantMusic = null;
  if (cur && ctx) cur.stop(ctx.currentTime, fade);
  cur = null;
  if (timer !== null) { clearInterval(timer); timer = null; }
}

/** 0..1: raises the fight track's extra layer (Danger, Rage, close finishes). */
export function setIntensity(x: number) {
  intensity = Math.min(1, Math.max(0, x));
  if (cur && ctx) cur.hot.gain.setTargetAtTime(intensity * 1.4, ctx.currentTime, 0.6);
}

// ---------------------------------------------------------------- offline rendering (verification / demos)
/**
 * Render audio offline: `kind` 'menu' | 'fight' | 'sfx'. For 'sfx' the given script calls sfx functions
 * at times via `at(seconds, fn)`. Returns the rendered AudioBuffer. Used by the test harness only.
 */
export async function renderOffline(kind: Kind | 'sfx', seconds: number, opts: { variant?: string; intensity?: number; script?: (at: (s: number, fn: () => void) => void) => void } = {}) {
  const off = new OfflineAudioContext(2, Math.floor(44100 * seconds), 44100);
  const saved = { ctx, G, cur, sfxTime, muted };
  ctx = off; G = buildGraph(off); cur = null; muted = false;
  try {
    if (kind === 'sfx') {
      const jobs: [number, () => void][] = [];
      opts.script?.((s, fn) => jobs.push([s, fn]));
      for (const [s, fn] of jobs) { sfxTime = s; fn(); }
      sfxTime = null;
    } else {
      const tr = new Track(kind, opts.variant ?? '', kind === 'menu' ? 84 : TEMPO[opts.variant ?? ''] ?? 128, 0);
      tr.hot.gain.value = (opts.intensity ?? 0) * 1.4;
      tr.schedule(seconds);
    }
    return await off.startRendering();
  } finally {
    ctx = saved.ctx; G = saved.G; cur = saved.cur; sfxTime = saved.sfxTime; muted = saved.muted;
  }
}
