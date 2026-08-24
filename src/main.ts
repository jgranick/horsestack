import type {
  Material,
  StandardPbrMaterial,
  RenderEffect,
  VertexAttributeLayout,
  Camera3D,
  ImportDiagnostic,
  Mesh,
  MeshGeometry,
  Node3D,
  ParticleEmitter3D,
  ParticleEmitterConfig,
  ParticleEmitterState,
  Physics2DWorld,
  PointLight,
  RigidBody2D,
  Scene3D,
  Scene3DLightsLike,
} from '@flighthq/sdk';
import {
  addNodeChild,
  addNodeChildAt,
  beginGlRenderPass,
  beginGlRenderEffectPipeline,
  clamp,
  clearParticleEmitter3D,
  cloneMeshGeometry,
  cloneMaterial,
  cloneMesh,
  cloneNode3DSubtree,
  compactMeshGeometryVertices,
  configureDirectionalShadowCamera3DTightFit,
  createAabb,
  createAmbientLight,
  createCamera3D,
  createDirectionalLight,
  createGlCanvasElement,
  createGlRenderEffectPipeline,
  createBlurEffect,
  createGlRenderState,
  createVignetteEffect,
  createMesh,
  createNode3D,
  createOrbitCameraController,
  createOrthographicProjection,
  createParticleEmitter3D,
  buildParticleCurve,
  createParticleEmitterConfig,
  createParticleEmitterState,
  createPerspectiveProjection,
  createPointLight,
  createRingMeshGeometry,
  createStandardPbrMaterial,
  createVector3,
  registerGlVertexColorMaterial,
  srgbChannelToLinear,
  setMeshGeometryVertexColor0,
  getMeshGeometryVertexPosition,
  getMeshGeometryVertexCount,
  createVertexColorMaterial,
  createSphereMeshGeometry,
  convertMeshGeometryLayout,
  easeOutCubic,
  emitParticleBurst3D,
  endGlRenderPass,
  enableFlightDiagnostics,
  endGlRenderEffectPipeline,
  findNodeByName,
  getCamera3DWorldToScreen,
  getMaterialOfKind,
  getNodeParent,
  getNodeLocalMatrix4,
  invalidateNodeLocalTransform,
  isMesh,
  isNodeLocalMatrix4Detached,
  Node3DKind,
  StandardPbrMaterialKind,
  normalizeVector3,
  registerGlBlurEffect,
  registerGlStandardPbrMaterial,
  registerGlVignetteEffect,
  registerStandardGlTextureResolvers,
  refreshMeshGeometryBounds,
  removeNodeChild,
  removeNodeChildren,
  removePhysics2DBody,
  renderGlBackground,
  setNode3DAlpha,
  setMeshGeometrySubsets,
  setNodeLocalMatrix4,
  setNodeTransform3D,
  setQuaternionFromEuler,
  stepParticleEmitter3D,
  updateOrbitCameraController,
} from '@flighthq/sdk';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { drawGlScene3D, drawGlScene3DShadowMap } from '@flighthq/sdk/rendering';
import { createGameUi2D } from './ui/gameUi';
import type { UiScreen } from './ui/gameUi';
import {
  FARM_PROP_SCENE_SCALE,
  FARM_PROP_VARIANTS,
  getRandomFarmPropVariantIndex,
  selectFarmPropTriangleIndices,
} from './data/farmPropGeometry';
import type { FarmPropPartSpec, FarmPropTriangleFilter } from './data/farmPropGeometry';
import {
  addStackObjectBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextObjectDelay,
  getRandomStackObjectKind,
  getStackBodyHalfWidth,
  getStackBodySupportExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectVerticalExtent,
  getSupportedStackHeight,
  HORSE_HALF_HEIGHT,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  STACK_OBJECT_PROFILES,
  stepHorseStack,
} from './physics/horseStackPhysics';
import type { StackObjectKind } from './physics/horseStackPhysics';
import {
  CAMERA_HEIGHT_COLLAPSE_RATE,
  CAMERA_HEIGHT_DEADBAND,
  CAMERA_HEIGHT_FALL_RATE,
  CAMERA_HEIGHT_RISE_RATE,
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  CAMERA_PILE_FILL,
  CAMERA_PILE_FILL_AT_HEIGHT,
  CAMERA_TOP_BIAS,
  FIXED_STEP_LIMIT,
  GAME_DURATION_MS,
  HORSE_SCALE,
  HORSE_VISUAL_CENTER_Y,
  INDICATOR_DAMPING,
  INDICATOR_MAX_ANGLE,
  INDICATOR_MAX_SPIN,
  INDICATOR_SPRING,
  LANDING_PREVIEW_LIFT,
  MAX_RESULT_COUNT_DURATION_MS,
  MIN_RESULT_COUNT_DURATION_MS,
  STACK_BASE_Y,
  STACK_X,
  STACK_Z,
  START_INPUT_GUARD_MS,
  WINDMILL_RADIANS_PER_SECOND,
} from './game/gameConfig';
import { createAudioManager } from './audio/audioManager';
import { prefersReducedMotion } from './reducedMotion';
import './styles.css';

type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';

interface ActiveStackObject {
  angle: number;
  kind: StackObjectKind;
  variantIndex: number;
  x: number;
}

interface StackedObject {
  body: RigidBody2D;
  kind: StackObjectKind;
  lost: boolean;
  node: Node3D;
}

// The title and score screens used to sit behind a flat black wash. The scene is the nicest
// thing on screen, so instead of hiding it the pipeline defocuses it: a real blur, plus a
// vignette to pull the eye to the middle and keep light text legible over bright grass.
// Both are Flight render effects, which is what the effect list on endGlRenderEffectPipeline
// is for — the game ran it empty until now.
const BACKDROP_BLUR_MAX = 13;
const backdropBlurEffect = createBlurEffect({ blurX: 0, blurY: 0 });
const backdropVignetteEffect = createVignetteEffect({
  color: 0x0d1622,
  intensity: 0,
  radius: 0.5,
  softness: 0.85,
});
// Just defocus, and nothing else. A colour grade behind the blur — desaturation, an
// exposure drop, a warm tint — all read as a filter laid over the game rather than as depth
// of field, so the scene keeps its own colour and the vignette alone does the separating.
// It buys the type less contrast than a grade would; the scene staying itself is worth it.
const NO_EFFECTS: readonly RenderEffect[] = [];
// Rebuilt only while the ramp is moving: brightness/contrast bake their matrix at
// construction, so a mutated field would not take.
let backdropEffects: RenderEffect[] = [];
let backdropEffectsAt = -1;

function getBackdropEffects(focus: number): readonly RenderEffect[] {
  const quantized = Math.round(focus * 60);
  if (quantized === backdropEffectsAt) return backdropEffects;
  backdropEffectsAt = quantized;
  const amount = quantized / 60;
  backdropBlurEffect.blurX = BACKDROP_BLUR_MAX * amount;
  backdropBlurEffect.blurY = BACKDROP_BLUR_MAX * amount;
  backdropVignetteEffect.intensity = 0.7 * amount;
  backdropEffects = [backdropBlurEffect, backdropVignetteEffect];
  return backdropEffects;
}

let backdropFocus = 0;
const GAME_VIEW = {
  azimuth: Math.PI / 2,
  distance: 0.82,
  maxDistance: 7.8,
  minDistance: 0.68,
  minPolar: 0.02,
  polar: 0.08,
  smoothTime: 0.2,
  target: createVector3(STACK_X, 0.1, STACK_Z),
} as const;

const viewer = requireElement<HTMLDivElement>('viewer');
const loadingPanel = requireElement<HTMLDivElement>('loading-panel');
const loadingCopy = requireElement<HTMLParagraphElement>('loading-copy');
const errorPanel = requireElement<HTMLDivElement>('error-panel');
const retryButton = requireElement<HTMLButtonElement>('retry-button');
const statusCopy = requireElement<HTMLSpanElement>('status-copy');
// Keep these paths indirect so Vite leaves the runtime module-relative URLs untouched
// without warning. Both directories are served straight out of public/.
const modelPathFromModule = '../models/';
const modelRoot = new URL(modelPathFromModule, import.meta.url).href.replace(/\/$/, '');
const soundPathFromModule = '../sounds/';
const soundRoot = new URL(soundPathFromModule, import.meta.url).href;
const audio = createAudioManager(soundRoot);

retryButton.addEventListener('click', () => window.location.reload());
const { canvas, pipeline, renderState } = initializeRenderer();
const gameUi = createGameUi2D(renderState, renderState.pixelRatio);
let creditsOpen = false;
// Where the pointer is and whether it is held, so 2D controls can light up and press in.
let pointerX = -1;
let pointerY = -1;
let pointerDown = false;

