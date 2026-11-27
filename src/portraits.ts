import * as THREE from 'three';
import { Rig } from './rig';
import { SkinnedBody, hasBodyModel, hasClip } from './skinned';
import { ROSTER, CharacterDef, finishMaterial } from './characters';

// Character art rendered from each fighter's actual 3D model in a small studio scene, as transparent
// PNG data URLs for the menus and HUD:
//  - pose:   full body in a posed clip (HUD portraits, results)
//  - comic:  the pose posterised into flat comic-style tone bands (fighter select panels)
//  - face:   head-and-shoulders close-up, duotone (roster strip)
//  - profile: a side-on head silhouette, duotone (Press Start screen)

const POSE: Record<string, [string, number]> = {
  basalt: ['Idle_FoldArms_Loop', 0.6],
  tether: ['Idle_Shield_Loop', 0.4],
  aerin: ['Spell_Simple_Idle_Loop', 0.5],
  shunt: ['Idle_Loop', 0.8],
  vanta: ['Idle_Shield_Loop', 0.9],
  magna: ['Spell_Simple_Shoot', 0.25],
  ember: ['Idle_FoldArms_Loop', 1.2],
  rift: ['Spell_Simple_Shoot', 0.3],
};

export const portraits = new Map<string, string>();
export const comics = new Map<string, string>();
export const faces = new Map<string, string>();
export const profiles = new Map<string, string>();

type Shot = { w: number; h: number; rotY: number; cam: (sk: SkinnedBody, def: CharacterDef, cam: THREE.PerspectiveCamera) => void; fov?: number };

/** Reads the render target into a canvas (flipped upright). */
function readCanvas(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, W: number, H: number) {
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  g.putImageData(img, 0, 0);
  return c;
}

/** Flat comic tone: luminance quantised into a few bands (hue kept), with a touch more contrast. */
function posterize(src: HTMLCanvasElement, bands = 4) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const L = (0.3 * r + 0.59 * gg + 0.11 * b) / 255;
    const q = Math.min(1, Math.round(Math.pow(L, 0.9) * bands) / bands * 1.08 + 0.04);
    const k = L > 0.001 ? q / L : 0;
    d[i] = Math.min(255, r * k); d[i + 1] = Math.min(255, gg * k); d[i + 2] = Math.min(255, b * k);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Duotone: luminance mapped from a dark ink to a light tint (alpha kept). */
