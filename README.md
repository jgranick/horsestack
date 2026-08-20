# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 2D rigid-body
physics drives cloned 3D horses in the farm scene, while Flight's 3D particle
renderer handles impact dust and the final celebration.

Each run gives you a generous herd of 80 cow-scale horses. Before every drop, the real
horse stays hidden and a translucent yellow horse previews its approximate
landing pose. Guide the marker horizontally and release before the shrinking
timer commits the horse automatically. Fast drops earn tempo points but carry
extra wobble; the middle of the window offers the steadiest placement; and the
marker turns frantic as a forced drop approaches. Once released, the visible
horse fades in roughly half a horse-height above the marker, settles straight
down, and is handed to Flight's full physics on contact with the green pasture.
The cow-scale horses stay readable under a close camera that tracks the pile's
top while gradually pulling back and changing angle with its growth. The result
reports the contact-supported height in meters alongside the combined score.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer or use <kbd>←</kbd>/<kbd>→</kbd> to position the yellow marker.
Click, tap, press <kbd>Space</kbd>, <kbd>Enter</kbd>, or <kbd>↓</kbd> to reveal and drop
the horse.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs all 80 horses at rushed, careful, and timer-lock
cadences using the shipped velocity formulas, then checks for finite
body state, contacts, a measurable supported pile, and a real fall beyond the
farm-edge collider.

## Model credits

- [Low Poly Farm](https://sketchfab.com/3d-models/low-poly-farm-879d61d8dfc048548ee380cace6f79d3)
  by [EdwinRC](https://sketchfab.com/Edwin3D), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Horse](https://sketchfab.com/3d-models/horse-e9f1f7d5684c4e8881eb24a1d57e71b3)
  by [SleepyPineapple](https://sketchfab.com/SleepyPineapple), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
