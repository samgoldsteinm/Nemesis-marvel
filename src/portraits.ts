import * as THREE from 'three';
import { Rig } from './rig';
import { SkinnedBody, hasBodyModel, hasClip } from './skinned';
import { ROSTER, CharacterDef, finishMaterial } from './characters';

// Character portraits rendered from each fighter's actual 3D model, posed with an authored clip,
// in a small studio scene. Produces transparent PNG data URLs for the menus and HUD.

const POSE: Record<string, [string, number]> = {
  basalt: ['Idle_FoldArms_Loop', 0.6],
  tether: ['Idle_Shield_Loop', 0.4],
  aerin: ['Spell_Simple_Idle_Loop', 0.5],
  shunt: ['Idle_Loop', 0.8],
};

export const portraits = new Map<string, string>();

export function renderPortraits(renderer: THREE.WebGLRenderer) {
  if (!hasBodyModel()) return;
  const W = 384, H = 512;
  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30283a, 1.6));
  const key = new THREE.DirectionalLight(0xfff0e0, 3.2);
  key.position.set(2.5, 4, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8ab8ff, 2.6);
  rim.position.set(-3, 3, -4);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTM = renderer.toneMapping;
  renderer.setClearColor(0x000000, 0);
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
    rig.root.rotation.y = 0.45;
    scene.add(rig.root);
    const h = def.look.height;
    cam.position.set(0.3, h * 0.62, h * 1.95);
    cam.lookAt(0, h * 0.52, 0);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    const px = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    g.putImageData(img, 0, 0);
    portraits.set(def.id, c.toDataURL('image/png'));
    scene.remove(rig.root);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = prevTM;
  rt.dispose();
}

export function portraitOf(def: CharacterDef) {
  return portraits.get(def.id) ?? '';
}