export function duotone(src: HTMLCanvasElement, dark: number, light: number, gamma = 0.85) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const a = new THREE.Color(dark), b = new THREE.Color(light);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const L = Math.pow((0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255, gamma);
    // Slight posterise so it reads like printed comic tone.
    const t = Math.min(1, Math.round(L * 6) / 6 * 1.15);
    d[i] = (a.r + (b.r - a.r) * t) * 255; d[i + 1] = (a.g + (b.g - a.g) * t) * 255; d[i + 2] = (a.b + (b.b - a.b) * t) * 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** True if any opaque pixel sits in the top 2% rows or the outer 1% columns (the subject is cropped). */
function touchesEdge(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!;
  const { width: w, height: h } = c;
  const d = g.getImageData(0, 0, w, h).data;
  const top = Math.max(2, Math.round(h * 0.02)), side = Math.max(2, Math.round(w * 0.01));
  for (let y = 0; y < top; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 24) return true;
  for (let y = 0; y < h; y++) for (const x of [0, side, w - 1 - side, w - 1]) if (d[(y * w + x) * 4 + 3] > 24) return true;
  return false;
}

export function renderPortraits(renderer: THREE.WebGLRenderer) {
  if (!hasBodyModel()) return;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30283a, 1.6));
  const key = new THREE.DirectionalLight(0xfff0e0, 3.2);
  key.position.set(2.5, 4, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8ab8ff, 2.6);
  rim.position.set(-3, 3, -4);
  scene.add(rim);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTM = renderer.toneMapping;
  renderer.setClearColor(0x000000, 0);
  const head = new THREE.Vector3();

  const shots: Record<'pose' | 'face' | 'profile', Shot> = {
    pose: {
      w: 448, h: 600, rotY: 0.45,
      cam: (_sk, def, cam) => { const h = def.look!.height; cam.position.set(0.3, h * 0.6, h * 2.15); cam.lookAt(0, h * 0.52, 0); },
    },
    face: {
      w: 256, h: 256, rotY: 0.32, fov: 26,
      cam: (sk, def, cam) => {
        // The Head bone sits at the skull base; the face centre is ~0.1 m above it. Frame head + shoulders
        // with the eyes a little above centre (≈45% from the top) and the chin well inside the frame.
        sk.boneWorld('Head', head);
        const s = def.look!.height / 1.95;
        const fy = head.y + 0.11 * s;
        cam.position.set(head.x + 0.18 * s, fy + 0.03 * s, head.z + 1.55 * s);
        cam.lookAt(head.x, fy - 0.04 * s, head.z);
      },
    },
    profile: {
      w: 640, h: 640, rotY: -Math.PI / 2 + 0.12, fov: 24,
      cam: (sk, def, cam) => {
        sk.boneWorld('Head', head);
        const s = def.look!.height / 1.95;
        cam.position.set(head.x, head.y - 0.02 * s, head.z + 1.9 * s);
        cam.lookAt(head.x, head.y - 0.12 * s, head.z);
      },
    },
  };

  for (const def of ROSTER) {
    if (!def.look || !def.adorn) continue;
    const sk = new SkinnedBody(def.look, (m, k) => finishMaterial(m, k, k === 'body' && !!def.look!.flat));
    const rig = new Rig(sk.proportions);
    sk.bind(rig);
    def.adorn(sk, rig);
    const [clip, t] = POSE[def.id] ?? ['Idle_Loop', 0.5];
    if (hasClip(clip)) {
      sk.drive({ name: clip, loop: true, speed: 1, key: clip });
      sk.procW = 0;
      sk.update(t);
    }
    // Wings open for the flier.
    const wings = (rig as any).wings as THREE.Mesh[] | undefined;
    if (wings) { wings[0].rotation.y = -1.0; wings[1].rotation.y = 1.0; }
    scene.add(rig.root);
    for (const kind of ['pose', 'face', 'profile'] as const) {
      // Only one profile is needed (the Press Start art); faces and poses for everyone.
      if (kind === 'profile' && def.id !== 'shunt' && def.id !== 'rift') continue;
      const sh = shots[kind];
      rig.root.rotation.y = sh.rotY;
      rig.root.updateMatrixWorld(true);
      sk.update(0);
      rig.root.updateMatrixWorld(true);
      const cam = new THREE.PerspectiveCamera(sh.fov ?? 30, sh.w / sh.h, 0.05, 50);
      sh.cam(sk, def, cam);
      const shoot = () => {
        const rt = new THREE.WebGLRenderTarget(sh.w, sh.h, { samples: 4 });
        rt.texture.colorSpace = THREE.SRGBColorSpace;
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(scene, cam);
        const out = readCanvas(renderer, rt, sh.w, sh.h);
        rt.dispose();
        return out;
      };
      let c = shoot();
      // Full-body poses must never be cropped (Basalt's head spike, raised arms, wings): if anything touches the
      // top or side edges, pull the camera back along its view line and shoot again.
      if (kind === 'pose') {
        const target = new THREE.Vector3(0, def.look!.height * 0.52, 0);
        for (let tries = 0; tries < 4 && touchesEdge(c); tries++) {
          cam.position.sub(target).multiplyScalar(1.12).add(target);
          target.y += def.look!.height * 0.025; // headroom grows upward, feet stay grounded in frame
          cam.lookAt(target);
          c = shoot();
        }
      }
      if (kind === 'pose') {
        portraits.set(def.id, c.toDataURL('image/png'));
        comics.set(def.id, posterize(c).toDataURL('image/png'));
      } else if (kind === 'face') {
        faces.set(def.id, duotone(c, 0x0a2436, 0xd6f3ff, 0.62).toDataURL('image/png'));
      } else {
        profiles.set(def.id, duotone(c, 0x030a0b, 0x7fc4bc, 0.75).toDataURL('image/png'));
      }
    }
    scene.remove(rig.root);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = prevTM;
}

export function portraitOf(def: CharacterDef) {
  return portraits.get(def.id) ?? '';
}
export function comicOf(def: CharacterDef) { return comics.get(def.id) ?? portraits.get(def.id) ?? ''; }
export function faceOf(def: CharacterDef) { return faces.get(def.id) ?? ''; }
export function profileOf(id: string) { return profiles.get(id) ?? ''; }
