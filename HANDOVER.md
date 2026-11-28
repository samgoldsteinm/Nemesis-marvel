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
| `src/rng.ts` | Seeded match RNG (`simRng`, `srand`). **All gameplay randomness goes through it** (see §7) |
| `src/net.ts` | Transport: tiny MQTT-over-wss client to public brokers (signalling + relay), WebRTC data channels, STUN/TURN (Metered), `NetLink` (hello/welcome, heartbeat, bye), `?net=local` BroadcastChannel bus for tests |
| `src/netplay.ts` | Lockstep netcode: input encoding, canonical stick frame, `checksum`, `snapshot`/`applySnapshot`, `Lockstep`, `OnlineSession` (lobby protocol) |
| `src/online.ts` | Online flow controller (host/join, lobby, intro, fight, rematch, disconnects) used by `main.ts` |
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
| 11-27 | Voiced intro lines: 90 Piper TTS clips (one per line; lines naming the opponent recorded per opponent) with per-fighter persona processing, `public/voices/<id>/<key>.mp3` + `manifest.json` (duration, speech end, 30 fps mouth envelope). Intro plays them on the voice bus, ducks music, stretches shots to fit, types subtitles in sync; talking animation (lips/mouth open, head nods, accent glow pulse). Generator: scratchpad `tts/gen.py` (copy kept in `tools/voices/gen.py`) |
| 11-27 | Both layouts: Xbox and GameCube (switch on the title screen or in How to Play → Controls; GameCube controllers/adapters auto-switch). Non-standard GameCube adapters (Mayflash etc.) get a raw button map; a "Set up controller" screen records each action's button/trigger per controller (`bl.bind.<pad id>` in localStorage). Menu confirm/back, HUD prompts, move lists, tips and touch labels follow the layout (`layoutText`, `actionLabel` in input.ts) |
| 11-27 | Real talking jaws: per-vertex `aJaw` weights computed from each face (nose/chin profile) + vertex-shader rotation about a hinge before skinning, on grafted heads, painted mannequin heads and the golem; outlines deform too; lower lip pieces rotate with the chin; golem gets a magma glow inside the mouth. Per-fighter strength in `looks.ts` (`look.jaw`) |
| 11-27 | Menu redesign: red accent (`--hot` #ff3b4e / `--hot2` #b8142c) replaces orange; Anton + Oswald fonts (OFL, `public/fonts`); Press Start screen (chrome logo, smoky teal band, duotone fighter profile, blinking prompt); title with comic-toned hero art; fighter select = two diagonal-split panels (P1 blue, P2 red, skyline + halftone backdrops, posterised poses) + duotone face roster strip + device-aware button prompts; restyled results/pause/how-to |
| 11-27 | Online 1v1 (`net.ts`, `netplay.ts`, `online.ts`, `rng.ts`): room codes + share links over public MQTT brokers, WebRTC data channel with relay fallback, Metered TURN; deterministic input lockstep (2–6 tick delay from RTT), seeded match RNG, checksums every 60 ticks with snapshot resync; determinism check in tests |
| 11-27 | Menu spacing pass (8/12/16/24/32 px scale on every screen; logo has its own block so its slash never touches the first button); select panels split into an info zone and an art zone (pose shrinks inside `.art`, never under the stats); roster faces re-framed (camera aimed at the face centre, square tiles, tags in corners, name on a gradient) |
| 11-27 | Fix: fighters falling off a broken edge could be snapped back onto the deck in a loop (stuck in the air, bout never ends). Title menu fits short landscape phones (settings row on one line) |
| 11-27 | Basalt's voice reprocessed for clarity (−4.5 st instead of −7, quiet octave-down only on stressed syllables, light gravel, 2–4 kHz presence, short stone room); victory follow-up lines (`FOLLOW`/`VERSUS_FOLLOW` in intro.ts, clips keyed `w_<intro key>`) and a victory cinematic (`VictoryCine`): letterboxed push-in on the winner, power flourish, voiced follow-up with jaw/talk, then results. Presentational only; runs when intros are on and the match was started with its intro |
| 11-27 | Phone select: stats behind a tap (`stats-tog` button, `statsOpen` in main.ts) |
| 11-27 | Phone-first touch controls: floating stick (left half), named ATTACK/JUMP/SPECIAL/GRAB/GUARD/DASH arc, contextual RAGE/FINISH/RECOVER/CHARGE buttons (via `setTouchContext` from main each frame), GUARD+SPECIAL = super block, HUD prompts touch-aware. Portraits auto-cropped to their opaque bounds (bigger select/title/result art), art zone widened to the seam; Basalt's comic art uses a charcoal-stone tone with lava kept (`posterizeStone`), neutral rim for studio renders |
| 11-28 | Roster close-ups framed like comic panels: per-fighter `FACE` shots in portraits.ts (camera azimuth/elevation/roll, body yaw, head turn via `SkinnedBody.headTurn`), face-level camera with the eyes ~40% down; Basalt pulled back, Tether turned toward us, Magna low angle, Ember tilted, Rift profile, Shunt dutch tilt |
| 11-28 | Arena select is its own screen after fighter select (`renderMap`, Screen `'map'`): big preview + strip of 5, name, blurb, ring-out danger (`DANGER`), Lives and CPU level moved here; ◀ ▶ keys / LB RB / tap; Back keeps fighters locked. Previews are real renders of each arena through the post stack (`captureArenaPreview`, one per frame while a menu is up, cached JPEG data URLs, original layout restored). Online: both locked → both go to the arena screen, host picks live (guest read-only), host's FIGHT calls `OnlineSession.go()` (no more auto-start on lock). Title menu redesigned: letterboxed band of tall slanted teal-duotone busts (`BUST` shots in portraits.ts, `bustOf`), text menu in a dark gap with gold highlight + red slash, device-aware prompt top-left, settings in the bottom bar; portrait = band on top, menu below. Aerin's roster face lifted (`aimY`) |
| 11-28 | Sharper image: multisampled composer target (MSAA 4x), light contrast-adaptive sharpen in the grade pass, grain 0.03→0.012, bloom radius ×0.55, adaptive quality drops shadows before resolution and never below native pixels (`minPixelRatio`) |

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
- CPU-vs-CPU bouts occasionally hit the 150 s test limit. Root cause found 11-27: `groundAt` treated the deck as floor for any point inside the footprint, so a fighter who fell off a broken edge and drifted back over the footprint while falling was snapped up to y=0, fell again, forever (stuck "air" loop, no ring-out). The deck now only supports things at/above it (`y + step >= 0`). This could also happen to players.
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

**Voices**
- Piper model files redirect to `us.aws.cdn.hf.co`; the environment must allow it (plus huggingface.co).
- Clip keys must match `pickLine()` in intro.ts: `l<i>`, `l<i>_<opponentId>` for lines with `{o}`, `vs_<opponentId>` for VERSUS lines. Regenerate clips whenever LINES/VERSUS text changes.
- The golem's CC jaw bone has no skin weights in the shipped mesh, so jaws are done in the vertex shader instead (`patchJaw` in skinned.ts): weights from the face profile, rotation in mesh space before skinning. Hinge/axis are converted per mesh (same for its outline, which shares geometry). `jawU` is 0 outside intro lines, so fights are unaffected.
- Kit hair meshes can carry more Head-weighted vertices than the face: exclude hair/eyes when picking the face frame, or the jaw lands in the wrong place.
- Jaw verification shots: freeze the fighter (`f.animate = () => {}`, `skeleton.pose()`) and place `vcam.cam` by hand (`vcam.update = () => {}`); the cinematic camera orbits and clamps height, which made earlier comparisons useless.
- Dark mouths vanish on dark faces (Vanta): use a coloured mouth interior.
- AudioBuffers decode on a throwaway OfflineAudioContext if sound isn't unlocked yet (decode isn't tied to the playing context).

