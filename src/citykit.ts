import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Quaternius "Downtown City MegaKit" (CC0): real modular buildings, street pieces and props.
// Loaded once at startup; the arenas place kit buildings and merge them per material, so the whole
// set costs one draw call per kit material (~13) however many buildings are placed. If loading fails,
// the arenas keep their procedural city.

export type KitBuilding = 'Building_Large_2' | 'Building_Medium_2_001' | 'Building_Small_1';
export type KitPiece = KitBuilding | 'Prop_ACUnit' | 'Prop_Bollard' | 'Prop_Planter_Single' | 'Prop_ManholeCover' | 'Prop_Drain' | 'Street_4Lane' | 'Sidewalk_Straight_3m' | 'Stairs_Rails_Metal';

/** Footprint of each building in its own frame (front faces +Z, ground at y = 0). */
export const KIT_SIZE: Record<KitBuilding, { w: number; d: number; h: number; cx: number; cz: number }> = {
  Building_Large_2: { w: 20.6, d: 16.6, h: 28, cx: 1.0, cz: -8.0 },
  Building_Medium_2_001: { w: 15.0, d: 13.1, h: 25, cx: 0, cz: -5.95 },
  Building_Small_1: { w: 12.4, d: 14.5, h: 17, cx: -1.0, cz: -4.95 },
};

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material };
const parts = new Map<string, Part[]>();

export function hasCityKit() {
  return parts.size > 0;
}

export async function loadCityKit(url: string) {
  try {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const g = await loader.loadAsync(url);
    g.scene.updateMatrixWorld(true);
    const tuned = new Set<THREE.Material>();
    for (const top of g.scene.children) {
      const list: Part[] = [];
      top.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // Quantised (meshopt) attributes are normalised integers with the dequantisation scale on the
        // node, so convert to float and bake the full node transform (the scene root is the identity).
        const geo = toFloat(m.geometry);
        geo.applyMatrix4(m.matrixWorld);
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!tuned.has(mat)) { tune(mat); tuned.add(mat); }
        list.push({ geo, mat });
      });
      parts.set(top.name, list);
    }
  } catch (e) {
    console.warn('City kit unavailable, using the procedural city:', e);
    parts.clear();
  }
}

function toFloat(src: THREE.BufferGeometry) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    const attr = a as THREE.BufferAttribute;
    const n = attr.count, sz = attr.itemSize, arr = new Float32Array(n * sz);
    for (let i = 0; i < n; i++) for (let c = 0; c < sz; c++) arr[i * sz + c] = attr.getComponent(i, c);
    g.setAttribute(k, new THREE.BufferAttribute(arr, sz));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(new Uint32Array(src.index.array), 1));
  return g;
}

/** Fit kit materials to the game's look: fake interiors glow like lit rooms at dusk, nothing too glossy. */
function tune(mat: THREE.MeshStandardMaterial) {
  const name = (mat.map?.name ?? '') + ' ' + mat.name;
  if (/lit_interior/i.test(name)) {
    mat.emissive = new THREE.Color(0xffe2b0);
    mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0.55;
  } else if (/dark_interior/i.test(name)) {
    mat.emissive = new THREE.Color(0x8090a0);
    mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0.12;
  }
  if (mat.transparent) {
    // Window glass: a faint sheen over the interiors.
    mat.depthWrite = false;
    mat.roughness = 0.12;
    mat.metalness = 0.3;
  } else {
    mat.roughness = Math.max(mat.roughness, 0.75);
    mat.metalness = 0;
  }
  // Interior-facing double sides aren't needed at a distance; front faces only (cheaper, no shadow acne).
  if (!/interior|glass/i.test(name)) mat.side = THREE.FrontSide;
  mat.envMapIntensity = 0.6;
}

export interface KitPlacement { name: KitPiece; x: number; y: number; z: number; ry?: number; scale?: number }

/**
 * Bake placed kit pieces into one merged mesh per material and add them to `parent`.
 * Returns the number of meshes added (0 if the kit is not loaded).
 */
export function placeKit(parent: THREE.Object3D, list: KitPlacement[], opts: { castShadow?: boolean } = {}) {
  if (!hasCityKit()) return 0;
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const p of list) {
    const src = parts.get(p.name);
    if (!src) continue;
    q.setFromAxisAngle(up, p.ry ?? 0);
    m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3().setScalar(p.scale ?? 1));
    for (const { geo, mat } of src) {
      const g = geo.clone();
      g.applyMatrix4(m4);
      let l = buckets.get(mat);
      if (!l) { l = []; buckets.set(mat, l); }
      l.push(g);
    }
  }
  let n = 0;
  for (const [mat, geos] of buckets) {
    // Keep only shared attributes so the geometries merge.
    const keep = ['position', 'normal', 'uv'].filter((k) => geos.every((g) => g.attributes[k]));
    for (const g of geos) for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = !!opts.castShadow && !(mat as THREE.MeshStandardMaterial).transparent;
    mesh.receiveShadow = true;
    if ((mat as THREE.MeshStandardMaterial).transparent) mesh.renderOrder = 1;
    parent.add(mesh);
    n++;
  }
  return n;
}

/** World-space footprint of a building placement (axis-aligned; ry must be a multiple of 90°). */
export function kitFootprint(name: KitBuilding, x: number, z: number, ry = 0) {
  const s = KIT_SIZE[name];
  const c = new THREE.Vector3(s.cx, 0, s.cz).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
  const quarter = Math.round(ry / (Math.PI / 2)) % 2 !== 0;
  return { cx: x + c.x, cz: z + c.z, w: quarter ? s.d : s.w, d: quarter ? s.w : s.d };
}

/** Placement that puts a building's footprint centre at (x, z) with its front facing `ry` (0 = +Z). */
export function kitAt(name: KitBuilding, x: number, y: number, z: number, ry = 0): KitPlacement {
  const s = KIT_SIZE[name];
  const c = new THREE.Vector3(s.cx, 0, s.cz).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
  return { name, x: x - c.x, y, z: z - c.z, ry };
}
