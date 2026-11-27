import * as THREE from 'three';
import type { Match } from './match';
import type { Fighter } from './fighter';
import type { VersusCamera } from './camera';
import * as audio from './audio';
const sfxAny = (audio as any).sfx as Record<string, (() => void) | undefined>;

// Cinematic fight intro: a close shot of each fighter in turn while they call out the other (subtitles +
// optional browser speech), some powering up, then a wide shot into READY / FIGHT. Any button or tap skips.

type Line = string | ((opp: Fighter) => string);
/** Lines about their own abilities or what they'll do to the opponent. {o} = opponent's name. */
const LINES: Record<string, Line[]> = {
  basalt: [
    'I am the mountain, {o}. Mountains do not move.',
    'Hit me all you like. Stone remembers. Then it falls on you.',
    'I will drive you through this roof and into the street below.',
  ],
  tether: [
    "Catch me if you can, {o}. Spoiler: you can't.",
    "I'll have you wrapped up and hanging off a billboard in ten seconds.",
    'Two jumps, one line, zero chance for you.',
  ],
  aerin: [
    'The storm has your name on it, {o}.',
    'Every third hit, I let the lightning say hello.',
    "Stay on the ground if you like. I'll be up here, raining down on you.",
  ],
  shunt: [
    "You won't see me move. You'll just see the floor.",
    "I'm already behind you, {o}.",
    'One blink and you are nine metres off the edge.',
  ],
  vanta: [
    "Run, {o}. It's more fun when you bleed tired.",
    'Claws out. Lights out.',
    "I've been stalking you all night. Now I pounce.",
  ],
  magna: [
    'Everything here is metal, {o}. Everything here is mine.',
    'Come closer. You will not have a choice.',
    "I'll crush you in a field of steel and drop what's left.",
  ],
  ember: [
    'Hit me. Go on. It only makes the fire hotter.',
    "You'll be burning long after this fight is over, {o}.",
    "I'm a furnace with fists. Step in.",
  ],
  rift: [
    "Every corner of this roof is a door, {o}. You'll never know which one.",
    "Stand near the edge. I'll swap us and wave goodbye.",
    'My portals send your little shots right back at you.',
  ],
};
/** Matchup-specific openers (attacker → defender). */
const VERSUS: Record<string, string> = {
  'basalt>ember': "Your fire can't melt stone, Ember.",
  'ember>basalt': 'Stone cracks when it gets hot enough, Basalt.',
  'aerin>magna': "Metal conducts, Magna. You're a lightning rod.",
  'magna>aerin': 'Your sparks are just electrons. And electrons answer to me.',
  'shunt>rift': 'Two of us blinking around? Only one of us lands.',
  'rift>shunt': 'You hop. I open doors. There is a difference, Shunt.',
  'tether>vanta': "Here kitty. Mind the string.",
  'vanta>tether': 'I eat web-slingers for breakfast.',
  'magna>basalt': 'You are mostly iron ore, Basalt. Come here.',
  'basalt>magna': "Pull all you like, Magna. I'm heavier than your ego.",
};