const scene = createNode3D(Node3DKind);
// The sky, in Flight rather than in CSS. It used to be a linear-gradient on the viewer
// showing through a transparent canvas, which meant the game's own background lived
// outside the renderer and could not travel with it. It is now a vertex-coloured dome
// inside the scene: an inverted sphere big enough to sit outside the farm and inside the
// camera's far plane, lit by nothing (createVertexColorMaterial is unlit), with the
// gradient written into color0 by height. The forward pass renders with culling off, so
// looking at the sphere from inside shows its back faces normally.
//
// The canonical mesh layout has no color0, so the geometry is converted to one that does.
const SKY_RADIUS = 40;
const SKY_LAYOUT = {
  attributes: [
    { byteOffset: 0, format: 'float32x3', semantic: 'position' },
    { byteOffset: 12, format: 'float32x3', semantic: 'normal' },
    { byteOffset: 24, format: 'float32x4', semantic: 'tangent' },
    { byteOffset: 40, format: 'float32x2', semantic: 'uv0' },
    { byteOffset: 48, format: 'float32x4', semantic: 'color0' },
  ],
  stride: 64,
} as const satisfies VertexAttributeLayout;
// A deeper blue overhead easing to a pale, almost warm horizon. The stylesheet's original
// stops are still in here in the middle, but the ramp now RESOLVES over the band the camera
// actually sees: mapping it pole to pole spent almost all of it below the island, and the
// visible sliver above the horizon came out as one flat blue.
const SKY_STOPS = [
  { at: 0, color: [0x2b8ce0] },
  { at: 0.42, color: [0x49a6ea] },
  { at: 0.74, color: [0x74c1f1] },
  { at: 1, color: [0xa6dbf8] },
] as const;

function sampleSkyGradient(t: number): readonly [number, number, number] {
  for (let index = 1; index < SKY_STOPS.length; index += 1) {
    const previous = SKY_STOPS[index - 1];
    const next = SKY_STOPS[index];
    if (previous === undefined || next === undefined || t > next.at) continue;
    const span = next.at - previous.at;
    const mix = span > 0 ? (t - previous.at) / span : 0;
    const from = previous.color[0];
    const to = next.color[0];
    return [16, 8, 0].map((shift) => {
      const a = (from >>> shift) & 0xff;
      const b = (to >>> shift) & 0xff;
      // The stops are sRGB; the scene composites linear, so decode rather than lerp bytes.
      return srgbChannelToLinear((a + (b - a) * mix) / 255);
    }) as unknown as readonly [number, number, number];
  }
  return [1, 1, 1];
}

function createSkyDome(): Mesh {
  const geometry = convertMeshGeometryLayout(
    createSphereMeshGeometry(SKY_RADIUS, 32, 20),
    SKY_LAYOUT,
  );
  const position = { x: 0, y: 0, z: 0 };
  const vertexCount = getMeshGeometryVertexCount(geometry);
  for (let index = 0; index < vertexCount; index += 1) {
    getMeshGeometryVertexPosition(position, geometry, index);
    // The stylesheet ran its gradient top to bottom, so t is 0 at the zenith.
    // Zenith at 0, horizon at 1: the whole ramp lands in the band above the island, and
    // everything below the horizon — which the island covers — holds the last stop.
    const height = position.y / SKY_RADIUS;
    const [r, g, b] = sampleSkyGradient(clamp(1 - height * 1.35, 0, 1));
    setMeshGeometryVertexColor0(geometry, index, r, g, b, 1);
  }
  // Double-sided because the camera lives INSIDE this sphere: the forward pass culls back
  // faces, and every face of a dome seen from within is a back face. Without this the mesh
  // is present, correct and completely invisible — which is what it was, and why the blur
  // was fringing every silhouette with the transparent background behind it.
  const dome = createMesh(geometry, [
    createVertexColorMaterial({ doubleSided: true, tint: 0xffffffff }),
  ]);
  dome.name = 'sky';
  return dome;
}

const skyDome = createSkyDome();
addNodeChild(scene, skyDome);
const stackLayer = createNode3D(Node3DKind, { name: 'horse-stack' });
addNodeChild(scene, stackLayer);
// The hovering preview and its halo ring share one parent so a single detach keeps both
// out of the shadow pass. They must LEAVE the graph to be excluded: drawGlScene3DShadowMap
// walks every descendant carrying geometry and never consults `enabled`, `visible`, or the
// material's alpha mode, so hiding a node does not stop it casting. That is why the halo
// used to lay a ring of shadow across the pasture despite being switched off for the pass.
const previewLayer = createNode3D(Node3DKind, { name: 'landing-preview-layer' });
const landingGhostMaterial = createStandardPbrMaterial({
  alphaMode: 'opaque',
  baseColor: 0xe2b83fff,
  doubleSided: true,
  emissive: 0x8a5a0bff,
  emissiveStrength: 0.7,
  metallic: 0.18,
  roughness: 0.38,
});
const landingHaloMaterial = createStandardPbrMaterial({
  alphaMode: 'blend',
  baseColor: 0xf5d36aff,
  doubleSided: true,
  emissive: 0xd49a22ff,
  emissiveStrength: 1.15,
  metallic: 0.1,
  roughness: 0.42,
});

const dustEmitter: ParticleEmitter3D = createParticleEmitter3D({
  blendMode: 'normal',
  data: { worldSpace: true },
  name: 'horse-impact-dust',
});
addNodeChild(scene, dustEmitter);
const celebrationEmitter: ParticleEmitter3D = createParticleEmitter3D({
  blendMode: 'normal',
  data: { worldSpace: true },
  name: 'horse-confetti',
});
addNodeChild(scene, celebrationEmitter);
const celebrationConfig: ParticleEmitterConfig = createParticleEmitterConfig({
  // Paper, not sparks. Four things separate the two, and the old burst had all four wrong:
  // confetti keeps its size (scaleEnd is a MULTIPLIER, so the old 0.02 shrank every piece
  // to nothing), holds its colour until it lands rather than dimming from the first frame,
  // tumbles fast, and falls slowly enough to hang in the air and flutter.
  alphaCurve: buildParticleCurve((t) => (t < 0.74 ? 1 : 1 - (t - 0.74) / 0.26)),
  alphaEnd: 1,
  alphaStart: 1,
  colorEndB: 1,
  colorEndG: 1,
  colorEndR: 1,
  colorStartB: 1,
  colorStartG: 1,
  colorStartR: 1,
  directionX: 0,
  directionY: 1,
  directionZ: 0,
  duration: 0,
  // Nearly a hemisphere: a party popper sprays sideways as much as up, where the old
  // narrower cone threw a fountain.
  emitterConeAngle: 2.5,
  emitterRadius: 0.22,
  emitterShape: 'cone3d',
  gravityY: -1.15,
  lifetimeMax: 4.4,
  lifetimeMin: 2.4,
  loop: false,
  maxParticles: 760,
  rotationSpeedMax: 17,
  rotationSpeedMin: -17,
  scaleEnd: 1,
  // Small and many. At 0.26 the pieces read as sheets of paper rather than confetti,
  // especially early on when the camera is still close to the pile.
  scaleMax: 0.135,
  scaleMin: 0.05,
  spawnRate: 0,
  speedMax: 3.4,
  speedMin: 1.5,
  worldSpace: true,
});

const dustConfig: ParticleEmitterConfig = createParticleEmitterConfig({
  alphaEnd: 0,
  alphaStart: 0.42,
  colorEndB: 0.58,
  colorEndG: 0.69,
  colorEndR: 0.76,
  colorStartB: 0.72,
  colorStartG: 0.8,
  colorStartR: 0.86,
  directionX: 0,
  directionY: 1,
  directionZ: 0,
  duration: 0,
  emitterConeAngle: 1.35,
  emitterRadius: 0.012,
  emitterShape: 'cone3d',
  gravityY: -0.5,
  lifetimeMax: 0.42,
  lifetimeMin: 0.18,
  loop: false,
  maxParticles: 96,
  rotationSpeedMax: 2,
  rotationSpeedMin: -2,
  scaleEnd: 0.002,
  scaleMax: 0.036,
  scaleMin: 0.008,
  spawnRate: 0,
  speedMax: 0.35,
  speedMin: 0.08,
  worldSpace: true,
});

let celebrationState: ParticleEmitterState = createParticleEmitterState();
let dustState: ParticleEmitterState = createParticleEmitterState();

const camera: Camera3D = createCamera3D({
  far: 90,
  near: 0.1,
  projection: createPerspectiveProjection({ aspect: 1, fovY: Math.PI / 5.4 }),
});
const cameraController = createOrbitCameraController(GAME_VIEW);

