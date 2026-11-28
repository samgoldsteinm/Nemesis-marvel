import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Arena } from './arena';
import { BOUNDS, Prop } from './arena';
import { addOutline } from './rig';
import { hasCityKit, KIT_SIZE, KitBuilding } from './citykit';
import { buildCar } from './props';
import { tex, std, glow, merged, boxG, cylG, neonSign } from './arenas2';

// Four enclosed venues with no way out (no ring-outs — K.O. and finishers only): a night market square boxed in by
// shop fronts, a gothic archive hall, a walled foundry rooftop and a reactor lab. Each perimeter is a solid wall
// (clingable up to its visible height, plus a tall non-clingable barrier) and Arena.pushOut clamps bodies inside
// as a backstop, so nothing — launches, teleports, Displace — can leave the floor.

type V3 = [number, number, number];
const DEG = Math.PI / 180;

/**
 * Solid perimeter just outside BOUNDS. `heights` = visible wall height per side [north(-z), south(+z), west(-x),
 * east(+x)]: that part is a clingable wall; above it a non-clingable barrier keeps fliers and launches in.
 */
function enclose(a: Arena, heights: [number, number, number, number]) {
  const hw = BOUNDS.hw, hd = BOUNDS.hd, T = 3;
  const sides: [number, number, number, number, number][] = [
    [-hw - T, hw + T, -hd - T, -hd, heights[0]],
    [-hw - T, hw + T, hd, hd + T, heights[1]],
    [-hw - T, -hw, -hd, hd, heights[2]],
    [hw, hw + T, -hd, hd, heights[3]],
  ];
  for (const [x0, x1, z0, z1, h] of sides) {
    a.fixedSolids.push({ min: new THREE.Vector3(x0, 0, z0), max: new THREE.Vector3(x1, h, z1), kind: 'hut', clingable: true });
    a.fixedSolids.push({ min: new THREE.Vector3(x0, 0, z0), max: new THREE.Vector3(x1, 80, z1), kind: 'mast', clingable: false });
  }
}
/** A solid cover block inside the arena (clingable). */
function cover(a: Arena, x: number, z: number, w: number, d: number, h: number, cling = true) {
  a.fixedSolids.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, h, z + d / 2), kind: cling ? 'hut' : 'mast', clingable: cling });
}
function noisy(g: CanvasRenderingContext2D, w: number, h: number, n: number, base: [number, number, number], spread: number, sz = 2) {
  for (let i = 0; i < n; i++) {
    const v = (Math.random() - 0.5) * spread;
    g.fillStyle = `rgb(${base[0] + v | 0},${base[1] + v | 0},${base[2] + v | 0})`;
    g.fillRect(Math.random() * w, Math.random() * h, sz, sz);
  }
}
const outlined = (m: THREE.Mesh, k = 1.03) => { m.castShadow = true; m.receiveShadow = true; addOutline(m, k); return m; };
/** Point light that only lights (no shadow), parented to the static group so it goes away with the layout. */
function lamp(a: Arena, color: number, intensity: number, dist: number, p: V3) {
  const l = new THREE.PointLight(color, intensity, dist, 2);
  l.position.set(...p);
  a.static.add(l);
  return l;
}

// ====================================================================== MARKET SQUARE
/** Shop-front texture: brick or painted panels, lit display windows, door, optional awning shadow. */
function shopTex(bg: string, lit: string, seed: number) {
  return tex(512, 256, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 512, 256);
    noisy(g, 512, 256, 3000, [40, 40, 44], 30);
    // Brick courses above the windows.
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
    for (let y = 0; y < 70; y += 9) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); for (let x = (y / 9) % 2 ? 0 : 12; x < 512; x += 24) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 9); g.stroke(); } }
    // Display windows with goods silhouettes, a door between.
    const wins = [[20, 90, 190, 140], [300, 90, 190, 140]];
    for (const [x, y, w, h] of wins) {
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, lit); gr.addColorStop(1, '#101418');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(10,14,16,0.75)';
      for (let i = 0; i < 9; i++) { const sx = x + 8 + ((i * 37 + seed * 13) % (w - 30)), sh = 18 + ((i * 17 + seed) % 40); g.fillRect(sx, y + h - sh - 6, 14 + (i % 3) * 6, sh); }
      g.strokeStyle = '#1a1c20'; g.lineWidth = 6; g.strokeRect(x, y, w, h); g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.stroke();
    }
    g.fillStyle = '#16181c'; g.fillRect(222, 96, 66, 160); g.fillStyle = lit; g.globalAlpha = 0.5; g.fillRect(232, 108, 46, 60); g.globalAlpha = 1;
    g.fillStyle = '#1a1c20'; g.fillRect(0, 76, 512, 10);
  });
}
/** A van: boxy body, cab, windscreen, wheels. Heavy prop, not explosive. */
function buildVan(color: number) {
  const g = new THREE.Group();
  const paint = std({ color, roughness: 0.5, metalness: 0.3 });
  const body = outlined(new THREE.Mesh(new RoundedBoxGeometry(2.1, 2.3, 4.6, 3, 0.18), paint), 1.02);
  body.position.set(0, 1.55, -0.3); g.add(body);
  const cab = outlined(new THREE.Mesh(new RoundedBoxGeometry(2.0, 1.6, 1.4, 3, 0.25), paint), 1.02);
  cab.position.set(0, 1.2, 2.55); g.add(cab);
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.8), new THREE.MeshPhysicalMaterial({ color: 0x18242c, roughness: 0.05, metalness: 0.3, clearcoat: 1 }));
  ws.position.set(0, 1.55, 3.26); ws.rotation.x = -0.25; g.add(ws);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.18, 4.4), std({ color: 0xe8e0c8, roughness: 0.6 }));
  stripe.position.set(0, 1.3, -0.3); g.add(stripe);
  const tire = std({ color: 0x141416, roughness: 0.9 });
  for (const [x, z] of [[-1.0, 2.3], [1.0, 2.3], [-1.0, -1.7], [1.0, -1.7]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16), tire); w.rotation.z = Math.PI / 2; w.position.set(x, 0.42, z); w.castShadow = true; g.add(w); }
  for (const x of [-0.7, 0.7]) { const hl = new THREE.Mesh(new THREE.CircleGeometry(0.13, 12), glow(0xfff4d0)); hl.position.set(x, 0.85, 3.27); g.add(hl); }
  return new Prop('van', 2, g, new THREE.Vector3(1.05, 1.3, 2.4), false);
}
function buildBench() {
  const g = new THREE.Group();
  const wood = std({ color: 0x5a3e28, roughness: 0.85 }), iron = std({ color: 0x1c2420, roughness: 0.5, metalness: 0.6 });
  for (const y of [0.45, 0.5]) { const s = outlined(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.22), wood), 1.05); s.position.set(0, y, y === 0.45 ? -0.1 : 0.14); g.add(s); }
  for (const y of [0.75, 0.9]) { const s = outlined(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.04), wood), 1.05); s.position.set(0, y, -0.26); g.add(s); }
  for (const x of [-0.85, 0.85]) { const l = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.55), iron), 1.05); l.position.set(x, 0.45, 0); g.add(l); }
  return new Prop('bench', 1, g, new THREE.Vector3(0.95, 0.47, 0.3));
}
function buildHydrant() {
  const g = new THREE.Group();
  const m = std({ color: 0xb8241c, roughness: 0.5, metalness: 0.3 });
  const b = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.7, 12), m), 1.06); b.position.y = 0.35; g.add(b);
  const cap = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), m), 1.06); cap.position.y = 0.7; g.add(cap);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8), m); arm.rotation.z = Math.PI / 2; arm.position.y = 0.5; g.add(arm);
  return new Prop('hydrant', 0, g, new THREE.Vector3(0.22, 0.4, 0.22));
}