/** How each fighter powers up on camera (a few just posture). */
type PowerUp = (f: Fighter, m: Match) => void;
const POWER: Record<string, PowerUp> = {
  basalt: (f, m) => { m.fx.vfx?.groundImpact(f.pos.clone(), 0xff6a1a, 3.2); m.fx.shake = 0.8; m.fx.burstDebris(f.pos.clone().setY(f.pos.y + 0.2), 18, 0x6a6a72, 7, 0.25); sfxAny.shock?.(); },
  aerin: (f, m) => {
    const sky = f.center.add(new THREE.Vector3(0.6, 7, 0.4));
    m.fx.vfx?.zap(sky, f.center, 0xb48cff, 0.3, 0.35); m.fx.vfx?.electricBall(f.center, 0xb48cff, 1.6, 0.6); m.fx.light(f.center, 0xb48cff, 40, 0.4, 10); sfxAny.zap?.();
  },
  ember: (f, m) => { m.fx.vfx?.explosion(f.pos.clone().setY(f.pos.y + 0.3), 1.3, true); m.fx.burners.push({ p: f.pos.clone(), t: 1.6, size: 0.9 }); sfxAny.explosion?.(); },
  magna: (f, m) => { m.fx.vfx?.cast(f.pos.clone().setY(f.pos.y + 0.05), 0xff5a7a, undefined, 1.8); m.fx.vfx?.bigImpact(f.center, 0xff5a7a, 0.7); sfxAny.zap?.(); },
  rift: (f, m) => { m.fx.vfx?.cast(f.center.addScaledVector(f.forward, -0.8), 0x7dff6a, f.forward, 1.6); m.fx.vfx?.cast(f.pos.clone().setY(f.pos.y + 0.05), 0x7dff6a, undefined, 1.4); sfxAny.teleport?.(); },
  shunt: (f, m) => { m.fx.vfx?.electricBall(f.center, 0x37f2ff, 1.4, 0.5); m.fx.vfx?.cast(f.pos.clone().setY(f.pos.y + 0.05), 0x37f2ff, undefined, 1.2); sfxAny.teleport?.(); },
  vanta: (f, m) => { for (let i = 0; i < 3; i++) m.fx.vfx?.hit(f.center.add(new THREE.Vector3((i - 1) * 0.35, 0.2 - i * 0.15, 0.3)).addScaledVector(f.forward, 0.4), f.forward, 0xe8c040, 0.6); sfxAny.whiff?.(); },
  tether: (f, m) => { f.vel.y = 9; f.onGround = false; f.setState('air'); m.fx.ring(f.pos.clone(), 1.6, 0xeaffff, 0.3); sfxAny.line?.(); },
};
/** Who visibly charges (aura) during their shot. */
const AURA: Record<string, number> = { aerin: 0xb48cff, ember: 0xff6a1a, magna: 0xff5a7a, basalt: 0xff7a3a, rift: 0x7dff6a };
/** Voice character per fighter for speech synthesis. */
const VOICE: Record<string, { pitch: number; rate: number; female?: boolean }> = {
  basalt: { pitch: 0.2, rate: 0.82 }, tether: { pitch: 1.2, rate: 1.12 }, aerin: { pitch: 1.15, rate: 1.0, female: true },
  shunt: { pitch: 0.75, rate: 1.0 }, vanta: { pitch: 1.0, rate: 0.95, female: true }, magna: { pitch: 0.55, rate: 0.88 },
  ember: { pitch: 0.35, rate: 0.9 }, rift: { pitch: 0.95, rate: 0.96, female: true },
};

const SHOT = 3.4; // minimum seconds per fighter (longer lines extend the shot)
const WIDE = 1.1;
const SPEAK_AT = 0.35; // seconds into a shot when the line starts

// ---------------------------------------------------------------- recorded voice lines
// public/voices/manifest.json: { fighterId: { key: { f: file, d: duration, s: speech end, m: mouth 0-9 at 30 fps } } }
interface Clip { f: string; d: number; s: number; m: string }
let manifest: Record<string, Record<string, Clip>> | null = null;
let manifestP: Promise<void> | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
function loadManifest() {
  if (!manifestP) manifestP = fetch('voices/manifest.json').then((r) => r.json()).then((j) => { manifest = j; }).catch(() => { manifest = {}; });
  return manifestP;
}
function loadClip(file: string): Promise<AudioBuffer | null> {
  let p = buffers.get(file);
  if (!p) {
    // AudioBuffers aren't tied to a context, so decode on a throwaway offline context if sound isn't unlocked yet.
    p = fetch(file).then((r) => r.arrayBuffer()).then((ab) => {
      const ctx: BaseAudioContext = audio.audioCtx() ?? new OfflineAudioContext(1, 1, 22050);
      return ctx.decodeAudioData(ab);
    }).catch(() => null);
    buffers.set(file, p);
  }
  return p;
}
/** Start fetching the manifest early (call at load). */
export function preloadVoices() { void loadManifest(); }
if (typeof window !== 'undefined') preloadVoices();


export class FightIntro {
  t = 0;
  done = false;
  private shotIdx = -1;
  private lines: [string, string];
  private keys: [string, string];
  private clips: (Clip | null)[] = [null, null];
  private bufs: (AudioBuffer | null)[] = [null, null];
  private src: AudioBufferSourceNode | null = null;
  private shotLen: [number, number] = [SHOT, SHOT];
  private spoken = [false, false];
  private speakAt = [SPEAK_AT, SPEAK_AT];
  private auraH: ({ stop(): void } | null)[] = [null, null];
  private skip = false;
  private onKey = () => { this.skip = true; };
  private padPrev = true;

