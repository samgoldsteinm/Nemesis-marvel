import * as THREE from 'three';

// Stylised combat VFX, re-implemented in GLSL from the ideas in Binbun3D's CC0 Godot packs
// (Stylized Hit FX, Electric FX, Explosion FX, Elemental Magic FX, Status FX, Magic Projectiles,
// Beam VFX, Muzzle Flash VFX). Everything is drawn by two instanced meshes (additive glow layer and
// an alpha-blended smoke layer): one draw call each. Particles are animated entirely on the GPU from
// their spawn parameters, so the CPU only writes a slot when something spawns. Persistent elements
// (status auras, beams, projectile cores) live in reserved slots whose position is rewritten per frame.

type Col = THREE.ColorRepresentation;

// Shape modes (fragment) and orientation types (vertex).
const M = {
  GLOW: 0, FLARE: 1, STAR: 2, CORE: 3, STREAK: 4, SPIRAL: 5, RING: 6, SHELL: 7, FIRE: 8, FLASH: 9,
  SLASH: 10, EBALL: 11, DIZZY: 12, CIRCLE: 13, WISP: 14, BOLT: 15, SMOKE: 16, SHARD: 17, AURA: 18,
  BIND: 19, ORB: 20, BEAM: 21,
} as const;
const O = { BILL: 0, STRETCH: 1, PLANE: 2, SEG: 3 } as const;