const sunDirection = createVector3(-0.75, -1, -0.5);
normalizeVector3(sunDirection, sunDirection);
const directionalLight = createDirectionalLight({
  castsShadow: true,
  color: 0xfff1d4ff,
  direction: sunDirection,
  intensity: 2.8,
  normalBias: 0.65,
  pcfRadius: 1,
  shadowBias: 0.001,
});
const indicatorLight: PointLight = createPointLight({
  color: 0xffd56aff,
  intensity: 0,
  position: createVector3(STACK_X + 0.16, 0.2, STACK_Z),
  range: 0.68,
});
const lights: Scene3DLightsLike = {
  ambient: createAmbientLight({ color: 0xbdd0b5ff, intensity: 0.72 }),
  directional: directionalLight,
  point: [indicatorLight],
};
const shadowCamera = createCamera3D({
  far: 55,
  near: 0.1,
  projection: createOrthographicProjection({ halfHeight: 15, halfWidth: 9 }),
});
// Flight's directional shadow map is a fixed 1024x1024 (DIRECTIONAL_SHADOW_MAP_SIZE),
// so sharpness is entirely a question of how much world those texels cover. The farm's
// own world bounds are only about 3.7 x 3.7 x 3.6, and the pile lives inside them, so
// the shadow volume is that plus a margin — not the far larger box a whole-level scene
// would need. Underside geometry below y=-0.7 is excluded: it casts nothing visible.
// Tight-fit rather than the bounding-sphere fit, because it fits the light-space X and Y
// extents independently and keeps noticeably more texel density. These are static bounds
// fitted once, so there is no per-frame refit to shimmer.
configureDirectionalShadowCamera3DTightFit(
  shadowCamera,
  sunDirection,
  createAabb(-1.95, -0.7, -4.05, 1.95, 2.25, -0.35),
  1.05,
);

let phase: GamePhase = 'loading';
// Placement input is refused until this moment, measured on the INPUT clock
// (Event.timeStamp) rather than the render clock: startGame() has to build a physics
// world and clone a model, and on a slow first frame that work alone can outlast the
// guard. Comparing input to input keeps the window honest whatever the frame costs.
let placementArmedAt = 0;
let cameraStackHeight = 0;
let swayClock = 0;
let horseTemplate: Scene3D | null = null;
const farmPropTemplates: Partial<Record<StackObjectKind, Node3D[]>> = {};
// The farm's sail assembly, spun in place each frame. Null until the farm mounts.
let windmillSails: Node3D | null = null;
// Centre of the sail disc in the mesh's own space, on the Y/Z axes it turns within.
let windmillHubY = 0;
let windmillHubZ = 0;
let windmillAngle = 0;
let landingGhost: Node3D | null = null;
let landingRadiance: Node3D | null = null;
let physicsWorld: Physics2DWorld = createHorseStackWorld();
let activeObject: ActiveStackObject | null = null;
let stackedObjects: StackedObject[] = [];
let objectsDropped = 0;
let aimOffset = 0;
let indicatorAngle = 0;
let indicatorAngularVelocity = 0;
let indicatorUpdatedAt = performance.now();
let lastAimAt = performance.now();
let nextObjectAt = 0;
let gameEndsAt = 0;
let finishAt = 0;
let finalHeight = 0;
let cachedStackHeight = 0;
// Top of the hovering drop preview, in physics Y. Only the dev framing probe reads it.
let previewTopY = 0;
let resultAnimationStart = 0;
let resultAnimationDuration = 0;
let resultHands = 0;
let resultHandsShown = 0;
let physicsAccumulator = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
let lastImpactAt = 0;
const measurementBodies: RigidBody2D[] = [];
const inputBounds = { left: 0, width: 1 };

bindGameControls();
bindRenderingLifecycle();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

async function start(): Promise<void> {
  setLoadingState('Rounding up the farm…');

  try {
    const [farm, horse] = await Promise.all([
      loadGltfScene(`${modelRoot}/farm`),
      loadGltfScene(`${modelRoot}/horse`),
    ]);

    extractFarmPropTemplates(farm);
    bindWindmillSails(farm);
    mountFarm(farm);
    horseTemplate = horse;
    phase = 'ready';
    updateCamera(1, cachedStackHeight);
    renderFrame();
    loadingPanel.classList.add('is-hidden');
    statusCopy.textContent = 'Stable enough';
  } catch (error) {
    showSceneError('Unable to load Horse Stacker.', error);
  }
}

// The farm is flattened by material, and the sails are their own layer: Object_6 holds
// the whole rotor, Object_18 the tower it sits on. In the source's Z-up space the rotor's
// Y and Z extents match (a disc), and X is the shaft it turns about — so it spins around
// mesh-space X, centred on the disc's Y/Z midpoint. Rotating about a point off the node
// origin needs no reparenting: for a rotation R about an axis through `hub`, the plain
// TRS position that reproduces it is hub - R*hub, and the shaft-axis component cancels.
function bindWindmillSails(farm: Readonly<Scene3D>): void {
  const sails = findNodeByName(farm.root, 'Object_6');
  if (sails === null || !isMesh(sails)) {
    throw new Error('Windmill sail mesh Object_6 was not imported');
  }
  const materialName = sails.materials[0]?.name;
  if (materialName !== 'Windmill2') {
    throw new Error(
      `Windmill sail mesh Object_6 uses ${materialName ?? 'no material'}, expected Windmill2`,
    );
  }
  refreshMeshGeometryBounds(sails.geometry);
  const bounds = sails.geometry.bounds;
  if (bounds === null) throw new Error('Windmill sail mesh has no bounds');
  windmillHubY = (bounds.min.y + bounds.max.y) / 2;
  windmillHubZ = (bounds.min.z + bounds.max.z) / 2;
  windmillSails = sails;
  windmillAngle = 0;
  updateWindmill(0);
}

function updateWindmill(deltaTime: number): boolean {
  const sails = windmillSails;
  if (sails === null || prefersReducedMotion()) return false;
  windmillAngle = (windmillAngle + WINDMILL_RADIANS_PER_SECOND * deltaTime) % (Math.PI * 2);
  const sin = Math.sin(windmillAngle);
  const cos = Math.cos(windmillAngle);
  setQuaternionFromEuler(sails.rotation, windmillAngle, 0, 0);
  sails.position.y = windmillHubY - (windmillHubY * cos - windmillHubZ * sin);
  sails.position.z = windmillHubZ - (windmillHubY * sin + windmillHubZ * cos);
  invalidateNodeLocalTransform(sails);
  return true;
}

function mountFarm(model: Scene3D): void {
  const wrapper = createNode3D(Node3DKind);
  const scale = FARM_PROP_SCENE_SCALE;
  wrapper.scale.x = scale;
  wrapper.scale.y = scale;
  wrapper.scale.z = scale;
  wrapper.position.x = 0.5;
  wrapper.position.y = -0.043;
  wrapper.position.z = -2.2;
  invalidateNodeLocalTransform(wrapper);
  addNodeChild(wrapper, model.root);
  addNodeChild(scene, wrapper);
}