  constructor(private match: Match, private vcam: VersusCamera, private el: HTMLElement, private voice: boolean) {
    const [a, b] = match.fighters;
    const la = pickLine(a, b), lb = pickLine(b, a);
    this.lines = [la.text, lb.text];
    this.keys = [la.key, lb.key];
    // Fetch both recorded lines now; shots stretch to fit the speech once the manifest is in.
    if (voice) void loadManifest().then(() => {
      match.fighters.forEach((f, i) => {
        const c = manifest?.[f.def.id]?.[this.keys[i]] ?? null;
        this.clips[i] = c;
        if (c) { this.shotLen[i] = Math.max(SHOT, SPEAK_AT + c.s + 0.9); void loadClip(c.f).then((buf) => { this.bufs[i] = buf; }); }
      });
    });
    match.introT = 100000; // hold inputs while the cinematic runs
    for (const f of match.fighters) faceOpp(f);
    el.classList.add('on');
    addEventListener('keydown', this.onKey);
    addEventListener('pointerdown', this.onKey);
  }

  /** Advance; returns false once finished. */
  update(dt: number): boolean {
    if (this.done) return false;
    this.t += dt;
    // Skip on any controller face button or Start.
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    const pressed = pads.some((g) => g && g.connected && [0, 1, 2, 3, 9].some((i) => g.buttons[i]?.pressed));
    if (pressed && !this.padPrev) this.skip = true;
    this.padPrev = pressed;
    if (this.skip) { this.finish(); return false; }

    const L0 = this.shotLen[0], L1 = this.shotLen[1];
    const idx: 0 | 1 | 2 = this.t < L0 ? 0 : this.t < L0 + L1 ? 1 : 2;
    if (idx !== this.shotIdx) this.enterShot(idx);
    if (idx < 2) {
      const f = this.match.fighters[idx];
      const local = this.t - (idx === 0 ? 0 : L0);
      const clip = this.clips[idx];
      const line = this.lines[idx as 0 | 1];
      // Speak: the recorded clip if it's ready, else the browser voice (once).
      if (!this.spoken[idx] && local >= SPEAK_AT) {
        // Give a just-requested clip a moment to arrive before falling back to the browser voice.
        const waiting = this.voice && (!manifest || (this.clips[idx] && !this.bufs[idx])) && local < SPEAK_AT + 0.8;
        if (!waiting) {
          this.spoken[idx] = true;
          this.speakAt[idx] = local;
          if (!this.playClip(idx)) this.say(f, line);
        }
      }
      // Subtitle typed out over the speech; mouth follows the clip's envelope.
      const speechLen = clip && this.bufs[idx] ? clip.s : Math.max(1.2, line.length / 15);
      const t0 = this.spoken[idx] ? this.speakAt[idx] : Infinity;
      const k = THREE.MathUtils.clamp((local - t0) / speechLen, 0, 1);
      const n = Math.min(line.length, Math.ceil(k * line.length));
      (this.el.querySelector('.iq') as HTMLElement).textContent = n > 0 ? `“${line.slice(0, n)}${n < line.length ? '' : '”'}` : '';
      let talk = 0;
      if (clip && this.src && local >= t0) {
        const fi = Math.floor((local - t0) * 30);
        talk = fi < clip.m.length ? Number(clip.m[fi]) / 9 : 0;
      } else if (local >= t0 && k < 1) {
        talk = 0.35 + 0.35 * Math.abs(Math.sin(local * 11)); // browser voice: generic chatter
      }
      f.talk(talk);
      if (local > 0.9 && local - dt <= 0.9) POWER[f.def.id]?.(f, this.match);
      if (local > (idx === 0 ? L0 : L1) - 0.5 && this.auraH[idx]) { this.auraH[idx]!.stop(); this.auraH[idx] = null; }
    } else if (this.t > L0 + L1 + WIDE) {
      this.finish();
      return false;
    }
    return true;
  }

