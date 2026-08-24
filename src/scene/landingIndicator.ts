// The gold marker for the piece about to drop: the hovering ghost of the piece itself, the
// halo ring under it, the point light in that halo, and the spring that makes the whole
// thing teeter as you aim. src/scene/LandingIndicator.hx in the Haxe sibling.
//
// Four things that were spread across main.ts belong together here, and the reason is that
// they are all one visual object:
//   - the ghost node and the derived "preview" materials that gild it,
//   - the halo mesh and its alpha/scale pulse,
//   - the point light, whose position and intensity track the halo exactly,
//   - the teeter spring, whose angle IS the queued piece's angle.
// The spring is the part most worth having behind a boundary: aiming kicks its angular
// velocity, the frame advances it, and a new piece zeroes it, so its three numbers were
// written from three different places and read from a fourth.
import type { Material, Node3D, PointLight, StandardPbrMaterial } from '@flighthq/sdk';
import {
  addNodeChild,
  clamp,
  cloneMaterial,
  createMesh,
  createNode3D,
  createRingMeshGeometry,
  createStandardPbrMaterial,
  getMaterialOfKind,
  invalidateNodeLocalTransform,
  Node3DKind,
  removeNodeChildren,
  setNode3DAlpha,
  setQuaternionFromEuler,
  StandardPbrMaterialKind,
} from '@flighthq/sdk';
import {
  INDICATOR_DAMPING,
  INDICATOR_MAX_ANGLE,
  INDICATOR_MAX_SPIN,
  INDICATOR_SPRING,
  LANDING_PREVIEW_LIFT,
  STACK_BASE_Y,
  STACK_X,
  STACK_Z,
} from '../game/gameConfig';
import type { StackObjectKind } from '../physics/horseStackPhysics';
import { getStackObjectVerticalExtent, PASTURE_HALF_WIDTH } from '../physics/horseStackPhysics';
import { prefersReducedMotion } from '../reducedMotion';
import type { StackObjectVisuals } from './stackObjectVisual';

export interface LandingIndicator {
  /** The angle the queued piece currently hangs at, driven by the teeter spring. */
  angle: () => number;
  /** Top of the hovering preview in physics Y, for the dev frame readout. */
  previewTopY: () => number;
  /** Build a fresh ghost and halo under previewLayer for a new round. */
  beginRound: () => void;
  /** A new piece is queued: swap the ghost's model and show the marker. */
  setKind: (kind: StackObjectKind, variantIndex: number) => void;
  /** Zero the teeter — a new piece, or a new round. */
  resetTeeter: (now: number) => void;
  /** Aiming moved this fast; kick the spring so the piece swings. */
  nudge: (pointerVelocity: number) => void;
  /** Advance the teeter spring for this frame. */
  stepTeeter: (now: number) => void;
  /**
   * Position the ghost, halo and light for this frame. `landingSurfaceY` is where the piece
   * would come to rest, which only the game knows; the lift above it is this module's.
   */
  update: (
    kind: StackObjectKind,
    x: number,
    angle: number,
    landingSurfaceY: number,
    now: number,
  ) => void;
  /** Switch the whole marker off — between rounds, and while the pile settles. */
  hide: () => void;
}

// How far the drop preview is pushed toward the gold "about to land" look. At 1 — which is
// what it used to be, a single gold material replacing every material on the clone — the
// preview is a featureless silhouette and you cannot tell a cow from a hay bale until it
// lands. Blending instead keeps each material's own colour (and its texture, since baseColor
// multiplies the map) while gilding and lighting it, so the piece stays readable.
const PREVIEW_TINT_MIX = 0.42;
// The glow is a SEPARATE, smaller fraction. Emissive does not just tint, it adds light on
// top of whatever the sun and the marker's own point light are already putting on the
// piece, so matching it to the tint blew pale materials out to white.
const PREVIEW_GLOW_MIX = 0.22;