**Menus**
- Inline SVG data URLs used inside a double-quoted `style="..."` attribute must use single quotes in `url('...')`, or the attribute ends early and the backdrop silently vanishes.
- Portrait variants (`portraits.ts`): pose, comic (posterised), face (duotone), profile (duotone) — all rendered once at load; faces need the camera ~1.9× head scale away or they crop to the forehead.
- The Press Start screen is `screen = 'start'`; test hooks (`__game.start`) bypass it.

**Online / determinism**
- Gameplay used `Math.random` (AI, hit side, finisher teleports, prop models/debris) and projectile origins used the
  *animated* hand bone, so two machines diverged. Fixed: `srand()` everywhere in sim code, `handSim()` for origins.
- Online stick input was camera-relative and each side's camera differs → fighters drifted. Fixed: both sides
  convert to the canonical frame (`toCanonical`) and set `match.camBasis = CANON`.
- Intro lines were picked with `Math.random` → different voice clips per side. Fixed: picked with an Rng seeded from the match seed.
- Old Lockstep handlers stayed subscribed after a rematch → double inputs. `NetLink.on` returns an unsubscribe; `Lockstep.dispose()`.
- The public brokers (broker.emqx.io, broker.hivemq.com, test.mosquitto.org) and crustrush.metered.live are blocked
  (403) from the cloud sandbox → test with `?net=local` (BroadcastChannel between tabs of one browser).