export function buildMarket(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  // Street: asphalt with a cobbled octagon in the middle, sidewalk kerbs along every front.
  const ground = tex(512, 512, (g) => {
    g.fillStyle = '#23262a'; g.fillRect(0, 0, 512, 512);
    noisy(g, 512, 512, 12000, [38, 40, 44], 26);
    // Cobbled octagon.
    g.save(); g.translate(256, 256);
    g.beginPath(); for (let i = 0; i < 8; i++) { const ang = (i + 0.5) * Math.PI / 4; g.lineTo(Math.cos(ang) * 170, Math.sin(ang) * 170); } g.closePath();
    g.fillStyle = '#34383a'; g.fill(); g.clip();
    for (let y = -180; y < 180; y += 11) for (let x = -180 + ((y / 11) % 2 ? 6 : 0); x < 180; x += 12) {
      const v = 46 + Math.random() * 26; g.fillStyle = `rgb(${v},${v + 3},${v + 2})`; g.beginPath(); g.ellipse(x, y, 5.2, 4.6, 0, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    g.strokeStyle = '#5a5e5c'; g.lineWidth = 6; g.beginPath(); for (let i = 0; i <= 8; i++) { const ang = (i + 0.5) * Math.PI / 4; g.lineTo(256 + Math.cos(ang) * 172, 256 + Math.sin(ang) * 172); } g.stroke();
    // Faded lane paint.
    g.strokeStyle = 'rgba(200,190,120,0.35)'; g.lineWidth = 4; g.setLineDash([22, 18]);
    g.beginPath(); g.moveTo(0, 470); g.lineTo(512, 470); g.stroke(); g.beginPath(); g.moveTo(0, 42); g.lineTo(512, 42); g.stroke();
  });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.4, HD * 2), std({ map: ground, roughness: 0.88 }));
  floor.position.y = -0.2; floor.receiveShadow = true; s.add(floor);
  // Kerbs + sidewalk strips (flush; visual only).
  const kerb = std({ color: 0x6a6c6a, roughness: 0.9 });
  merged(s, [boxG(HW * 2, 0.06, 1.6, 0, 0.0, -HD + 0.8), boxG(HW * 2, 0.06, 1.6, 0, 0.0, HD - 0.8), boxG(1.6, 0.06, HD * 2 - 3.2, -HW + 0.8, 0, 0), boxG(1.6, 0.06, HD * 2 - 3.2, HW - 0.8, 0, 0)], kerb, false);

  // ---- Shop fronts on all four sides (ground-floor facades with lit windows), buildings above.
  const fronts: [string, string, string, string][] = [
    ['GROCERS', '#7dffb0', '#2a3a34', '#cfe8a0'], ['DELI & CO', '#ffd27a', '#3a2a22', '#ffd890'], ['SURPLUS STORE', '#9adfff', '#2a3238', '#a8d8e8'],
    ['PAWN', '#ffb04f', '#30282a', '#e8c890'], ['LAUNDROMAT', '#7ad0ff', '#283038', '#c0e0f0'], ['NOODLES', '#ff6a8a', '#33242a', '#ffc0a0'],
  ];
  const shopMats = fronts.map(([, , bg, lit], i) => { const t = shopTex(bg, lit, i * 7 + 3); return std({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.35, roughness: 0.75 }); });
  type Side = { len: number; at: (u: number, off: number) => V3; ry: number };
  const sides: Side[] = [
    { len: HW * 2, at: (u, off) => [u, 0, -HD - off], ry: 0 },
    { len: HW * 2, at: (u, off) => [u, 0, HD + off], ry: Math.PI },
    { len: HD * 2, at: (u, off) => [-HW - off, 0, u], ry: Math.PI / 2 },
    { len: HD * 2, at: (u, off) => [HW + off, 0, u], ry: -Math.PI / 2 },
  ];
  let si = 0;
  const pilasters: THREE.BufferGeometry[] = [];
  const cornices: THREE.BufferGeometry[] = [];
  const awnings = new Map<number, THREE.BufferGeometry[]>();
  for (const side of sides) {
    const n = Math.round(side.len / 9);
    const w = side.len / n;
    for (let i = 0; i < n; i++) {
      const u = -side.len / 2 + w * (i + 0.5);
      const [x, , z] = side.at(u, 0.15);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, 4.6), shopMats[si % shopMats.length]);
      panel.position.set(x, 2.3, z); panel.rotation.y = side.ry; panel.receiveShadow = true; s.add(panel);
      const [px, , pz] = side.at(u - w / 2, 0.1);
      const pg = new THREE.BoxGeometry(0.5, 5.4, 0.5); pg.translate(px, 2.7, pz); pilasters.push(pg);
      const cg = new THREE.BoxGeometry(w, 0.4, 0.6); cg.rotateY(side.ry); const [cx, , cz] = side.at(u, 0.2); cg.translate(cx, 4.9, cz); cornices.push(cg);
      // Awning over the windows, sign above it.
      const col = [0x2a6a4a, 0x8a2a2a, 0x2a4a7a, 0x6a5a2a][si % 4];
      const ag = new THREE.BoxGeometry(w - 1.2, 0.1, 1.4); ag.rotateX(0.32); ag.rotateY(side.ry); const [ax, , az] = side.at(u, -0.55); ag.translate(ax, 3.9, az);
      const al = awnings.get(col) ?? []; al.push(ag); awnings.set(col, al);
      const [name, neon] = fronts[si % fronts.length];
      if (si % 3 !== 2) { const sg = neonSign(name, neon, Math.min(w - 1.5, 6.5), 1.3); const [sx, , sz] = side.at(u, -0.05); sg.position.set(sx, 5.7, sz); sg.rotation.y = side.ry; s.add(sg); }
      si++;
    }
  }
  const brick = std({ color: 0x3a2e2a, roughness: 0.9 });
  merged(s, pilasters, brick);
  merged(s, cornices, std({ color: 0x4a4a48, roughness: 0.85 }), false);
  for (const [c, l] of awnings) merged(s, l, std({ color: c, roughness: 0.8, side: THREE.DoubleSide }), false);
  // Theatre marquee on the east side (original show title), vertical blade sign on the north.
  const marqT = tex(512, 192, (g) => {
    g.fillStyle = '#f0e8d0'; g.fillRect(0, 0, 512, 192);
    g.fillStyle = '#1a1414'; g.font = 'bold 44px Arial'; g.textAlign = 'center';
    g.fillText('THE ROYALE', 256, 56); g.font = 'bold 30px Arial'; g.fillText('TONIGHT: CITY OF ECHOES', 256, 110); g.font = '24px Arial'; g.fillText('LATE SHOW 11:40', 256, 154);
    for (let x = 8; x < 512; x += 18) { g.fillStyle = '#ffd890'; g.beginPath(); g.arc(x, 8, 4, 0, 7); g.arc(x, 184, 4, 0, 7); g.fill(); }
  });
  const marq = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, 7.5), [std({ color: 0x2a2224 }), std({ color: 0x2a2224 }), std({ color: 0x2a2224 }), std({ color: 0x2a2224 }), std({ map: marqT, emissive: 0xffffff, emissiveMap: marqT, emissiveIntensity: 0.55 }), std({ map: marqT, emissive: 0xffffff, emissiveMap: marqT, emissiveIntensity: 0.55 })]), 1.02);
  marq.position.set(HW + 0.1, 6.6, 3); marq.rotation.y = Math.PI / 2; s.add(marq);
  const blade = neonSign('SURPLUS', '#9adfff', 6, 1.2); blade.rotation.set(0, 0, Math.PI / 2); blade.position.set(-4, 9.5, -HD + 0.2); s.add(blade);
  // Buildings above the shop fronts (kit where available), closing the square on every side.
  const top = (x: number, z: number, w: number, d: number, h: number, face: V3) => a.cityB.building({ x, z, w, d, bottom: 5.1, top: 5.1 + h, detail: 2, front: new THREE.Vector3(...face) });
  if (hasCityKit()) {
    const place = (name: KitBuilding, x: number, z: number, ry: number) => a.kitBlock(name, x, z, ry, 5.1, 5.1, undefined, undefined, 2);
    place('Building_Large_2', -6.6, -HD - KIT_SIZE.Building_Large_2.d / 2 - 0.3, 0);
    place('Building_Small_1', 10.5, -HD - KIT_SIZE.Building_Small_1.d / 2 - 0.3, 0);
    place('Building_Medium_2_001', -8.5, HD + KIT_SIZE.Building_Medium_2_001.d / 2 + 0.3, Math.PI);
    place('Building_Medium_2_001', 8.5, HD + KIT_SIZE.Building_Medium_2_001.d / 2 + 0.3, Math.PI);
    a.flushKit(false);
  } else {
    top(-6, -HD - 7.5, 22, 15, 22, [0, 0, 1]); top(11, -HD - 7.5, 12, 15, 14, [0, 0, 1]);
    top(-8.5, HD + 7, 16, 14, 18, [0, 0, -1]); top(8.5, HD + 7, 16, 14, 24, [0, 0, -1]);
  }
  top(-HW - 7.3, 0, 14, HD * 2 + 1, 16, [1, 0, 0]);
  top(HW + 7.3, 0, 14, HD * 2 + 1, 20, [-1, 0, 0]);
  // Lower podium walls behind the shop fronts so nothing shows through gaps between kit buildings.
  merged(s, [boxG(HW * 2 + 2, 5.1, 0.5, 0, 2.55, -HD - 0.55), boxG(HW * 2 + 2, 5.1, 0.5, 0, 2.55, HD + 0.55), boxG(0.5, 5.1, HD * 2 + 2, -HW - 0.55, 2.55, 0), boxG(0.5, 5.1, HD * 2 + 2, HW + 0.55, 2.55, 0)], brick, false);
  a.buildCity(30, -10, 0x2a4a44);
  a.cityB.flush(a.static);

  // ---- Street furniture: lamps (anchors), fire escapes (anchors), steam vents, a newsstand and a bus shelter (cover).
  const iron = std({ color: 0x1a2220, roughness: 0.5, metalness: 0.6 });
  const lampHead = glow(0xd8ffd8);
  const poles: THREE.BufferGeometry[] = [], heads: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-HW + 1.6, -HD + 1.6], [HW - 1.6, -HD + 1.6], [-HW + 1.6, HD - 1.6], [HW - 1.6, HD - 1.6]] as [number, number][]) {
    poles.push(cylG(0.1, 0.14, 6.4, x, 3.2, z, 8), boxG(1.4, 0.08, 0.08, x - Math.sign(x) * 0.6, 6.3, z));
    heads.push(boxG(0.5, 0.18, 0.4, x - Math.sign(x) * 1.2, 6.2, z));
    a.anchors.push(new THREE.Vector3(x, 6.4, z));
    a.fixedSolids.push({ min: new THREE.Vector3(x - 0.2, 0, z - 0.2), max: new THREE.Vector3(x + 0.2, 6.4, z + 0.2), kind: 'mast', clingable: false });
  }
  merged(s, poles, iron);
  merged(s, heads, lampHead, false);
  lamp(a, 0xb8ffd8, 18, 18, [-HW + 3, 6, -HD + 2]);
  lamp(a, 0xffd8a0, 16, 18, [HW - 3, 6, HD - 2]);
  const esc: THREE.BufferGeometry[] = [];
  for (const [x, z, ry] of [[-8, -HD - 0.6, 0], [6, HD + 0.6, Math.PI], [-HW - 0.6, -4, Math.PI / 2]] as V3[]) {
    for (const y of [7.5, 10.5, 13.5]) {
      const pl = new THREE.BoxGeometry(4, 0.08, 1.2); pl.rotateY(ry); pl.translate(x, y, z); esc.push(pl);
      const rl = new THREE.BoxGeometry(4, 0.06, 0.06); rl.rotateY(ry); rl.translate(x + Math.sin(ry) * -0.55, y + 0.9, z + Math.cos(ry) * 0.55); esc.push(rl);
    }
    a.anchors.push(new THREE.Vector3(x, 10.5, z));
  }
  merged(s, esc, iron, false);
  // Steam vents (grates) that breathe green steam.
  const vents: V3[] = [[-6, 0.02, 4], [7.5, 0.02, -5], [-11, 0.02, -7]];
  merged(s, vents.map(([x, y, z]) => boxG(1.2, 0.04, 0.8, x, y, z)), std({ color: 0x101414, roughness: 0.5, metalness: 0.7 }), false);
  let steamT = 0;
  a.ambient = (dt) => {
    steamT += dt;
    if (steamT < 0.06) return;
    steamT = 0;
    const v = vents[(Math.random() * vents.length) | 0];
    a.fx.wisp(new THREE.Vector3(v[0] + (Math.random() - 0.5) * 0.8, 0.3, v[2] + (Math.random() - 0.5) * 0.5), new THREE.Color(0x3ac08a).multiplyScalar(0.35), 1.6 + Math.random());
  };
  // Newsstand kiosk (cover, clingable) and a bus shelter.
  const kiosk = new THREE.Group();
  const kb = outlined(new THREE.Mesh(new RoundedBoxGeometry(2.6, 2.6, 1.8, 2, 0.06), std({ color: 0x24443a, roughness: 0.7 })));
  kb.position.y = 1.3; kiosk.add(kb);
  const kr = outlined(new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.15, 2.2), std({ color: 0x1a2a24, roughness: 0.6 }))); kr.position.y = 2.7; kiosk.add(kr);
  const mags = tex(256, 128, (g) => { g.fillStyle = '#20201c'; g.fillRect(0, 0, 256, 128); for (let i = 0; i < 24; i++) { g.fillStyle = `hsl(${(i * 47) % 360},60%,${40 + (i % 3) * 12}%)`; g.fillRect(8 + (i % 8) * 31, 8 + Math.floor(i / 8) * 40, 26, 34); } });
  const mp = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.1), std({ map: mags, emissive: 0xffffff, emissiveMap: mags, emissiveIntensity: 0.25 })); mp.position.set(0, 1.5, 0.91); kiosk.add(mp);
  kiosk.position.set(-HW + 4.5, 0, 6.5); s.add(kiosk);
  cover(a, -HW + 4.5, 6.5, 2.6, 1.8, 2.7);
  a.anchors.push(new THREE.Vector3(-HW + 4.5, 6, 6.5));
  const shelter: THREE.BufferGeometry[] = [boxG(3.6, 0.12, 1.6, 12, 2.6, -HD + 2.1), boxG(0.1, 2.6, 0.1, 10.3, 1.3, -HD + 1.4), boxG(0.1, 2.6, 0.1, 13.7, 1.3, -HD + 1.4), boxG(0.1, 2.6, 0.1, 10.3, 1.3, -HD + 2.8), boxG(0.1, 2.6, 0.1, 13.7, 1.3, -HD + 2.8)];
  merged(s, shelter, iron);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.2), std({ color: 0x9adfd0, transparent: true, opacity: 0.18, roughness: 0.1, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide }));
  glass.position.set(12, 1.4, -HD + 1.4); s.add(glass);
  // Solid back pane and posts (walking through the glass hid fighters from the camera); the roof stays open below.
  cover(a, 12, -HD + 1.4, 3.6, 0.2, 2.6, false);
  for (const [x, z] of [[10.3, -HD + 2.8], [13.7, -HD + 2.8]] as [number, number][]) cover(a, x, z, 0.2, 0.2, 2.6, false);
  // Puddles and grime.
  for (let i = 0; i < 7; i++) a.decal('puddle', (Math.random() - 0.5) * HW * 1.7, (Math.random() - 0.5) * HD * 1.6, 1.5 + Math.random() * 2.5, Math.random() * 3);
  for (let i = 0; i < 8; i++) a.decal('stain', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.7, 2 + Math.random() * 2);
  enclose(a, [5, 5, 5, 5]);
  a.ceiling = 14;
  a.spawns = [new THREE.Vector3(-5.5, 0, 0.5), new THREE.Vector3(5.5, 0, 0.5)];
}