function createStackObjectVisual(
  kind: StackObjectKind,
  variantIndex = 0,
  materialOverride: ReturnType<typeof createStandardPbrMaterial> | null = null,
  alpha = 1,
): Node3D {
  const pivot = createNode3D(Node3DKind);
  pivot.alpha = alpha;
  if (kind !== 'horse') {
    const templates = farmPropTemplates[kind];
    const template = templates?.[variantIndex] ?? templates?.[0];
    if (template === undefined) throw new Error(`${STACK_OBJECT_PROFILES[kind].label} is not loaded`);
    addNodeChild(pivot, cloneNode3DSubtree(template, materialOverride === null ? null : toPreviewMaterial));
    return pivot;
  }

  if (horseTemplate === null) throw new Error('Horse model is not loaded');
  const modelTransform = createNode3D(Node3DKind);
  modelTransform.scale.x = HORSE_SCALE;
  modelTransform.scale.y = HORSE_SCALE;
  modelTransform.scale.z = HORSE_SCALE;
  modelTransform.position.y = -HORSE_VISUAL_CENTER_Y;
  setQuaternionFromEuler(modelTransform.rotation, 0, 0, 0);
  invalidateNodeLocalTransform(modelTransform);
  addNodeChild(
    modelTransform,
    cloneNode3DSubtree(horseTemplate.root, materialOverride === null ? null : toPreviewMaterial),
  );
  addNodeChild(pivot, modelTransform);
  return pivot;
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
// Derived materials are cached per source material: a clone is built for every preview, and
// the same handful of source materials come round again every time.
const previewMaterials = new WeakMap<Material, Material>();

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

// The preview's version of one of an object's own materials: its colour pulled halfway to
// the marker gold, lit by the marker's emissive at the same fraction.
function toPreviewMaterial(source: Material | null): Material | null {
  if (source === null) return landingGhostMaterial;
  const cached = previewMaterials.get(source);
  if (cached !== undefined) return cached;
  const pbr = getMaterialOfKind<StandardPbrMaterial>(source, StandardPbrMaterialKind);
  if (pbr === null) {
    previewMaterials.set(source, landingGhostMaterial);
    return landingGhostMaterial;
  }
  const blended = cloneMaterial(pbr) as StandardPbrMaterial;
  blended.baseColor = mixRgba(pbr.baseColor, landingGhostMaterial.baseColor, PREVIEW_TINT_MIX);
  // Mixed FROM the source's own emissive, not simply taken from the marker: most of these
  // materials emit nothing, and handing them the marker's glow outright blew pale ones —
  // a white Holstein especially — out to a featureless white, which is the very thing the
  // blend exists to avoid.
  blended.emissive = mixRgba(pbr.emissive, landingGhostMaterial.emissive, PREVIEW_GLOW_MIX);
  blended.emissiveStrength =
    pbr.emissiveStrength +
    (landingGhostMaterial.emissiveStrength - pbr.emissiveStrength) * PREVIEW_GLOW_MIX;
  blended.metallic = pbr.metallic + (landingGhostMaterial.metallic - pbr.metallic) * PREVIEW_TINT_MIX;
  blended.roughness = pbr.roughness + (landingGhostMaterial.roughness - pbr.roughness) * PREVIEW_TINT_MIX;
  // The preview is a lone floating object, so its back faces would otherwise show through.
  blended.doubleSided = true;
  previewMaterials.set(source, blended);
  return blended;
}

function setLandingGhostKind(kind: StackObjectKind, variantIndex: number): void {
  const ghost = landingGhost;
  if (ghost === null) return;
  removeNodeChildren(ghost);
  addNodeChild(ghost, createStackObjectVisual(kind, variantIndex, landingGhostMaterial));
  ghost.name = `${kind}-landing-preview`;
}

function extractFarmPropTemplates(farm: Readonly<Scene3D>): void {
  for (const kind of ['hay', 'cow', 'chickens'] as const) {
    const templates: Node3D[] = [];
    for (let variantIndex = 0; variantIndex < FARM_PROP_VARIANTS[kind].length; variantIndex += 1) {
      const spec = FARM_PROP_VARIANTS[kind][variantIndex];
      if (spec === undefined) continue;
      const template = createNode3D(Node3DKind, { name: `${kind}-${variantIndex}-template` });
      const scaleRoot = createNode3D(Node3DKind);
      const scale = FARM_PROP_SCENE_SCALE * (spec.scaleMultiplier ?? 1);
      scaleRoot.scale.x = scale;
      scaleRoot.scale.y = scale;
      scaleRoot.scale.z = scale;
      invalidateNodeLocalTransform(scaleRoot);

      const axisRoot = createNode3D(Node3DKind);
      setNodeTransform3D(axisRoot, farm.root);
      if (isNodeLocalMatrix4Detached(farm.root)) {
        setNodeLocalMatrix4(axisRoot, getNodeLocalMatrix4(farm.root));
      }

      const centeredSource = createNode3D(Node3DKind);
      centeredSource.position.x = -spec.centerX;
      centeredSource.position.y = -spec.centerY;
      centeredSource.position.z = -spec.centerZ;
      invalidateNodeLocalTransform(centeredSource);
      for (const part of spec.parts) {
        const source = findNodeByName(farm.root, part.nodeName);
        if (source === null || !isMesh(source)) {
          throw new Error(`Farm prop mesh ${part.nodeName} was not imported`);
        }
        const materialName = source.materials[0]?.name;
        if (materialName !== part.materialName) {
          throw new Error(
            `Farm prop mesh ${part.nodeName} uses ${materialName ?? 'no material'}, expected ${part.materialName}`,
          );
        }
        addNodeChild(centeredSource, cloneFarmPropPart(source, part));
      }
      const orientationRoot = createNode3D(Node3DKind);
      setQuaternionFromEuler(orientationRoot.rotation, 0, 0, spec.rotationZ ?? 0);
      invalidateNodeLocalTransform(orientationRoot);
      addNodeChild(orientationRoot, centeredSource);
      addNodeChild(axisRoot, orientationRoot);
      addNodeChild(scaleRoot, axisRoot);
      addNodeChild(template, scaleRoot);
      templates.push(template);
    }
    farmPropTemplates[kind] = templates;
  }
}

function cloneFarmPropPart(source: Readonly<Mesh>, part: Readonly<FarmPropPartSpec>): Mesh {
  const clone = cloneMesh(source);
  if (part.filter !== undefined) {
    clone.geometry = filterFarmPropGeometry(source.geometry, part.filter, part.nodeName);
  }
  return clone;
}

function filterFarmPropGeometry(
  source: Readonly<MeshGeometry>,
  filter: Readonly<FarmPropTriangleFilter>,
  nodeName: string,
): MeshGeometry {
  if (source.topology !== 'triangle-list' || source.indices === null) {
    throw new Error(`Farm prop mesh ${nodeName} is not an indexed triangle list`);
  }

  const selectedIndices = selectFarmPropTriangleIndices(source, filter);

  if (selectedIndices.length === 0) {
    throw new Error(`Farm prop mesh ${nodeName} produced no selected triangles`);
  }

  const filtered = cloneMeshGeometry(source);
  filtered.indices =
    source.indices instanceof Uint32Array
      ? new Uint32Array(selectedIndices)
      : new Uint16Array(selectedIndices);
  setMeshGeometrySubsets(filtered, [{ indexCount: selectedIndices.length, indexOffset: 0 }]);
  const compact = compactMeshGeometryVertices(filtered);
  refreshMeshGeometryBounds(compact);
  return compact;
}

function createLandingRadiance(): Node3D {
  const root = createNode3D(Node3DKind, { name: 'landing-radiance' });
  const halo = createMesh(createRingMeshGeometry(0.105, 0.132, 28), [landingHaloMaterial]);
  halo.alpha = 0.24;
  halo.position.x = 0.012;
  setQuaternionFromEuler(halo.rotation, 0, 0, Math.PI / 2);
  invalidateNodeLocalTransform(halo);
  addNodeChild(root, halo);
  return root;
}

async function loadGltfScene(basePath: string): Promise<Scene3D> {
  const [documentResponse, bufferResponse] = await Promise.all([
    fetch(`${basePath}/scene.gltf`),
    fetch(`${basePath}/scene.bin`),
  ]);

  if (!documentResponse.ok || !bufferResponse.ok) {
    throw new Error(`Model download failed for ${basePath}`);
  }

  const diagnostics: ImportDiagnostic[] = [];
  const document = await documentResponse.text();
  const buffer = new Uint8Array(await bufferResponse.arrayBuffer());
  const imported = createScene3DFromGltf(document, diagnostics, {
    basePath: `${basePath}/`,
    externalBuffers: { 'scene.bin': buffer },
  });

  if (diagnostics.length > 0) {
    console.info(`Flight imported ${basePath} with diagnostics:`, diagnostics);
  }
  return imported;
}

function startGame(startedFrom?: Event): void {
  if (horseTemplate === null || phase === 'loading') return;

  const now = performance.now();
  // The credits only exist on the score screen now, so a panel left open there must not
  // still be open when the next score screen arrives.
  creditsOpen = false;
  audio.startRound(now);
  physicsWorld = createHorseStackWorld();
  physicsAccumulator = 0;
  activeObject = null;
  stackedObjects = [];
  objectsDropped = 0;
  aimOffset = 0;
  indicatorAngle = 0;
  indicatorAngularVelocity = 0;
  indicatorUpdatedAt = now;
  lastAimAt = now;
  nextObjectAt = 0;
  gameEndsAt = now + GAME_DURATION_MS;
  finishAt = 0;
  finalHeight = 0;
  cachedStackHeight = 0;
  resultAnimationStart = 0;
  resultAnimationDuration = 0;
  resultHands = 0;
  resultHandsShown = 0;
  beatTheRecord = false;
  recordBeforeRound = null;
  lastImpactAt = 0;
  removeNodeChildren(stackLayer);
  removeNodeChildren(previewLayer);
  addNodeChild(stackLayer, previewLayer);
  landingGhost = createNode3D(Node3DKind, { name: 'landing-preview' });
  // A solid silhouette keeps the small chicken readable and prevents the
  // horse's back-facing surfaces from showing through the preview. The halo,
  // beam, emissive material, and point light retain the golden placement cue.
  landingGhost.alpha = 1;
  landingGhost.name = 'landing-preview';
  addNodeChild(previewLayer, landingGhost);
  landingRadiance = createLandingRadiance();
  addNodeChild(previewLayer, landingRadiance);
  indicatorLight.intensity = 0;
  clearParticleEmitter3D(dustEmitter);
  clearParticleEmitter3D(celebrationEmitter);
  dustState = createParticleEmitterState();
  celebrationState = createParticleEmitterState();

  phase = 'playing';
  cameraStackHeight = 0;
  placementArmedAt = (startedFrom?.timeStamp ?? now) + START_INPUT_GUARD_MS;
  spawnObject(now);
  renderRequested = true;
}

function spawnObject(now: number): void {
  if (phase !== 'playing' || now >= gameEndsAt) return;

  indicatorAngle = 0;
  indicatorAngularVelocity = 0;
  indicatorUpdatedAt = now;
  lastAimAt = now;
  const kind = getRandomStackObjectKind();
  const variantIndex = kind === 'horse' ? 0 : getRandomFarmPropVariantIndex(kind);
  activeObject = {
    angle: 0,
    kind,
    variantIndex,
    x: 0,
  };
  setLandingGhostKind(kind, variantIndex);
  if (landingGhost !== null) landingGhost.enabled = true;
  if (landingRadiance !== null) landingRadiance.enabled = true;
  // Announced to screen readers only. The label alone: an emoji here is read aloud as its
  // own name before the word it duplicates.
  statusCopy.textContent = getStackObjectVisualLabel(kind, variantIndex);
  updateActiveStackObject(now);
}

function updateActiveStackObject(now: number): void {
  const current = activeObject;
  if (current === null) return;

  updateIndicatorTeeter(now);
  const horizontalLimit = getAimHalfWidth();
  current.x = clamp(aimOffset, -horizontalLimit, horizontalLimit);
  current.angle = indicatorAngle;
  updateLandingGhost(current, now);
}

function commitObjectPlacement(now: number): void {
  const current = activeObject;
  if (current === null || phase !== 'playing') return;

  const landingY =
    getLandingSurfaceY(current.x, current.kind) +
    getStackObjectVerticalExtent(current.kind, current.angle);
  const body = addStackObjectBody(
    physicsWorld,
    current.kind,
    current.x,
    landingY,
    current.angle,
  );
  body.velocityX = 0;
  body.velocityY = 0;
  body.angularVelocity = 0;
  const node = createStackObjectVisual(current.kind, current.variantIndex);
  setStackObjectVisualTransform(node, current.x, landingY, current.angle);
  addNodeChild(stackLayer, node);
  stackedObjects.push({ body, kind: current.kind, lost: false, node });
  activeObject = null;
  // The prompt has served its purpose once the player has placed something.
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingRadiance !== null) landingRadiance.enabled = false;
  indicatorLight.intensity = 0;
  objectsDropped++;
  audio.playStackThud();

  nextObjectAt = now + getNextObjectDelay(objectsDropped);
  renderRequested = true;
}

