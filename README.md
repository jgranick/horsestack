# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 2D rigid-body
physics drives cloned 3D horses in the farm scene, while Flight's 3D particle
renderer handles impact dust and the final celebration.

Each run gives you 30 seconds and an unlimited supply of cow-scale horses.
Before every drop, the real horse stays hidden and a radiant yellow horse
previews its landing pose. The marker behaves like a damped
pendulum: a still pointer lets it balance level, while quick horizontal movement
teeters it. On placement, the marker is immediately replaced by a fully visible
real horse at that exact position and angle. Flight physics activates there
with zero linear or angular impulse, so the pile can still shift, tip, and
tumble without an artificial drop destabilizing it.
The cow-scale horses stay readable under a close camera that tracks the pile's
top while gradually pulling back and changing angle with its growth. The result
reports the contact-supported height in meters alongside the combined score.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer or use <kbd>←</kbd>/<kbd>→</kbd> to position the yellow marker.
Click, tap, press <kbd>Space</kbd>, <kbd>Enter</kbd>, or <kbd>↓</kbd> to reveal and place
the horse.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs 64-horse level, balanced, and teetered placement
scenarios using the shipped timing and surface-placement rules, then checks for
finite body state, contacts, a measurable supported pile, zero-impulse physics
activation, and a real fall beyond the farm-edge collider.

## Model credits

- [Low Poly Farm](https://sketchfab.com/3d-models/low-poly-farm-879d61d8dfc048548ee380cace6f79d3)
  by [EdwinRC](https://sketchfab.com/Edwin3D), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Horse](https://sketchfab.com/3d-models/horse-e9f1f7d5684c4e8881eb24a1d57e71b3)
  by [SleepyPineapple](https://sketchfab.com/SleepyPineapple), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
