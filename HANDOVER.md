# BREAKLINE — Handover

Read this before changing anything. It records what the game is, how it's built, what changed and when, and
every mistake we've already made and fixed, so they aren't repeated. **Add to it whenever you change
something or fix a problem** (newest entries at the bottom of each list).

Live site: https://rooftop-nemesis-crust-rush.vercel.app (Vercel project `rooftop-nemesis`, team `crust-rush`).
Branch: `claude/game-from-video-q75dfr` — every push to it deploys to production.

---

## 1. What the game is

An **original** 3D arena brawler inspired by the *mechanics* of a GameCube-era superhero fighting game (the user
supplied a design doc and gameplay video). It must **not** recreate that game: no Marvel names, characters,
arenas, art or music. All fighters, names, arenas and designs are our own.

Core mechanics: lift classes (light/medium/heavy props, cars), breakable fences/barriers with ring-outs,
layered vitality (recoverable stamina in front of lasting health), energy pips, Rage, Danger state + finishers,
per-fighter recovery families (ground / swing / flight / teleport), power grapples, charged powers.

Controls (Xbox layout since 11-27): X attack, A jump, Y grab/throw, B or LT guard (+dir = evade), LB mobility,
RT/RB power modifier. Internally the actions are still named attack/jump/grab/guard/mobility/power. Gamepad (standard mapping), two keyboard layouts, and touch.

## 2. Tech and layout

- Three.js r170 + TypeScript + Vite. Fixed 60 Hz simulation (`simTick`), rendering decoupled.
- Post: RenderPass → AfterimagePass (motion blur) → UnrealBloomPass → OutputPass → custom grade ShaderPass.
  Adaptive quality lowers bloom → blur → fx density → pixel ratio → shadows when frames are slow.

| File | Purpose |
|---|---|
| `src/main.ts` | Renderer, palettes per arena, menus (title/select/results/pause/how-to), match start, main loop, landscape fit, test hooks on `window.__game` |
| `src/match.ts` | Match state, end conditions, **lives/rounds**, projectiles (`spawnProjectile`), mines, thrown props, explosions |
| `src/fighter.ts` | Fighter state machine, moves, specials, grapples, finishers, traits, hit resolution, status FX, clip selection (`clipFor`, `STYLE`, `MOVE_CLIP`, `CLIP_IMPACT`) |
| `src/characters.ts` | Fighter definitions (stats, move data, sheets). `ROSTER` |
| `src/looks.ts` | Fighter visual designs (body paint regions, faces/masks, attachments) |
| `src/skinned.ts` | Loads mannequin + animation glbs, `SkinnedBody` (clip playback, procedural blend, attachments, body paint shader) |
| `src/traits.ts` | Passive trait names/descriptions (logic lives in fighter.ts) |
| `src/fx.ts` | Particle FX (debris, sparks, wisps, billows, rings, flashes, light pool); owns `fx.vfx` |
| `src/vfx.ts` | Shader VFX ported from Binbun packs: hit, bigImpact, groundImpact, explosion, zap, electricBall, cast, muzzle, beam, projectile, status (stun/snare/burn/rage/charge), shatter. 2 draw calls total |
| `src/intro.ts` | Cinematic fight intro (per-fighter lines, speech, power-ups) |
| `src/padcursor.ts` | Controller arrow cursor in menus |
| `src/audio.ts` | Synth SFX + music (Web Audio, no files) |
| `src/arena.ts`, `src/city.ts`, `src/citykit.ts`, `src/props.ts` | Arenas (rooftop, overpass), procedural city, MegaKit buildings, props |
| `src/arenas2.ts` | Skyline Site, Harbor Pier 7, Neon Helipad builders + their dynamic pieces (`resetExtra`), water splash height `WATER_Y` |
| `src/camera.ts` | Versus camera (`zoomMul`, `zLimit`, `cinematic`) |
| `src/ai.ts` | CPU opponent |
| `src/hud.ts`, `src/input.ts`, `src/portraits.ts`, `src/rig.ts` | HUD, input devices, select-screen portraits, procedural rig |
| `tests/checks.cjs` | Deterministic gameplay checks (Playwright). `node tests/checks.cjs [url]` with the dev server running |

