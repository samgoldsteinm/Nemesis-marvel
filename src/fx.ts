import { VFX } from './vfx';
import * as THREE from 'three';
import { BOUNDS } from './arena';

// Pooled visual effects. Debris and sparks are single InstancedMeshes so heavy fights stay cheap.
// Density scales with `quality` (lowered first when frame time is over budget).

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  rv: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  grav: number;
  color: THREE.Color;
}

/** A fading ribbon that follows a striking limb: a readable swoosh for every attack. */
export class Ribbon {
  mesh: THREE.Mesh;
  private pts: { a: THREE.Vector3; b: THREE.Vector3; life: number }[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private color: THREE.Color;
  static N = 14;
  constructor(scene: THREE.Scene, color: number) {
    const N = Ribbon.N;
    this.color = new THREE.Color(color);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3);
    this.col = new Float32Array(N * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  push(a: THREE.Vector3, b: THREE.Vector3) {
    this.pts.unshift({ a: a.clone(), b: b.clone(), life: 0.16 });
    if (this.pts.length > Ribbon.N) this.pts.pop();
  }
  update(dt: number) {
    for (const p of this.pts) p.life -= dt;
    while (this.pts.length && this.pts[this.pts.length - 1].life <= 0) this.pts.pop();
    const N = Ribbon.N;
    for (let i = 0; i < N; i++) {
      const p = this.pts[Math.min(i, this.pts.length - 1)];
      const k = p ? Math.max(0, p.life / 0.16) * (1 - i / N) : 0;
      for (let j = 0; j < 2; j++) {
        const v = p ? (j ? p.b : p.a) : this.mesh.position;
        const o = (i * 2 + j) * 3;
        this.pos[o] = v.x; this.pos[o + 1] = v.y; this.pos[o + 2] = v.z;
        const c = j ? k : k * 0.35;
        this.col[o] = this.color.r * c; this.col[o + 1] = this.color.g * c; this.col[o + 2] = this.color.b * c;
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
  }
}

/** Soft additive glow: 'shell' brightens toward the silhouette (auras), 'ball' toward the centre (flashes).
 *  Exposes .color and .level, so callers can animate it the same way. */
export class GlowMaterial extends THREE.ShaderMaterial {
  constructor(color: number, mode: 'shell' | 'ball') {
    super({
      uniforms: { gColor: { value: new THREE.Color(color) }, gOpacity: { value: 0 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY;
        void main(){ vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform vec3 gColor; uniform float gOpacity; varying vec3 vN; varying vec3 vV; varying float vY;
        void main(){
          float d = abs(dot(vN, vV));
          ${mode === 'shell'
            ? 'float a = pow(d, 0.9) * pow(1.0 - d, 1.6) * smoothstep(0.0, 0.35, vY) * smoothstep(1.0, 0.45, vY) * 3.2;'
            : 'float a = pow(d, 2.0) * 1.4;'}
          gl_FragColor = vec4(gColor * a * gOpacity, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: mode === 'shell' ? THREE.DoubleSide : THREE.FrontSide,
    });
  }
  get color() { return this.uniforms?.gColor.value as THREE.Color; }
  set color(_c: THREE.Color) { /* fixed reference; use .color.setHex */ }
  /** Glow strength (0 = invisible). */
  get level() { return this.uniforms.gOpacity.value as number; }
  set level(v: number) { this.uniforms.gOpacity.value = v; }
}

function radialTex(stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Billow { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; s0: number; s1: number; fire: boolean }

export class FX {
  quality = 1;
  private debris: THREE.InstancedMesh;
  private sparks: THREE.InstancedMesh;
  private dParts: Particle[] = [];
  private sParts: Particle[] = [];
  private billows: Billow[] = [];
  private firePool: THREE.Sprite[] = [];
  private smokePool: THREE.Sprite[] = [];
  private dustPool: THREE.Sprite[] = [];
  /** Flame-shaped additive wisps for auras (Rage, charging). */
  private wisps: { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; size: number; sway: number }[] = [];
  private wispPool: THREE.Sprite[] = [];
  /** Lingering flames (e.g. on a burnt wreck): position and remaining seconds. */
  burners: { p: THREE.Vector3; t: number; size: number }[] = [];
  /** A small fixed pool of point lights for hits, explosions and power effects (fixed count: no shader recompiles). */
  private lights: { l: THREE.PointLight; life: number; max: number; peak: number; follow?: () => THREE.Vector3 | null }[] = [];
  private puffs: THREE.InstancedMesh;
  private pParts: Particle[] = [];
  private maxP = 120;
  private rings: { m: THREE.Mesh; life: number; max: number; r0: number; r1: number }[] = [];
  private flashes: { m: THREE.Mesh; life: number; max: number; s: number }[] = [];
  private tmp = new THREE.Object3D();
  private maxD = 260;
  private maxS = 320;
  shake = 0;
  hitstop = 0;
  /** Motion-blur amount (afterimage damp) and full-screen flash, decaying. */
  blur = 0;
  blurAllowed = true;
  screenFlash = 0;

  constructor(public scene: THREE.Scene) {
    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), this.maxD);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    scene.add(this.debris);
    this.sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), this.maxS);
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.frustumCulled = false;
    this.sparks.count = 0;
    scene.add(this.sparks);
    this.puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0xb8b0a8, transparent: true, opacity: 0.45, depthWrite: false }), this.maxP);
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    scene.add(this.puffs);
    const fireTex = radialTex([[0, 'rgba(255,255,230,1)'], [0.25, 'rgba(255,200,90,0.95)'], [0.55, 'rgba(255,90,20,0.6)'], [1, 'rgba(120,20,0,0)']]);
    const smokeTex = radialTex([[0, 'rgba(70,66,64,0.85)'], [0.5, 'rgba(60,58,58,0.5)'], [1, 'rgba(40,40,40,0)']]);
    {
      // Tall, soft flame wisp: bright core fading up and out.
      const c = document.createElement('canvas');
      c.width = 32; c.height = 64;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(16, 44, 1, 16, 40, 30);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(16, 38, 12, 26, 0, 0, Math.PI * 2); g.fill();
      const wt = new THREE.CanvasTexture(c);
      for (let i = 0; i < 160; i++) {
        const w = new THREE.Sprite(new THREE.SpriteMaterial({ map: wt, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        w.visible = false; scene.add(w); this.wispPool.push(w);
      }
    }
    const dustTex = radialTex([[0, 'rgba(225,215,200,0.55)'], [0.5, 'rgba(210,200,185,0.28)'], [1, 'rgba(200,190,175,0)']]);
    for (let i = 0; i < 90; i++) {
      const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false }));
      d.visible = false; scene.add(d); this.dustPool.push(d);
    }
    for (let i = 0; i < 70; i++) {
      const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      f.visible = false; scene.add(f); this.firePool.push(f);
      const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false }));
      sm.visible = false; scene.add(sm); this.smokePool.push(sm);
    }
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 9, 2);
      scene.add(l);
      this.lights.push({ l, life: 0, max: 1, peak: 0 });
    }
    const ringGeo = new THREE.RingGeometry(0.85, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.rings.push({ m, life: 0, max: 1, r0: 0, r1: 1 });
    }
    const flashGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(flashGeo, new GlowMaterial(0xffffff, 'ball'));
      m.visible = false;
      scene.add(m);
      this.flashes.push({ m, life: 0, max: 1, s: 1 });
    }
  }

  clear() {
    this.vfx?.clear();
    this.dParts.length = 0;
    this.pParts.length = 0;
    for (const b of this.billows) b.s.visible = false;
    for (const w of this.wisps) w.s.visible = false;
    this.wisps.length = 0;
    this.billows.length = 0;
    this.burners.length = 0;
    for (const s of this.lights) { s.life = 0; s.l.intensity = 0; }
    this.sParts.length = 0;
    for (const r of this.rings) { r.life = 0; r.m.visible = false; }
    for (const f of this.flashes) { f.life = 0; f.m.visible = false; }
    this.shake = 0;
    this.hitstop = 0;
    this.blur = 0;
    this.screenFlash = 0;
  }

  burstDebris(pos: THREE.Vector3, count: number, color: number, speed = 6, size = 0.25, dir?: THREE.Vector3) {
    const n = Math.round(count * this.quality);
    for (let i = 0; i < n; i++) {
      if (this.dParts.length >= this.maxD) this.dParts.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (dir) v.addScaledVector(dir, speed * 0.6);
      const c = new THREE.Color(color).multiplyScalar(0.7 + Math.random() * 0.4);
      this.dParts.push({ p: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.5, (Math.random() - 0.5) * 0.5)), v, r: new THREE.Euler(Math.random() * 3, Math.random() * 3, 0), rv: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0), life: 1.6 + Math.random(), max: 2.6, size: size * (0.5 + Math.random()), grav: 22, color: c });
    }
  }

  sparksAt(pos: THREE.Vector3, count: number, color: number, speed = 8, size = 0.08, grav = 6) {
    if (count >= 12) this.light(pos, color, 6 + count * 0.4, 0.14, 5);
    const n = Math.round(count * this.quality);
    for (let i = 0; i < n; i++) {
      if (this.sParts.length >= this.maxS) this.sParts.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      const life = 0.25 + Math.random() * 0.35;
      this.sParts.push({ p: pos.clone(), v, r: new THREE.Euler(), rv: new THREE.Vector3(), life, max: life, size: size * (0.6 + Math.random()), grav, color: new THREE.Color(color) });
    }
  }

  private billow(pos: THREE.Vector3, fire: boolean, size: number, v: THREE.Vector3, life: number, dust = false) {
    const pool = dust ? this.dustPool : fire ? this.firePool : this.smokePool;
    const s = pool.find((x) => !x.visible);
    if (!s) return;
    s.visible = true;
    s.position.copy(pos);
    s.material.rotation = Math.random() * Math.PI * 2;
    this.billows.push({ s, v, life, max: life, s0: size * 0.5, s1: size * (fire ? 1.4 : dust ? 3 : 2.4), fire });
  }

  /** A fiery explosion: core flash, rolling fireballs, then smoke that rises and spreads. */
  fireball(pos: THREE.Vector3, size = 3) {
    const n = Math.max(4, Math.round(14 * this.quality));
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7 + 0.1, Math.random() - 0.5).normalize();
      this.billow(pos.clone().addScaledVector(d, size * 0.25), true, size * (0.6 + Math.random() * 0.6), d.multiplyScalar(size * (1 + Math.random() * 1.5)), 0.45 + Math.random() * 0.35);
    }
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.4, Math.random() - 0.5).normalize();
      this.billow(pos.clone().addScaledVector(d, size * 0.3), false, size * (0.8 + Math.random() * 0.6), d.multiplyScalar(size * 0.6).add(new THREE.Vector3(0, 1.5, 0)), 1.6 + Math.random() * 1.2);
    }
    this.screenFlash = Math.max(this.screenFlash, 0.55);
    this.blur = Math.max(this.blur, 0.55);
    this.light(pos.clone().setY(pos.y + 1), 0xff8a30, 90, 0.9, 16);
  }

  /** One aura wisp at a body point: rises, sways, flickers and fades. */
  wisp(pos: THREE.Vector3, color: THREE.Color, size: number) {
    const s = this.wispPool.find((x) => !x.visible);
    if (!s) return;
    s.visible = true;
    s.position.copy(pos);
    s.material.color.copy(color);
    const life = 0.3 + Math.random() * 0.3;
    this.wisps.push({ s, v: new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.4 + Math.random() * 1.4, (Math.random() - 0.5) * 0.4), life, max: life, size, sway: Math.random() * 6.28 });
  }

  /** Soft dust from landings, footsteps and slides. */
  dust(pos: THREE.Vector3, count: number, size = 0.35, spread = 1.5) {
    // Soft billboard puffs (no hard-edged meshes).
    const n = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * spread * (0.5 + Math.random()), 0.4 + Math.random() * 0.6, Math.sin(a) * spread * (0.5 + Math.random()));
      this.billow(pos.clone().add(new THREE.Vector3(0, 0.12 + size * 0.3, 0)), false, size * 1.6 * (0.6 + Math.random() * 0.8), v, 0.5 + Math.random() * 0.4, true);
    }
  }

  trail(pos: THREE.Vector3, color: number, size = 0.12, life = 0.35) {
    if (this.quality < 0.5 && Math.random() < 0.5) return;
    if (this.sParts.length >= this.maxS) this.sParts.shift();
    this.sParts.push({ p: pos.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6), r: new THREE.Euler(), rv: new THREE.Vector3(), life, max: life, size, grav: -1, color: new THREE.Color(color) });
  }

  ring(pos: THREE.Vector3, r1: number, color: number, dur = 0.45) {
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.life = dur;
    r.max = dur;
    r.r0 = 0.3;
    r.r1 = r1;
    r.m.position.copy(pos);
    r.m.position.y += 0.08;
    (r.m.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.m.visible = true;
  }

  /** Light the surroundings briefly: hits, explosions, casts. Optionally follow a moving source. */
  light(pos: THREE.Vector3, color: number, intensity: number, dur: number, range = 8, follow?: () => THREE.Vector3 | null) {
    if (this.quality < 0.5 && intensity < 20) return;
    const s = this.lights.reduce((a, b) => (b.life <= 0 ? b : a.life <= 0 ? a : b.life < a.life ? b : a));
    s.l.position.copy(pos);
    s.l.color.setHex(color);
    s.l.distance = range;
    s.life = dur; s.max = dur; s.peak = intensity; s.follow = follow;
  }

  flash(pos: THREE.Vector3, size: number, color: number, dur = 0.18) {
    this.light(pos, color, 9 * size, Math.max(0.12, dur * 1.3), 4 + size * 3);
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.life = dur;
    f.max = dur;
    f.s = size;
    f.m.position.copy(pos);
    (f.m.material as GlowMaterial).color.setHex(color);
    f.m.visible = true;
  }

  /** Ported Binbun shader effects (hits, impacts, projectiles, statuses). */
  vfx: VFX | null = null;

  update(dt: number) {
    if (this.vfx) { this.vfx.quality = this.quality; this.vfx.update(dt); }
    const t = this.tmp;
    let i = 0;
    for (let k = this.dParts.length - 1; k >= 0; k--) {
      const d = this.dParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.dParts.splice(k, 1); continue; }
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < d.size * 0.5 && Math.abs(d.p.x) < BOUNDS.hw && Math.abs(d.p.z) < BOUNDS.hd) {
        d.p.y = d.size * 0.5;
        d.v.y *= -0.3;
        d.v.x *= 0.6;
        d.v.z *= 0.6;
        d.rv.multiplyScalar(0.6);
      }
      d.r.x += d.rv.x * dt;
      d.r.y += d.rv.y * dt;
      const s = d.size * Math.min(1, d.life / 0.4);
      t.position.copy(d.p);
      t.rotation.copy(d.r);
      t.scale.setScalar(s);
      t.updateMatrix();
      this.debris.setMatrixAt(i, t.matrix);
      this.debris.setColorAt(i, d.color);
      i++;
    }
    this.debris.count = i;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;

    i = 0;
    for (let k = this.sParts.length - 1; k >= 0; k--) {
      const d = this.sParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.sParts.splice(k, 1); continue; }
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      const f = d.life / d.max;
      t.position.copy(d.p);
      t.rotation.set(0, 0, 0);
      t.scale.set(d.size * f, d.size * f * 2.2, d.size * f);
      t.updateMatrix();
      this.sparks.setMatrixAt(i, t.matrix);
      this.sparks.setColorAt(i, d.color);
      i++;
    }
    this.sparks.count = i;
    this.sparks.instanceMatrix.needsUpdate = true;
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;

    i = 0;
    for (let k = this.pParts.length - 1; k >= 0; k--) {
      const d = this.pParts[k];
      d.life -= dt;
      if (d.life <= 0) { this.pParts.splice(k, 1); continue; }
      d.v.multiplyScalar(Math.exp(-3 * dt));
      d.v.y -= d.grav * dt;
      d.p.addScaledVector(d.v, dt);
      const f = 1 - d.life / d.max;
      t.position.copy(d.p);
      t.rotation.set(0, 0, 0);
      t.scale.setScalar(d.size * (0.6 + f * 1.2) * (1 - f * f));
      t.updateMatrix();
      this.puffs.setMatrixAt(i, t.matrix);
      i++;
    }
    this.puffs.count = i;
    this.puffs.instanceMatrix.needsUpdate = true;

    for (let k = this.billows.length - 1; k >= 0; k--) {
      const b = this.billows[k];
      b.life -= dt;
      if (b.life <= 0) { b.s.visible = false; this.billows.splice(k, 1); continue; }
      const f = 1 - b.life / b.max;
      b.v.multiplyScalar(Math.exp(-(b.fire ? 3 : 1.2) * dt));
      if (!b.fire && b.s1 / Math.max(1e-3, b.s0) < 5.5) b.v.y += 0.8 * dt;
      b.s.position.addScaledVector(b.v, dt);
      const sc = b.s0 + (b.s1 - b.s0) * (1 - (1 - f) * (1 - f));
      b.s.scale.set(sc, sc, 1);
      b.s.material.opacity = b.fire ? Math.max(0, 1 - f * 1.15) : Math.max(0, Math.min(1, f * 4) * (1 - f)) * 0.9;
      b.s.material.rotation += dt * 0.4;
    }
    for (let k = this.wisps.length - 1; k >= 0; k--) {
      const w = this.wisps[k];
      w.life -= dt;
      if (w.life <= 0) { w.s.visible = false; this.wisps.splice(k, 1); continue; }
      const f = 1 - w.life / w.max;
      w.sway += dt * 9;
      w.s.position.x += (w.v.x + Math.sin(w.sway) * 0.35) * dt;
      w.s.position.y += w.v.y * dt;
      w.s.position.z += (w.v.z + Math.cos(w.sway) * 0.35) * dt;
      const sc = w.size * (1 - f * 0.6);
      w.s.scale.set(sc * 0.55, sc * (1 + f * 0.6), 1);
      w.s.material.opacity = Math.sin(Math.min(1, f * 1.4) * Math.PI) * (0.75 + Math.random() * 0.25);
    }
    for (const bn of this.burners) {
      bn.t -= dt;
      if (Math.random() < dt * 14 * this.quality) this.billow(bn.p.clone().add(new THREE.Vector3((Math.random() - 0.5) * bn.size, 0, (Math.random() - 0.5) * bn.size)), true, bn.size * (0.5 + Math.random() * 0.4), new THREE.Vector3(0, 2 + Math.random() * 1.5, 0), 0.5);
      if (Math.random() < dt * 6 * this.quality) this.billow(bn.p.clone().add(new THREE.Vector3(0, bn.size, 0)), false, bn.size, new THREE.Vector3((Math.random() - 0.5) * 0.5, 2, (Math.random() - 0.5) * 0.5), 2.2);
    }
    this.burners = this.burners.filter((b) => b.t > 0);

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const f = 1 - r.life / r.max;
      const s = r.r0 + (r.r1 - r.r0) * (1 - (1 - f) * (1 - f));
      r.m.scale.set(s, 1, s);
      (r.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f);
      if (r.life <= 0) r.m.visible = false;
    }
    for (const fl of this.flashes) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      const f = 1 - fl.life / fl.max;
      fl.m.scale.setScalar(fl.s * (0.5 + f));
      (fl.m.material as GlowMaterial).level = Math.max(0, 1 - f);
      if (fl.life <= 0) fl.m.visible = false;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.blur = Math.max(0, this.blur - dt * 2.2);
    for (const s of this.lights) {
      if (s.life <= 0) { s.l.intensity = 0; continue; }
      s.life -= dt;
      const f = Math.max(0, s.life / s.max);
      s.l.intensity = s.peak * f * f;
      const p = s.follow?.();
      if (p) s.l.position.copy(p);
    }
    this.screenFlash = Math.max(0, this.screenFlash - dt * 4);
  }
}
