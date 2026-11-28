import * as THREE from 'three';
import { Rig } from './rig';
import { SkinnedBody, hasBodyModel, hasClip } from './skinned';
import { ROSTER, CharacterDef, finishMaterial, RIM_COLOR } from './characters';

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

/**
 * Roster close-ups, framed like comic panels: each fighter gets its own angle.
 * rotY: body yaw; az: camera azimuth from the body's front (+ = the fighter's left); el: camera elevation
 * (negative = from below, looking up); dist: metres for a 1.95 m fighter; roll: dutch tilt;
 * head: extra head turn on top of the pose; fcY: face centre above the Head bone; shiftX: subject off-centre.
 */
type FaceShot = { rotY?: number; az: number; el: number; dist: number; roll?: number; head?: { yaw: number; pitch: number; roll: number }; fcY?: number; aimY?: number; shiftX?: number };
const FACE: Record<string, FaceShot> = {
  default: { az: 0.3, el: 0, dist: 0.9 },
  basalt: { az: 0.12, el: -0.16, dist: 1.5, fcY: 0.1, aimY: -0.02, head: { yaw: 0, pitch: -0.1, roll: 0 } },            // head-on from slightly below, glowing eyes
  tether: { rotY: 1.5, az: -1.2, el: 0.06, dist: 0.95, shiftX: 0.06, head: { yaw: -1.0, pitch: 0.06, roll: 0.1 } },    // looking back over his shoulder
  aerin: { az: 0.75, el: 0.06, dist: 0.95, roll: 0.1, aimY: -0.06, head: { yaw: 0.45, pitch: -0.05, roll: 0.1 } },       // turning toward us, hair swept
  shunt: { az: -0.6, el: 0.02, dist: 0.95, roll: -0.28, aimY: -0.03, head: { yaw: -0.25, pitch: 0.04, roll: 0 } },        // visor 3/4, dutch tilt
  vanta: { az: 0.25, el: -0.06, dist: 0.9, aimY: -0.05, head: { yaw: 0.15, pitch: 0.14, roll: -0.1 } },     // head low, prowling, eyes up
  magna: { az: -0.5, el: -0.2, dist: 0.95, aimY: -0.02, head: { yaw: -0.2, pitch: 0.14, roll: 0 } },                     // low angle, looking down at you
  ember: { az: -0.35, el: -0.06, dist: 0.95, roll: 0.26, head: { yaw: -0.2, pitch: -0.12, roll: -0.18 } },  // tilted, fangs out
  rift: { az: -1.15, el: 0.02, dist: 0.95, head: { yaw: -0.35, pitch: 0.05, roll: 0 } },                    // half-hooded profile
};

/** Title-menu busts (tall slanted panels): head and shoulders, each fighter facing its own way. Same fields as FACE. */
const BUST: Record<string, FaceShot> = {
  default: { az: 0.3, el: 0, dist: 2.1 },
  basalt: { az: 0.15, el: -0.05, dist: 2.6, fcY: 0.1, aimY: 0.06, head: { yaw: 0.1, pitch: -0.14, roll: 0 } },
  tether: { rotY: 1.5, az: -1.25, el: 0.04, dist: 2.1, head: { yaw: -0.95, pitch: 0.04, roll: 0.08 } },
  aerin: { az: 0.85, el: 0.04, dist: 2.1, roll: 0.06, head: { yaw: 0.5, pitch: -0.04, roll: 0.08 } },
  shunt: { az: -0.55, el: 0.02, dist: 2.1, roll: -0.1, head: { yaw: -0.3, pitch: 0.04, roll: 0 } },
  vanta: { az: 0.2, el: -0.1, dist: 2.0, head: { yaw: 0.2, pitch: 0.16, roll: -0.08 } },
  magna: { az: -0.75, el: -0.22, dist: 2.1, head: { yaw: -0.3, pitch: 0.12, roll: 0 } },
  ember: { az: 0.55, el: -0.04, dist: 2.1, roll: 0.08, head: { yaw: 0.35, pitch: -0.08, roll: -0.1 } },
  rift: { az: -1.3, el: 0.02, dist: 2.1, head: { yaw: -0.4, pitch: 0.05, roll: 0 } },
};