function getStackObjectVisualLabel(kind: StackObjectKind, variantIndex: number): string {
  if (kind === 'horse') return STACK_OBJECT_PROFILES.horse.label;
  return FARM_PROP_VARIANTS[kind][variantIndex]?.label ?? STACK_OBJECT_PROFILES[kind].label;
}

function updateGame(now: number): void {
  if (phase === 'playing') {
    if (now >= gameEndsAt) {
      beginSettling(now);
      return;
    }
    if (activeObject !== null) {
      updateActiveStackObject(now);
    } else if (now >= nextObjectAt) {
      spawnObject(now);
    }
  } else if (phase === 'settling' && now >= finishAt) {
    finishGame(now);
  }
}

function beginSettling(now: number): void {
  phase = 'settling';
  audio.beginResultCount();
  activeObject = null;
  finishAt = now + FINAL_SETTLE_SECONDS * 1000;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingRadiance !== null) landingRadiance.enabled = false;
  indicatorLight.intensity = 0;
  renderRequested = true;
}

function finishGame(now: number): void {
  phase = 'finished';
  finalHeight = getCurrentStackHeight();
  cachedStackHeight = finalHeight;
  recordFinalHeight(getStackHeightMeters(finalHeight));
  resultHands = getStackHeightHands(finalHeight);
  resultHandsShown = 0;
  audio.armResultTicks(now);
  resultAnimationStart = now;
  resultAnimationDuration = prefersReducedMotion()
    ? 1
    : clamp(
        1_800 + resultHands * 14,
        MIN_RESULT_COUNT_DURATION_MS,
        MAX_RESULT_COUNT_DURATION_MS,
      );
  indicatorLight.intensity = 0;
  renderRequested = true;
}

function updateResultAnimation(now: number): void {
  if (resultAnimationStart === 0) return;
  const progress = clamp((now - resultAnimationStart) / resultAnimationDuration, 0, 1);
  const easedProgress = easeOutCubic(progress);
  const handsToShow = Math.min(resultHands, Math.floor(resultHands * easedProgress));
  if (advanceHorseHands(handsToShow)) audio.playResultTick(now);

  if (progress >= 1) completeResultAnimation();
}

// The tally itself is drawn by the 2D layer straight from resultHandsShown; this only
// advances the count and reports whether it moved, which is what drives the tick sound.
function advanceHorseHands(targetCount: number): boolean {
  const previousCount = resultHandsShown;
  resultHandsShown = Math.max(resultHandsShown, Math.min(targetCount, resultHands));
  return resultHandsShown > previousCount;
}

function completeResultAnimation(): void {
  resultAnimationStart = 0;
  audio.celebrateResult();
  advanceHorseHands(resultHands);

  celebrateFinalHeight();
}

// The best height ever reached on this machine, in metres, or null before a first round
// has ever been finished here. Kept in localStorage so it survives a reload, and read
// through try/catch because storage throws outright in some private-browsing modes.
const BEST_HEIGHT_KEY = 'horse-stacker.best-height';
let bestMeters: number | null = readBestMeters();
// The record as it stood when the round began, which is what the result screen reports.
// Reading bestMeters there would be wrong: by then this round has already been folded in,
// so a first ever round would echo its own height back at the player as "BEST".
let recordBeforeRound: number | null = null;
let beatTheRecord = false;