const VERT = /* glsl */ `
uniform float uTime;
attribute vec4 aP0;   // pos xyz, start time
attribute vec4 aV;    // velocity xyz, life
attribute vec4 aD;    // dir / normal / segment vector xyz, gravity
attribute vec4 aC1;   // colour 1 rgb, intensity
attribute vec4 aC2;   // colour 2 rgb, mode
attribute vec4 aS;    // size0, size1, seed, rotation
attribute vec4 aX;    // drag, spin, orient, param
varying vec2 vUv;
varying float vT;
varying float vAge;
varying vec4 vC1;
varying vec4 vC2;
varying vec4 vS;
varying float vParam;
varying float vLen;
varying float vFade;
void main() {
  float age = uTime - aP0.w;
  float t = age / max(aV.w, 1e-4);
  vUv = position.xy * 2.0;
  vFade = smoothstep(0.0, 0.08, age) * smoothstep(0.0, 0.18, aV.w - age);
  vT = t; vAge = age; vC1 = aC1; vC2 = aC2; vS = aS; vParam = aX.w; vLen = 1.0;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = aX.x;
  vec3 disp = k > 0.001 ? aV.xyz * (1.0 - exp(-k * age)) / k : aV.xyz * age;
  vec3 c = aP0.xyz + disp + vec3(0.0, -0.5 * aD.w * age * age, 0.0);
  float te = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(aS.x, aS.y, te);
  float rot = aS.w + aX.y * age;
  vec2 q = position.xy;
  float cr = cos(rot), sr = sin(rot);
  int orient = int(aX.z + 0.5);
  vec4 mv;
  if (orient == 0) {
    mv = viewMatrix * vec4(c, 1.0);
    mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * size;
  } else if (orient == 1) {
    // Stretched along the projected direction of motion (or aD when there's no velocity).
    vec3 dir = length(aV.xyz) > 0.001 ? aV.xyz * (k > 0.001 ? exp(-k * age) : 1.0) + vec3(0.0, -aD.w * age, 0.0) : aD.xyz;
    vec3 dv = (viewMatrix * vec4(dir, 0.0)).xyz;
    vec2 ax = length(dv.xy) > 1e-4 ? normalize(dv.xy) : vec2(1.0, 0.0);
    vec2 pp = vec2(-ax.y, ax.x);
    mv = viewMatrix * vec4(c, 1.0);
    int md = int(aC2.a + 0.5);
    bool flatQ = md == 9 || md == 10;
    float len = size * (flatQ ? 1.0 : 1.0 + aX.w * (1.0 - t));
    mv.xy += ax * q.x * len + pp * q.y * size * (flatQ ? 1.0 : 0.18);
  } else if (orient == 2) {
    vec3 n = normalize(aD.xyz);
    vec3 tA = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 tB = cross(n, tA);
    vec2 rq = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * size;
    mv = viewMatrix * vec4(c + tA * rq.x + tB * rq.y, 1.0);
  } else {
    // Segment: from c to c + aD, widened perpendicular to the axis and the view ray.
    vec4 s = viewMatrix * vec4(c, 1.0);
    vec4 e = viewMatrix * vec4(c + aD.xyz, 1.0);
    vec3 axv = e.xyz - s.xyz;
    vec3 mid = (s.xyz + e.xyz) * 0.5;
    vec3 side = normalize(cross(axv, mid));
    mv = vec4(mix(s.xyz, e.xyz, q.x + 0.5) + side * q.y * size, 1.0);
    vLen = length(axv) / max(size, 1e-3);
  }
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform sampler2D uAtlas;
uniform float uSmoke;
varying vec2 vUv;
varying float vT;
varying float vAge;
varying vec4 vC1;
varying vec4 vC2;
varying vec4 vS;
varying float vParam;
varying float vLen;
varying float vFade;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.55 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.7) * 0.15; }
float star5(vec2 p, float r, float rf) {
  // Signed distance to a five-pointed star (iq).
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
void main() {
  vec2 uv = vUv;
  float t = clamp(vT, 0.0, 1.0);
  float seed = vS.z;
  int mode = int(vC2.a + 0.5);
  float r = length(uv);
  float ang = atan(uv.x, uv.y);
  float v = 0.0;   // shape value 0..1 (mixes colour 2 -> colour 1)
  float a = 0.0;   // coverage
  if (mode == 0) { // GLOW
    v = pow(max(1.0 - r, 0.0), 2.2); a = v * (1.0 - t);
  } else if (mode == 1) { // FLARE: streaky radial flash
    float s = pow(cos((ang + seed) * 3.0) * 0.5 + 0.5, 16.0) * (sin((ang + seed) * 12.0) * 0.5 + 0.5);
    float rad = pow(max(1.0 - r, 0.0), 3.0);
    v = max(rad * 0.9, s * pow(max(1.0 - r, 0.0), 1.2) * 1.4);
    v *= 0.6 + 0.4 * (sin((ang + seed) * 5.0 + seed) * 0.5 + 0.5);
    a = smoothstep(0.02, 0.5, v) * pow(1.0 - t, 1.5);
  } else if (mode == 2) { // STAR: four-point star that thins as it ages
    vec2 q = abs(uv);
    float e = mix(1.6, 0.18, t);
    float k = pow(q.x, e) + pow(q.y, e);
    v = smoothstep(0.95, 0.6, k); a = v * (1.0 - t * t);
  } else if (mode == 3) { // CORE: expanding impact ring with streak spikes
    float off = abs(sin(ang * 3.5 + seed)) * r * 0.6 + (fbm(vec2(ang * 3.0 + seed, seed)) - 0.5) * 0.15;
    float rr = r + off * 0.5;
    float w = 1.0 - abs(rr * 2.0 - (t * 2.6 + 0.1)) * 2.2;
    v = smoothstep(0.1, 0.9, w * pow(max(1.0 - r, 0.0), 0.15));
    a = v * (1.0 - t);
  } else if (mode == 4) { // STREAK: tapered spark
    float x = uv.x * 0.5 + 0.5;
    float body = (1.0 - abs(uv.y)) * smoothstep(0.0, 0.2, x) * (1.0 - smoothstep(0.75, 1.0, x));
    v = pow(max(body, 0.0), 1.5) * (0.5 + x * 0.5); a = v * (1.0 - t);
  } else if (mode == 5) { // SPIRAL dust
    float sp = pow(abs(sin(ang * 1.5 + seed + r * 3.0 - vAge * 6.0)), 2.0);
    float n = fbm(vec2((ang + r * 2.0) * 1.2, r * 3.0 - vAge * 1.5) + seed);
    float ring = smoothstep(0.15 + t * 0.5, 0.5 + t * 0.4, r) * smoothstep(1.0, 0.75, r);
    v = sp * n * ring * 2.2; a = smoothstep(0.05, 0.6, v) * (1.0 - t);
  } else if (mode == 6) { // RING: flat shock ring with breakup
    float rad = mix(0.15, 0.95, 1.0 - pow(1.0 - t, 3.0));
    float w = mix(0.16, 0.03, t);
    float n = fbm(vec2(ang * 4.0 + seed, t * 2.0));
    float ring = 1.0 - abs(r - rad) / w;
    v = clamp(ring, 0.0, 1.0) * (0.55 + 0.6 * n); a = smoothstep(0.0, 0.6, v) * (1.0 - t);
  } else if (mode == 7) { // SHELL: sphere shock that dissolves into noise
    if (r > 1.0) discard;
    float rim = smoothstep(0.55, 0.97, r) * smoothstep(1.0, 0.94, r) + pow(r, 4.0) * 0.25;
    float n = fbm(uv * 2.5 + seed + vAge * 0.8);
    float d = smoothstep(t * 1.1 - 0.1, t * 1.1 + 0.15, n);
    v = rim * d; a = v * 0.9;
  } else if (mode == 8) { // FIRE: billowing hot puff
    float n = fbm(uv * 1.8 + vec2(seed, seed * 1.7 - vAge * 1.5));
    float shape = max(1.0 - r, 0.0) * (0.6 + n * 1.1);
    float th = t * 0.85;
    v = smoothstep(th, th + 0.35, shape);
    a = v * smoothstep(1.0, 0.7, t);
    v = mix(v * 0.55, v, 1.0 - t); // cools toward the secondary colour
  } else if (mode == 9) { // FLASH: muzzle flash texture from the atlas
    float idx = vParam;
    vec2 cell = vec2(mod(idx, 2.0), floor(idx / 2.0));
    vec2 tuv = (clamp(uv * 0.5 + 0.5, 0.0, 1.0) + cell) * 0.5;
    tuv.y = 1.0 - tuv.y;
    float tex = texture2D(uAtlas, tuv).r;
    v = pow(tex, 1.4); a = v * (1.0 - t) * smoothstep(1.0, 0.85, max(abs(uv.x), abs(uv.y)));
  } else if (mode == 10) { // SLASH: sweeping crescent
    vec2 p = vParam > 0.5 ? vec2(-uv.y, uv.x) : uv;
    float d = length(p - vec2(0.0, -1.05));
    float thick = 0.22 * (1.0 - abs(p.x)) + 0.02;
    float arc = 1.0 - abs(d - 1.35) / thick;
    float head = -1.0 + t * 3.2, tail = head - 1.1;
    float sweep = vParam > 0.5 ? 1.0 : smoothstep(tail, tail + 0.6, p.x) * smoothstep(head + 0.05, head - 0.25, p.x);
    v = clamp(arc, 0.0, 1.0) * sweep * (0.75 + 0.25 * fbm(p * 4.0 + seed + (vParam > 0.5 ? vec2(0.0, -vAge * 6.0) : vec2(0.0))));
    a = smoothstep(0.05, 0.5, v) * (vParam > 0.5 ? vFade : 1.0 - t * t);
  } else if (mode == 11) { // EBALL: crackling electric sphere
    float flick = floor(vAge * 24.0);
    float n = fbm(uv * 3.0 + vec2(flick * 1.37 + seed, flick * 0.71));
    float lines = 1.0 - smoothstep(0.0, 0.06, abs(n - 0.5));
    float core = pow(max(1.0 - r, 0.0), 3.0);
    float mask = smoothstep(1.0, 0.6, r);
    v = max(core, lines * mask); a = clamp(v, 0.0, 1.0) * (1.0 - t * t);
  } else if (mode == 12) { // DIZZY star
    float d = star5(uv * 1.1, 0.7, 0.45);
    v = 1.0 - smoothstep(-0.02, 0.06, d);
    float halo = exp(-max(d, 0.0) * 10.0) * 0.45;
    a = max(v, halo) * vFade;
    v = max(v, halo * 0.3);
  } else if (mode == 13) { // CIRCLE: rotating magic circle
    float spin = vAge * 2.0 + seed;
    float ring1 = 1.0 - abs(r - 0.9) / 0.05;
    float ring2 = 1.0 - abs(r - 0.68) / 0.035;
    float ticks = step(0.5, fract((ang + spin) * 24.0 / 6.2831)) * step(abs(r - 0.79), 0.06);
    float tri = abs(sin((ang - spin * 0.6) * 1.5)) ;
    float spokes = (1.0 - smoothstep(0.0, 0.05, abs(r * tri - 0.45))) * step(r, 0.68);
    v = clamp(max(max(ring1, ring2), max(ticks * 0.8, spokes * 0.7)), 0.0, 1.0);
    float grow = smoothstep(0.0, 0.2, t);
    a = v * grow * (1.0 - smoothstep(0.6, 1.0, t)) * step(r, 0.97 * mix(0.6, 1.0, grow) + 0.04);
  } else if (mode == 14) { // WISP: soft flame tongue
    vec2 p = uv;
    float wv = sin(p.y * 3.0 + vAge * 9.0 + seed) * 0.12 * (p.y + 1.0);
    p.x += wv;
    float wdt = 0.55 * (1.0 - (p.y * 0.5 + 0.5) * 0.75);
    float d = length(vec2(p.x / max(wdt, 0.05), (p.y + 0.3) * 0.75));
    v = pow(max(1.0 - d, 0.0), 1.4) * (0.7 + 0.5 * fbm(p * 2.5 + vec2(seed, -vAge * 3.0)));
    a = smoothstep(0.0, 0.5, v) * sin(t * 3.14159);
  } else if (mode == 15 || mode == 21) { // BOLT / BEAM segment
    float y = uv.y;
    float x = uv.x * 0.5 + 0.5;
    float ends = smoothstep(0.0, 0.04, x) * smoothstep(1.0, 0.96, x);
    if (mode == 15) {
      float core = exp(-abs(y) * 9.0);
      float glow = exp(-abs(y) * 2.6) * 0.45;
      float flick = step(0.25, hash(vec2(floor(vAge * 30.0), seed)));
      v = core; a = max(core, glow) * ends * (1.0 - t) * mix(0.35, 1.0, flick);
    } else {
      float n = fbm(vec2(x * vLen * 0.35 - vAge * 7.0, y * 1.5 + seed));
      float core = exp(-abs(y) * 7.0) * (0.85 + 0.3 * sin(vAge * 40.0 + x * 20.0));
      float outer = smoothstep(0.2 + abs(y) * 0.9, 0.9, n + 0.35) * (1.0 - abs(y));
      v = core; a = clamp(core + outer * 0.6, 0.0, 1.0) * ends * vFade;
    }
  } else if (mode == 16) { // SMOKE (alpha layer)
    float n = fbm(uv * 1.6 + vec2(seed, seed * 0.7 - vAge * 0.4));
    float shape = max(1.0 - r, 0.0) * (0.5 + n);
    v = smoothstep(t * 0.6, t * 0.6 + 0.35, shape);
    a = v * 0.8 * smoothstep(0.0, 0.08, t) * (1.0 - t * t);
  } else if (mode == 17) { // SHARD: faceted ice / glass chip
    vec2 p = uv;
    float d = abs(p.x) * 1.7 + abs(p.y);
    if (d > 1.0) discard;
    float facet = step(0.0, p.x * 0.6 + p.y);
    v = mix(0.55, 1.0, facet) * smoothstep(1.0, 0.85, d);
    a = smoothstep(1.0, 0.9, d) * (1.0 - smoothstep(0.75, 1.0, t));
  } else if (mode == 18) { // AURA: soft body-hugging energy shell
    vec2 p = vec2(uv.x * 1.35, uv.y);
    float rr = length(p);
    float n = fbm(vec2(ang * 2.0 + seed, rr * 2.0 - vAge * 2.5));
    float streams = pow(abs(sin(uv.x * 5.0 + n * 3.0 + vAge * 2.0)), 6.0) * smoothstep(-1.0, 0.6, uv.y);
    float rim = smoothstep(0.45, 0.92, rr + (n - 0.5) * 0.35) * smoothstep(1.0, 0.86, rr + (n - 0.5) * 0.2);
    v = clamp(rim + streams * 0.35 * smoothstep(1.0, 0.6, rr), 0.0, 1.0);
    a = v * 0.7 * vFade;
  } else if (mode == 19) { // BIND: rotating segmented ring (snare)
    float spin = vAge * 3.0 + seed;
    float ring = 1.0 - abs(r - 0.85) / 0.11;
    float seg = smoothstep(0.2, 0.35, abs(sin((ang + spin) * 3.0)));
    v = clamp(ring, 0.0, 1.0) * seg; a = v * vFade;
  } else if (mode == 20) { // ORB: swirling projectile core
    float sw = fbm(vec2(ang * 1.5 + vAge * 6.0 + seed, r * 3.0 - vAge * 4.0));
    float core = pow(max(1.0 - r, 0.0), 2.5);
    float shell = smoothstep(1.0, 0.5, r) * sw;
    v = max(core * 1.2, shell * 0.8); a = clamp(v, 0.0, 1.0) * vFade;
  }
  if (a <= 0.002) discard;
  vec3 col = mix(vC2.rgb, vC1.rgb, clamp(v, 0.0, 1.0)) * vC1.a;
  if (uSmoke > 0.5) gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  else gl_FragColor = vec4(col * clamp(a, 0.0, 1.0), 1.0);
}`;

