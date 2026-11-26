# BREAKLINE

An original 3D rooftop arena brawler for the browser (Three.js + TypeScript + Vite). It is built from
the mechanics described in the design brief (lift classes, breakable perimeters that turn into ring-outs,
layered stamina/health, energy, Rage, Danger finishers and four recovery families). The characters,
arena, art, audio and names are all original. It is not a recreation of any existing game.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (add ?perf for the frame-time overlay, or press F3)
npm run build      # production build in dist/
npm run preview    # serve the build
```

Gameplay checks (needs Playwright with Chromium available to `require('playwright')`):

```bash
npm run dev &
node tests/checks.cjs
```

## Controls

| Action | Gamepad | Keyboard P1 | Keyboard P2 | Touch |
|---|---|---|---|---|
| Move | Left stick / d-pad | WASD | Arrows | Left virtual stick |
| A: attack (chain ×3, rising/descending air attacks) | A | J | `.` / Num1 | A |
| B: jump | B | K | `/` / Num2 | B |
| X: grapple / pick up / throw | X | L | `,` / Num3 | X |
| Y: guard; + direction = evade; A in evade = counter; timed Y catches | Y | I | `;` / Num5 | Y |
| L: mobility (sprint / swing / flight / teleport); L+A mobility attack | LB / LT | U | Right Shift / Num4 | L |
| R: power modifier (R+A, R+B, R+X, R+Y); hold to recharge; tap to Rage | RB / RT | O | Enter / Num6 | R |
| L+R while launched: recovery | LB+RB | U+O | | **L+R** chord button |
| Super block | R+Y | O+I | | **R+Y** chord button |
| Pause | Start | Esc | Backspace | ‖ |

In single-player, P1 can also use the P2 keys. Menus accept a stick or arrows, A or Enter to confirm, and B or Esc to go back. Unplugging a human player's pad mid-bout pauses the game. On-screen touch buttons and keyboard hints only show for the input you last used, so they disappear as soon as a gamepad is used.

## What's in this build

- **Modes:** Versus CPU (easy, normal or hard) and shared-screen Versus 2P. After a bout you can rematch, switch sides, return to character select or go to the main menu.
- **Arena select** on the character screen.
- **Route 9 Overpass:** a narrow elevated roadway at night. It has three stalled cars that are heavy and explode when thrown, concrete barrier blocks (medium), barrels and crates, and 26 breakable noise-barrier panels along exposed sides above a river. Wreck pile-ups close off both ends, and the light poles and sign gantry serve as swing anchors.
- **Arena: Clarion Rooftop.** The roof is enclosed by 28 breakable fence segments. It has seven sign letters that can be knocked loose into throwable debris, three A/C units (medium), an explosive fuel tank (heavy), crates and panels (light), an access hut that serves as cover and a cling wall, corner masts that act as swing anchors, and a visible city drop. Broken fence opens ring-outs. Broken props leave rubble. A rematch restores the pristine arena.
- **Fighters** (each has a move sheet on the *Controls & Move Sheets* screen):
  - **BASALT**: heavy lift class, ground recovery. Sprint, shoulder charge, a planted heavy throw, Thunderclap (a shockwave cone) and Ground Pound. He is the only fighter who can lift the A/C units and the fuel tank.
  - **TETHER**: swing recovery. Line swing, wall cling and climb, ranged line-yank grapple, snare bolt. A launch that is fatal for Basalt can be saved by Tether's reel-in recovery.
  - **AERIN VOLT**: flight recovery. Flight drains energy (B rises, Y sinks), volt bolts, flight dash.
  - **SHUNT**: teleport recovery. Directional hop, neutral L flanks behind the opponent, blink strike, displacement pulse. A teleport needs energy, so with an empty meter he cannot get back.
- **Move-set structure (shared across the roster, different content per fighter):**
  - **Chains and aerials:** a 3-hit A chain, plus rising and falling air attacks
  - **Running A:** a running attack
  - **R+A:** standing power; running R+A for a **dash power**; keep A held for a **charged power**; aerial power in the air
  - **Mobility:** an attack out of mobility (L+A)
  - **Grapples:** pummels while holding a grab (A, up to three), and a light prop swung as a weapon (breaks after three swings)
  - **R+X power grapple, unique per fighter:** Basalt *Piledriver*, Tether *Line Spin* (a fling built for ring-outs), Aerin *Skyfall Drop*, Shunt *Displace* (teleports the victim nine metres, off an open edge if you aim there)
  - **Finisher:** each fighter has a cinematic finisher

  The full per-fighter list is on the *Controls & Move Sheets* screen.
- **Presentation:**
  - spring-driven joint animation with anticipation and follow-through
  - swoosh ribbons along the striking limb, plus a white flash on the victim when hit
  - hit-stop, and a camera punch-in on heavy impacts
  - dust from landings, footfalls and slides, and tumbling launches
- **Look (matched to the reference clip):**
  - a display-space colour grade: desaturated, split-toned, with lifted teal blacks, a vignette and film grain
  - stronger bloom
  - motion blur on dashes, heavy hits and explosions, plus a full-screen flash
  - a wider field of view, with a little dutch tilt on big impacts
  - per-venue lighting: an overcast, washed-out teal day on the Overpass and a hazy late afternoon on the roof
- **Environments:**
  - Overpass: a through-truss bridge whose girders cast striped shadows across the deck, and a camera kept inside the roadway
  - close city blocks with storefront signs and awnings
  - road cracks, skid marks, stains and reflective puddles, plus debris along the barriers
  - Rooftop: crowding neighbour buildings, a water tower, a billboard, and pipes and vents
  - cars explode into fireballs and smoke, leaving a burning wreck that still blocks and can be thrown again
- **City and props (`src/city.ts`, `src/props.ts`):**
  - **Buildings:** generated with facades at true window scale: brick, dark brick, concrete, stone or glass curtain wall. Lit and dark rooms vary floor to floor, with frames, sills, blinds and grime.
  - **Building detail:** belt-course ledges, cornices and parapets, stepped-back upper floors, pilasters, fire escapes on buildings facing the fight, and rooftop clutter (water towers, AC units, antennas, stair huts). Everything is merged per material, so the whole city costs only a few draw calls.
  - **Skyline:** a mid-distance ring of varied towers plus a painted far panorama with lit windows that fades into each venue's haze. Soft light shafts hang between the buildings.
  - **Props:** sculpted car bodies with glass, rims, bumpers and lights; slatted crates; AC units with grilles and fans; ribbed, labelled barrels; a domed fuel tank; and jersey barriers with reflectors. Overpass pile-ups are built from a box truck, burnt cars and barriers.
  - **Fighters (8):**
  - **Basalt:** heavy, ground recovery. Thunderclap, Avalanche Charge, Tectonic Slam, Piledriver.
  - **Tether:** swing recovery, line yank. Snare bolts, Line Slingshot, Line Spin ring-out throw.
  - **Aerin Volt:** flight and bolts. Storm Dash, Chain Lightning, Skyfall Drop.
  - **Shunt (teleporter):** L hops or flanks behind the opponent, L+A Blink Strike, Phase Lunge, Pulse Mines, Displace (teleports the victim, off an edge if aimed there).
  - **Rift (teleporter):** portal fighter. L portal hop / step behind, **Swap Gate** (trade places with the opponent — use it when you're near an edge), **Portal Punch** (hits from behind at range and pulls them in), **Rift Storm** (three portals fire on the opponent), **Portal Drop** grapple (drops them from the sky).
  - **Vanta:** fast claw striker with a 4-hit combo, ground recovery. **Shade Rend**: phases through the opponent three times.
  - **Magna:** magnetic flier who pulls opponents and *any* object, cars included, to his hands from range. **Implosion**: drags the opponent in, then blasts.
  - **Ember:** fire bruiser whose heavy hits set the target burning, a damage-over-time effect that can't K.O. on its own. **Fireball**: an exploding, burning projectile.
- **Auras:** Rage and charging are shown as flickering flame wisps spawned across the fighter's skeleton, so the aura hugs the body and moves with the animation.
- **Lighting:** an environment map built from each venue's sky gives car paint, glass, metal and puddles real reflections. Contact shading comes from the lighting features described above.
- **Lighting:**
  - The sun's shadow map follows the action with a tight, texel-snapped box, so shadows are sharp and soft near the fighters.
  - Each fighter carries a glow light in their own colour that lights the floor and the opponent. It turns red in Rage, pulses blue while charging, and flashes white on hits.
  - Effect lights come from a small fixed pool: explosions, sparks, flashes and projectiles light their surroundings.
  - Each fighter has a soft contact shadow, building walls darken toward street level and under cornices, and the rim light is tinted per venue.
  - Light shafts are soft volumetric cones, and the Rage and charge auras and impact flashes use soft glow shaders. Dust uses soft billboard puffs.
  - The screen-space AO pass was removed because it produced artefacts.
- **Animated bodies (CC0):**
  - Fighters use the Quaternius *Universal Animation Library* mannequins, male and female (Aerin), from `public/models`.
  - Authored clips drive idle, walk, jog and sprint, jumps, jab, cross and hook, guard, roll, hit reactions, getting up off the ground, throws and pick-ups, dashes, slides, projectile casts, carrying and victory. One-shot clips are time-fitted to each move's gameplay frames.
  - Each fighter has its own animation set: idle stance, three-hit chain clips, running attack, dash and victory (Basalt shield-bashes, Shunt and Vanta fight with blade swings, Tether moves like a ninja, Aerin and Magna cast).
  - Fighting feel: a 10-frame input buffer, jump/guard/mobility cancels out of chain hits, smooth turning instead of instant snaps, momentum lean when running and changing direction, landing recoveries, block-impact reactions and faster rolls and get-ups.
  - Moves the library doesn't cover (kicks, swings, flight, wall-cling, finishers, power grapples, tumbling launches) use the procedural rig, retargeted onto the same skeleton and blended in smoothly.
  - Each fighter is recoloured with original bone-attached armour and accessories. If the models fail to load, the game falls back to the procedural bodies.
- **City Props (CC0):** jersey barriers, barrels, cones, road barricades, trash cans, wheelie bins and pallets from Coding Creature's *City Props 1*, used as throwable objects. The code-built props remain as fallbacks.
- **Menus:**
  - **Title:** three clear choices.
  - **Fighter select:** one screen with Player 1 and Player 2/CPU panels side by side. Each panel shows a portrait rendered from that fighter's actual 3D model, stat bars, recovery and lift type, and difficulty. Arena and CPU level pickers sit beside a single FIGHT button.
  - **Results:** a winner portrait with per-fighter stats.
  - **How to play:** Controls, Combat and Fighters tabs.
  - **HUD:** fighter headshots in the corner panels.
  - **Phones:** a compact layout for short (landscape) screens.
- **Characters (procedural fallback):**
  - muscle-shaped limbs and shaped torsos
  - more realistic proportions: longer legs, smaller heads
  - a surface bump texture and a fresnel rim light on every body
- **Resources:** yellow recoverable stamina is drawn over red lasting health. Powered hits, throws, props and explosions cut health. Energy shows quarter ticks. Rage builds from dealing damage, and a neutral tap of R gives 8 seconds of unlimited energy. **Danger** starts at health ≤ 25 or stamina ≤ 10. **Finisher** is R+X on a fighter in Danger, with at least a quarter of the energy meter or during Rage. Each fighter has its own cinematic finisher. Without enough energy, R+X becomes an ordinary grab and shows "NEED 1/4 POWER". A bout ends by K.O., RING OUT or FINISHER, and the results screen says which one ended it.
- **Feel:** startup, active and recovery frames per move. Hit-stop and screen shake on heavy impacts. Directional knockback. Launched bodies break the fence. A diamond marker shows the current X target. Synthesized audio gives a distinct sound for hits, blocks, catches, wall breaks, explosions, Rage on and off, and Danger.
- **Camera:** one shared camera sits perpendicular to the fighters. It holds its angle when one fighter is directly above the other, leaves room in the direction of a launch, and rate-limits rotation so fast side swaps don't whip the view. Props and the hut fade when they block the view. Finishers and victories get cinematic framing.
- **CPU:** it reacts with a delay and commits to short plans. It recovers from off-roof launches, steers away from open edges, and tries to push the opponent toward broken fence. Heavies go for props, Aerin flies and shoots, and Shunt flanks. It holds fire on a fighter who is down and limits itself to two projectiles in a row. Difficulty changes reaction time and decision quality, not damage.
- **Performance:** fixed 60 Hz simulation. Debris and sparks use instanced meshes. Adaptive quality lowers particle density, then render scale, then shadows. It never changes simulation, collision or input.

## Reference video notes

These come from 40 frames of the gameplay clip you supplied. They're genre conventions, and I adopted them without copying any assets:
- compact corner HUD panels with a portrait square, segmented energy pips, a thin vitality bar, and DANGER/RAGE badges, plus an R+X prompt when a finisher is available
- a low, close camera that pulls wide only as the fighters separate
- bloom with a full-screen red wash during Rage
- an elevated roadway arena full of throwable cars and barrels

## Checks actually run (`tests/checks.cjs`, 30/30 passing)

The CPU detours around objects it gets stuck behind. In a batch of 14 rooftop bouts, none timed out.


These checks covered K.O. on depleted health, Danger from stamina with full health, leaving Danger before a finisher, a valid finisher, a failed finisher with too little energy, and a finisher during Rage. They covered Tether's aerial save from a launch off an open edge, Basalt's ring-out on the same trajectory, and Shunt's ring-out with no energy. They covered a clean rematch reset, the lift-class split (only Basalt lifts the tank), the planted heavy throw and tank explosion, catching a prop, an R+A chord on the same tick resolving once, X choosing between the opponent and an adjacent prop, a grab returning to a valid state after rematch, a thrown prop breaking the fence, super block deflecting a projectile, Rage turning on and back off, Basalt lifting a car on the Overpass and the car exploding, CPU bouts on the Overpass, the tap/charged/dash power variants, the running attack, grab pummels, all four power grapples, a Displace ring-out, prop-weapon swings breaking the prop, and four complete CPU-vs-CPU bouts with no errors.

Also checked by hand in headless Chromium: the full keyboard menu flow (title → 2P → select → fight → pause/resume → K.O. → results → switch sides), and touch on an emulated Pixel 7 in landscape, steering with the stick while holding R and A at once.

**Performance was not measured on real hardware.** The only measurements came from headless Chromium using software WebGL (SwiftShader), at about 100 ms per frame. That reflects the emulator, not the game. Use `?perf` on a real PC or phone to record p50, p95 and p99 frame times.

## Approximations and known gaps

- YouTube is blocked in this build environment, so the reference was a supplied MP4 clip, reviewed as 40 sampled frames. The clip had no captions. All frame data, damage, thresholds (`TUNING` in `src/fighter.ts`) and collision sizes are tuning estimates, not measured values.
- Bodies are skinned, but all motion is still authored procedurally, with no motion capture. A different look per fighter comes from colour and attachments on one shared base mesh.
- With the CPU on hard, bouts often end by finisher in 20–60 s. Ring-outs mostly happen after fence breaks. Pacing needs human playtesting.
- Gamepad face buttons are mapped by label position on the browser's "standard" layout. Non-standard pads have not been tested.

## Next-session checklist

1. Measure frame times on a real PC and phone (`?perf`), then tune bloom, `fx.quality` and the shadow map size. `?nobloom` turns off bloom, and `?nopost` turns off the whole post stack.
2. Human playtest of Basalt vs Tether: compare a fight before and after the fence breaks, then tune `TUNING`, knockback and the Danger thresholds.
3. More arenas, each needing a distinct layout (the overpass is done): a street with liftable vehicles, a mansion interior with breakable columns, a two-level power plant with a cycling core, a station with columns and barriers, and a headquarters with force walls, mines and a healing chamber.
4. More original fighters for each recovery family (more swing, flight and teleport fighters, plus a magnetic object-controller).
5. Story mode: reusable objectives (clear an area, destroy targets, defend objects, defeat a named opponent), a catch-and-return barrier mission, a two-dish defense mission, and an underdog duel. Add unlocks saved across reloads.
6. A follow camera with player control for Story mode.
7. A rebind screen for keyboard and gamepad, plus layout handling for non-standard pads.