// ====================================================================== THE ARCHIVE
function booksTex() {
  return tex(512, 512, (g) => {
    g.fillStyle = '#1a1210'; g.fillRect(0, 0, 512, 512);
    const shelfH = 64;
    for (let y = 0; y < 512; y += shelfH) {
      let x = 4;
      while (x < 508) {
        const w = 6 + Math.random() * 12, h = shelfH * (0.62 + Math.random() * 0.3);
        const hue = [8, 20, 30, 140, 200, 350][(Math.random() * 6) | 0];
        g.fillStyle = `hsl(${hue},${25 + Math.random() * 30}%,${14 + Math.random() * 16}%)`;
        g.fillRect(x, y + shelfH - h - 6, w, h);
        g.fillStyle = 'rgba(220,190,120,0.35)'; g.fillRect(x + 1, y + shelfH - h + 6, w - 2, 2);
        x += w + 1 + (Math.random() < 0.06 ? 14 : 0);
      }
      g.fillStyle = '#3a2618'; g.fillRect(0, y + shelfH - 6, 512, 6);
    }
    for (let x = 0; x <= 512; x += 128) { g.fillStyle = '#2a1a10'; g.fillRect(x - 5, 0, 10, 512); }
  }, [3, 1]);
}
function buildArmchair() {
  const g = new THREE.Group();
  const vel = std({ color: 0x5a3a5a, roughness: 0.95 }), wood = std({ color: 0x2a1a10, roughness: 0.7 });
  const seat = outlined(new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.3, 0.85, 3, 0.1), vel), 1.05); seat.position.y = 0.45; g.add(seat);
  const back = outlined(new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.9, 0.22, 3, 0.1), vel), 1.05); back.position.set(0, 0.95, -0.34); g.add(back);
  for (const x of [-0.48, 0.48]) { const arm = outlined(new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.45, 0.8, 3, 0.08), vel), 1.05); arm.position.set(x, 0.65, 0.02); g.add(arm); }
  for (const [x, z] of [[-0.4, -0.35], [0.4, -0.35], [-0.4, 0.35], [0.4, 0.35]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.3, 6), wood); l.position.set(x, 0.15, z); g.add(l); }
  return new Prop('armchair', 1, g, new THREE.Vector3(0.55, 0.65, 0.48));
}
function buildArmour() {
  const g = new THREE.Group();
  const steel = std({ color: 0x8a909a, roughness: 0.3, metalness: 0.9 }), dark = std({ color: 0x2a2220, roughness: 0.7 });
  const base = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.5), dark), 1.05); base.position.y = 0.075; g.add(base);
  for (const x of [-0.12, 0.12]) { const leg = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.85, 8), steel), 1.05); leg.position.set(x, 0.58, 0); g.add(leg); }
  const torso = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.6, 10), steel), 1.05); torso.position.y = 1.3; g.add(torso);
  for (const x of [-0.3, 0.3]) { const sh = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), steel), 1.05); sh.position.set(x, 1.55, 0); g.add(sh); const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.6, 8), steel); arm.position.set(x * 1.05, 1.22, 0.04); g.add(arm); }
  const helm = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 10), steel), 1.05); helm.position.y = 1.78; g.add(helm);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.02), dark); visor.position.set(0, 1.8, 0.14); g.add(visor);
  const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.2, 6), dark); spear.position.set(0.32, 1.1, 0.1); g.add(spear);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.25, 6), steel); tip.position.set(0.32, 2.3, 0.1); g.add(tip);
  return new Prop('armour', 1, g, new THREE.Vector3(0.32, 1.0, 0.28));
}
function buildCabinet() {
  const g = new THREE.Group();
  const wood = std({ color: 0x4a3418, roughness: 0.6, metalness: 0.1 }), gold = std({ color: 0xc8a050, roughness: 0.35, metalness: 0.8 });
  const body = outlined(new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.0, 0.55), wood), 1.03); body.position.y = 1.0; g.add(body);
  const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.5), std({ color: 0xa8c8d8, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.3, depthWrite: false })); gl.position.set(0, 1.1, 0.28); g.add(gl);
  for (const y of [0.55, 1.05, 1.55]) { const sh = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.45), gold); sh.position.set(0, y, 0); g.add(sh); }
  const crown = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 0.65), gold); crown.position.y = 2.05; g.add(crown);
  return new Prop('cabinet', 1, g, new THREE.Vector3(0.6, 1.0, 0.28));
}
function buildSideTable() {
  const g = new THREE.Group();
  const wood = std({ color: 0x3a2414, roughness: 0.6 });
  const top = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 18), wood), 1.05); top.position.y = 0.7; g.add(top);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.68, 8), wood); leg.position.y = 0.35; g.add(leg);
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.06, 0.18), std({ color: 0x6a1a1a })); book.position.set(0.1, 0.76, 0); g.add(book);
  return new Prop('table', 0, g, new THREE.Vector3(0.45, 0.37, 0.45));
}