interface Spec {
  mode: number; orient: number;
  px: number; py: number; pz: number; vx: number; vy: number; vz: number;
  dx: number; dy: number; dz: number; grav: number; life: number; delay: number;
  s0: number; s1: number; seed: number; rot: number; drag: number; spin: number; param: number;
  c1: THREE.Color; c2: THREE.Color; inten: number;
}
function newSpec(): Spec {
  return { mode: 0, orient: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, dx: 0, dy: 1, dz: 0, grav: 0, life: 0.5, delay: 0, s0: 1, s1: 1, seed: 0, rot: 0, drag: 0, spin: 0, param: 0, c1: new THREE.Color(1, 1, 1), c2: new THREE.Color(1, 0.8, 0.4), inten: 1 };
}

class Layer {
  mesh: THREE.Mesh;
  private a: Record<string, THREE.InstancedBufferAttribute> = {};
  private next = 0;
  private dmin = Infinity;
  private dmax = -1;
  private free: number[] = [];
  readonly transient: number;
  constructor(scene: THREE.Scene, readonly cap: number, persistent: number, smoke: boolean, uniforms: Record<string, THREE.IUniform>) {
    this.transient = cap - persistent;
    for (let i = cap - 1; i >= this.transient; i--) this.free.push(i);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    for (const n of ['aP0', 'aV', 'aD', 'aC1', 'aC2', 'aS', 'aX']) {
      const arr = new Float32Array(cap * 4);
      if (n === 'aV') for (let i = 0; i < cap; i++) arr[i * 4 + 3] = 1;
      if (n === 'aP0') for (let i = 0; i < cap; i++) arr[i * 4 + 3] = -1e6;
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(n, at);
      this.a[n] = at;
    }
    g.instanceCount = cap;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...uniforms, uSmoke: { value: smoke ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = smoke ? 5 : 6;
    scene.add(this.mesh);
  }
  private mark(i: number) { if (i < this.dmin) this.dmin = i; if (i > this.dmax) this.dmax = i; }
  private put(n: string, i: number, x: number, y: number, z: number, w: number) {
    const arr = this.a[n].array as Float32Array; const o = i * 4;
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w;
  }
  write(i: number, s: Spec, now: number) {
    this.put('aP0', i, s.px, s.py, s.pz, now + s.delay);
    this.put('aV', i, s.vx, s.vy, s.vz, s.life);
    this.put('aD', i, s.dx, s.dy, s.dz, s.grav);
    this.put('aC1', i, s.c1.r, s.c1.g, s.c1.b, s.inten);
    this.put('aC2', i, s.c2.r, s.c2.g, s.c2.b, s.mode);
    this.put('aS', i, s.s0, s.s1, s.seed, s.rot);
    this.put('aX', i, s.drag, s.spin, s.orient, s.param);
    this.mark(i);
  }
  spawn(s: Spec, now: number) { const i = this.next; this.next = (this.next + 1) % this.transient; this.write(i, s, now); }
  claim(): number { return this.free.length ? this.free.pop()! : -1; }
  release(i: number) { if (i < 0) return; const arr = this.a.aP0.array as Float32Array; arr[i * 4 + 3] = -1e6; this.mark(i); this.free.push(i); }
  setPos(i: number, x: number, y: number, z: number) { const arr = this.a.aP0.array as Float32Array; arr[i * 4] = x; arr[i * 4 + 1] = y; arr[i * 4 + 2] = z; this.mark(i); }
  setDir(i: number, x: number, y: number, z: number) { const arr = this.a.aD.array as Float32Array; arr[i * 4] = x; arr[i * 4 + 1] = y; arr[i * 4 + 2] = z; this.mark(i); }
  setRot(i: number, r: number) { const arr = this.a.aS.array as Float32Array; arr[i * 4 + 3] = r; this.mark(i); }
  /** End a persistent slot `fade` seconds from now (the shader fades it out over its last 0.18 s). */
  setLifeEnd(i: number, now: number, fade = 0.18) {
    if (i < 0) return;
    const p = this.a.aP0.array as Float32Array, v = this.a.aV.array as Float32Array;
    v[i * 4 + 3] = Math.min(v[i * 4 + 3], now - p[i * 4 + 3] + fade);
    this.mark(i);
  }
  resetAll() {
    const p = this.a.aP0.array as Float32Array;
    for (let i = 0; i < this.cap; i++) p[i * 4 + 3] = -1e6;
    this.free.length = 0;
    for (let i = this.cap - 1; i >= this.transient; i--) this.free.push(i);
    this.mark(0); this.mark(this.cap - 1);
  }
  flush() {
    if (this.dmax < 0) return;
    for (const n in this.a) {
      const at = this.a[n];
      // Ranges accumulate until the renderer uploads (and clears) them; several updates can run per render.
      if (at.updateRanges.length > 32) { at.clearUpdateRanges(); at.addUpdateRange(0, this.cap * 4); }
      else at.addUpdateRange(this.dmin * 4, (this.dmax - this.dmin + 1) * 4);
      at.needsUpdate = true;
    }
    this.dmin = Infinity; this.dmax = -1;
  }
}

const PERSIST_LIFE = 1e5;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _c = new THREE.Color();
const _zf = new THREE.Vector3();
const _zt = new THREE.Vector3();
const _e = new THREE.Vector3();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export type StatusKind = 'stun' | 'snare' | 'burn' | 'rage' | 'charge' | 'shatter';
export interface StatusHandle { stop(): void; readonly alive: boolean }
export interface BeamHandle { set(from: THREE.Vector3, to: THREE.Vector3): void; stop(): void }
export interface ProjectileHandle { set(pos: THREE.Vector3, dir: THREE.Vector3): void; stop(impact?: boolean): void }

interface Persistent { update(dt: number): boolean; kill(): void } // update returns false when finished

export class VFX {
  /** 0..1: scales particle counts (call sites never get zero of an essential layer). */
  quality = 1;
  /** Optional hook so the game can add a real point light for big moments. */
  onLight: ((pos: THREE.Vector3, color: THREE.Color, intensity: number, dur: number) => void) | null = null;
  time = 0;
  private glow: Layer;
  private smoke: Layer;
  private s = newSpec();
  private live: Persistent[] = [];
  readonly atlas: THREE.Texture;