### Assets and licences (keep the LICENSE files)
- Quaternius Universal Animation Library 1 & 2 (CC0): `public/models/ual_*.glb`.
- Motifect Combat + Martial Arts packs: retargeted clips in `public/models/ual_motifect.glb` (`M_*` names).
  Free to use; **never commit the raw BVH/FBX files**.
- Quaternius City Props (CC0) `public/models/props/`, Downtown City MegaKit (CC0) `public/models/city/`.
- Binbun VFX packs (CC0): only `public/vfx/flash_atlas.png` is shipped.
- Quaternius Fantasy Races + Bestiary (Quaternius Asset License: use in the game, **don't redistribute as an
  asset pack**).

## 3. Workflow

- Dev server: `(setsid npx vite --port 5173 --strictPort >/dev/null 2>&1 &)`. It dies on container restarts; restart it.
- Type-check: `npx tsc --noEmit`. Build: `npm run build`. Tests: `node tests/checks.cjs` (≈5 min, must be all PASS).
- Screenshots: Playwright with chromium args `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.
  Drive the game through `window.__game` (`start`, `startWithIntro`, `setManual`, `step`, `forced`, `emptyRaw`,
  `vcam.cinematic`, `match`). Add `?nobloom` to the URL for faster captures. Always look at the images.
- Deploy: push to the branch → Vercel builds. Check with Vercel `list_deployments`
  (projectId `prj_BiUEKm4O6PVtNLwMAhhirbdb31Kh`, teamId `team_rJB6nGDrpDmBmmRjy6AVwCa6`). If no deployment
  appears after a couple of minutes, the webhook was missed: trigger one with `create_deployment`
  (gitSource github, org `samgoldsteinm`, repo `Nemesis-marvel`, ref = branch, sha = HEAD, target production).
- Commit messages end with the Co-Authored-By / Claude-Session lines from the session instructions. Never put a model ID in commits.
- Large files from the user come as Google Drive links. The project environment allows `drive.google.com` and
  `drive.usercontent.google.com`. The file must be shared "Anyone with the link"; big files need the
  virus-scan confirm (`&confirm=t&uuid=...` from the warning page).

## 4. Change log

| Date | Change |
|---|---|
| 11-22 | First playable: rooftop arena, four fighters, HUD, menus, CPU, Vercel deploy |
| 11-22 | Tap latching fix, swing recovery, Overpass arena, bloom, deeper move sets |
| 11-23 | Colour grade, girder shadows, rigged skinned bodies |
| 11-26 | Detailed procedural city/props/lighting; UAL animated mannequins; City Props; portraits; cleaner UI |
| 11-26 | Softer lighting + character glow; Vanta, Magna, Ember; particle Rage aura; less blown-out light |
| 11-26 | Gamepad hides touch/key hints; input buffer, chain cancels, smooth turning, lean; per-fighter clip styles |
| 11-26 | Rift (portal teleporter); Swap Gate, Portal Punch, Rift Storm, Portal Drop; Shade Rend, Implosion, Fireball |
| 11-26 | Health damage ×0.5 (`TUNING.healthScale`); traits; Shadow Shred / Iron Maiden / Furnace Slam; unique finishers |
| 11-26 | Binbun shader VFX (`vfx.ts`) wired into hits/specials/projectiles/statuses; Motifect clips per fighter |
| 11-26 | Downtown City MegaKit buildings + street in both arenas |
| 11-26 | Fighter redesign: humans, cat-woman, golem, fire demon (`looks.ts`); softer glow light + hit flash |
| 11-26 | Landscape layout (camera zoom, compact HUD/touch, safe areas, fullscreen+lock, rotate prompt) |
| 11-26 | Controller arrow cursor in menus; stats visible in landscape select |
| 11-26 | Select: tap previews, Confirm locks in (tap twice = confirm), Back undoes last lock |
| 11-26 | Fix recycled particle sprites flashing at old size (Ember's hand "orange balls") |
| 11-26 | Cinematic fight intros with lines, speech, power-ups; title toggles for intros/voices |
| 11-26 | Lives/rounds (1/2/3/5 on select; HUD diamonds; "ROUND n"; arena damage persists) |
| 11-26 | Sound design (`audio.ts`): buses + limiter, shared reverb/distortion, D Phrygian; menu + fight music with intensity layer; per-fighter ability palettes, impacts, Rage cue, power/special stingers, FIGHT stinger |
| 11-26 | Faces/masks for every fighter; head parts grafted from Quaternius Fantasy Races/Bestiary (`public/models/chars/`, recoloured) for Aerin, Shunt, Magna, Ember, Rift; outfit patterns (web/rosette/tiger/quilt) in the body shader |
| 11-27 | Basalt = rock golem model ("Golem Rock" by Oscar Creativo, `public/models/golem.glb`), runtime-retargeted from the hidden UAL driver; 2.22 m visual / 2.3 gameplay height |
| 11-27 | Rage tap works from controllers (24-tick window, from charge, mid-move); grab is a clinch with knee pummels, victim stays grounded and flinches |
| 11-27 | Select screen: full trait text (panel scrolls), compact bar on small phones; HUD names can't overlap |
| 11-27 | Three new arenas: Skyline Site (construction floor, crane/hoist/scaffold, safety-mesh edges, beams/lumber/cement props), Harbor Pier 7 (container ends, pier railings over water with splash, fuel drums, quay cranes, cargo ship), Neon Helipad (circular deck via `SHAPE.circle`, 3 low rims, neon district). Per-arena palettes and fight tempos; select-screen arena picker is ◀ name ▶ (fits 667×375) |
| 11-27 | Controls remapped from GameCube to Xbox: X attack, A jump, Y grab, B/LT guard, LB mobility, RT/RB power; all move lists, tips, HUD prompts, touch buttons (Xbox colours) and README updated |
| 11-27 | Both layouts: Xbox and GameCube (switch on the title screen or in How to Play → Controls; GameCube controllers/adapters auto-switch). Non-standard GameCube adapters (Mayflash etc.) get a raw button map; a "Set up controller" screen records each action's button/trigger per controller (`bl.bind.<pad id>` in localStorage). Menu confirm/back, HUD prompts, move lists, tips and touch labels follow the layout (`layoutText`, `actionLabel` in input.ts) |

## 5. Problems we hit and how they were fixed (don't repeat these)

**Rendering / visuals**
- GTAO screen-space AO produced a dark rectangle on the roof → removed GTAO entirely.
- Outline hull on skinned models became a huge black blob: outline thickness was divided by the armature's
  0.01 scale → use the model's world scale.
- Bump/noise maps on skinned bodies moiré on their UVs → no bump on skinned bodies.
- Facade material with `vertexColors` turned black → `fac.vertexColors = false`.
- Square puddles → CircleGeometry + alphaMap.
- Lighting "blown out" / "blocky": exposure ≈0.98, palettes toned down; auras are soft particle wisps, not
  shells; keep VFX colours saturated (never pure white) under bloom.
- The per-fighter coloured PointLight washed costumes into one colour → intensity 0.6, positioned 1 m out
  and 0.9 m up. Hit flash fully whitened the victim → warm 0.3 emissive for ~2 ticks.
- Pooled sprites (wisps, billows) rendered one frame at their previous owner's scale → set scale/opacity on spawn.
- MegaKit: meshopt-quantised attributes must be converted to float and node matrices baked, or buildings
  render tiny/invisible; the kit's `COLOR_0` wear mask tints everything red → strip it.
- Overpass camera filmed through the truss → `vcam.zLimit`.
- Charge aura saturated to white → fewer, smaller, saturated wisps.

**Gameplay / sim**
- CPU stalled chasing props or with an obstacle between fighters → anti-stall and unstick detours.
- CPU-vs-CPU bouts occasionally hit the 150 s test limit (rare, AI-only); not user-facing, watch for regressions.
- Taps shorter than one frame were lost → key tap latching (`tapped` set, `endInputRead`).
- Airborne specials were cancelled on landing → add the special to the landing-exempt list in `fighter.ts`.
- `faceOpp` is private in Fighter; outside code must compute yaw itself.

**Animation**
- Mocap (Motifect) clips have long wind-ups that can't be sped up enough → `once()` skips into the clip
  (`startAt`) so the blow lands on the hit frame. Impact times in `CLIP_IMPACT` are estimates.
- `NinjaJump_Idle_Loop` is an in-air pose (fighter floats when idle) → don't use it as an idle.
- Throw clips that need a partner (hip throw, body slam) look wrong solo → dropped.

**UI / input**
- Touch buttons inside a CSS-transformed container: `position: fixed` children become relative to it (the
  pause button moved into the cluster) → keep fixed elements outside transformed parents.
- Portrait-only breakpoints applied to landscape phones → scope with `(orientation: portrait)`.
- A local variable named `screen` shadows `window.screen` in `main.ts` → use `window.screen`.
- `import.meta.env` isn't typed in this project → don't use it (use '' / relative paths).
- Pad cursor jumped back to FIGHT whenever the select screen re-rendered → reset only when the screen key changes.
- Test-harness matches (`__game.start`) must not run the intro (it locks inputs) → `startMatch(false)`;
  `startWithIntro` exists for intro screenshots.

**Audio**
- Audio only starts after a user gesture; `startMusic` before unlock is remembered and starts on the first tap/key.
- Verify audio offline (`renderOffline` → WAV + levels); we can't listen in this environment.

**Characters**
- User wants their OWN characters: borrow parts from asset packs (heads, hair, horns), never swap a whole stock character in. Always send screenshots and wait for approval before committing visual character changes.
- Bulk (`look.bulk`) widens the whole model in X/Z; grafted heads are counter-scaled so faces don't squash.
- Head attachments (`HA`) are authored for a 1.95 m reference head; scale for taller fighters or they look tiny/huge.
- Golem (CC skeleton) model: FBX importer duplicated the skeleton per mesh (merged by name); UDIM tile names were lost in the zip (matched by UV masks); meshopt-quantised bounds aren't metres (measure skinned bounds); inward vertex normals made rim light paint pale blotches (rim uses |N·V| on the smooth normal); forearm roll must be spread over twist bones.
- Rage tap on gamepads: analog triggers are slow to release; a tap that slips into charge must still count.

- Never call `addOutline` inside `traverse()`: the outline mesh is added as a child and gets traversed too (infinite recursion, "Maximum call stack size exceeded"). Outline each mesh when you create it.

**Arenas**
- New wall styles live on `WallSeg` (`style`, `height`): `fence`/`noise` (rooftop/overpass), `safety`, `rail`, `rim`.
- Circular decks: set `SHAPE.circle` (radius) so `inside()` is a disc; `BOUNDS` is the enclosing square and stays valid for clamps.
- Don't put collision on edge dressing (bollards etc.): it stops launched fighters at the edge and blocks ring-outs.
- Watch-less dev servers (`hmr:false`, `watch.ignored`) serve stale modules after edits: restart them with `--force`.
- `renderer.info` resets every frame; read draw calls from a manual `render()` with `autoReset=false` (`__game.renderInfo()`).

**Controllers**
- Browsers report GameCube adapters with non-standard button numbers (mapping ''), so a GameCube R press may never reach "power"; that's why Rage "didn't work". Keep `RAW_GC` + the setup screen; analog triggers may be axes that rest at -1 (deflection measured from rest).
- Authored text uses Xbox names; `layoutText()` rewrites them for GameCube at render time. Don't run it over keyboard keys (WASD's "A").

**Process**
- Background agents editing files while tests run make Vite hot-reload the page mid-test → failures that say
  "Execution context was destroyed" / "T is not defined" are not real; re-run when files are quiet, or test in
  a git worktree on another port (`git worktree add`, copy only your files, symlink node_modules, vite on 5174).
- Don't commit while another agent is mid-edit in the same files (it can ship a broken build to production);
  commit your own files only after verifying them on top of HEAD in a worktree.
- YouTube is blocked by the network policy; the user supplied the video file instead.
- The user declined an API-key credential prompt once; don't re-ask for that.

## 6. Open items / ideas
- Commit the faces work once its job finishes; re-run the full test suite.
- Tune `CLIP_IMPACT` timings by eye for a few Motifect clips.
- Overpass triangle count roughly doubled with the MegaKit; watch low-end phones.
- iPhone Safari doesn't allow fullscreen/orientation lock; the rotate prompt covers it.