export function buildArchive(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  // Stone floor with diamond inlays, a big patterned rug in the middle.
  const floorT = tex(256, 256, (g) => {
    g.fillStyle = '#3a3c48'; g.fillRect(0, 0, 256, 256); noisy(g, 256, 256, 4000, [58, 60, 72], 18);
    g.strokeStyle = 'rgba(20,20,30,0.6)'; g.lineWidth = 2; for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    g.fillStyle = '#20222c'; for (let y = 0; y <= 256; y += 64) for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 8, y); g.lineTo(x, y + 8); g.lineTo(x - 8, y); g.fill(); }
  }, [8, 5.5]);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 8, 0.4, HD * 2 + 8), std({ map: floorT, roughness: 0.55, metalness: 0.1 }));
  floor.position.y = -0.2; floor.receiveShadow = true; s.add(floor);
  const rugT = tex(512, 320, (g) => {
    g.fillStyle = '#3a1c24'; g.fillRect(0, 0, 512, 320);
    g.strokeStyle = '#a07838'; g.lineWidth = 8; g.strokeRect(14, 14, 484, 292); g.lineWidth = 3; g.strokeRect(30, 30, 452, 260);
    for (let y = 60; y < 280; y += 50) for (let x = 60; x < 470; x += 56) {
      g.fillStyle = (x + y) % 3 ? '#5a2a34' : '#24304a'; g.beginPath(); g.moveTo(x, y - 20); g.lineTo(x + 22, y); g.lineTo(x, y + 20); g.lineTo(x - 22, y); g.fill();
      g.fillStyle = '#b89048'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    }
    noisy(g, 512, 320, 4000, [60, 30, 36], 24);
  });
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(18, 11), std({ map: rugT, roughness: 0.98 }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = 0.012; rug.receiveShadow = true; s.add(rug);

  // Walls: two storeys of bookcases; the upper gallery is set back behind a balustrade at the playfield edge.
  const books = std({ map: booksTex(), roughness: 0.85 });
  const wood = std({ color: 0x2a1a12, roughness: 0.6 });
  const stone = std({ color: 0x4a4c58, roughness: 0.85 });
  const GH = 6.2, TOP = 17;
  const lower: THREE.BufferGeometry[] = [], upper: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [], gallery: THREE.BufferGeometry[] = [];
  const wall = (len: number, x: number, z: number, ry: number, inset: number) => {
    const nx = Math.sin(ry), nz = Math.cos(ry);
    const lw = new THREE.PlaneGeometry(len, GH - 0.4); lw.rotateY(ry); lw.translate(x, GH / 2 - 0.2, z); lower.push(lw);
    const uw = new THREE.PlaneGeometry(len + inset * 2, TOP - GH - 1); uw.rotateY(ry); uw.translate(x - nx * inset, GH + (TOP - GH - 1) / 2, z - nz * inset); upper.push(uw);
    const gf = new THREE.BoxGeometry(len + inset * 2, 0.5, inset); gf.rotateY(ry); gf.translate(x - nx * inset / 2, GH, z - nz * inset / 2); gallery.push(gf);
    const rail = new THREE.BoxGeometry(len, 0.14, 0.18); rail.rotateY(ry); rail.translate(x, GH + 1.1, z); trim.push(rail);
    for (let u = -len / 2; u <= len / 2; u += 0.7) { const b = new THREE.CylinderGeometry(0.05, 0.06, 1.0, 6); b.translate(x + nz * u, GH + 0.6, z - nx * u); trim.push(b); }
    const base = new THREE.BoxGeometry(len, 0.4, 0.3); base.rotateY(ry); base.translate(x, 0.2, z); trim.push(base);
  };
  wall(HW * 2, 0, -HD, 0, 3); wall(HW * 2, 0, HD, Math.PI, 3); wall(HD * 2, -HW, 0, Math.PI / 2, 3); wall(HD * 2, HW, 0, -Math.PI / 2, 3);
  merged(s, lower, books, false);
  merged(s, upper, books, false);
  merged(s, gallery, wood, false);
  merged(s, trim, wood, false);
  // Tall dark columns: four inside the hall (cover, clingable) and a row along each long wall.
  const cols: THREE.BufferGeometry[] = [], caps: THREE.BufferGeometry[] = [];
  const colAt = (x: number, z: number, solid: boolean) => {
    cols.push(boxG(1.1, TOP, 1.1, x, TOP / 2, z));
    caps.push(boxG(1.5, 0.5, 1.5, x, 0.25, z), boxG(1.5, 0.6, 1.5, x, GH, z), boxG(1.4, 0.5, 1.4, x, TOP - 0.3, z));
    if (solid) cover(a, x, z, 1.1, 1.1, TOP);
  };
  for (const [x, z] of [[-9, -5.5], [9, -5.5], [-9, 5.5], [9, 5.5]]) colAt(x, z, true);
  for (const x of [-HW + 0.6, -5, 5, HW - 0.6]) colAt(x, -HD - 0.6, false); // north only: the camera usually sits south
  merged(s, cols, std({ color: 0x1c1a22, roughness: 0.55, metalness: 0.15 }));
  merged(s, caps, stone, false);
  // Vaulted roof: beams and glowing skylights (doesn't cast shadows, so the key light reaches the floor).
  const roof: THREE.BufferGeometry[] = [];
  for (let x = -HW - 3; x <= HW + 3; x += 4) { roof.push(boxG(0.5, 0.7, HD * 2 + 6, x, TOP, 0)); }
  roof.push(boxG(HW * 2 + 6, 0.7, 0.5, 0, TOP + 2.4, 0));
  for (const sz of [-1, 1]) roof.push(boxG(HW * 2 + 6, 0.5, 0.5, 0, TOP + 1.2, sz * (HD / 2)));
  merged(s, roof, wood, false);
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2 + 6, HD * 2 + 6), std({ color: 0x0c1424, emissive: 0x3a5a9a, emissiveIntensity: 0.35, roughness: 1 }));
  sky.rotation.x = Math.PI / 2; sky.position.y = TOP + 2.6; s.add(sky);
  // Chandeliers: iron rings with candle lanterns hanging over the floor (swing anchors).
  const ring: THREE.BufferGeometry[] = [], chains: THREE.BufferGeometry[] = [], lanterns: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-6, -3], [6, -3], [-6, 3.5], [6, 3.5], [0, 0]] as [number, number][]) {
    const y = 10.5;
    const t = new THREE.TorusGeometry(1.1, 0.06, 6, 20); t.rotateX(Math.PI / 2); t.translate(x, y, z); ring.push(t);
    chains.push(cylG(0.02, 0.02, TOP - y, x, (TOP + y) / 2, z, 4));
    for (let i = 0; i < 6; i++) { const ang = (i / 6) * Math.PI * 2; lanterns.push(boxG(0.2, 0.35, 0.2, x + Math.cos(ang) * 1.1, y - 0.2, z + Math.sin(ang) * 1.1)); }
    lanterns.push(boxG(0.4, 0.8, 0.4, x, y - 0.6, z));
    a.anchors.push(new THREE.Vector3(x, y, z));
  }
  merged(s, ring, std({ color: 0x1a1814, roughness: 0.4, metalness: 0.8 }), false);
  merged(s, chains, std({ color: 0x1a1814, roughness: 0.4, metalness: 0.8 }), false);
  merged(s, lanterns, glow(0xbcd8ff), false);
  // Gallery-edge swing points.
  for (const x of [-10, 0, 10]) for (const z of [-HD, HD]) a.anchors.push(new THREE.Vector3(x, GH + 1.2, z));
  // Fireplace on the north wall: stone surround, glowing hearth, flickering flames.
  const fp: THREE.BufferGeometry[] = [boxG(5, 3.6, 0.8, 0, 1.8, -HD + 0.1), boxG(5.6, 0.4, 1.0, 0, 3.7, -HD + 0.2)];
  merged(s, fp, stone);
  const hearth = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), std({ color: 0x100604, emissive: 0xff7a2a, emissiveIntensity: 0.9 }));
  hearth.position.set(0, 1.2, -HD + 0.52); s.add(hearth);
  lamp(a, 0xff8a3a, 30, 16, [0, 1.6, -HD + 2]);
  lamp(a, 0x9ac0ff, 14, 26, [0, 9.5, 0]);
  let fireT = 0;
  a.ambient = (dt) => {
    fireT += dt;
    if (fireT < 0.05) return;
    fireT = 0;
    a.fx.wisp(new THREE.Vector3((Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.4, -HD + 0.7), new THREE.Color(Math.random() < 0.5 ? 0xff6a1a : 0xffb040).multiplyScalar(0.75), 0.7 + Math.random() * 0.4);
  };
  // Portraits on the gallery wall (dark frames, warm canvas), a grand clock.
  const frames: THREE.BufferGeometry[] = [], canv: THREE.BufferGeometry[] = [];
  for (const x of [-11, -6, 6, 11]) { frames.push(boxG(2.4, 3, 0.12, x, GH + 4.5, -HD - 2.9)); canv.push(boxG(2.0, 2.6, 0.14, x, GH + 4.5, -HD - 2.88)); }
  merged(s, frames, std({ color: 0x8a6a30, roughness: 0.4, metalness: 0.6 }), false);
  merged(s, canv, std({ color: 0x3a2a20, emissive: 0x4a2a18, emissiveIntensity: 0.4, roughness: 0.9 }), false);
  enclose(a, [GH, GH, GH, GH]);
  a.ceiling = 13;
  a.spawns = [new THREE.Vector3(-5, 0, 1), new THREE.Vector3(5, 0, 1)];
}