  constructor(scene: THREE.Scene, base = '') {
    this.atlas = new THREE.TextureLoader().load(`${base}vfx/flash_atlas.png`);
    this.atlas.colorSpace = THREE.NoColorSpace;
    const uniforms = { uTime: { value: 0 }, uAtlas: { value: this.atlas } };
    this.glow = new Layer(scene, 1400, 96, false, uniforms);
    this.smoke = new Layer(scene, 320, 0, true, uniforms);
  }

  private n(count: number, min = 1) { return Math.max(min, Math.round(count * this.quality)); }
  private spec(mode: number, orient: number, p: THREE.Vector3, life: number, s0: number, s1: number, c1: Col, c2: Col, inten: number) {
    const s = this.s;
    s.mode = mode; s.orient = orient; s.px = p.x; s.py = p.y; s.pz = p.z; s.vx = s.vy = s.vz = 0; s.dx = 0; s.dy = 1; s.dz = 0;
    s.grav = 0; s.life = life; s.delay = 0; s.s0 = s0; s.s1 = s1; s.seed = Math.random() * 100; s.rot = Math.random() * Math.PI * 2;
    s.drag = 0; s.spin = 0; s.param = 0; s.c2.set(c2); s.c1.set(c1).lerp(s.c2, 0.3); s.inten = inten * 0.72;
    return s;
  }
  private emit(s = this.s) { this.glow.spawn(s, this.time); }

  // ------------------------------------------------------------------ hits
  /** Stylised hit spark: flare, four-point star, streaks and a slash arc. strength 0 = jab, 1 = heavy. */
  hit(pos: THREE.Vector3, dir: THREE.Vector3, color: Col = 0xffb040, strength = 0.5) {
    const k = THREE.MathUtils.clamp(strength, 0, 1);
    const sz = 0.7 + k * 0.9;
    this.emit(this.spec(M.FLARE, O.BILL, pos, 0.2 + k * 0.08, sz * 0.6, sz * 1.3, 0xffffff, color, 1.0));
    const st = this.spec(M.STAR, O.BILL, pos, 0.25 + k * 0.15, sz * 0.5, sz * 1.1, 0xfff6e0, color, 1.6);
    st.rot = rnd(-0.3, 0.3); this.emit(st);
    this.emit(this.spec(M.GLOW, O.BILL, pos, 0.16, sz * 0.5, sz * 0.8, color, color, 0.35));
    const sl = this.spec(M.SLASH, O.BILL, pos, 0.2 + k * 0.06, sz * 1.5, sz * 1.7, 0xffffff, color, 1.6);
    sl.rot = rnd(-0.8, 0.8) + (Math.random() < 0.5 ? 0 : Math.PI);
    this.emit(sl);
    if (k > 0.45) this.emit(this.spec(M.CORE, O.BILL, pos, 0.3, sz * 1.2, sz * 1.6, 0xffffff, color, 1.1));
    const n = this.n(4 + Math.round(k * 8), 3);
    for (let i = 0; i < n; i++) this.spark(pos, dir, color, 6 + k * 8, 0.55, 0.1 + k * 0.06);
    if (k > 0.6) this.light(pos, color, 6 + k * 10, 0.18);
  }

