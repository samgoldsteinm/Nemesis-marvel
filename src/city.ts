import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural city: buildings with real-scale facades (windows sized per metre, not stretched),
// ledges, cornices, pilasters, setbacks, fire escapes and rooftop clutter; a mid-distance skyline of
// varied towers; and a painted far panorama. Everything is merged per material to keep draw calls low.

export const BAY = 3; // metres per window bay
export const FLOOR = 3.4; // metres per storey
const TILE_BAYS = 8, TILE_FLOORS = 8;
const TILE_W = BAY * TILE_BAYS, TILE_H = FLOOR * TILE_FLOORS;

export type FacadeStyle = 'brick' | 'darkbrick' | 'concrete' | 'stone' | 'glass';
const STYLES: FacadeStyle[] = ['brick', 'darkbrick', 'concrete', 'stone', 'glass'];

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** One facade tile (8 bays x 8 floors): colour, emissive (lit rooms) and bump maps. */
function facadeMaps(style: FacadeStyle) {
  const S = 512, cw = S / TILE_BAYS, ch = S / TILE_FLOORS;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const col = mk(), emi = mk(), bmp = mk();
  const g = col.getContext('2d')!, e = emi.getContext('2d')!, b = bmp.getContext('2d')!;
  const base: Record<FacadeStyle, [string, string]> = {
    brick: ['#8a4a36', '#6e3a2a'], darkbrick: ['#4a3a36', '#3a2c2a'], concrete: ['#9a968e', '#86827a'], stone: ['#b8ac94', '#a0947e'], glass: ['#40545e', '#2c3c44'],
  };
  const [c1, c2] = base[style];
  g.fillStyle = c1; g.fillRect(0, 0, S, S);
  e.fillStyle = '#000'; e.fillRect(0, 0, S, S);
  b.fillStyle = '#808080'; b.fillRect(0, 0, S, S);
  // Wall surface texture.
  if (style === 'brick' || style === 'darkbrick') {
    for (let y = 0; y < S; y += 6) for (let x = (y / 6) % 2 ? 0 : 7; x < S; x += 14) {
      g.fillStyle = Math.random() < 0.5 ? c1 : c2;
      g.fillRect(x, y, 13, 5);
      b.fillStyle = '#8a8a8a'; b.fillRect(x, y, 13, 5);
    }
    b.fillStyle = '#5a5a5a';
    for (let y = 5; y < S; y += 6) b.fillRect(0, y, S, 1);
  } else if (style === 'glass') {
    // Curtain wall: big panes with mullions.
    for (let x = 0; x < S; x += cw / 2) { g.fillStyle = '#7a8a90'; g.fillRect(x, 0, 2, S); b.fillStyle = '#b0b0b0'; b.fillRect(x, 0, 2, S); }
  } else {
    for (let i = 0; i < 2500; i++) { const v = Math.random() < 0.5 ? c1 : c2; g.fillStyle = v; g.globalAlpha = 0.25; g.fillRect(Math.random() * S, Math.random() * S, 3, 3); }
    g.globalAlpha = 1;
    b.fillStyle = '#606060';
    for (let y = 0; y < S; y += ch) b.fillRect(0, y + ch - 2, S, 2);
  }
  // Windows.
  const glassW = style === 'glass' ? 0.86 : 0.5, glassH = style === 'glass' ? 0.8 : 0.58;
  for (let fy = 0; fy < TILE_FLOORS; fy++) {
    const litFloor = Math.random();
    for (let bx = 0; bx < TILE_BAYS; bx++) {
      const wx = bx * cw + cw * (1 - glassW) / 2, wy = fy * ch + ch * 0.2, ww = cw * glassW, wh = ch * glassH;
      // Frame and sill.
      if (style !== 'glass') {
        g.fillStyle = style === 'stone' ? '#e0d8c4' : '#cfc8bc';
        g.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        g.fillRect(wx - 5, wy + wh + 2, ww + 10, 4);
        b.fillStyle = '#c8c8c8'; b.fillRect(wx - 5, wy + wh + 2, ww + 10, 4); b.fillRect(wx - 3, wy - 3, ww + 6, 3);
      }
      // Glass: dark with a sky reflection streak.
      const gr = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
      gr.addColorStop(0, '#2a3a46'); gr.addColorStop(0.45, '#5a7484'); gr.addColorStop(0.55, '#24323c'); gr.addColorStop(1, '#141c24');
      g.fillStyle = gr; g.fillRect(wx, wy, ww, wh);
      b.fillStyle = '#404040'; b.fillRect(wx, wy, ww, wh);
      // Mullion cross.
      g.fillStyle = '#20262c'; g.fillRect(wx + ww / 2 - 1, wy, 2, wh); g.fillRect(wx, wy + wh * 0.35, ww, 2);
      // Some rooms lit (warm), clustered by floor.
      if (Math.random() < 0.18 + litFloor * 0.25) {
        const warm = Math.random() < 0.7 ? '#ffd28a' : '#cfe6ff';
        e.fillStyle = warm; e.globalAlpha = 0.55 + Math.random() * 0.45; e.fillRect(wx + 1, wy + 1, ww - 2, wh - 2); e.globalAlpha = 1;
        g.fillStyle = warm; g.globalAlpha = 0.5; g.fillRect(wx + 1, wy + 1, ww - 2, wh - 2); g.globalAlpha = 1;
        // Blinds on some lit windows.
        if (Math.random() < 0.4) { e.fillStyle = 'rgba(0,0,0,0.5)'; for (let k = 0; k < wh * 0.6; k += 4) e.fillRect(wx, wy + k, ww, 2); }
      }
    }
  }
  // Grime streaks below sills.
  g.globalAlpha = 0.08;
  for (let i = 0; i < 60; i++) { g.fillStyle = '#000'; g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 4, 20 + Math.random() * 60); }
  g.globalAlpha = 1;
  return { map: tex(col), emissiveMap: tex(emi), bumpMap: tex(bmp, false) };
}