export function createLandingIndicator(
  visuals: StackObjectVisuals,
  previewLayer: Node3D,
  indicatorLight: PointLight,
): LandingIndicator {
  const ghostMaterial: StandardPbrMaterial = createStandardPbrMaterial({
    alphaMode: 'opaque',
    baseColor: 0xe2b83fff,
    doubleSided: true,
    emissive: 0x8a5a0bff,
    emissiveStrength: 0.7,
    metallic: 0.18,
    roughness: 0.38,
  });
  const haloMaterial: StandardPbrMaterial = createStandardPbrMaterial({
    alphaMode: 'blend',
    baseColor: 0xf5d36aff,
    doubleSided: true,
    emissive: 0xd49a22ff,
    emissiveStrength: 1.15,
    metallic: 0.1,
    roughness: 0.42,
  });
  // Derived materials are cached per source material: a clone is built for every preview, and
  // the same handful of source materials come round again every time.
  const previewMaterials = new WeakMap<Material, Material>();

  // The preview's version of one of an object's own materials: its colour pulled halfway to
  // the marker gold, lit by the marker's emissive at the same fraction.
  function toPreviewMaterial(source: Material | null): Material | null {
    if (source === null) return ghostMaterial;
    const cached = previewMaterials.get(source);
    if (cached !== undefined) return cached;
    const pbr = getMaterialOfKind<StandardPbrMaterial>(source, StandardPbrMaterialKind);
    if (pbr === null) {
      previewMaterials.set(source, ghostMaterial);
      return ghostMaterial;
    }
    const blended = cloneMaterial(pbr) as StandardPbrMaterial;
    blended.baseColor = mixRgba(pbr.baseColor, ghostMaterial.baseColor, PREVIEW_TINT_MIX);
    // Mixed FROM the source's own emissive, not simply taken from the marker: most of these
    // materials emit nothing, and handing them the marker's glow outright blew pale ones —
    // a white Holstein especially — out to a featureless white, which is the very thing the
    // blend exists to avoid.
    blended.emissive = mixRgba(pbr.emissive, ghostMaterial.emissive, PREVIEW_GLOW_MIX);
    blended.emissiveStrength =
      pbr.emissiveStrength + (ghostMaterial.emissiveStrength - pbr.emissiveStrength) * PREVIEW_GLOW_MIX;
    blended.metallic = pbr.metallic + (ghostMaterial.metallic - pbr.metallic) * PREVIEW_TINT_MIX;
    blended.roughness = pbr.roughness + (ghostMaterial.roughness - pbr.roughness) * PREVIEW_TINT_MIX;
    // The preview is a lone floating object, so its back faces would otherwise show through.
    blended.doubleSided = true;
    previewMaterials.set(source, blended);
    return blended;
  }

  function createRadiance(): Node3D {
    const root = createNode3D(Node3DKind, { name: 'landing-radiance' });
    const halo = createMesh(createRingMeshGeometry(0.105, 0.132, 28), [haloMaterial]);
    halo.alpha = 0.24;
    halo.position.x = 0.012;
    setQuaternionFromEuler(halo.rotation, 0, 0, Math.PI / 2);
    invalidateNodeLocalTransform(halo);
    addNodeChild(root, halo);
    return root;
  }

  let ghost: Node3D | null = null;
  let radiance: Node3D | null = null;
  let angle = 0;
  let angularVelocity = 0;
  let updatedAt = performance.now();
  let previewTopY = 0;

  function updateRadiance(x: number, physicsY: number, now: number): void {
    if (radiance === null) return;
    const pulse = prefersReducedMotion() ? 1 : 1 + Math.sin(now * 0.006) * 0.025;
    radiance.enabled = true;
    setNode3DAlpha(radiance, 0.48 + Math.sin(now * 0.008) * 0.055);
    radiance.position.x = STACK_X + 0.006;
    radiance.position.y = STACK_BASE_Y + physicsY;
    radiance.position.z = STACK_Z - x;
    radiance.scale.x = pulse;
    radiance.scale.y = pulse;
    radiance.scale.z = pulse;
    invalidateNodeLocalTransform(radiance);

    indicatorLight.position.x = STACK_X + 0.1;
    indicatorLight.position.y = STACK_BASE_Y + physicsY + 0.09;
    indicatorLight.position.z = STACK_Z - x;
    // Down from 0.8: a gold point light this close at that strength lit every preview the
    // same gold no matter what its material said, which is why blending the material barely
    // showed. The marker still reads — the halo ring and the tint carry it — and now the
    // piece's own colour survives underneath.
    indicatorLight.intensity = 0.34 + Math.sin(now * 0.008) * 0.07;
  }

  return {
    angle() {
      return angle;
    },

    previewTopY() {
      return previewTopY;
    },

    beginRound() {
      ghost = createNode3D(Node3DKind, { name: 'landing-preview' });
      // A solid silhouette keeps the small chicken readable and prevents the horse's
      // back-facing surfaces from showing through the preview. The halo, beam, emissive
      // material, and point light retain the golden placement cue.
      ghost.alpha = 1;
      addNodeChild(previewLayer, ghost);
      radiance = createRadiance();
      addNodeChild(previewLayer, radiance);
      indicatorLight.intensity = 0;
    },

    setKind(kind, variantIndex) {
      if (ghost === null) return;
      removeNodeChildren(ghost);
      addNodeChild(ghost, visuals.create(kind, variantIndex, toPreviewMaterial));
      ghost.name = `${kind}-landing-preview`;
      ghost.enabled = true;
      if (radiance !== null) radiance.enabled = true;
    },

    resetTeeter(now) {
      angle = 0;
      angularVelocity = 0;
      updatedAt = now;
    },

    nudge(pointerVelocity) {
      angularVelocity = clamp(
        angularVelocity - clamp(pointerVelocity * 0.32, -4.2, 4.2),
        -INDICATOR_MAX_SPIN,
        INDICATOR_MAX_SPIN,
      );
    },

    stepTeeter(now) {
      const deltaTime = clamp((now - updatedAt) / 1000, 0, 0.05);
      updatedAt = now;
      if (deltaTime === 0) return;
      const acceleration = -angle * INDICATOR_SPRING - angularVelocity * INDICATOR_DAMPING;
      angularVelocity = clamp(
        angularVelocity + acceleration * deltaTime,
        -INDICATOR_MAX_SPIN,
        INDICATOR_MAX_SPIN,
      );
      angle = clamp(angle + angularVelocity * deltaTime, -INDICATOR_MAX_ANGLE, INDICATOR_MAX_ANGLE);
    },

    update(kind, x, pieceAngle, landingSurfaceY, now) {
      if (ghost === null) return;
      ghost.enabled = Math.abs(x) <= PASTURE_HALF_WIDTH;
      if (!ghost.enabled) {
        if (radiance !== null) radiance.enabled = false;
        indicatorLight.intensity = 0;
        return;
      }
      const landingY = landingSurfaceY + getStackObjectVerticalExtent(kind, pieceAngle);
      // The halo and its light ride up with the object so the ring surrounds whatever is
      // about to drop, rather than marking the landing pose it will fall to.
      const previewY = landingY + LANDING_PREVIEW_LIFT;
      previewTopY = previewY + getStackObjectVerticalExtent(kind, pieceAngle);
      visuals.setTransform(ghost, x, previewY, pieceAngle);
      updateRadiance(x, previewY, now);
    },

    hide() {
      if (ghost !== null) ghost.enabled = false;
      if (radiance !== null) radiance.enabled = false;
      indicatorLight.intensity = 0;
    },
  };
}

function mixChannel(from: number, to: number, shift: number, amount: number): number {
  const a = (from >>> shift) & 0xff;
  const b = (to >>> shift) & 0xff;
  return Math.round(a + (b - a) * amount) << shift;
}

function mixRgba(from: number, to: number, amount: number): number {
  return (
    (mixChannel(from, to, 24, amount) |
      mixChannel(from, to, 16, amount) |
      mixChannel(from, to, 8, amount) |
      (from & 0xff)) >>>
    0
  );
}