- Two swiftshader tabs in the sandbox can show multi-second RTT → heartbeat dropped the link. Timeout is 20 s;
  tests pass `?nettimeout=120000`.
- Under heavy sandbox load the page can take ~2 min to finish "LOADING FIGHTERS…"; `checks.cjs` waits up to 240 s for boot.
- Another agent rewrote the shared vite config file mid-test → use your own config/port per agent.

**Layout**
- Reserve zones for art and text. Never let art (poses, logos, slashes) overlap text or buttons: give the art its own box (`.half .art`) and let it shrink (object-fit: contain) instead of overlapping.
- Wide/short boxes with `object-fit: cover` crop to a strip: keep thumbnails square and frame the render itself (face renders aim at the Head bone + ~0.11 m, the face centre).
- Check spacing at very wide desktop sizes too (the user plays at ~2000×920); a block-level logo with an absolutely positioned slash spans the whole column.

**Victory cinematic**
- The follow-up is derived from the same seeded `pickLine` choice as the intro (`victoryLine`), so online both sides hear the same payoff. Keep `pickLine`'s RNG consumption unchanged or the keys stop matching.
- `VictoryCine` only runs for matches started with their intro (`matchCine`); test matches (`__game.start`) go straight to results. It never touches match state.
- Esc during a match opens pause: skip cinematics in scripts with a click, not Escape.

**Select screen**
- The select `.half` panels each span the full width and are clipped diagonally, so position art/info with that in mind (percentages are of the full width).