const facadeCache = new Map<FacadeStyle, THREE.MeshStandardMaterial>();
export function facadeMaterial(style: FacadeStyle) {
  let m = facadeCache.get(style);
  if (!m) {
    const t = facadeMaps(style);
    m = new THREE.MeshStandardMaterial({
      map: t.map, emissive: 0xffffff, emissiveMap: t.emissiveMap, emissiveIntensity: 0.6, bumpMap: t.bumpMap, bumpScale: 2.2,
      roughness: style === 'glass' ? 0.25 : 0.88, metalness: style === 'glass' ? 0.55 : 0.05,
      vertexColors: true,
    });
    facadeCache.set(style, m);
  }
  return m;
}

let roofMat: THREE.MeshStandardMaterial | null = null;
function roofMaterial() {
  if (!roofMat) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3c3a3e'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1500; i++) { const v = 40 + Math.random() * 30; g.fillStyle = `rgb(${v},${v},${v + 4})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
    const t = tex(c);
    t.repeat.set(1, 1);
    roofMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  }
  return roofMat;
}

/** A plane for one side of a volume, with UVs in facade-tile units so windows keep their real size,
 *  and vertex colours that fake ambient occlusion: darker toward street level and under the cornice. */
function sidePlane(w: number, h: number, u0: number, groundAbove: number) {
  const segs = Math.max(1, Math.ceil(h / 3.4));
  const g = new THREE.PlaneGeometry(w, h, 1, segs);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + (uv.getX(i) * w) / TILE_W, (uv.getY(i) * h) / TILE_H);
    const yFromBase = pos.getY(i) + h / 2 + groundAbove;
    const yFromTop = h / 2 - pos.getY(i);
    const ao = (0.42 + 0.58 * THREE.MathUtils.smoothstep(yFromBase, 0, 16)) * (0.82 + 0.18 * THREE.MathUtils.smoothstep(yFromTop, 0, 1.4));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export interface BuildingOpts {
  x: number; z: number; w: number; d: number; bottom: number; top: number;
  style?: FacadeStyle;
  detail: 0 | 1 | 2; // 0 far, 1 mid, 2 near
  front?: THREE.Vector3; // outward normal of the face that sees the action (fire escapes, pilasters)
}

