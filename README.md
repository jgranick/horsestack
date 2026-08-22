# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 3D rigid-body
physics drives cloned 3D horses in the farm scene, while Flight's 3D particle
renderer handles impact dust and the final celebration.

Each run gives you 60 seconds and an unlimited supply of cow-scale horses.
Before every placement, the real horse stays hidden and a translucent gold horse
previews its pose anywhere across the field in 3D. An exact Flight physics shape
cast positions that horse where its collider will first touch the live pile. A
faint footprint shows its center and facing direction, while a small ring marks
the exact contact point and surface angle. The marker behaves like a damped
pendulum: a still pointer lets it balance level, while quick horizontal movement
teeters it. Each new marker chooses from several roll and yaw orientations—including
upside down and facing toward or away from the camera—and that preview remains the
pose you place. On placement, the marker is immediately replaced by a fully visible
real horse at that exact position and orientation. Flight physics activates there
with zero linear or angular impulse, so the pile can still shift, tip, roll in
depth, and tumble without an artificial drop destabilizing it.
The cow-scale horses stay readable under a close camera that tracks the pile's
top while gradually pulling back and changing angle with its growth. Displayed
height is calibrated so one upright physics horse represents a typical 1.55m
riding horse. After the TIME UP beat, the result counts upward in meters and in
hands (4 inches each), stacking one horse emoji per hand before revealing the
final score.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer across the field or use the four arrow keys to position the
yellow marker in depth and from side to side. Click, tap, press <kbd>Space</kbd>,
or <kbd>Enter</kbd> to reveal and place the horse immediately.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs 64-horse level, balanced, and random-orientation
placement scenarios using the shipped timing and surface-placement rules, then
checks for finite 3D body state, contacts, a measurable supported pile, exact
shape-cast placement, front/back-facing yaw options, zero-impulse physics
activation, the wide conservative single-box horse proxy, the 1.55m horse-height
conversion, and real falls beyond both the lateral and depth edges of the farm
collider.

## Model credits

- [Low Poly Farm](https://sketchfab.com/3d-models/low-poly-farm-879d61d8dfc048548ee380cace6f79d3)
  by [EdwinRC](https://sketchfab.com/Edwin3D), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Horse](https://sketchfab.com/3d-models/horse-e9f1f7d5684c4e8881eb24a1d57e71b3)
  by [SleepyPineapple](https://sketchfab.com/SleepyPineapple), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Music credit

- “The Mountain's Happy Song” by Elijah_K, sourced from
  [Free Music Archive](https://freemusicarchive.org/) and licensed under CC BY.
- “Farm Early Morning (Loop),” “Bodyfall Wood Double Thud,” “Flashlight Turn On 4,”
  “Fanfare Arpeggio Resolution,” and “Ta Da Brass Fanfare 1” sourced from
  [Free Sound Effects](https://free-sound-effects.net/).
- “HORSE3” whinny compilation sourced from Free Sound Effects and cued as four
  short reaction clips in the game.