// ====================================================================== FOUNDRY ROOF
function buildTankProp() {
  const g = new THREE.Group();
  const m = std({ color: 0x5a6a5a, roughness: 0.55, metalness: 0.5 });
  const b = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 14), m), 1.04); b.position.y = 0.6; g.add(b);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.15, 14), std({ color: 0xd8a020, roughness: 0.5 })); band.position.y = 0.85; g.add(band);
  return new Prop('canister', 1, g, new THREE.Vector3(0.42, 0.6, 0.42), true);
}
export function buildFoundry(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  const deckT = tex(256, 256, (g) => {
    g.fillStyle = '#4a4238'; g.fillRect(0, 0, 256, 256); noisy(g, 256, 256, 6000, [72, 64, 54], 28);
    g.strokeStyle = 'rgba(20,16,12,0.7)'; g.lineWidth = 3; for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    for (let i = 0; i < 8; i++) { const gr = g.createRadialGradient(Math.random() * 256, Math.random() * 256, 4, 128, 128, 120); gr.addColorStop(0, 'rgba(20,16,10,0.25)'); gr.addColorStop(1, 'rgba(20,16,10,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  }, [7, 5]);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 2, 0.5, HD * 2 + 2), std({ map: deckT, roughness: 0.92 }));
  deck.position.y = -0.25; deck.receiveShadow = true; s.add(deck);
  // Painted landing H in a ring (faded).
  const hT = tex(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(220,190,120,0.55)'; g.lineWidth = 12; g.beginPath(); g.arc(128, 128, 110, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(220,190,120,0.55)'; g.fillRect(78, 58, 26, 140); g.fillRect(152, 58, 26, 140); g.fillRect(104, 116, 48, 24);
  });
  const hm = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), std({ map: hT, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
  hm.rotation.x = -Math.PI / 2; hm.position.y = 0.015; s.add(hm);
  // Perimeter: a tall factory wall with lit windows on the north, high parapet walls elsewhere.
  const factT = tex(512, 256, (g) => {
    g.fillStyle = '#3a3028'; g.fillRect(0, 0, 512, 256); noisy(g, 512, 256, 5000, [58, 48, 40], 22);
    for (let x = 16; x < 512; x += 128) {
      g.fillStyle = '#2a2018'; g.fillRect(x, 30, 96, 200);
      for (let yy = 38; yy < 222; yy += 24) for (let xx = x + 6; xx < x + 90; xx += 21) { const lit = Math.random() < 0.75; g.fillStyle = lit ? (Math.random() < 0.5 ? '#ffcf7a' : '#ffe0a8') : '#3a2a20'; g.fillRect(xx, yy, 17, 19); }
    }
  }, [3, 1]);
  const fact = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 6, 16, 2), [std({ color: 0x3a3028 }), std({ color: 0x3a3028 }), std({ color: 0x2a2018 }), std({ color: 0x2a2018 }), std({ map: factT, emissive: 0xffffff, emissiveMap: factT, emissiveIntensity: 0.45, roughness: 0.85 }), std({ color: 0x2a2018 })]);
  fact.position.set(0, 8, -HD - 1); fact.receiveShadow = true; s.add(fact);
  const parT = tex(256, 128, (g) => { g.fillStyle = '#5a5248'; g.fillRect(0, 0, 256, 128); noisy(g, 256, 128, 3000, [86, 78, 68], 24); g.fillStyle = 'rgba(30,24,18,0.5)'; g.fillRect(0, 0, 256, 10); for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(40,30,20,0.3)'; g.fillRect(Math.random() * 256, 10, 3 + Math.random() * 6, 60 + Math.random() * 60); } }, [6, 1]);
  const par = std({ map: parT, roughness: 0.9 });
  merged(s, [boxG(HW * 2 + 2, 3.2, 1.0, 0, 1.6, HD + 0.5), boxG(1.0, 3.2, HD * 2 + 2, -HW - 0.5, 1.6, 0), boxG(1.0, 3.2, HD * 2 + 2, HW + 0.5, 1.6, 0)], par);
  merged(s, [boxG(HW * 2 + 2.4, 0.25, 1.3, 0, 3.3, HD + 0.5), boxG(1.3, 0.25, HD * 2 + 2.4, -HW - 0.5, 3.3, 0), boxG(1.3, 0.25, HD * 2 + 2.4, HW + 0.5, 3.3, 0)], std({ color: 0x3a342c, roughness: 0.8 }), false);
  // Lighting truss towers in the corners (anchors, thin solids).
  const truss: THREE.BufferGeometry[] = [], flood: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-HW + 1.5, -HD + 1.5], [HW - 1.5, -HD + 1.5], [-HW + 1.5, HD - 1.5], [HW - 1.5, HD - 1.5]] as [number, number][]) {
    for (const [dx, dz] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) truss.push(boxG(0.08, 13, 0.08, x + dx, 6.5, z + dz));
    for (let y = 1; y < 13; y += 1.2) { truss.push(boxG(0.75, 0.05, 0.05, x, y, z - 0.35), boxG(0.75, 0.05, 0.05, x, y, z + 0.35), boxG(0.05, 0.05, 0.75, x - 0.35, y, z), boxG(0.05, 0.05, 0.75, x + 0.35, y, z)); truss.push(boxG(0.05, 1.6, 0.05, x - 0.35, y + 0.6, z, 0, 0, 0.6)); }
    flood.push(boxG(0.7, 0.45, 0.25, x - Math.sign(x) * 0.5, 12.8, z - Math.sign(z) * 0.5, Math.atan2(-x, -z)));
    a.anchors.push(new THREE.Vector3(x, 13, z));
    a.fixedSolids.push({ min: new THREE.Vector3(x - 0.45, 0, z - 0.45), max: new THREE.Vector3(x + 0.45, 13, z + 0.45), kind: 'mast', clingable: false });
  }
  merged(s, truss, std({ color: 0x2a2620, roughness: 0.5, metalness: 0.7 }));
  merged(s, flood, glow(0xffe8c0), false);
  // Big rooftop tanks (cover, clingable), steam pipes along the factory wall (anchors).
  const tankM = std({ color: 0x4a4a48, roughness: 0.6, metalness: 0.5 });
  const tanks: THREE.BufferGeometry[] = [], bands: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-10, 5.5], [10.5, -5.5], [12, 6]] as [number, number][]) {
    tanks.push(cylG(1.7, 1.7, 4.4, x, 2.2, z, 20), cylG(1.75, 1.75, 0.25, x, 4.45, z, 20));
    for (const y of [0.9, 2.2, 3.5]) bands.push(cylG(1.74, 1.74, 0.15, x, y, z, 20));
    cover(a, x, z, 3.2, 3.2, 4.5);
    a.anchors.push(new THREE.Vector3(x, 7.5, z));
  }
  merged(s, tanks, tankM);
  merged(s, bands, std({ color: 0x8a6a30, roughness: 0.5, metalness: 0.6 }), false);
  const pipes: THREE.BufferGeometry[] = [];
  for (const y of [6.5, 7.2]) pipes.push(cylG(0.25, 0.25, HW * 2 + 2, 0, y, -HD + 0.3, 12, 0, Math.PI / 2));
  for (const x of [-12, -2, 8]) pipes.push(cylG(0.25, 0.25, 7, x, 3.5, -HD + 0.3, 12));
  merged(s, pipes, std({ color: 0x6a4a2a, roughness: 0.5, metalness: 0.6 }), false);
  for (const x of [-8, 4]) a.anchors.push(new THREE.Vector3(x, 7, -HD + 0.3));
  // Giant sign frame beyond the south-west parapet: backlit letters on a lattice.
  const word = 'ANVIL WORKS';
  const signRoot = new THREE.Group();
  const lat: THREE.BufferGeometry[] = [];
  for (let x = -14; x <= 14; x += 2) lat.push(boxG(0.12, 9, 0.12, x, 4.5, 0));
  for (const y of [1, 4.5, 8.5]) lat.push(boxG(28, 0.12, 0.12, 0, y, 0));
  merged(signRoot, lat, std({ color: 0x1c1a18, roughness: 0.5, metalness: 0.7 }), false);
  [...word].forEach((ch, i) => {
    if (ch === ' ') return;
    const lt = tex(128, 160, (g) => { g.fillStyle = '#18120c'; g.fillRect(0, 0, 128, 160); g.font = 'bold 140px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = '#ffb060'; g.shadowBlur = 18; g.fillStyle = '#ffd8a0'; g.fillText(ch, 64, 86); });
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.8, 0.3), std({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 0.6 }));
    m.position.set(-12.5 + i * 2.5, 6.3, 0.2); signRoot.add(m);
  });
  signRoot.position.set(-2, 3.4, HD + 6); signRoot.rotation.y = Math.PI; s.add(signRoot);
  // Hazy city beyond: kit buildings and skyline in sepia.
  if (hasCityKit()) {
    a.kitBlock('Building_Large_2', 30, 4, -Math.PI / 2, -6, -40, undefined, undefined, 3);
    a.kitBlock('Building_Medium_2_001', -30, -2, Math.PI / 2, -4, -40, undefined, undefined, 3);
    a.kitBlock('Building_Medium_2_001', 6, 34, Math.PI, -10, -40, undefined, undefined, 2);
    a.flushKit(false);
  }
  a.buildCity(40, -40, 0xc8a878);
  a.cityB.flush(a.static);
  // Steam vents.
  const vents: V3[] = [[-5, 0.3, -7], [3, 0.3, 8], [14, 0.3, 0]];
  merged(s, vents.map(([x, , z]) => cylG(0.35, 0.4, 0.6, x, 0.3, z, 10)), std({ color: 0x3a3430, roughness: 0.6, metalness: 0.5 }));
  for (const [x, , z] of vents) cover(a, x, z, 0.7, 0.7, 0.6, false);
  let ventT = 0;
  a.ambient = (dt) => {
    ventT += dt;
    if (ventT < 0.08) return;
    ventT = 0;
    const v = vents[(Math.random() * vents.length) | 0];
    a.fx.wisp(new THREE.Vector3(v[0], 0.8, v[2]), new THREE.Color(0xc8a878).multiplyScalar(0.3), 1.6 + Math.random());
  };
  lamp(a, 0xffd8a0, 20, 22, [0, 9, -HD + 3]);
  for (let i = 0; i < 8; i++) a.decal('stain', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.7, 2 + Math.random() * 3);
  for (let i = 0; i < 5; i++) a.decal('crack', (Math.random() - 0.5) * HW * 1.8, (Math.random() - 0.5) * HD * 1.7, 2 + Math.random() * 2, Math.random() * 6);
  enclose(a, [14, 3.2, 3.2, 3.2]);
  a.ceiling = 14;
  a.spawns = [new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0)];
}