export class CityBuilder {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  constructor(public trim: THREE.Material, public metal: THREE.Material, public dark: THREE.Material) {}

  add(mat: THREE.Material, g: THREE.BufferGeometry) {
    let l = this.buckets.get(mat);
    if (!l) { l = []; this.buckets.set(mat, l); }
    // Normalise attributes so everything merges: drop extras, ensure uv exists.
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    l.push(g.index ? g.toNonIndexed() : g);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  cyl(mat: THREE.Material, r0: number, r1: number, h: number, x: number, y: number, z: number, seg = 12) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /** One rectangular volume: four facade sides, a roof, a cornice and parapet. */
  private volume(style: FacadeStyle, x: number, z: number, w: number, d: number, y0: number, y1: number, detail: number, base = y0) {
    const h = y1 - y0;
    const fm = facadeMaterial(style);
    const u0 = Math.random() * 8;
    const sides: [number, number, number, number][] = [[w, 0, d / 2, 0], [w, 0, -d / 2, Math.PI], [d, w / 2, 0, Math.PI / 2], [d, -w / 2, 0, -Math.PI / 2]];
    for (const [len, ox, oz, ry] of sides) {
      const g = sidePlane(len, h, u0, y0 - base);
      g.rotateY(ry);
      g.translate(x + ox, y0 + h / 2, z + oz);
      this.add(fm, g);
    }
    const roof = new THREE.PlaneGeometry(w, d);
    roof.rotateX(-Math.PI / 2);
    roof.translate(x, y1, z);
    this.add(roofMaterial(), roof);
    // Cornice and parapet.
    this.box(this.trim, w + 0.7, 0.55, d + 0.7, x, y1 - 0.1, z);
    if (detail >= 1) {
      this.box(this.trim, w, 0.9, 0.25, x, y1 + 0.45, z + d / 2 - 0.12);
      this.box(this.trim, w, 0.9, 0.25, x, y1 + 0.45, z - d / 2 + 0.12);
      this.box(this.trim, 0.25, 0.9, d, x + w / 2 - 0.12, y1 + 0.45, z);
      this.box(this.trim, 0.25, 0.9, d, x - w / 2 + 0.12, y1 + 0.45, z);
      // Belt-course ledges every three floors.
      for (let y = y0 + FLOOR * 3; y < y1 - 2; y += FLOOR * 3) this.box(this.trim, w + 0.3, 0.22, d + 0.3, x, y, z);
    }
  }

  /** A plain facade volume (no rooftop clutter): the base under a kit building. */
  podium(x: number, z: number, w: number, d: number, bottom: number, top: number, style: FacadeStyle = 'concrete') {
    this.volume(style, x, z, w, d, bottom, top, 0);
  }

  building(o: BuildingOpts) {
    const style = o.style ?? STYLES[Math.floor(Math.random() * STYLES.length)];
    const h = o.top - o.bottom;
    // Main volume, then optional setbacks for tall buildings.
    let w = o.w, d = o.d, y = o.bottom;
    const tiers = h > 40 && Math.random() < 0.75 ? 2 + (Math.random() < 0.35 ? 1 : 0) : 1;
    for (let t = 0; t < tiers; t++) {
      const frac = tiers === 1 ? 1 : t === 0 ? rand(0.55, 0.7) : t === tiers - 1 ? 1 : rand(0.75, 0.88);
      const yTop = t === tiers - 1 ? o.top : o.bottom + h * frac;
      this.volume(style, o.x, o.z, w, d, y, yTop, o.detail, o.bottom);
      y = yTop;
      w *= rand(0.62, 0.8);
      d *= rand(0.62, 0.8);
    }
    const topW = w / 0.7, topD = d / 0.7;
    // Rooftop clutter.
    if (o.detail >= 1) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.box(this.metal, rand(1.2, 2.5), rand(0.8, 1.6), rand(1.2, 2.2), o.x + rand(-topW / 3, topW / 3), y + 0.6, o.z + rand(-topD / 3, topD / 3));
      if (Math.random() < 0.45) this.waterTower(o.x + rand(-topW / 4, topW / 4), y, o.z + rand(-topD / 4, topD / 4));
      if (Math.random() < 0.5) this.cyl(this.metal, 0.06, 0.12, rand(4, 10), o.x + rand(-topW / 4, topW / 4), y + 3, o.z, 6);
      if (Math.random() < 0.3) this.box(this.trim, rand(2.5, 4), rand(2.2, 3), rand(2.5, 4), o.x - topW * 0.25, y + 1.2, o.z + topD * 0.2);
    } else if (Math.random() < 0.25) {
      this.cyl(this.metal, 0.1, 0.3, rand(6, 18), o.x, y + 4, o.z, 5);
    }
    // Pilasters and fire escapes on the face that looks at the fight.
    if (o.front && o.detail >= 1) {
      const fz = o.front.z !== 0, sgn = Math.sign(fz ? o.front.z : o.front.x);
      const faceLen = fz ? o.w : o.d;
      for (let k = -faceLen / 2 + BAY * 2; k < faceLen / 2 - 1; k += BAY * 2) {
        if (fz) this.box(this.trim, 0.45, h * 0.62, 0.3, o.x + k, o.bottom + h * 0.31, o.z + sgn * (o.d / 2 + 0.15));
        else this.box(this.trim, 0.3, h * 0.62, 0.45, o.x + sgn * (o.w / 2 + 0.15), o.bottom + h * 0.31, o.z + k);
      }
      if (o.detail === 2 && style !== 'glass') this.fireEscape(o, fz, sgn, Math.min(o.top - 3, o.bottom + h * 0.6));
    }
  }