function readBestMeters(): number | null {
  try {
    const stored = window.localStorage.getItem(BEST_HEIGHT_KEY);
    if (stored === null) return null;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// Compares against the previous best, then adopts the new one. The margin is a whole
// centimetre because the result screen shows two decimals: a win by less than that would
// raise a NEW RECORD! badge over a number identical to the record it supposedly beat.
// A first ever round sets the record without claiming to have broken one.
function recordFinalHeight(meters: number): void {
  const previous = bestMeters;
  recordBeforeRound = previous;
  beatTheRecord = previous !== null && meters >= previous + 0.01;
  if (previous !== null && meters <= previous) return;
  bestMeters = meters;
  try {
    window.localStorage.setItem(BEST_HEIGHT_KEY, meters.toFixed(4));
  } catch {
    // A best height that cannot be persisted still stands for the rest of the session.
  }
}

function celebrateFinalHeight(): void {
  const burstY = STACK_BASE_Y + Math.max(0.8, finalHeight);
  // One popper per colour, strung out across the pile.
  const colors = [
    0xffd166ff, 0xef8354ff, 0x7ea16bff, 0xf7ede2ff, 0x8ecae6ff, 0xe5989bff, 0xb08fd8ff,
  ];
  for (let index = 0; index < colors.length; index++) {
    const horizontalOffset = -1.8 + (index / (colors.length - 1)) * 3.6;
    emitParticleBurst3D(
      celebrationEmitter,
      celebrationState,
      celebrationConfig,
      92,
      STACK_X + (Math.random() - 0.5) * 0.16,
      burstY,
      STACK_Z - horizontalOffset,
      colors[index],
    );
  }
  renderRequested = true;
}

function stepGamePhysics(now: number, deltaTime: number): void {
  physicsAccumulator = Math.min(physicsAccumulator + deltaTime, PHYSICS_STEP * FIXED_STEP_LIMIT);
  let steps = 0;
  while (physicsAccumulator >= PHYSICS_STEP && steps < FIXED_STEP_LIMIT) {
    stepHorseStack(physicsWorld);
    physicsAccumulator -= PHYSICS_STEP;
    steps++;
    handlePhysicsContacts(now);
  }
}

function handlePhysicsContacts(now: number): void {
  if (physicsWorld.events.began.length === 0 || now - lastImpactAt < 90) return;
  const contact = physicsWorld.events.began[0];
  const point = contact?.points[0];
  if (point === undefined) return;

  lastImpactAt = now;
  emitParticleBurst3D(
    dustEmitter,
    dustState,
    dustConfig,
    8,
    STACK_X,
    STACK_BASE_Y + point.y,
    STACK_Z - point.x,
    0xe8d6a9cc,
  );
  audio.maybePlayCollisionWhinny(now);
}

function synchronizeStackVisuals(): void {
  let retainedCount = 0;
  for (const object of stackedObjects) {
    if (object.lost) continue;
    const body = object.body;

    // Leave enough void beyond the collider for the whole tumble to remain visible.
    if (body.y < -1 || Math.abs(body.x) > PASTURE_HALF_WIDTH + 1.5) {
      object.lost = true;
      object.node.enabled = false;
      removePhysics2DBody(physicsWorld, body);
      continue;
    }

    // A sway that exists only in the render transform. The physics never sees it, so it
    // costs the player nothing, but the pile is visibly never quite at rest — which is the
    // read we want from something this tall. Amplitude grows with how high the piece rides
    // and is nil at the pasture, so the base looks planted and the top looks precarious.
    const carried = clamp((body.y - PASTURE_TOP_Y) / 0.9, 0, 1);
    const sway = prefersReducedMotion() ? 0 : carried * carried;
    const phase = swayClock + body.index * 0.7;
    setStackObjectVisualTransform(
      object.node,
      body.x + Math.sin(phase) * 0.0016 * sway,
      body.y,
      body.angle + Math.sin(phase * 0.77 + 1.3) * 0.010 * sway,
    );
    stackedObjects[retainedCount++] = object;
  }
  // Fallen objects have already left the physics world and score calculation;
  // keep them out of every subsequent placement, height, and visual scan too.
  stackedObjects.length = retainedCount;
}

function updateLandingGhost(current: Readonly<ActiveStackObject>, now: number): void {
  if (landingGhost === null) return;

  const previewX = current.x;
  const landingSurfaceY = getLandingSurfaceY(previewX, current.kind);

  landingGhost.enabled = Math.abs(previewX) <= PASTURE_HALF_WIDTH;
  if (!landingGhost.enabled) {
    if (landingRadiance !== null) landingRadiance.enabled = false;
    indicatorLight.intensity = 0;
    return;
  }
  const landingY =
    landingSurfaceY + getStackObjectVerticalExtent(current.kind, current.angle);
  // The halo and its light ride up with the object so the ring surrounds whatever is
  // about to drop, rather than marking the landing pose it will fall to.
  const previewY = landingY + LANDING_PREVIEW_LIFT;
  previewTopY = previewY + getStackObjectVerticalExtent(current.kind, current.angle);
  setStackObjectVisualTransform(landingGhost, previewX, previewY, current.angle);
  updateLandingRadiance(previewX, previewY, now);
}

function updateLandingRadiance(x: number, physicsY: number, now: number): void {
  const radiance = landingRadiance;
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

function getLandingSurfaceY(x: number, kind: StackObjectKind): number {
  let surfaceY = PASTURE_TOP_Y;
  const activeHalfWidth = STACK_OBJECT_PROFILES[kind].halfWidth;

  for (const object of stackedObjects) {
    const body = object.body;
    const horizontalReach = activeHalfWidth + getStackBodyHalfWidth(body);
    if (
      object.lost ||
      body.y < PASTURE_TOP_Y ||
      Math.abs(body.x - x) > horizontalReach * 0.92 ||
      Math.abs(body.velocityY) > 1.2
    ) {
      continue;
    }
    const objectTop = body.y + getStackBodySupportExtent(body);
    surfaceY = Math.max(surfaceY, objectTop);
  }
  return surfaceY;
}

function setStackObjectVisualTransform(node: Node3D, x: number, physicsY: number, angle: number): void {
  node.position.x = STACK_X;
  node.position.y = STACK_BASE_Y + physicsY;
  node.position.z = STACK_Z - x;
  setQuaternionFromEuler(node.rotation, angle, 0, 0);
  invalidateNodeLocalTransform(node);
}

function followStackHeight(measured: number, deltaTime: number): number {
  const difference = measured - cameraStackHeight;
  if (Math.abs(difference) <= CAMERA_HEIGHT_DEADBAND) return cameraStackHeight;
  const fallRate = CAMERA_HEIGHT_FALL_RATE + Math.abs(difference) * CAMERA_HEIGHT_COLLAPSE_RATE;
  const limit = (difference > 0 ? CAMERA_HEIGHT_RISE_RATE : fallRate) * deltaTime;
  cameraStackHeight += difference > 0 ? Math.min(difference, limit) : Math.max(difference, -limit);
  return cameraStackHeight;
}

function updateCamera(deltaTime: number, measuredHeight: number): void {
  const height = followStackHeight(measuredHeight, deltaTime);
  const rise = clamp(height / 1.1, 0, 1);
  const herdProgress = clamp(objectsDropped / 50, 0, 1);
  const restingHorseTop = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 1.2;
  // Frame the whole tower, not its top. Tracking the top left the pile hanging off the
  // bottom of a frame whose upper half held nothing, and it got worse the more the pile
  // tumbled: a shorter tower simply sat lower. So the camera fits the span from the
  // pasture to the pile top into CAMERA_PILE_FILL of the frame height and centres on its
  // middle, nudged up by CAMERA_TOP_BIAS to leave the drop some room. Distance falls out
  // of the fit rather than being a curve of its own, so a collapse zooms back in.
  const tanHalfFov =
    camera.projection.kind === 'perspective' ? Math.tan(camera.projection.fovY / 2) : 1;
  const visibleHalfHeight = cameraController.distance * tanHalfFov;
  const pileBottomY = STACK_BASE_Y + PASTURE_TOP_Y;
  const pileTopY = STACK_BASE_Y + Math.max(restingHorseTop, height + HORSE_HALF_HEIGHT * 0.2);
  const pileSpan = Math.max(pileTopY - pileBottomY, 0.0001);
  const desiredTargetY =
    (pileBottomY + pileTopY) / 2 + CAMERA_TOP_BIAS * visibleHalfHeight;
  if (Math.abs(desiredTargetY - cameraController.target.y) > 0.001) renderRequested = true;
  const follow = 1 - Math.exp(-deltaTime * 2.4);
  cameraController.target.y += (desiredTargetY - cameraController.target.y) * follow;
  cameraController.target.x += (STACK_X - cameraController.target.x) * follow;
  cameraController.target.z = STACK_Z;
  cameraController.goalAzimuth = Math.PI / 2 + rise * 0.18 + herdProgress * 0.04;
  // Pitch down harder as the pile grows. A near-level camera high above a tall stack
  // frames the top and loses everything under it, which is worst exactly when the pile
  // collapses and the action moves downward. Measured over played runs, on samples with
  // a pile above 0.5 units, the base of the pile is inside the frame in 26 of 34 samples
  // at this rate against 4 of 27 at the old 0.14, and the pile top stays around a fifth
  // of the way above centre either way. At rest the tilt is unchanged.
  // Pitch down through the low and middle heights, where a level camera loses the base of
  // the pile, then ease back off once the pile is tall — otherwise the view ends up aimed
  // at the grass with the barn and silo out of frame entirely.
  cameraController.goalPolar =
    0.06 + 0.6 * Math.min(rise, 0.45) - 0.34 * Math.max(0, rise - 0.45);
  const fill = CAMERA_PILE_FILL + (CAMERA_PILE_FILL_AT_HEIGHT - CAMERA_PILE_FILL) * rise;
  cameraController.goalDistance = clamp(
    pileSpan / (2 * fill) / tanHalfFov,
    CAMERA_MIN_DISTANCE,
    CAMERA_MAX_DISTANCE,
  );
  updateOrbitCameraController(cameraController, camera, deltaTime);
}

function getCurrentStackHeight(): number {
  measurementBodies.length = 0;
  for (const object of stackedObjects) {
    if (!object.lost) measurementBodies.push(object.body);
  }
  return getSupportedStackHeight(physicsWorld, measurementBodies);
}

function updateIndicatorTeeter(now: number): void {
  const deltaTime = clamp((now - indicatorUpdatedAt) / 1000, 0, 0.05);
  indicatorUpdatedAt = now;
  if (deltaTime === 0) return;
  const acceleration =
    -indicatorAngle * INDICATOR_SPRING - indicatorAngularVelocity * INDICATOR_DAMPING;
  indicatorAngularVelocity = clamp(
    indicatorAngularVelocity + acceleration * deltaTime,
    -INDICATOR_MAX_SPIN,
    INDICATOR_MAX_SPIN,
  );
  indicatorAngle = clamp(
    indicatorAngle + indicatorAngularVelocity * deltaTime,
    -INDICATOR_MAX_ANGLE,
    INDICATOR_MAX_ANGLE,
  );
}

function bindGameControls(): void {
  // Window-level, not canvas-level: aiming and placing follow the pointer anywhere on
  // the page while a run is live. setAimFromClientX clamps against the canvas bounds, so
  // a click out in the margin simply aims at that edge.
  window.addEventListener('pointermove', (event: PointerEvent) => {
    trackPointer(event);
    renderRequested = true;
    if (phase !== 'playing' || activeObject === null) return;
    setAimFromClientX(event.clientX, performance.now());
  });
  window.addEventListener('pointerup', () => {
    pointerDown = false;
    renderRequested = true;
  });
  window.addEventListener('pointerleave', () => {
    pointerX = -1;
    pointerY = -1;
    pointerDown = false;
  });

  window.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    trackPointer(event);
    pointerDown = true;
    renderRequested = true;
    if (handleUiPress(event)) {
      event.preventDefault();
      return;
    }
    if (phase !== 'playing') return;
    // Controls and links keep their own meaning: Start over must restart, the place
    // prompt has its own handler, and a credit link must still open.
    if (isInteractiveEventTarget(event.target)) return;
    canvas.focus({ preventScroll: true });
    const now = performance.now();
    setAimFromClientX(event.clientX, now);
    placeActiveStackObject(now, event.timeStamp);
  });

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    if (phase !== 'playing') return;
    const now = performance.now();
    if (event.key === 'ArrowLeft') {
      const horizontalLimit = getAimHalfWidth();
      setAimOffset(aimOffset - 0.08, horizontalLimit, now);
    } else if (event.key === 'ArrowRight') {
      const horizontalLimit = getAimHalfWidth();
      setAimOffset(aimOffset + 0.08, horizontalLimit, now);
    } else if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowDown') {
      placeActiveStackObject(now, event.timeStamp);
    } else {
      return;
    }
    event.preventDefault();
  });

  bindFullscreenToggle();
}

