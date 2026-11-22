// Synthesized sound effects. Each decision-changing event has a distinct, short signature:
// hit, block, catch, wall break, landing, explosion, rage on/off, danger, finisher, core.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let musicGain: GainNode | null = null;
export let muted = false;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.55;
}

function noise(dur: number, freq: number, q: number, vol: number, type: BiquadFilterType = 'lowpass', delay = 0) {
  if (!ctx || !master || !noiseBuf) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

function tone(f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const last: Record<string, number> = {};
function throttle(name: string, ms: number) {
  const now = performance.now();
  if (last[name] && now - last[name] < ms) return false;
  last[name] = now;
  return true;
}

export const sfx = {
  whiff() { if (throttle('whiff', 40)) noise(0.09, 1800, 0.8, 0.12, 'bandpass'); },
  hit(heavy = false) {
    tone(heavy ? 120 : 180, 50, heavy ? 0.25 : 0.14, heavy ? 0.7 : 0.45, 'sine');
    noise(heavy ? 0.18 : 0.1, heavy ? 900 : 2200, 1, heavy ? 0.5 : 0.35);
  },
  block() { tone(900, 700, 0.08, 0.25, 'square'); noise(0.06, 4000, 2, 0.2, 'highpass'); },
  superBlock() { tone(500, 1400, 0.2, 0.25, 'sawtooth'); tone(1500, 1500, 0.15, 0.1, 'sine', 0.05); },
  catch() { tone(300, 600, 0.08, 0.35, 'triangle'); tone(600, 900, 0.1, 0.3, 'triangle', 0.07); },
  grab() { noise(0.12, 600, 1, 0.3); },
  throwIt() { noise(0.25, 700, 0.7, 0.3, 'bandpass'); },
  land() { if (throttle('land', 80)) tone(90, 40, 0.12, 0.35); },
  wallBreak() { noise(0.7, 500, 0.5, 0.9); tone(70, 30, 0.6, 0.8); noise(0.4, 3000, 1, 0.3, 'highpass', 0.05); },
  crack() { noise(0.15, 1500, 1, 0.35, 'bandpass'); },
  explosion() { noise(1.2, 300, 0.5, 1.0); tone(60, 25, 1.0, 0.9); },
  shock() { tone(80, 30, 0.5, 0.8, 'sawtooth'); noise(0.5, 400, 0.6, 0.6); },
  zap() { tone(1200, 300, 0.15, 0.2, 'sawtooth'); },
  line() { tone(1600, 500, 0.12, 0.15, 'triangle'); },
  teleport() { tone(300, 1800, 0.18, 0.2, 'sine'); tone(1800, 300, 0.18, 0.12, 'sine', 0.08); },
  jump() { if (throttle('jump', 60)) noise(0.08, 1200, 1, 0.12, 'bandpass'); },
  charge() { if (throttle('charge', 180)) tone(200, 260, 0.2, 0.08, 'sine'); },
  rageOn() { tone(110, 440, 0.6, 0.5, 'sawtooth'); tone(220, 880, 0.6, 0.3, 'square', 0.05); },
  rageOff() { tone(440, 110, 0.5, 0.35, 'sawtooth'); },
  danger() { tone(880, 880, 0.08, 0.25, 'square'); tone(660, 660, 0.08, 0.25, 'square', 0.12); },
  finisher() { tone(50, 50, 1.4, 0.9, 'sawtooth'); noise(1.2, 200, 0.4, 0.6); tone(220, 55, 1.2, 0.4, 'square', 0.2); },
  noPower() { tone(200, 120, 0.2, 0.3, 'square'); },
  ko() { tone(300, 40, 1.5, 0.6, 'sawtooth'); },
  ringout() { tone(900, 80, 1.6, 0.5, 'sine'); },
  menu() { tone(660, 990, 0.06, 0.15, 'triangle'); },
  select() { tone(440, 880, 0.12, 0.25, 'triangle'); },
};

// A sparse synth-orchestral pulse for matches. Quiet enough to keep events audible.
let musicTimer: number | null = null;
export function startMusic() {
  if (!ctx || !master || musicTimer !== null) return;
  musicGain = ctx.createGain();
  musicGain.gain.value = 0.11;
  musicGain.connect(master);
  const notes = [55, 55, 65.4, 49, 55, 55, 73.4, 65.4];
  let step = 0;
  const beat = () => {
    if (!ctx || !musicGain) return;
    const t = ctx.currentTime;
    const f = notes[step % notes.length];
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(900, t);
    flt.frequency.exponentialRampToValueAtTime(120, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(flt).connect(g).connect(musicGain);
    o.start(t);
    o.stop(t + 0.4);
    if (step % 8 === 0) {
      for (const m of [2, 3, 4.5]) {
        const p = ctx.createOscillator();
        p.type = 'triangle';
        p.frequency.value = f * m * 2;
        const pg = ctx.createGain();
        pg.gain.setValueAtTime(0.0001, t);
        pg.gain.linearRampToValueAtTime(0.12, t + 0.6);
        pg.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
        p.connect(pg).connect(musicGain);
        p.start(t);
        p.stop(t + 3.3);
      }
    }
    step++;
  };
  musicTimer = window.setInterval(beat, 400);
}

export function stopMusic() {
  if (musicTimer !== null) clearInterval(musicTimer);
  musicTimer = null;
  if (musicGain) { musicGain.disconnect(); musicGain = null; }
}