  private waterTower(x: number, y: number, z: number) {
    const wood = this.dark;
    this.cyl(wood, 1.6, 1.6, 2.8, x, y + 4.2, z, 14);
    const cone = new THREE.ConeGeometry(1.75, 1.1, 14);
    cone.translate(x, y + 6.15, z);
    this.add(wood, cone);
    for (const [dx, dz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) this.box(this.metal, 0.14, 2.8, 0.14, x + dx, y + 1.4, z + dz);
    this.box(this.metal, 2.6, 0.08, 0.08, x, y + 1.4, z - 1.1);
    this.box(this.metal, 2.6, 0.08, 0.08, x, y + 1.4, z + 1.1);
  }

  private fireEscape(o: BuildingOpts, fz: boolean, sgn: number, yTop: number) {
    const col = (Math.random() - 0.5) * (fz ? o.w : o.d) * 0.4;
    const out = 0.75;
    for (let y = o.bottom + FLOOR * 2; y < yTop; y += FLOOR) {
      const [cx, cz] = fz ? [o.x + col, o.z + sgn * (o.d / 2 + out)] : [o.x + sgn * (o.w / 2 + out), o.z + col];
      const [pw, pd] = fz ? [4.2, 1.4] : [1.4, 4.2];
      this.box(this.metal, pw, 0.06, pd, cx, y, cz);
      // Railing.
      const [rx, rz] = fz ? [cx, cz + sgn * 0.68] : [cx + sgn * 0.68, cz];
      this.box(this.metal, fz ? pw : 0.04, 0.04, fz ? 0.04 : pd, rx, y + 0.95, rz);
      this.box(this.metal, fz ? pw : 0.04, 0.04, fz ? 0.04 : pd, rx, y + 0.5, rz);
      for (let k = -1.9; k <= 1.95; k += 0.95) this.box(this.metal, 0.04, 0.95, 0.04, fz ? cx + k : rx, y + 0.48, fz ? rz : cz + k);
      // Stair down to the floor below.
      const len = Math.hypot(FLOOR, 2.6);
      const ang = Math.atan2(FLOOR, 2.6);
      if (fz) this.box(this.metal, 2.8, 0.06, 0.6, cx + 0.2, y - FLOOR / 2, cz, 0, 0, ang * (Math.round(y) % 2 ? 1 : -1));
      else this.box(this.metal, 0.6, 0.06, 2.8, cx, y - FLOOR / 2, cz + 0.2, 0, ang * (Math.round(y) % 2 ? 1 : -1), 0);
      void len;
    }
  }

  /** A ring of varied mid-distance towers, keeping clear of a rectangle around the arena. */
  skyline(clearHW: number, clearHD: number, minR: number, maxR: number, n: number, yBase: number) {
    let k = 0;
    for (let i = 0; i < n * 6 && k < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.85;
      const w = rand(8, 18), d = rand(8, 18);
      if (Math.abs(x) < clearHW + w / 2 + 4 && Math.abs(z) < clearHD + d / 2 + 4) continue;
      const top = yBase + rand(18, r > 90 ? 120 : 75);
      this.building({ x, z, w, d, bottom: yBase - 40, top, detail: r < 80 ? 1 : 0 });
      k++;
    }
  }

  flush(parent: THREE.Object3D, castShadow = false) {
    for (const [mat, geos] of this.buckets) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = castShadow;
      m.receiveShadow = true;
      parent.add(m);
      for (const g of geos) g.dispose();
    }
    this.buckets.clear();
  }
}