function trackPointer(event: PointerEvent): void {
  const bounds = canvas.getBoundingClientRect();
  pointerX = event.clientX - bounds.left;
  pointerY = event.clientY - bounds.top;
}

function handleUiPress(event: PointerEvent): boolean {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return false;
  const screen = getUiScreen();
  for (const button of gameUi.buttons) {
    if (
      x < button.x || y < button.y ||
      x > button.x + button.width || y > button.y + button.height
    ) {
      continue;
    }
    if (button.id === 'credits') {
      creditsOpen = !creditsOpen;
      renderRequested = true;
      return true;
    }
    if (button.id === 'fullscreen') {
      toggleFullscreen();
      return true;
    }
    if (button.id === 'play' && screen === 'title') {
      startGame(event);
      return true;
    }
    if (button.id === 'again' && screen === 'result') {
      startGame(event);
      return true;
    }
  }
  return false;
}

function isInteractiveEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('a, button, input, select, textarea, summary, [role="button"]') !== null
  );
}

// document.fullscreenEnabled is false inside an iframe without allowfullscreen, and the
// method is missing entirely on iOS Safari for non-video elements, so the control is
// hidden rather than left to fail when the user presses it.
function bindFullscreenToggle(): void {
  if (typeof viewer.requestFullscreen !== 'function' || document.fullscreenEnabled !== true) {
    return;
  }
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenToggle();
    // The viewer's box changes before a resize event necessarily arrives, and
    // resizeCanvas also refreshes inputBounds, which pointer aiming maps against.
    resizeCanvas();
    renderRequested = true;
  });
  syncFullscreenToggle();
}

function toggleFullscreen(): void {
  if (typeof viewer.requestFullscreen !== 'function') return;
  const request =
    document.fullscreenElement === viewer ? document.exitFullscreen() : viewer.requestFullscreen();
  request.catch((error: unknown) => {
    console.info('Fullscreen request was refused:', error);
  });
}

function syncFullscreenToggle(): void {
  const active = document.fullscreenElement === viewer;
  viewer.classList.toggle('is-fullscreen', active);
}

function placeActiveStackObject(now: number, inputAt = now): void {
  if (activeObject === null) return;
  if (inputAt < placementArmedAt) return;
  if (now >= gameEndsAt) {
    beginSettling(now);
    return;
  }
  // Touch devices do not necessarily send a pointermove before pointerdown, so refresh
  // the hidden object's projected landing pose at the exact moment it is placed.
  updateActiveStackObject(now);
  commitObjectPlacement(now);
}

function setAimFromClientX(clientX: number, now: number): void {
  const current = activeObject;
  if (current === null) return;
  const normalized = clamp((clientX - inputBounds.left) / inputBounds.width, 0, 1) * 2 - 1;
  const horizontalLimit = getAimHalfWidth();
  setAimOffset(normalized * horizontalLimit, horizontalLimit, now);
}

function setAimOffset(targetX: number, horizontalLimit: number, now: number): void {
  const nextAim = clamp(targetX, -horizontalLimit, horizontalLimit);
  const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
  const pointerVelocity = (nextAim - aimOffset) / elapsed;
  indicatorAngularVelocity = clamp(
    indicatorAngularVelocity - clamp(pointerVelocity * 0.32, -4.2, 4.2),
    -INDICATOR_MAX_SPIN,
    INDICATOR_MAX_SPIN,
  );
  aimOffset = nextAim;
  lastAimAt = now;
}

function getAimHalfWidth(): number {
  if (camera.projection.kind !== 'perspective') return 0.36;
  const visibleHalfWidth =
    cameraController.distance *
    Math.tan(camera.projection.fovY / 2) *
    camera.projection.aspect;
  const activeHalfWidth =
    activeObject === null
      ? STACK_OBJECT_PROFILES.horse.halfWidth
      : STACK_OBJECT_PROFILES[activeObject.kind].halfWidth;
  return Math.min(PASTURE_HALF_WIDTH - activeHalfWidth * 1.2, visibleHalfWidth * 0.88);
}

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  inputBounds.left = bounds.left;
  inputBounds.width = Math.max(bounds.width, 1);
  const backingWidth = Math.round(width * nextPixelRatio);
  const backingHeight = Math.round(height * nextPixelRatio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    renderState.pixelRatio = nextPixelRatio;
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    // Deliberately NOT setting canvas.style.width/height. The backing store has to be a
    // whole number of device pixels, but pinning the CSS size to that rounded value leaves
    // the canvas a fraction of a pixel short of a viewer whose own width is fractional —
    // which happens with browser zoom or a HiDPI window — and the page shows through as a
    // hairline stripe along the edge. The `.viewer canvas` rule sizes it at 100%/100%
    // instead, so it always covers exactly, and the slight sampling stretch is invisible.
    gameUi.resize(width, height, nextPixelRatio);
    if (camera.projection.kind === 'perspective') camera.projection.aspect = width / height;
    renderRequested = true;
  }
}

function setLoadingState(copy: string): void {
  loadingCopy.textContent = copy;
  statusCopy.textContent = copy.replace('…', '');
}

function renderFrame(): void {
  // Lift the preview and its halo out of the graph for the depth pass, then put them back
  // at the index they held so forward draw order is untouched. See previewLayer above for
  // why switching them off is not enough.
  const previewParent = getNodeParent(previewLayer);
  const skyParent = getNodeParent(skyDome);
  if (previewParent !== null) removeNodeChild(previewParent, previewLayer);
  // The sky has to come out too, and for a sharper reason than the halo: the shadow pass
  // draws every node with geometry, and a dome that ENCLOSES the shadow camera would write
  // depth in front of the whole farm and shadow all of it.
  if (skyParent !== null) removeNodeChild(skyParent, skyDome);
  drawGlScene3DShadowMap(renderState, scene, shadowCamera, directionalLight);
  if (previewParent !== null) addNodeChildAt(previewParent, previewLayer, 0);
  if (skyParent !== null) addNodeChildAt(skyParent, skyDome, 0);
  beginGlRenderEffectPipeline(renderState, pipeline, 'linear');
  renderGlBackground(renderState);
  // The pipeline opens its pass preserving BOTH aspects, so last frame's depth is still in
  // the target and the scene has to start from a cleared one. A nested pass that spares
  // only the colour does exactly that, using the target's own clear values — the same job
  // three raw depthMask/clearDepth/clear calls used to do by hand.
  const sceneTarget = pipeline.sceneTarget;
  if (sceneTarget !== null) {
    beginGlRenderPass(renderState, sceneTarget, { preserveColor: true });
    drawGlScene3D(renderState, scene, camera, lights);
    endGlRenderPass(renderState);
  }
  // An empty list is the fast path: no ping-pong targets are acquired and no pass runs, so
  // the game pays for the defocus only on the screens that show it.
  endGlRenderEffectPipeline(
    renderState,
    pipeline,
    backdropFocus > 0.002 ? getBackdropEffects(backdropFocus) : NO_EFFECTS,
  );
  const countProgress =
    resultAnimationStart === 0
      ? phase === 'finished' ? 1 : 0
      : clamp((performance.now() - resultAnimationStart) / resultAnimationDuration, 0, 1);
  const shownMeters = getStackHeightMeters(finalHeight) * easeOutCubic(countProgress);
  const uiWantsAnotherFrame = gameUi.update({
    // Blank on a first ever round: there is no previous best to measure this one against,
    // and echoing the number already on screen back as "BEST" says nothing.
    bestText:
      recordBeforeRound === null || beatTheRecord
        ? ''
        : `BEST ${formatMeters(recordBeforeRound)}`,
    countProgress,
    creditsOpen,
    isRecord: beatTheRecord,
    handsShown: resultHandsShown,
    now: performance.now(),
    pointerDown,
    pointerX,
    pointerY,
    heightText: countProgress >= 1 ? formatHeight(finalHeight) : formatMeters(shownMeters),
    screen: getUiScreen(),
    secondsLeft: Math.max(0, (gameEndsAt - performance.now()) / 1000),
    timeUpProgress: import.meta.env.DEV && forcedScreen === 'timeup'
      ? 1
      : finishAt === 0
        ? 0
        : clamp(1 - (finishAt - performance.now()) / (FINAL_SETTLE_SECONDS * 1000), 0, 1) * 2.6,
  });
  gameUi.render();
  if (uiWantsAnotherFrame) renderRequested = true;
}