// ====================================================================== CORE LAB
function buildConsole() {
  const g = new THREE.Group();
  const body = std({ color: 0x2a2a36, roughness: 0.5, metalness: 0.6 });
  const scrT = tex(128, 64, (c) => { c.fillStyle = '#06141a'; c.fillRect(0, 0, 128, 64); c.strokeStyle = '#3affd8'; c.lineWidth = 2; c.beginPath(); for (let x = 0; x < 128; x += 4) c.lineTo(x, 32 + Math.sin(x * 0.2) * 14); c.stroke(); c.fillStyle = '#ff4a5a'; c.fillRect(100, 6, 20, 8); });
  const b = outlined(new THREE.Mesh(new RoundedBoxGeometry(1.4, 1.0, 0.8, 2, 0.06), body), 1.04); b.position.y = 0.5; g.add(b);
  const top = outlined(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.9), body), 1.04); top.position.set(0, 1.05, 0.05); top.rotation.x = 0.35; g.add(top);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.5), std({ map: scrT, emissive: 0xffffff, emissiveMap: scrT, emissiveIntensity: 0.8 })); scr.position.set(0, 1.25, -0.25); scr.rotation.x = -0.3; g.add(scr);
  const sb = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.6, 0.06), body); sb.position.set(0, 1.25, -0.3); sb.rotation.x = -0.3; g.add(sb);
  return new Prop('console', 1, g, new THREE.Vector3(0.7, 0.62, 0.45));
}
function buildCanister() {
  const g = new THREE.Group();
  const m = std({ color: 0x3a3a46, roughness: 0.4, metalness: 0.7 });
  const b = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.95, 14), m), 1.05); b.position.y = 0.48; g.add(b);
  const w = new THREE.Mesh(new THREE.CylinderGeometry(0.305, 0.305, 0.5, 14, 1, true, 0, 1.4), std({ color: 0x0a1a1a, emissive: 0x3affd8, emissiveIntensity: 1.2 })); w.position.y = 0.48; g.add(w);
  return new Prop('canister', 0, g, new THREE.Vector3(0.3, 0.48, 0.3), true);
}
export function buildLab(a: Arena) {
  const s = a.static;
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  // Floor: dark metal plates with grated glowing borders and a big teal emblem in the middle.
  const floorT = tex(256, 256, (g) => {
    g.fillStyle = '#1e1e28'; g.fillRect(0, 0, 256, 256); noisy(g, 256, 256, 3000, [36, 36, 46], 14);
    g.strokeStyle = '#0e0e16'; g.lineWidth = 3; for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    g.fillStyle = '#383848'; for (let y = 8; y < 256; y += 64) for (let x = 8; x < 256; x += 64) { g.fillRect(x, y, 4, 4); g.fillRect(x + 44, y, 4, 4); g.fillRect(x, y + 44, 4, 4); g.fillRect(x + 44, y + 44, 4, 4); }
  }, [8, 6]);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 2, 0.4, HD * 2 + 2), std({ map: floorT, roughness: 0.45, metalness: 0.6 }));
  floor.position.y = -0.2; floor.receiveShadow = true; s.add(floor);
  const embT = tex(512, 512, (g) => {
    g.clearRect(0, 0, 512, 512); g.translate(256, 256);
    g.strokeStyle = '#3affd8'; g.shadowColor = '#3affd8'; g.shadowBlur = 12;
    g.lineWidth = 10; g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 92, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 12; i++) {
      g.save(); g.rotate((i / 12) * Math.PI * 2);
      g.fillStyle = i % 2 ? 'rgba(58,255,216,0.75)' : 'rgba(58,255,216,0.45)';
      g.beginPath(); g.moveTo(-10, 100); g.lineTo(10, 100); g.lineTo(18, i % 2 ? 200 : 240); g.lineTo(0, i % 2 ? 212 : 252); g.lineTo(-18, i % 2 ? 200 : 240); g.fill();
      g.fillRect(-28, 150, 56, 8);
      g.restore();
    }
    g.fillStyle = 'rgba(58,255,216,0.18)'; for (let y = -60; y <= 60; y += 15) for (let x = -60; x <= 60; x += 15) if (x * x + y * y < 3600) g.fillRect(x - 5, y - 5, 10, 10);
  });
  const emb = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshBasicMaterial({ map: embT, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, color: 0xb8fff0 }));
  emb.rotation.x = -Math.PI / 2; emb.position.y = 0.015; s.add(emb);
  // Glowing floor grates around the edge.
  const grT = tex(64, 64, (g) => { g.fillStyle = '#0a2a2a'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#2affc8'; for (let i = 2; i < 64; i += 8) for (let j = 2; j < 64; j += 8) g.fillRect(i, j, 5, 5); }, [1, 1]);
  const grM = std({ map: grT, emissive: 0xffffff, emissiveMap: grT, emissiveIntensity: 0.55, roughness: 0.5 });
  const grates: THREE.BufferGeometry[] = [];
  for (let x = -HW + 1.5; x < HW; x += 3) for (const z of [-HD + 0.9, HD - 0.9]) { const g = new THREE.PlaneGeometry(2.2, 1.2); g.rotateX(-Math.PI / 2); g.translate(x, 0.012, z); grates.push(g); }
  for (let z = -HD + 3; z < HD - 2; z += 3) for (const x of [-HW + 0.9, HW - 0.9]) { const g = new THREE.PlaneGeometry(1.2, 2.2); g.rotateX(-Math.PI / 2); g.translate(x, 0.012, z); grates.push(g); }
  merged(s, grates, grM, false);
  // Walls: ribbed dark panels, purple lit; an observation window on the east wall; red light slats on pillars.
  const wallT = tex(256, 256, (g) => {
    g.fillStyle = '#24202e'; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 32) { g.fillStyle = '#2e2a3a'; g.fillRect(x + 2, 0, 26, 256); g.fillStyle = '#16141e'; g.fillRect(x, 0, 2, 256); }
    g.fillStyle = '#1a1824'; g.fillRect(0, 120, 256, 14); g.fillStyle = '#3a3450'; g.fillRect(0, 118, 256, 2);
  }, [6, 1]);
  const WH = 12;
  const wallM = std({ map: wallT, roughness: 0.6, metalness: 0.4 });
  // Inward-facing planes (back faces culled), so a camera that ends up outside the room still sees in.
  const wallPlane = (w: number, h: number, x: number, y: number, z: number, ry: number) => { const g = new THREE.PlaneGeometry(w, h); g.rotateY(ry); g.translate(x, y, z); return g; };
  merged(s, [wallPlane(HW * 2, WH, 0, WH / 2, -HD, 0), wallPlane(HW * 2, WH, 0, WH / 2, HD, Math.PI), wallPlane(HD * 2, WH, -HW, WH / 2, 0, Math.PI / 2),
    wallPlane(6, WH, HW, WH / 2, -HD + 3, -Math.PI / 2), wallPlane(6, WH, HW, WH / 2, HD - 3, -Math.PI / 2), wallPlane(10, 1.6, HW, 0.8, 0, -Math.PI / 2), wallPlane(10, WH - 6, HW, 6 + (WH - 6) / 2, 0, -Math.PI / 2)], wallM, false);
  const winT = tex(512, 256, (g) => {
    g.fillStyle = '#062a2e'; g.fillRect(0, 0, 512, 256);
    const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(58,255,216,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#0c3c40'; for (let x = 30; x < 512; x += 90) { g.fillRect(x, 120, 50, 110); g.fillStyle = '#3affd8'; g.fillRect(x + 20, 100, 10, 20); g.fillStyle = '#0c3c40'; }
    g.strokeStyle = '#3affd8'; g.lineWidth = 3; g.beginPath(); g.arc(420, 150, 30, 0, 7); g.stroke();
    g.fillStyle = 'rgba(200,255,250,0.12)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(120, 0); g.lineTo(40, 256); g.lineTo(0, 256); g.fill();
  });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(10, 4.4), std({ map: winT, emissive: 0xffffff, emissiveMap: winT, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.3 }));
  win.position.set(HW, 3.8, 0); win.rotation.y = -Math.PI / 2; s.add(win);
  merged(s, [boxG(0.4, 0.3, 10.4, HW - 0.1, 1.55, 0), boxG(0.4, 0.3, 10.4, HW - 0.1, 6.05, 0), boxG(0.4, 4.8, 0.3, HW - 0.1, 3.8, -5.1), boxG(0.4, 4.8, 0.3, HW - 0.1, 3.8, 5.1)], std({ color: 0x3a3a4a, roughness: 0.4, metalness: 0.7 }), false);
  // Corner pillars with red slats; the reactor column at the back (cover, clingable).
  const pil: THREE.BufferGeometry[] = [], red: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-HW + 0.8, -HD + 0.8], [HW - 0.8, -HD + 0.8], [-HW + 0.8, HD - 0.8], [HW - 0.8, HD - 0.8]] as [number, number][]) {
    pil.push(boxG(1.6, WH, 1.6, x, WH / 2, z));
    cover(a, x, z, 1.6, 1.6, WH); // solid: fighters used to walk into the pillars (and hide from the camera)
    for (let y = 4; y < 11; y += 0.9) red.push(boxG(0.9, 0.12, 0.05, x, y, z + (z < 0 ? 0.83 : -0.83)));
  }
  const RZ = -HD + 3.2;
  pil.push(cylG(1.6, 1.6, WH, 0, WH / 2, RZ, 16), cylG(2.2, 2.2, 0.8, 0, 0.4, RZ, 16), cylG(2.0, 2.0, 0.6, 0, WH - 0.3, RZ, 16));
  for (let y = 2; y < 11; y += 1.1) for (const ang of [0, 90, 180, 270]) red.push(boxG(0.5, 0.16, 0.06, Math.sin(ang * DEG) * 1.62, y, RZ + Math.cos(ang * DEG) * 1.62, ang * DEG));
  merged(s, pil, std({ color: 0x2c2a38, roughness: 0.45, metalness: 0.6 }));
  merged(s, red, glow(0xff2a3a), false);
  cover(a, 0, RZ, 3.0, 3.0, WH);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 6, 16, 1, true), std({ color: 0x100808, emissive: 0xff3040, emissiveIntensity: 1.1, side: THREE.DoubleSide }));
  core.position.set(0, 4, RZ + 1.0); s.add(core);
  lamp(a, 0xff3a4a, 22, 16, [0, 4, RZ + 2.4]);
  lamp(a, 0x3affd8, 18, 20, [0, 3, 2]);
  // Tesla coil (cover; arcs crackle), catwalk gantry overhead (anchors), ceiling spotlights.
  const TX = -HW + 4, TZ = -2;
  const coil: THREE.BufferGeometry[] = [cylG(0.9, 1.1, 0.8, TX, 0.4, TZ, 14), cylG(0.35, 0.45, 3.4, TX, 2.5, TZ, 12)];
  for (let y = 1.2; y < 4; y += 0.35) coil.push(cylG(0.52, 0.52, 0.14, TX, y, TZ, 14));
  merged(s, coil, std({ color: 0x6a6a7a, roughness: 0.3, metalness: 0.85 }));
  const torus = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.28, 10, 24), std({ color: 0x9a9aaa, roughness: 0.2, metalness: 0.9 }));
  torus.rotation.x = Math.PI / 2; torus.position.set(TX, 4.5, TZ); torus.castShadow = true; s.add(torus);
  cover(a, TX, TZ, 1.8, 1.8, 4.6);
  a.anchors.push(new THREE.Vector3(TX, 7, TZ));
  const gant: THREE.BufferGeometry[] = [];
  for (const z of [-5, 5]) { gant.push(boxG(HW * 2, 0.25, 1.4, 0, 8.6, z), boxG(HW * 2, 0.06, 0.06, 0, 9.6, z - 0.68), boxG(HW * 2, 0.06, 0.06, 0, 9.6, z + 0.68)); for (let x = -HW + 2; x < HW; x += 3) gant.push(boxG(0.06, 1, 0.06, x, 9.1, z - 0.68), boxG(0.06, 1, 0.06, x, 9.1, z + 0.68)); }
  for (let x = -HW + 3; x < HW; x += 6) gant.push(boxG(0.3, WH - 8.6, 0.3, x, (WH + 8.6) / 2, -5), boxG(0.3, WH - 8.6, 0.3, x, (WH + 8.6) / 2, 5));
  merged(s, gant, std({ color: 0x34343e, roughness: 0.5, metalness: 0.7 }), false);
  for (const x of [-9, -3, 3, 9]) for (const z of [-5, 5]) a.anchors.push(new THREE.Vector3(x, 8.6, z));
  const ceilM = std({ color: 0x14121a, roughness: 0.8 });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2 + 2, HD * 2 + 2), ceilM); // faces down only
  ceil.rotation.x = Math.PI / 2; ceil.position.y = WH; s.add(ceil);
  const spots: THREE.BufferGeometry[] = [];
  for (let x = -HW + 4; x < HW; x += 6) for (const z of [-HD + 3, 0, HD - 3]) { const c = new THREE.CircleGeometry(0.3, 12); c.rotateX(Math.PI / 2); c.translate(x, WH - 0.02, z); spots.push(c); }
  merged(s, spots, glow(0xe0e8ff), false);
  // Wall consoles (fixed) along the north wall.
  const wc: THREE.BufferGeometry[] = [];
  for (const x of [-9, -5, 5, 9]) { wc.push(boxG(2.6, 1.1, 0.7, x, 0.55, -HD + 0.35)); cover(a, x, -HD + 0.35, 2.6, 0.7, 1.1); }
  merged(s, wc, std({ color: 0x2a2a36, roughness: 0.5, metalness: 0.6 }));
  const wsT = tex(256, 64, (g) => { g.fillStyle = '#041416'; g.fillRect(0, 0, 256, 64); for (let i = 0; i < 18; i++) { g.fillStyle = i % 4 ? '#3affd8' : '#ff4a5a'; g.fillRect(8 + (i % 9) * 27, 10 + Math.floor(i / 9) * 26, 18, 14); } });
  const wsM = std({ map: wsT, emissive: 0xffffff, emissiveMap: wsT, emissiveIntensity: 0.7 });
  for (const x of [-9, -5, 5, 9]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.55), wsM); p.position.set(x, 1.6, -HD + 0.05); s.add(p); }
  let zapT = 0, wispT = 0;
  a.ambient = (dt) => {
    zapT += dt; wispT += dt;
    if (zapT > 1.4 + Math.random()) {
      zapT = 0;
      const ang = Math.random() * Math.PI * 2;
      a.fx.vfx?.zap(new THREE.Vector3(TX, 4.6, TZ), new THREE.Vector3(TX + Math.cos(ang) * 2.4, 2.2 + Math.random() * 3, TZ + Math.sin(ang) * 2.4), 0x7affe8, 0.12, 0.18);
    }
    if (wispT > 0.1) { wispT = 0; a.fx.wisp(new THREE.Vector3((Math.random() - 0.5) * 0.8, 1 + Math.random() * 6, RZ + 1.1), new THREE.Color(0xff3040).multiplyScalar(0.4), 0.6); }
  };
  enclose(a, [WH, WH, WH, WH]);
  a.ceiling = 11;
  a.spawns = [new THREE.Vector3(-5.5, 0, 2), new THREE.Vector3(5.5, 0, 2)];
}

