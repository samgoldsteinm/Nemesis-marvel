// Deterministic random numbers for anything that affects gameplay state (online play runs the same
// simulation on both machines, so both must draw the same numbers in the same order). Purely visual
// randomness (particles, textures, decals, audio) keeps using Math.random.

/** mulberry32: small, fast, good enough for gameplay variety. */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  seed(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  get state() { return this.s; }
  set state(v: number) { this.s = v >>> 0; }
}

/** The match simulation's RNG. Seeded at every match (re)start; never use it from rendering code. */
export const simRng = new Rng(0x9e3779b9);
/** Gameplay random in [0, 1). */
export const srand = () => simRng.next();
/** A fresh seed for an offline match (any value works; online the host picks it and sends it). */
export const newSeed = () => (Math.random() * 0xffffffff) >>> 0;