  /** Velocity-aligned spark biased along dir (cone), with drag and a little gravity. */
  spark(pos: THREE.Vector3, dir: THREE.Vector3 | null, color: Col, speed: number, cone: number, size: number) {
    _v.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
    if (dir && dir.lengthSq() > 1e-6) _v.multiplyScalar(cone).add(_w.copy(dir).normalize()).normalize();
    const sp = speed * rnd(0.5, 1.2);
    const s = this.spec(M.STREAK, O.STRETCH, pos, rnd(0.18, 0.35), size * 3, size * 2, 0xffffff, color, 1.3);
    s.vx = _v.x * sp; s.vy = _v.y * sp; s.vz = _v.z * sp; s.drag = 4; s.grav = 6; s.param = 1.5;
    this.emit(s);
  }

  /** Big impact: noisy sphere shock, impact core ring, spiral dust, star, streaks. Launchers, slams, finishers. */
  bigImpact(pos: THREE.Vector3, color: Col = 0xff9a3a, scale = 1) {
    const S = scale;
    this.emit(this.spec(M.SHELL, O.BILL, pos, 0.45, 0.8 * S, 3.0 * S, color, color, 0.75));
    this.emit(this.spec(M.CORE, O.BILL, pos, 0.4, 1.6 * S, 2.6 * S, 0xfff0d8, color, 1.1));
    this.emit(this.spec(M.FLARE, O.BILL, pos, 0.18, 0.8 * S, 1.6 * S, 0xffffff, color, 0.8));
    const st = this.spec(M.STAR, O.BILL, pos, 0.35, 1.2 * S, 2.4 * S, 0xffffff, color, 1.2); st.rot = 0; this.emit(st);
    const sp = this.spec(M.SPIRAL, O.BILL, pos, 0.6, 1.6 * S, 3.2 * S, 0xffe8c8, color, 1.0); this.emit(sp);
    this.emit(this.spec(M.GLOW, O.BILL, pos, 0.3, 1.2 * S, 1.8 * S, color, color, 0.25));
    const n = this.n(16, 6);
    for (let i = 0; i < n; i++) this.spark(pos, null, color, 14 * S, 1, 0.16 * S);
    this.light(pos, _c.set(color), 26 * S, 0.3);
  }

  /** Ground shock: flat ring + inner ring, dust spray and debris sparks. Ground pound, quakes, landings. */
  groundImpact(pos: THREE.Vector3, color: Col = 0xffa050, radius = 3) {
    _u.set(0, 1, 0);
    const p = _w.copy(pos); p.y += 0.04;
    const r1 = this.spec(M.RING, O.PLANE, p, 0.5, radius * 0.4, radius * 2.1, 0xffffff, color, 1.2); r1.dx = 0; r1.dy = 1; r1.dz = 0; this.emit(r1);
    const r2 = this.spec(M.RING, O.PLANE, p, 0.35, radius * 0.2, radius * 1.2, 0xfff0d0, color, 1.0); this.emit(r2);
    const g = this.spec(M.GLOW, O.PLANE, p, 0.3, radius * 0.8, radius * 1.4, color, color, 0.5); this.emit(g);
    this.emit(this.spec(M.FLARE, O.BILL, _v.copy(pos).setY(pos.y + 0.4), 0.25, radius * 0.6, radius * 1.1, 0xffffff, color, 1.2));
    const n = this.n(10, 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2);
      _v.set(Math.cos(a), 0, Math.sin(a));
      const d = this.smokeSpec(_w.copy(pos).addScaledVector(_v, radius * 0.25).setY(pos.y + 0.25), rnd(0.8, 1.3), radius * 0.25, radius * 0.6, 0x8a8178);
      d.vx = _v.x * radius * 2.2; d.vz = _v.z * radius * 2.2; d.vy = rnd(0.5, 1.5); d.drag = 3;
      this.smoke.spawn(d, this.time);
    }
    const m = this.n(10, 4);
    for (let i = 0; i < m; i++) this.spark(pos, _u, color, 10, 1.4, 0.13);
    this.light(_v.copy(pos).setY(pos.y + 0.6), _c.set(color), 18, 0.25);
  }

  private smokeSpec(p: THREE.Vector3, life: number, s0: number, s1: number, col: Col) {
    const s = this.spec(M.SMOKE, O.BILL, p, life, s0, s1, col, col, 1);
    s.c2.copy(s.c1).multiplyScalar(0.55);
    s.spin = rnd(-0.6, 0.6);
    return s;
  }

