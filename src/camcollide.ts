import * as THREE from 'three';

/**
 * Camera collision for the versus/cinematic camera: a coarse voxel occupancy grid of the arena's static, opaque
 * geometry (deck, parapets, huts, girders, cranes, containers and every surrounding building — city kit and
 * procedural), built once per layout. The camera marches a ray from its focus to where it wants to be and stops in
 * front of the first solid cell, so it can never end up inside or behind a building (which showed the building's
 * interior instead of the fight).
 *
 * Cells are marked wherever a triangle passes through them (triangles are subdivided until smaller than a cell), so
 * thin walls and beams are caught and the grid errs on the solid side. Transparent / alpha-tested / non-depth-writing
 * materials (glass, chain-link, safety mesh, decals) and `exclude`d objects (fadeables) don't block the camera.
 */
export class CamCollider {
  readonly grid: Uint8Array;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Solid cells (stats). */
  solid = 0;
  /** Triangles voxelised (stats). */
  tris = 0;
  ms = 0;

  constructor(readonly x0: number, readonly y0: number, readonly z0: number, x1: number, y1: number, z1: number, readonly cell = 1) {
    this.nx = Math.ceil((x1 - x0) / cell);
    this.ny = Math.ceil((y1 - y0) / cell);
    this.nz = Math.ceil((z1 - z0) / cell);
    this.grid = new Uint8Array(this.nx * this.ny * this.nz);
  }

  static build(root: THREE.Object3D, exclude: Set<THREE.Object3D>, region: Region, cell = 1) {
    const job = CamCollider.job(root, exclude, region, cell);
    let r = job.next();
    while (!r.done) r = job.next();
    return r.value;
  }

  /**
   * Incremental build: a generator that yields every ~2000 triangles, so the work can be spread over frames
   * (measured 0.4-0.8 s in one go on a desktop core, several seconds on a phone or a busy machine).
   */
  static *job(root: THREE.Object3D, exclude: Set<THREE.Object3D>, region: Region, cell = 1): Generator<void, CamCollider, void> {
    const t0 = performance.now();
    const c = new CamCollider(region.x0, region.y0, region.z0, region.x1, region.y1, region.z1, cell);
    root.updateMatrixWorld(true);
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (exclude.has(o)) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || !visibleChain(mesh, root)) return;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
      if (!mat || mat.transparent || mat.alphaTest > 0 || !mat.depthWrite || !mat.visible) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
      if (bb.max.x < region.x0 || bb.min.x > region.x1 || bb.max.y < region.y0 || bb.min.y > region.y1 || bb.max.z < region.z0 || bb.min.z > region.z1) return;
      meshes.push(mesh);
    });
    let busy = 0;
    for (const mesh of meshes) {
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const idx = geo.index;
      const n = idx ? idx.count : pos.count;
      const mw = mesh.matrixWorld;
      for (let i = 0; i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(mw);
        c.tri(v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z, 0);
        c.tris++;
        if (++busy % 2000 === 0) yield;
      }
    }
    for (let i = 0; i < c.grid.length; i++) c.solid += c.grid[i];
    c.ms = performance.now() - t0;
    return c;
  }

  private mark(x: number, y: number, z: number) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return;
    this.grid[(j * this.nz + k) * this.nx + i] = 1;
  }

  /** Mark every cell a triangle passes through: split until the pieces are smaller than a cell. */
  private tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, depth: number) {
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    const minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
    const x1 = this.x0 + this.nx * this.cell, y1 = this.y0 + this.ny * this.cell, z1 = this.z0 + this.nz * this.cell;
    if (maxX < this.x0 || minX > x1 || maxY < this.y0 || minY > y1 || maxZ < this.z0 || minZ > z1) return;
    const lim = this.cell * 0.7;
    if (depth > 16 || (maxX - minX <= lim && maxY - minY <= lim && maxZ - minZ <= lim)) {
      this.mark(ax, ay, az); this.mark(bx, by, bz); this.mark(cx, cy, cz);
      this.mark((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
      return;
    }
    const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2;
    const cax = (cx + ax) / 2, cay = (cy + ay) / 2, caz = (cz + az) / 2;
    const d = depth + 1;
    this.tri(ax, ay, az, abx, aby, abz, cax, cay, caz, d);
    this.tri(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, d);
    this.tri(cax, cay, caz, bcx, bcy, bcz, cx, cy, cz, d);
    this.tri(abx, aby, abz, bcx, bcy, bcz, cax, cay, caz, d);
  }

  solidAt(x: number, y: number, z: number) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.grid[(j * this.nz + k) * this.nx + i] === 1;
  }

  /**
   * Distance from `a` toward `b` to the first solid cell (Infinity if the segment is clear). Solid cells right at
   * the start (the focus point hugging a wall or a prop) are skipped for up to 0.8 m.
   */
  march(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return Infinity;
    const step = this.cell * 0.25;
    let leaving = true;
    for (let t = 0; t <= len; t += step) {
      const k = t / len;
      const s = this.solidAt(a.x + dx * k, a.y + dy * k, a.z + dz * k);
      // Only the start's own cell may be skipped: skipping further let a ray that began against a wall pass
      // straight through it (the camera ended up outside the walled arenas).
      if (leaving) { if (!s || t > 0.8) leaving = false; else continue; }
      if (s) return t;
    }
    return this.solidAt(b.x, b.y, b.z) ? len : Infinity;
  }
}

export interface Region { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }

function visibleChain(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}