// DEV only: pins the UI to one screen so a short-lived one (TIME UP lasts 2.35s) can be
// held still and inspected instead of raced with a screenshot.
let forcedScreen: UiScreen | null = null;

function getUiScreen(): UiScreen {
  if (import.meta.env.DEV && forcedScreen !== null) return forcedScreen;
  if (phase === 'loading') return 'loading';
  if (phase === 'playing') return 'playing';
  if (phase === 'settling') return 'timeup';
  if (phase === 'finished') return 'result';
  return 'title';
}

function enterFrame(now: number): void {
  const deltaTime = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  if (phase !== 'loading' && isViewerVisible && document.visibilityState !== 'hidden') {
    const gameIsMoving = phase === 'playing' || phase === 'settling';
    if (gameIsMoving) {
      updateGame(now);
      swayClock += deltaTime * 1.6;
      stepGamePhysics(now, deltaTime);
      synchronizeStackVisuals();
      cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
      renderRequested = true;
    }
    if (phase === 'finished' && resultAnimationStart !== 0) {
      updateResultAnimation(now);
    }

    if (updateWindmill(deltaTime)) renderRequested = true;

    const screen = getUiScreen();
    const wantsBackdrop = screen === 'title' || screen === 'result' ? 1 : 0;
    const focused = backdropFocus + (wantsBackdrop - backdropFocus) * (1 - Math.exp(-deltaTime * 5.5));
    if (Math.abs(focused - backdropFocus) > 0.0005) {
      backdropFocus = focused;
      renderRequested = true;
    } else if (backdropFocus !== wantsBackdrop) {
      backdropFocus = wantsBackdrop;
      renderRequested = true;
    }

    const dustIsMoving = dustEmitter.data.particleCount > 0;
    const celebrationIsMoving = celebrationEmitter.data.particleCount > 0;
    const particlesAreMoving = dustIsMoving || celebrationIsMoving;
    if (dustIsMoving) {
      stepParticleEmitter3D(dustEmitter, dustState, dustConfig, deltaTime);
      renderRequested = true;
    }
    if (celebrationIsMoving) {
      stepParticleEmitter3D(celebrationEmitter, celebrationState, celebrationConfig, deltaTime);
      renderRequested = true;
    }

    const displayedHeight = phase === 'finished' ? finalHeight : cachedStackHeight;
    updateCamera(deltaTime, displayedHeight);
    const cameraIsMoving =
      Math.abs(cameraController.distance - cameraController.goalDistance) > 0.001 ||
      Math.abs(cameraController.polar - cameraController.goalPolar) > 0.0001 ||
      Math.abs(cameraController.azimuth - cameraController.goalAzimuth) > 0.0001;
    if (renderRequested || gameIsMoving || particlesAreMoving || cameraIsMoving) {
      renderFrame();
      renderRequested = false;
    }
  }

  requestAnimationFrame(enterFrame);
}

function initializeRenderer() {
  const initialPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const nextCanvas = createGlCanvasElement(1, 1, initialPixelRatio);
  nextCanvas.setAttribute(
    'aria-label',
    'Farm Stacker game. Move with the pointer or arrow keys, then click, tap, Space, or Enter to place the next random farm object.',
  );
  nextCanvas.tabIndex = 0;
  // createGlCanvasElement writes an inline pixel size, which would beat the stylesheet's
  // 100%/100%. Set it to fill once, here, so resizeCanvas never has to touch the CSS size
  // and can never round it a fraction short of the viewer (see the note there).
  nextCanvas.style.width = '100%';
  nextCanvas.style.height = '100%';
  viewer.prepend(nextCanvas);

  try {
    const nextRenderState = createGlRenderState(nextCanvas, {
      pixelRatio: initialPixelRatio,
      backgroundColor: 0x00000000,
      contextAttributes: { alpha: true, antialias: false },
      powerPreference: 'high-performance',
    });
    if (import.meta.env.DEV) enableFlightDiagnostics(nextRenderState);
    registerStandardGlTextureResolvers(nextRenderState);
    registerGlStandardPbrMaterial(nextRenderState);
    registerGlVertexColorMaterial(nextRenderState);
    registerGlBlurEffect(nextRenderState);
    registerGlVignetteEffect(nextRenderState);
    const nextPipeline = createGlRenderEffectPipeline(nextRenderState, {
      sampleCount: 4,
      format: 'rgba16f',
      depth: 'depth-stencil',
    });
    return { canvas: nextCanvas, pipeline: nextPipeline, renderState: nextRenderState };
  } catch (error) {
    showSceneError('Unable to initialize WebGL2.', error);
    throw error;
  }
}

function bindRenderingLifecycle(): void {
  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    phase = 'loading';
    showSceneError('The WebGL context was lost.', new Error('WebGL context lost'));
  });
  canvas.addEventListener('webglcontextrestored', () => window.location.reload());

  if ('IntersectionObserver' in window) {
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isViewerVisible = entry?.isIntersecting ?? true;
      previousTime = performance.now();
      if (isViewerVisible) renderRequested = true;
    });
    visibilityObserver.observe(viewer);
  }

  document.addEventListener('visibilitychange', () => {
    previousTime = performance.now();
    physicsAccumulator = 0;
    if (document.visibilityState === 'visible') renderRequested = true;
  });
}

function showSceneError(message: string, error: unknown): void {
  audio.stopAll();
  console.error(message, error);
  loadingPanel.classList.add('is-hidden');
  errorPanel.hidden = false;
  statusCopy.textContent = 'Game unavailable';
}

function formatHeight(height: number): string {
  return formatMeters(getStackHeightMeters(height));
}

function formatMeters(meters: number): string {
  return `${meters.toFixed(2)} m`;
}

// The HUD used to double as a test surface — harnesses read the placed count and height
// out of the DOM. Those elements are gone, so dev builds expose the same few numbers
// directly. Not shipped: production has no reason to carry it.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game = {
    get height() {
      return getStackHeightMeters(phase === 'finished' ? finalHeight : cachedStackHeight);
    },
    get phase() {
      return phase;
    },
    get placed() {
      return objectsDropped;
    },
    set screen(value: UiScreen | null) {
      forcedScreen = value;
      renderRequested = true;
    },
    // Where the pile top and the hovering preview actually land in the frame. NDC y, so
    // +1 is the top edge and anything past it is off screen. Camera framing is easy to
    // reason about wrongly on paper (the top bias scales with distance, which flatters
    // a clamped camera), so read it off the real view-projection instead.
    get frame() {
      const aspect =
        camera.projection.kind === 'perspective' ? camera.projection.aspect : 1;
      const probe = createVector3(0, 0, 0);
      const ndcY = (physicsY: number): number => {
        const point = createVector3(STACK_X, STACK_BASE_Y + physicsY, STACK_Z);
        return getCamera3DWorldToScreen(probe, camera, point, aspect) ? probe.y : NaN;
      };
      return {
        distance: cameraController.distance,
        followed: cameraStackHeight,
        measured: cachedStackHeight,
        preview: ndcY(previewTopY),
        targetY: cameraController.target.y,
        top: ndcY(cachedStackHeight),
      };
    },
  };
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

void start();
requestAnimationFrame(enterFrame);