/** A painted far skyline wrapped around the scene: silhouettes, lit windows, haze. Almost free to draw. */
export function farPanorama(radius: number, baseY: number, height: number, tint: number) {
  const W = 2048, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const layers = [
    { min: 0.25, max: 0.75, shade: 70, win: 0.25 },
    { min: 0.15, max: 0.55, shade: 52, win: 0.35 },
    { min: 0.08, max: 0.35, shade: 38, win: 0.45 },
  ];
  for (const L of layers) {
    for (let x = 0; x < W; ) {
      const bw = 18 + Math.random() * 60;
      const bh = H * (L.min + Math.random() * (L.max - L.min));
      const v = L.shade + Math.random() * 10;
      g.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
      g.fillRect(x, H - bh, bw, bh);
      // Setback crown or spire.
      if (Math.random() < 0.3) g.fillRect(x + bw * 0.25, H - bh - bh * 0.12, bw * 0.5, bh * 0.12);
      if (Math.random() < 0.12) g.fillRect(x + bw / 2 - 1, H - bh - bh * 0.3, 2, bh * 0.3);
      // Window lights.
      for (let wy = H - bh + 6; wy < H - 4; wy += 6) for (let wx = x + 3; wx < x + bw - 3; wx += 5) {
        if (Math.random() < L.win * 0.35) { g.fillStyle = Math.random() < 0.7 ? 'rgba(255,214,150,0.9)' : 'rgba(200,230,255,0.85)'; g.fillRect(wx, wy, 2, 2); }
      }
      x += bw + Math.random() * 6;
    }
  }
  // Haze toward the bottom.
  const hz = g.createLinearGradient(0, H * 0.4, 0, H);
  hz.addColorStop(0, 'rgba(255,255,255,0)');
  hz.addColorStop(1, 'rgba(255,255,255,0.45)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = hz;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  const t = tex(c);
  t.repeat.set(3, 1);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: tint, transparent: true, fog: false, depthWrite: false, side: THREE.BackSide });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 64, 1, true), mat);
  m.position.y = baseY + height / 2;
  m.renderOrder = -1;
  return m;
}

/** Soft volumetric sun shafts: open cones whose silhouettes and ends fade out (no hard plane edges). */
export function lightShafts(parent: THREE.Object3D, spots: [number, number, number][], sunDir: THREE.Vector3, color: number, opacity = 0.08) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: opacity * 2.2 } },
    vertexShader: `
      varying float vY; varying vec3 vN; varying vec3 vV;
      void main() {
        vY = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 color; uniform float opacity;
      varying float vY; varying vec3 vN; varying vec3 vV;
      void main() {
        float edge = pow(abs(dot(vN, vV)), 2.0);          // fade at the cone silhouette
        float along = smoothstep(0.0, 0.35, vY) * smoothstep(1.0, 0.6, vY); // fade both ends
        gl_FragColor = vec4(color * opacity * edge * along, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const dir = sunDir.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  for (const [x, y, z] of spots) {
    const r = 2 + Math.random() * 2;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 1.6, 50, 24, 1, true), mat);
    cone.position.set(x, y, z);
    cone.quaternion.copy(q);
    cone.renderOrder = 2;
    parent.add(cone);
  }
}