**Touch**
- Touch buttons send the same actions as a pad (attack/jump/grab/guard/mobility/power); combos are built from those (SPECIAL = power+attack, FINISH = power+grab, RECOVER = mobility+power). Contextual buttons must only appear when the action will work (e.g. RECOVER needs launch t > 6 and energy), or the tap is wasted.
- Test touch with CDP `Input.dispatchTouchEvent` (multi-touch with ids) in a manual-stepped match; `page.touchscreen.tap` can't hold or multi-touch.
- Portrait renders: reset `RIM_COLOR` to neutral while rendering (the arena palette's blue rim tinted the golem lavender) and restore it after.

**Portrait framing**
- `SkinnedBody.headTurn` (portrait-only) turns the head on top of the clip before the golem retarget; head angle in world ≈ body yaw + headTurn.yaw. Check shots on a large contact sheet (`faces` map) — raised arms in the pose can block a 3/4 angle (Magna), so orbit to the other side.

**Image quality**
- EffectComposer needs its own multisampled render target; the canvas `antialias` flag does nothing once post-processing is on.
- Never let adaptive quality push pixelRatio below 1 (CSS pixels): that is what made phones look fuzzy.

**Process**
- Background agents editing files while tests run make Vite hot-reload the page mid-test → failures that say
  "Execution context was destroyed" / "T is not defined" are not real; re-run when files are quiet, or test in
  a git worktree on another port (`git worktree add`, copy only your files, symlink node_modules, vite on 5174).
- Don't commit while another agent is mid-edit in the same files (it can ship a broken build to production);
  commit your own files only after verifying them on top of HEAD in a worktree.
- YouTube is blocked by the network policy; the user supplied the video file instead.
- The user declined an API-key credential prompt once; don't re-ask for that.

**Arena previews / title**
- Previews are captured with `drawImage(renderer.domElement)` right after `composer.render()` in the same task (no preserveDrawingBuffer needed); do it at the start of `frame()` so the normal render overwrites it. Turn off the motion-blur pass and the flash uniform for the capture, and swap `renderPass.camera` back afterwards.
- `.pill > *` is inline-block, so a leading space inside a child span collapses ("Xboxbuttons") — use `&nbsp;`.

## 6. Open items / ideas
- Commit the faces work once its job finishes; re-run the full test suite.
- Tune `CLIP_IMPACT` timings by eye for a few Motifect clips.
- Overpass triangle count roughly doubled with the MegaKit; watch low-end phones.
- iPhone Safari doesn't allow fullscreen/orientation lock; the rotate prompt covers it.

## 7. Online play (architecture, protocol, rules)

**Transport (`net.ts`).** No server of our own. Each room has two MQTT inbox topics on three public brokers
(`breakline/v1/r/<CODE>/h` for the host, `/g` for the guest); every message is published to all brokers and
de-duplicated by id. Over that relay the peers exchange SDP/ICE and open WebRTC data channels (`c` reliable,
`f` unordered no-retransmit), using Google/Cloudflare STUN plus Metered TURN (`TURN_URL`, Crust Rush's app).
If WebRTC fails the game keeps playing over the relay (slower). `NetLink`: `hello`→`welcome` (a third peer gets
`full`), `hb`/`hbr` heartbeat every 1 s (RTT for the ping display), link lost after 20 s, `bye` on leave.

**Lobby (`OnlineSession`).** Host picks P1 and the arena/lives, guest picks P2. Messages: `pick` {pick, locked},
`cfg` {arena, lives}, `start` {seed, p1, p2, arena, lives, delay} (host, when it presses FIGHT on the arena screen — `go()`, both must be locked), `ready` (intro done or
skipped), `rematch`. The fight starts only when both are `ready`: `match.restart(seed)` + `setLives`, then Lockstep.

**Netcode (`Lockstep`).** Deterministic input lockstep at 60 Hz. Input per tick = `[mx*100, my*100, buttons]`
(quantised the same on both sides, in the canonical stick frame). Local input is scheduled `delay` ticks ahead
(`delayFor(rtt)` = 2–6); every packet carries the last 30 unacked inputs (redundancy, so loss costs nothing).
A tick is simulated only when both inputs are known; otherwise the game stalls ("waiting…" after 0.5 s) —
it never guesses, so it can't desync from missing input. The host sends a checksum (`ck`) every 60 ticks; on a
mismatch the guest asks (`rs`), the host sends a snapshot (`sn`), the guest applies it and re-simulates from its
input history (240 ticks).

**Determinism rules (breaking these desyncs online play):**
- Never call `Math.random()` in gameplay code (fighter, match, ai, arena props, anything that changes sim state).
  Use `srand()` from `rng.ts`. Visual-only randomness (fx, vfx, audio, camera shake) stays on `Math.random`.
- Gameplay positions must not come from animated bones: use `fighter.handSim()`, not `hand()`, for spawns.
- The sim must not depend on frame rate or render state; it advances only via `simTick` at fixed 60 Hz.
- The intro is cosmetic; anything it does must not change sim state. Only `restart(seed)` starts the fight.
- New sim state that matters must be covered by `checksum()` and survive `snapshot()` (reflection over fighter
  fields; props only if counts match; walls via damage).
- `tests/checks.cjs` "Determinism" runs 5 arenas × 1200 CPU-vs-CPU ticks twice with different animation cadence
  and compares checksums — run it after any gameplay change.

**Testing online locally.** `?net=local` swaps MQTT/WebRTC for a BroadcastChannel (two tabs of the same browser),
`?rtc` re-enables WebRTC on top of it, `?nettimeout=ms` changes the drop timeout, `?room=CODE` auto-joins.
Two-page Playwright script used: scratchpad `online_e2e.cjs` (host + join, lock picks, fight, compare checksums,
guest leaves → host sees "Opponent left.").