// ====================================================================== dynamic pieces
export function resetEnclosed(a: Arena) {
  const add = (p: Prop, x: number, z: number, ry = 0) => {
    p.pos.set(x, 0, z);
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = ry;
    if (Math.abs(Math.sin(ry)) > 0.7) p.half.set(p.half.z, p.half.y, p.half.x);
    p.updateSolid();
    a.props.push(p);
    a.dyn.add(p.mesh);
  };
  const HW = BOUNDS.hw, HD = BOUNDS.hd;
  if (a.layout === 'market') {
    add(a.makeCar(0xd8b020), -11, -6.5, 0.35);
    add(a.makeCar(0xd8b020), 10, 7.2, Math.PI / 2 + 0.2);
    add(buildVan(0x3a6a7a), 11.5, -6, 0.6);
    add(buildBench(), -6, HD - 2.4, 0);
    add(buildBench(), 4, -HD + 2.4, Math.PI);
    add(buildHydrant(), -HW + 2.6, -2.5);
    add(buildHydrant(), HW - 2.6, 3);
    add(a.makeBin(), -2.5, HD - 2.2);
    add(a.makeBin(), 7, HD - 2.4);
    add(a.modelProp('mailbox_01_green', 'mailbox', 0, () => a.makeCrate()), 1, HD - 2.3);
    add(a.makeCrate(), -14.5, -9.5);
    add(a.makeCrate(), -13.6, -9.8);
    add(a.makeBarrel(), 14.5, -9.8);
    add(a.makeWheelie(), -15, 9.5);
    return;
  }
  if (a.layout === 'archive') {
    add(buildArmchair(), -2.2, 7, Math.PI);
    add(buildArmchair(), 2.2, 7, Math.PI);
    add(buildArmchair(), -12.5, -2, Math.PI / 2);
    add(buildArmchair(), 12.5, 2, -Math.PI / 2);
    add(buildSideTable(), 0, 8);
    add(buildSideTable(), 12.5, 4);
    add(buildArmour(), -9, -7.6);
    add(buildArmour(), 9, -7.6);
    add(buildArmour(), -9, 7.6, Math.PI);
    add(buildCabinet(), -14.6, -7, Math.PI / 2);
    add(buildCabinet(), 14.6, 7, -Math.PI / 2);
    add(a.makeCrate(), 6, -9);
    return;
  }
  if (a.layout === 'foundry') {
    add(a.makeTank(), -13, -8.5);
    add(buildTankProp(), 6, 9.5);
    add(buildTankProp(), 7, 9.2);
    add(a.makeAC(), -5, 9.2);
    add(a.makeAC(), 2, -9.4);
    add(a.makeCrate(), -12, 0.5);
    add(a.makeCrate(), -11.3, 1.3);
    add(a.makeCrate(), 6.5, -3.5);
    add(a.makeBarrel(), 14.5, 2.5);
    add(a.makeBarrel(), -6.5, -9.6);
    add(a.makeBarrel(), -1, 10);
    add(a.makePallet(), 3, 6);
    add(a.makeWheelie(), -15, 10.2);
    return;
  }
  // lab
  add(buildConsole(), -6, 7.5, Math.PI);
  add(buildConsole(), 6.5, 7.5, Math.PI);
  add(buildConsole(), 9.5, -4, -Math.PI / 2);
  add(buildCanister(), -10.5, 6);
  add(buildCanister(), -11.2, 6.6);
  add(buildCanister(), 11.5, 8.5);
  add(buildCanister(), -4.5, -6.5);
  add(a.makeCrate(), 12.5, -8.5);
  add(a.makeCrate(), 12, -7.8);
  add(a.makeBarrel(), -12.5, 8.6);
  add(a.makeBarrel(), 3, -8.2);
  void buildCar;
}
