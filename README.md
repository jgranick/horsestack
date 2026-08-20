# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 2D rigid-body
physics drives cloned 3D horses in the farm scene, while Flight's 3D particle
renderer handles impact dust and the final celebration.

Each run gives you 40 tiny horses. A Tetris-style active horse descends over the
front of the farm while a translucent yellow horse previews its approximate
landing pose. Guide it horizontally and hard-drop when the pose looks suitably
unsafe—or let the shrinking timer commit it automatically. A hard drop hands
the horse to Flight's full physics from its current height with a consistent
initial impulse, so early drops have farther to fall. The camera follows the
supported pile upward, and the final score is its contact-supported height in
meters rather than the altitude of a horse still flying through the scene.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer or use <kbd>←</kbd>/<kbd>→</kbd> to position the descending horse.
Click, tap, press <kbd>Space</kbd>, <kbd>Enter</kbd>, or <kbd>↓</kbd> to hard-drop it.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs all 40 horses at both early-hard-drop and
timer-lock cadences using the shipped velocity formulas, then checks for finite
body state, contacts, a measurable supported pile, and a real fall beyond the
farm-edge collider.

## Model credits

- [Low Poly Farm](https://sketchfab.com/3d-models/low-poly-farm-879d61d8dfc048548ee380cace6f79d3)
  by [EdwinRC](https://sketchfab.com/Edwin3D), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Horse](https://sketchfab.com/3d-models/horse-e9f1f7d5684c4e8881eb24a1d57e71b3)
  by [SleepyPineapple](https://sketchfab.com/SleepyPineapple), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
