# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 2D rigid-body
physics drives cloned 3D horses in the farm scene, while Flight's 3D particle
renderer handles impact dust and the final celebration.

Each run gives you 40 tiny horses. The active horse sweeps across a platform in
the farmyard until you drop it—or the shrinking timer drops it for you. The
rounded physics proxies, loose friction, and escalating spin turn the result
into a pile-up rather than a tidy tower. The camera follows the supported pile
upward, and the final score is its contact-supported height in meters rather
than the altitude of a horse still flying through the scene.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer or use <kbd>←</kbd>/<kbd>→</kbd> to influence the active horse.
Click, tap, press <kbd>Space</kbd>, <kbd>Enter</kbd>, or <kbd>↓</kbd> to drop it.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs all 40 horses at both manual-spam and timer-expiry
cadences using the shipped velocity formulas, then checks for finite body
state, contacts, and a measurable supported pile.

## Model credits

- [Low Poly Farm](https://sketchfab.com/3d-models/low-poly-farm-879d61d8dfc048548ee380cace6f79d3)
  by [EdwinRC](https://sketchfab.com/Edwin3D), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Horse](https://sketchfab.com/3d-models/horse-e9f1f7d5684c4e8881eb24a1d57e71b3)
  by [SleepyPineapple](https://sketchfab.com/SleepyPineapple), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
