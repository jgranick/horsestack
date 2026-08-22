# Horse Stacker

A chaotic low-poly stacking game built in TypeScript with
[`@flighthq/sdk`](https://github.com/flighthq/flight). Flight's 2D rigid-body
physics drives the 3D farm props, while Flight's 3D particle renderer handles
impact dust and the final celebration.

## Run locally

```bash
npm install
npm run dev
```

Move the pointer or use <kbd>←</kbd>/<kbd>→</kbd> to position the yellow marker.
Click or tap anywhere on the page, or press <kbd>Space</kbd>, <kbd>Enter</kbd>, or
<kbd>↓</kbd>, to reveal and place the object.

## Checks

```bash
npm run build
npm run validate:assets
npm run validate:game
```

The gameplay validation runs 64-object level, balanced, and teetered placement
scenarios using the shipped timing and surface-placement rules, then checks the
weighted prop distribution and both hen variants, all four randomized prop
types, finite body state, contacts, distinct 2D
colliders, a measurable supported pile, zero-impulse physics activation, the
1.55m horse-height conversion, and a real fall beyond the farm-edge collider.

## Deploying

`.github/workflows/deploy-pages.yml` builds and publishes to GitHub Pages on every
push to `main`, and can be run by hand from the Actions tab. It runs `npm run build`
(which typechecks first) plus both validations, so a broken build or a bad asset never
reaches the site, then uploads `dist` and deploys it.

Two things have to be set on the repository once, from the GitHub side:

- **Settings -> Pages -> Build and deployment -> Source** must be **GitHub Actions**.
- The `github-pages` environment is created by the first run; nothing to prepare.

No `base` configuration is needed for a project page at `/<repo>/`: `vite.config.ts`
sets `base: './'` and the glTF models are resolved against `import.meta.url`, so the
bundle is location-independent.

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