  private enterShot(idx: number) {
    this.shotIdx = idx;
    const el = this.el;
    if (idx < 2) {
      const f = this.match.fighters[idx];
      const o = f.opp;
      // Camera in front of the fighter, slowly orbiting across their face; low and close.
      this.vcam.cinematic = { focus: () => f.center.add(new THREE.Vector3(0, 0.25, 0)), yaw: f.yaw - 0.5, dist: 1.5 + f.def.height * 0.6, h: 0.05, t: 0 };
      el.style.setProperty('--c', f.def.color);
      el.classList.toggle('right', idx === 1);
      (el.querySelector('.iname') as HTMLElement).textContent = f.def.name;
      (el.querySelector('.ititle') as HTMLElement).textContent = `${f.def.title} · vs ${o.def.name}`;
      (el.querySelector('.iq') as HTMLElement).textContent = '';
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
      if (AURA[f.def.id] && this.match.fx.vfx) {
        this.auraH[idx] = this.match.fx.vfx.status(() => f.center, 'charge', AURA[f.def.id], f.def.height);
      }
      if (['basalt', 'magna', 'shunt'].includes(f.def.id)) f.setState('victory'); // arms folded / taunt pose
      if (idx === 1) { const p = this.match.fighters[0]; p.talk(0); if (p.state === 'victory') p.setState('ground'); }
    } else {
      const p = this.match.fighters[1];
      p.talk(0);
      if (p.state === 'victory') p.setState('ground');
      el.classList.remove('show');
      this.vcam.cinematic = null;
      this.vcam.update(this.match.fighters, 0, 0, true);
    }
  }

  /** Play fighter idx's recorded line on the voice bus; false if it isn't available (falls back to speech). */
  private playClip(idx: number): boolean {
    const clip = this.clips[idx], buf = this.bufs[idx], ctx = audio.audioCtx(), bus = audio.voiceBus();
    if (!this.voice || !clip || !buf || !ctx || !bus) return false;
    try {
      this.src?.stop();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      src.start();
      this.src = src;
      audio.duckMusic(0.55, clip.s + 0.3);
      return true;
    } catch { return false; }
  }

  private say(f: Fighter, text: string) {
    if (!this.voice || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = VOICE[f.def.id] ?? { pitch: 1, rate: 1 };
      u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.95;
      const voices = synth.getVoices().filter((x) => /^en/i.test(x.lang));
      const fem = /female|samantha|victoria|zira|susan|karen|moira|tessa|fiona|serena|aria|jenny|libby|sonia/i;
      const pick = voices.find((x) => (v.female ? fem.test(x.name) : !fem.test(x.name)));
      if (pick) u.voice = pick;
      (audio as any).duckMusic?.(0.4, 3);
      synth.speak(u);
    } catch { /* speech is optional */ }
  }

  finish() {
    if (this.done) return;
    this.done = true;
    removeEventListener('keydown', this.onKey);
    removeEventListener('pointerdown', this.onKey);
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    try { this.src?.stop(); } catch { /* ignore */ }
    this.src = null;
    for (const f of this.match.fighters) f.talk(0);
    for (const h of this.auraH) h?.stop();
    for (const f of this.match.fighters) { if (f.state === 'victory' || f.state === 'air') f.setState('ground'); faceOpp(f); }
    this.el.classList.remove('on', 'show');
    this.vcam.cinematic = null;
    this.vcam.update(this.match.fighters, 0, 0, true);
    this.match.introT = 90; // READY → FIGHT!
  }
}

function pickLine(f: Fighter, o: Fighter): { text: string; key: string } {
  const vsKey = `${f.def.id}>${o.def.id}`;
  const vs = VERSUS[vsKey];
  const pool = LINES[f.def.id] ?? ['Let’s go.'];
  const nm = o.def.name.split(' ')[0];
  const oname = nm.charAt(0) + nm.slice(1).toLowerCase();
  if (vs && Math.random() < 0.6) return { text: vs, key: `vs_${o.def.id}` };
  const i = Math.floor(Math.random() * pool.length);
  const raw = pool[i];
  const s = typeof raw === 'function' ? raw(o) : raw;
  // Clip keys match the generator (scratchpad tts/gen.py): l<i>, or l<i>_<opponent> for lines naming them.
  return { text: s.replace(/\{o\}/g, oname), key: s.includes('{o}') ? `l${i}_${o.def.id}` : `l${i}` };
}

function faceOpp(f: Fighter) {
  const o = f.opp;
  f.yaw = Math.atan2(o.pos.x - f.pos.x, o.pos.z - f.pos.z);
}