  /** Stylised explosion: flash, fire puffs, shock sphere, ground ring, smoke and flying bits. */
  explosion(pos: THREE.Vector3, size = 2, ground = true) {
    const S = size;
    this.emit(this.spec(M.FLARE, O.BILL, pos, 0.28, S * 1.2, S * 2.4, 0xfff4d0, 0xff8a2a, 1.3));
    this.emit(this.spec(M.SHELL, O.BILL, pos, 0.4, S * 0.6, S * 2.0, 0xffe0a0, 0xff6a1a, 1.0));
    this.emit(this.spec(M.GLOW, O.BILL, pos, 0.5, S * 1.4, S * 2.2, 0xff7a20, 0xff5010, 0.7));
    const nf = this.n(9, 4);
    for (let i = 0; i < nf; i++) {
      _v.set(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize();
      const f = this.spec(M.FIRE, O.BILL, _w.copy(pos).addScaledVector(_v, S * 0.25), rnd(0.6, 1.0), S * rnd(0.5, 0.8), S * rnd(1.1, 1.6), 0xffd27a, 0xd8380c, 1.25);
      f.vx = _v.x * S * 2.4; f.vy = _v.y * S * 2.4 + S * 0.6; f.vz = _v.z * S * 2.4; f.drag = 3.5; f.spin = rnd(-1, 1);
      this.emit(f);
    }
    const ns = this.n(8, 3);
    for (let i = 0; i < ns; i++) {
      _v.set(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize();
      const sm = this.smokeSpec(_w.copy(pos).addScaledVector(_v, S * 0.3), rnd(1.6, 2.4), S * 0.7, S * rnd(1.6, 2.2), 0x5a534d);
      sm.vx = _v.x * S * 1.4; sm.vy = S * rnd(0.8, 1.6); sm.vz = _v.z * S * 1.4; sm.drag = 1.6; sm.delay = 0.08;
      this.smoke.spawn(sm, this.time);
    }
    if (ground) {
      const r = this.spec(M.RING, O.PLANE, _w.copy(pos).setY(pos.y - S * 0.3 + 0.04), 0.5, S * 0.6, S * 2.6, 0xffe6b0, 0xff6a1a, 1.0);
      this.emit(r);
    }
    const nb = this.n(14, 5);
    for (let i = 0; i < nb; i++) {
      _v.set(rnd(-1, 1), rnd(0.2, 1.2), rnd(-1, 1)).normalize();
      const sp = S * rnd(5, 9);
      const b = this.spec(M.STREAK, O.STRETCH, pos, rnd(0.5, 0.9), 0.35, 0.2, 0xffe0a0, 0xff6010, 1.2);
      b.vx = _v.x * sp; b.vy = _v.y * sp; b.vz = _v.z * sp; b.grav = 14; b.drag = 0.8; b.param = 1;
      this.emit(b);
    }
    this.light(pos, _c.set(0xff8a30), 60 * S * 0.5, 0.6);
  }

  // ------------------------------------------------------------------ electric & magic
  /** Jagged lightning bolt between two points, with forks, flicker and end sparks. */
  zap(from: THREE.Vector3, to: THREE.Vector3, color: Col = 0x9fd8ff, width = 0.18, life = 0.22, ends = true) {
    const segs = 9;
    from = _zf.copy(from); to = _zt.copy(to);
    const len = from.distanceTo(to);
    _u.copy(to).sub(from);
    for (let pass = 0; pass < 2; pass++) {
      let px = from.x, py = from.y, pz = from.z;
      for (let i = 1; i <= segs; i++) {
        const f = i / segs;
        const j = i === segs ? 0 : len * 0.09;
        const nx = from.x + _u.x * f + rnd(-j, j), ny = from.y + _u.y * f + rnd(-j, j), nz = from.z + _u.z * f + rnd(-j, j);
        const s = this.spec(M.BOLT, O.SEG, _v.set(px, py, pz), life, width * (pass ? 0.6 : 1), width * (pass ? 0.6 : 1), 0xffffff, color, pass ? 0.9 : 1.4);
        s.dx = nx - px; s.dy = ny - py; s.dz = nz - pz; s.delay = pass * 0.06;
        this.emit(s);
        if (!pass && i > 1 && i < segs - 1 && Math.random() < 0.3) {
          // Fork.
          const fs = this.spec(M.BOLT, O.SEG, _v.set(nx, ny, nz), life * 0.7, width * 0.5, width * 0.5, 0xffffff, color, 0.9);
          fs.dx = rnd(-1, 1) * len * 0.15; fs.dy = rnd(-1, 1) * len * 0.15; fs.dz = rnd(-1, 1) * len * 0.15;
          this.emit(fs);
        }
        px = nx; py = ny; pz = nz;
      }
    }
    if (!ends) return;
    this.emit(this.spec(M.GLOW, O.BILL, to, 0.2, 0.6, 1.0, color, color, 0.8));
    const st = this.spec(M.STAR, O.BILL, to, 0.2, 0.5, 0.9, 0xffffff, color, 1.3); st.rot = 0; this.emit(st);
    for (let i = 0; i < this.n(5, 2); i++) this.spark(to, null, color, 7, 1, 0.08);
  }

  /** Crackling electric ball burst (pulse, zap impacts). */
  electricBall(pos: THREE.Vector3, color: Col = 0x7fd0ff, size = 1.2, life = 0.45) {
    this.emit(this.spec(M.EBALL, O.BILL, pos, life, size * 0.7, size * 1.1, 0xffffff, color, 1.3));
    this.emit(this.spec(M.GLOW, O.BILL, pos, life, size * 1.2, size * 1.6, color, color, 0.6));
    const n = this.n(5, 2);
    for (let i = 0; i < n; i++) {
      _e.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(size * rnd(0.9, 1.6)).add(pos);
      this.zap(pos, _e, color, 0.06 * size, life * 0.6, false);
    }
  }

  /** Magic cast: rotating circle facing dir (or flat), flash and rising motes. */
  cast(pos: THREE.Vector3, color: Col = 0xb48cff, dir?: THREE.Vector3, size = 1) {
    const c = this.spec(M.CIRCLE, O.PLANE, pos, 0.55, size * 0.9, size * 1.1, 0xffffff, color, 1.2);
    if (dir) { c.dx = dir.x; c.dy = dir.y; c.dz = dir.z; }
    this.emit(c);
    this.emit(this.spec(M.FLARE, O.BILL, pos, 0.2, size * 0.5, size * 1.0, 0xffffff, color, 1.1));
    this.emit(this.spec(M.GLOW, O.BILL, pos, 0.3, size * 0.6, size * 0.9, color, color, 0.6));
    const n = this.n(6, 2);
    for (let i = 0; i < n; i++) {
      const m = this.spec(M.GLOW, O.BILL, _v.copy(pos).add(_w.set(rnd(-0.4, 0.4), rnd(-0.3, 0.3), rnd(-0.4, 0.4)).multiplyScalar(size)), rnd(0.35, 0.6), 0.12 * size, 0.05 * size, 0xffffff, color, 1.2);
      m.vy = rnd(1, 2.5); m.drag = 1.5;
      this.emit(m);
    }
  }

  /** Muzzle-style flash (texture) for punches and casts, pointing along dir. */
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, color: Col = 0xffc070, size = 0.8) {
    const f = this.spec(M.FLASH, O.BILL, pos, 0.09, size, size * 1.15, 0xfff4e0, color, 1.4);
    f.param = Math.random() < 0.5 ? 0 : 1;
    this.emit(f);
    const sd = this.spec(M.FLASH, O.STRETCH, _v.copy(pos).addScaledVector(_w.copy(dir).normalize(), size * 0.45), 0.08, size * 0.6, size * 0.7, 0xfff4e0, color, 1.2);
    sd.dx = dir.x; sd.dy = dir.y; sd.dz = dir.z; sd.param = 3; // atlas cell 3: long flash, laid along dir
    this.emit(sd);
  }

  // ------------------------------------------------------------------ persistent: beams, projectiles, statuses
  /** A sustained beam (core + noisy outer + end flares). set() moves it; stop() fades it out. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: Col = 0x9ff7ff, width = 0.35, dur = Infinity): BeamHandle {
    const L = this.glow, vfx = this;
    const slots = [L.claim(), L.claim(), L.claim(), L.claim()];
    const life = Number.isFinite(dur) ? dur : PERSIST_LIFE;
    const mk = (i: number, mode: number, orient: number, w: number, c1: Col, inten: number) => {
      if (slots[i] < 0) return;
      const s = this.spec(mode, orient, from, life, w, w, c1, color, inten);
      if (orient === O.SEG) { s.dx = to.x - from.x; s.dy = to.y - from.y; s.dz = to.z - from.z; }
      L.write(slots[i], s, this.time);
    };
    mk(0, M.BEAM, O.SEG, width, 0xffffff, 1.2);
    mk(1, M.BEAM, O.SEG, width * 2.2, color, 0.6);
    mk(2, M.ORB, O.BILL, width * 2.4, 0xffffff, 1.0);
    mk(3, M.ORB, O.BILL, width * 2.0, 0xffffff, 1.0);
    let stopped = false, endT = this.time + life;
    const h: BeamHandle & Persistent = {
      set(a, b) {
        if (stopped) return;
        for (const i of [0, 1]) if (slots[i] >= 0) { L.setPos(slots[i], a.x, a.y, a.z); L.setDir(slots[i], b.x - a.x, b.y - a.y, b.z - a.z); }
        if (slots[2] >= 0) L.setPos(slots[2], a.x, a.y, a.z);
        if (slots[3] >= 0) L.setPos(slots[3], b.x, b.y, b.z);
      },
      stop() { if (stopped) return; stopped = true; for (const s of slots) if (s >= 0) L.setLifeEnd(s, vfx.time, 0.2); endT = vfx.time + 0.25; },
      update() { if (vfx.time > endT) { for (const s of slots) L.release(s); return false; } return true; },
      kill() { stopped = true; endT = -1; },
    };
    this.live.push(h);
    return h;
  }

  /** A projectile body that the game moves each tick: 'basic' orb, 'javelin' streak or 'wave' crescent. */
  projectile(kind: 'basic' | 'javelin' | 'wave', color: Col = 0xb48cff, size = 0.5): ProjectileHandle {
    const L = this.glow, vfx = this;
    const core = L.claim(), halo = L.claim();
    const mode = kind === 'wave' ? M.SLASH : kind === 'javelin' ? M.STREAK : M.ORB;
    const orient = kind === 'basic' ? O.BILL : O.STRETCH;
    const col = new THREE.Color(color);
    const p0 = new THREE.Vector3();
    const s = this.spec(mode, orient, p0, PERSIST_LIFE, size * (kind === 'javelin' ? 2.2 : kind === 'wave' ? 2.0 : 1), size * (kind === 'javelin' ? 2.2 : kind === 'wave' ? 2.0 : 1), 0xffffff, col, 1.2);
    s.param = kind === 'wave' ? 1 : 0;
    if (core >= 0) L.write(core, s, this.time);
    const hs = this.spec(M.GLOW, O.BILL, p0, PERSIST_LIFE, size * 1.8, size * 1.8, col, col, 0.55);
    if (halo >= 0) L.write(halo, hs, this.time);
    const last = new THREE.Vector3();
    let has = false, stopped = false, acc = 0, endT = Infinity;
    const h: ProjectileHandle & Persistent = {
      set(pos, dir) {
        if (stopped) return;
        if (core >= 0) {
          L.setPos(core, pos.x, pos.y, pos.z); L.setDir(core, dir.x, dir.y, dir.z);
        }
        if (halo >= 0) L.setPos(halo, pos.x, pos.y, pos.z);
        last.copy(pos); has = true;
      },
      stop(impact = true) {
        if (stopped) return; stopped = true;
        if (core >= 0) L.release(core);
        if (halo >= 0) L.release(halo);
        if (impact && has) { vfx.hit(last, _u.set(0, 1, 0), col, 0.4); vfx.emit(vfx.spec(M.CORE, O.BILL, last, 0.3, size * 1.5, size * 2.6, 0xffffff, col, 1.1)); }
        endT = vfx.time;
      },
      update(dt) {
        if (stopped) return vfx.time <= endT;
        acc += dt;
        if (has && acc > 0.016) {
          acc = 0;
          const tr = vfx.spec(M.GLOW, O.BILL, last, kind === 'javelin' ? 0.18 : 0.3, size * 0.9, size * 0.2, 0xffffff, col, 0.9);
          tr.px += rnd(-0.05, 0.05); tr.py += rnd(-0.05, 0.05); tr.pz += rnd(-0.05, 0.05);
          vfx.emit(tr);
          if (Math.random() < 0.5 * vfx.quality) {
            const m = vfx.spec(M.STAR, O.BILL, last, 0.3, size * 0.35, size * 0.1, 0xffffff, col, 1.1); m.rot = 0;
            m.vx = rnd(-1, 1); m.vy = rnd(-1, 1); m.vz = rnd(-1, 1); m.drag = 2;
            vfx.emit(m);
          }
        }
        return true;
      },
      kill() { stopped = true; endT = -1; },
    };
    this.live.push(h);
    return h;
  }

  /**
   * Status effect attached to a moving target (the fighter's chest/centre). Returns a handle; stop() fades it.
   * stun: dizzy stars circling above the head · snare: rotating binding rings + ice shards and mist
   * burn: flame wisps and embers · rage / charge: body aura shell + rising aura wisps · shatter: one-shot burst.
   */
  status(target: () => THREE.Vector3 | null, kind: StatusKind, color?: Col, height = 2): StatusHandle {
    const vfx = this, L = this.glow;
    const col = new THREE.Color(color ?? (kind === 'burn' ? 0xff6a1a : kind === 'snare' ? 0x9fe8ff : kind === 'stun' ? 0xffe05a : kind === 'charge' ? 0x6fc8ff : kind === 'shatter' ? 0xcfeeff : 0xff3a2a));
    if (kind === 'shatter') {
      const p = target();
      if (p) this.shatter(p, col, height);
      return { stop() {}, alive: false };
    }
    const slots: number[] = [];
    const claim = (s: Spec) => { const i = L.claim(); if (i >= 0) { L.write(i, s, vfx.time); slots.push(i); } return i; };
    const p0 = target() ?? new THREE.Vector3();
    const deep = new THREE.Color(col).multiplyScalar(0.6);
    if (kind === 'stun') {
      for (let i = 0; i < 3; i++) { const s = this.spec(M.DIZZY, O.BILL, p0, PERSIST_LIFE, 0.36, 0.36, 0xfff6c0, col, 1.4); s.rot = 0; s.spin = 2.5; claim(s); }
    } else if (kind === 'snare') {
      for (const h of [-0.35, 0.25]) { const s = this.spec(M.BIND, O.PLANE, p0, PERSIST_LIFE, 1.35, 1.35, 0xffffff, col, 1.5); s.seed = h * 10; claim(s); }
      const au = this.spec(M.AURA, O.BILL, p0, PERSIST_LIFE, height * 1.2, height * 1.2, col, deep, 0.5); au.rot = 0; claim(au);
    } else if (kind === 'rage' || kind === 'charge') {
      const s = this.spec(M.AURA, O.BILL, p0, PERSIST_LIFE, height * 1.25, height * 1.25, col, deep, kind === 'rage' ? 1.0 : 0.8); s.rot = 0; claim(s);
    }
    let stopped = false, acc = 0, endT = Infinity, ang = 0;
    const h: StatusHandle & Persistent = {
      get alive() { return !stopped; },
      stop() { if (stopped) return; stopped = true; for (const s of slots) L.setLifeEnd(s, vfx.time, 0.25); endT = vfx.time + 0.3; },
      update(dt) {
        if (stopped) { if (vfx.time > endT) { for (const s of slots) L.release(s); return false; } return true; }
        const p = target();
        if (!p) return true;
        ang += dt * 4;
        if (kind === 'stun') {
          for (let i = 0; i < slots.length; i++) {
            const a = ang + (i / slots.length) * Math.PI * 2;
            L.setPos(slots[i], p.x + Math.cos(a) * 0.45, p.y + height * 0.5 + 0.25 + Math.sin(a * 2) * 0.05, p.z + Math.sin(a) * 0.45);
          }
        } else if (kind === 'snare') {
          L.setPos(slots[0], p.x, p.y - height * 0.15, p.z);
          if (slots.length > 1) L.setPos(slots[1], p.x, p.y + height * 0.12, p.z);
          if (slots.length > 2) L.setPos(slots[2], p.x, p.y + height * 0.05, p.z);
        } else if (slots.length) {
          L.setPos(slots[0], p.x, p.y + height * 0.05, p.z);
        }
        acc += dt;
        const rate = (kind === 'rage' ? 0.03 : kind === 'charge' ? 0.04 : kind === 'burn' ? 0.022 : kind === 'snare' ? 0.12 : 0.2) / Math.max(0.3, vfx.quality);
        while (acc > rate) {
          acc -= rate;
          vfx.statusParticle(kind, p, col, deep, height);
        }
        return true;
      },
      kill() { stopped = true; endT = -1; },
    };
    this.live.push(h);
    return h;
  }

  private statusParticle(kind: StatusKind, p: THREE.Vector3, col: THREE.Color, deep: THREE.Color, height: number) {
    const a = Math.random() * Math.PI * 2;
    const rr = rnd(0.3, 0.55);
    _v.set(p.x + Math.cos(a) * rr, p.y + rnd(-0.5, 0.45) * height, p.z + Math.sin(a) * rr);
    if (kind === 'rage' || kind === 'charge' || kind === 'burn') {
      const fire = kind === 'burn';
      const s = this.spec(M.WISP, O.BILL, _v, rnd(0.35, 0.6), rnd(0.3, 0.45) * (fire ? 1.3 : 1), rnd(0.14, 0.24), fire ? 0xffd080 : 0xffffff, fire ? 0xe8400c : col, fire ? 1.2 : 1.0);
      s.rot = rnd(-0.25, 0.25); s.vy = rnd(1.2, 2.4); s.vx = rnd(-0.3, 0.3); s.vz = rnd(-0.3, 0.3); s.drag = 0.5;
      if (!fire) s.c2.copy(col).lerp(deep, 0.3);
      this.emit(s);
      if (Math.random() < 0.35) {
        const e = this.spec(M.GLOW, O.BILL, _v, rnd(0.4, 0.8), 0.07, 0.02, 0xffffff, fire ? 0xff7a2a : col, 1.4);
        e.vy = rnd(1.5, 3); e.vx = rnd(-0.6, 0.6); e.vz = rnd(-0.6, 0.6); e.drag = 0.8;
        this.emit(e);
      }
    } else if (kind === 'snare') {
      const s = this.spec(M.SHARD, O.BILL, _v, rnd(0.5, 0.9), 0.2, 0.14, 0xffffff, col, 1.2);
      s.spin = rnd(-3, 3); s.vy = rnd(-0.2, 0.4);
      this.emit(s);
      if (Math.random() < 0.4) {
        const m = this.smokeSpec(_v, rnd(0.8, 1.2), 0.35, 0.7, 0xc8ecff); m.vy = 0.3; m.c2.set(0x9ccbe0);
        this.smoke.spawn(m, this.time);
      }
    } else if (kind === 'stun') {
      const s = this.spec(M.STAR, O.BILL, _w.set(p.x + Math.cos(a) * 0.45, p.y + height * 0.5 + 0.25, p.z + Math.sin(a) * 0.45), 0.3, 0.15, 0.05, 0xffffff, col, 1.2);
      s.rot = 0; this.emit(s);
    }
  }

  /** One-shot shatter: glassy shards fly out with gravity, ring and star flash. Guard breaks, KOs, freezes. */
  shatter(pos: THREE.Vector3, color: Col = 0xcfeeff, height = 2) {
    const st = this.spec(M.STAR, O.BILL, pos, 0.35, 1.0, 2.2, 0xffffff, color, 1.2); st.rot = 0; this.emit(st);
    this.emit(this.spec(M.SHELL, O.BILL, pos, 0.4, height * 0.5, height * 1.3, color, color, 0.8));
    this.emit(this.spec(M.FLARE, O.BILL, pos, 0.2, 0.9, 1.8, 0xffffff, color, 0.8));
    const n = this.n(26, 10);
    for (let i = 0; i < n; i++) {
      _v.set(rnd(-1, 1), rnd(-0.3, 1), rnd(-1, 1)).normalize();
      const s = this.spec(M.SHARD, O.BILL, _w.copy(pos).add(_u.set(rnd(-0.3, 0.3), rnd(-0.6, 0.6) * height * 0.5, rnd(-0.3, 0.3))), rnd(0.6, 1.1), rnd(0.16, 0.32), rnd(0.12, 0.24), 0xffffff, color, 1.2);
      const sp = rnd(3, 8);
      s.vx = _v.x * sp; s.vy = _v.y * sp + 2; s.vz = _v.z * sp; s.grav = 14; s.drag = 0.6; s.spin = rnd(-12, 12);
      this.emit(s);
    }
    const ring = this.spec(M.RING, O.BILL, pos, 0.35, 0.6, height * 1.4, 0xffffff, color, 1.0);
    this.emit(ring);
    this.light(pos, _c.set(color), 18, 0.25);
  }

  private light(pos: THREE.Vector3, color: Col, intensity: number, dur: number) {
    if (this.onLight) this.onLight(pos, color instanceof THREE.Color ? color : _c.set(color), intensity, dur);
  }

  update(dt: number) {
    this.time += dt;
    for (let i = this.live.length - 1; i >= 0; i--) if (!this.live[i].update(dt)) this.live.splice(i, 1);
    (this.glow.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    (this.smoke.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    this.glow.flush();
    this.smoke.flush();
  }

  /** Removes every effect, including persistent ones (their handles become inert). */
  clear() {
    for (const h of this.live) h.kill();
    this.live.length = 0;
    this.glow.resetAll();
    this.smoke.resetAll();
  }

  dispose(scene: THREE.Scene) {
    for (const l of [this.glow, this.smoke]) { scene.remove(l.mesh); l.mesh.geometry.dispose(); (l.mesh.material as THREE.Material).dispose(); }
    this.atlas.dispose();
  }
}