export const portraits = new Map<string, string>();
export const busts = new Map<string, string>();
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

/**
 * Comic tone for the stone golem: charcoal stone in three tight bands (no muddy beige mid-tones),
 * with saturated warm pixels (the lava cracks) kept bright and glowing.
 */
function posterizeStone(src: HTMLCanvasElement) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const ramp = [[30, 30, 35], [64, 63, 70], [106, 104, 112], [158, 156, 164]];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    // Lava: clearly red/orange and bright — keep, pushed hotter.
    if (r > 120 && r > gg * 1.35 && r > b * 1.6 && sat > 0.45) {
      d[i] = Math.min(255, r * 1.15); d[i + 1] = Math.min(255, gg * 0.95); d[i + 2] = b * 0.6;
      continue;
    }
    const L = (0.3 * r + 0.59 * gg + 0.11 * b) / 255;
    const k = Math.min(3, Math.floor(Math.pow(L, 0.8) * 4.4));
    d[i] = ramp[k][0]; d[i + 1] = ramp[k][1]; d[i + 2] = ramp[k][2];
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Crops a render to its opaque bounding box plus a small padding, so CSS contain fills the box. */
function autocrop(src: HTMLCanvasElement, pad = 0.03) {
  const g = src.getContext('2d')!;
  const { width: W, height: H } = src;
  const d = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return src;
  const p = Math.round(Math.max(x1 - x0, y1 - y0) * pad);
  x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(W - 1, x1 + p); y1 = H - 1; // keep the feet line
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
  c.getContext('2d')!.drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
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

/** First row (from the top) with an opaque pixel; the height if there is none. */
function topRow(c: HTMLCanvasElement) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 24) return y;
  return h;
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
  // Neutral-cool back light (a saturated blue rim gave the golem a lavender outline).
  const rim = new THREE.DirectionalLight(0xd8e0ea, 1.6);
  rim.position.set(-3, 3, -4);
  scene.add(rim);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTM = renderer.toneMapping;
  renderer.setClearColor(0x000000, 0);
  // The material rim colour follows the arena palette; keep it neutral and dim for studio portraits.
  const prevRim = RIM_COLOR.value.clone();
  RIM_COLOR.value.setRGB(0.55, 0.55, 0.58);
  const head = new THREE.Vector3();

  const shots: Record<'pose' | 'face' | 'profile' | 'bust', Shot> = {
    pose: {
      w: 448, h: 600, rotY: 0.45,
      cam: (_sk, def, cam) => { const h = def.look!.height; cam.position.set(0.3, h * 0.6, h * 2.15); cam.lookAt(0, h * 0.52, 0); },
    },
    face: {
      w: 256, h: 256, rotY: 0, fov: 24,
      cam: (sk, def, cam) => {
        // Comic-panel close-up per fighter (see FACE): camera orbits the face centre at its own angle,
        // elevation and roll; the eyes land ~40% from the top of the tile.
        const f = FACE[def.id] ?? FACE.default;
        sk.boneWorld('Head', head);
        const s = def.look!.height / 1.95;
        const fc = head.clone().add(new THREE.Vector3(0, (f.fcY ?? 0.11) * s, 0));
        const d = f.dist * s;
        const yaw = (f.rotY ?? 0) + f.az;
        cam.position.set(fc.x + Math.sin(yaw) * Math.cos(f.el) * d, fc.y + Math.sin(f.el) * d, fc.z + Math.cos(yaw) * Math.cos(f.el) * d);
        const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        const aim = fc.clone().add(new THREE.Vector3(0, -0.1 * viewH + (f.aimY ?? 0) * s, 0));
        cam.lookAt(aim);
        if (f.roll) cam.rotateZ(f.roll);
        if (f.shiftX) cam.translateX(f.shiftX * viewH);
      },
    },
    bust: {
      w: 512, h: 1024, rotY: 0, fov: 26, // sharp on 3x phones and 1080p: panels are up to ~1000 device px tall
      cam: (sk, def, cam) => {
        // Tall title-menu panel: head in the upper quarter, down to about the waist.
        const f = BUST[def.id] ?? BUST.default;
        sk.boneWorld('Head', head);
        const s = def.look!.height / 1.95;
        const fc = head.clone().add(new THREE.Vector3(0, (f.fcY ?? 0.08) * s, 0));
        const d = f.dist * s;
        const yaw = (f.rotY ?? 0) + f.az;
        cam.position.set(fc.x + Math.sin(yaw) * Math.cos(f.el) * d, fc.y + Math.sin(f.el) * d, fc.z + Math.cos(yaw) * Math.cos(f.el) * d);
        const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        cam.lookAt(fc.clone().add(new THREE.Vector3(0, -0.24 * viewH + (f.aimY ?? 0) * s, 0)));
        if (f.roll) cam.rotateZ(f.roll);
        // Centre the face horizontally: narrow panels crop the sides, never the face.
        cam.updateMatrixWorld(true);
        const v = fc.clone().project(cam);
        cam.translateX(v.x * viewH * cam.aspect / 2);
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
    for (const kind of ['pose', 'face', 'bust', 'profile'] as const) {
      // Only one profile is needed (the Press Start art); faces and poses for everyone.
      if (kind === 'profile' && def.id !== 'shunt' && def.id !== 'rift') continue;
      const sh = shots[kind];
      const framing = kind === 'face' ? FACE[def.id] ?? FACE.default : kind === 'bust' ? BUST[def.id] ?? BUST.default : null;
      rig.root.rotation.y = framing ? framing.rotY ?? 0 : sh.rotY;
      sk.headTurn = framing?.head ?? null;
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
      // Busts: the top of the head (horns, spikes, hood) sits ~6% below the panel top, never cut off.
      if (kind === 'bust') {
        const viewH = 2 * cam.position.distanceTo(head) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        for (let tries = 0; tries < 2; tries++) {
          const err = sh.h * 0.06 - topRow(c);
          if (Math.abs(err) < sh.h * 0.01) break;
          cam.translateY((err / sh.h) * viewH);
          c = shoot();
        }
      }
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
        const cropped = autocrop(c);
        portraits.set(def.id, cropped.toDataURL('image/png'));
        comics.set(def.id, (def.look!.golem ? posterizeStone(cropped) : posterize(cropped)).toDataURL('image/png'));
      } else if (kind === 'bust') {
        busts.set(def.id, duotone(c, 0x021312, 0x9cefe2, 0.7).toDataURL('image/webp', 0.92));
      } else if (kind === 'face') {
        faces.set(def.id, duotone(c, 0x0a2436, 0xd6f3ff, 0.62).toDataURL('image/png'));
      } else {
        profiles.set(def.id, duotone(c, 0x030a0b, 0x7fc4bc, 0.75).toDataURL('image/png'));
      }
    }
    scene.remove(rig.root);
  }
  RIM_COLOR.value.copy(prevRim);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = prevTM;
}

export function portraitOf(def: CharacterDef) {
  return portraits.get(def.id) ?? '';
}
export function comicOf(def: CharacterDef) { return comics.get(def.id) ?? portraits.get(def.id) ?? ''; }
export function faceOf(def: CharacterDef) { return faces.get(def.id) ?? ''; }
export function bustOf(def: CharacterDef) { return busts.get(def.id) ?? ''; }
export function profileOf(id: string) { return profiles.get(id) ?? ''; }
