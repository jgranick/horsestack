import type {
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
  beginGlRenderEffectPipeline,
  clearParticleEmitter3D,
  cloneMeshGeometry,
  cloneMesh,
  compactMeshGeometryVertices,
  configureDirectionalShadowCamera3DTightFit,
  createAabb,
  createAmbientLight,
  createCamera3D,
  createDirectionalLight,
  createGlCanvasElement,
  createGlRenderEffectPipeline,
  createGlRenderState,
  createMesh,
  createNode3D,
  createOrbitCameraController,
  createOrthographicProjection,
  createParticleEmitter3D,
  createParticleEmitterConfig,
  createParticleEmitterState,
  createPerspectiveProjection,
  createPointLight,
  createRingMeshGeometry,
  createStandardPbrMaterial,
  createVector3,
  emitParticleBurst3D,
  enableFlightDiagnostics,
  endGlRenderEffectPipeline,
  getNodeChildren,
  getNodeLocalMatrix4,
  invalidateNodeLocalTransform,
  isMesh,
  isNodeLocalMatrix4Detached,
  Node3DKind,
  normalizeVector3,
  registerGlStandardPbrMaterial,
  registerStandardGlTextureResolvers,
  refreshMeshGeometryBounds,
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
import {
  FARM_PROP_SCENE_SCALE,
  FARM_PROP_VARIANTS,
  getRandomFarmPropVariantIndex,
  selectFarmPropTriangleIndices,
} from './farmPropGeometry';
import type { FarmPropPartSpec, FarmPropTriangleFilter } from './farmPropGeometry';
import {
  addStackObjectBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextObjectDelay,
  getPaceLevel,
  getRandomStackObjectKind,
  getStackBodyHalfWidth,
  getStackBodySupportExtent,
  getStackHeightHands,
  getStackHeightMeters,
  getStackObjectVerticalExtent,
  getSupportedStackHeight,
  HORSE_HALF_HEIGHT,
  HORSE_SIZE_MULTIPLIER,
  isStackBodyWithinPasture,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  STACK_OBJECT_PROFILES,
  stepHorseStack,
} from './horseStackPhysics';
import type { StackObjectKind } from './horseStackPhysics';
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

// Maps physics Y into world Y, and so decides where the play surface sits against the
// rendered farm. PASTURE_TOP_Y is -0.015, putting the platform at world Y -0.072 — the
// height of the modelled grass under the play band, sampled by ray-casting the farm
// glTF's Ground/Ground2 triangles along the pile line (world x=1.55): the terrain runs
// -0.045 to -0.079 there, mean -0.066, and this sits just under that so pieces settle
// into the grass rather than hovering over it. Deliberately fixed HERE and not by moving
// PASTURE_TOP_Y: the physics and scoring code treats y=0 as the floor in several places
// (getSupportedStackHeight's empty-pile sentinel, its fall-off test, getStackHeightMeters'
// guard), so lowering the pasture itself would read a settled chicken as fallen.
const STACK_BASE_Y = -0.057;
// At a 90° camera azimuth, +X is toward the viewer and Z runs horizontally.
// Pull the 2D play plane close to the island's front edge at roughly x=1.8,
// while retaining a small strip of visible pasture beneath the pieces.
const STACK_X = 1.55;
const STACK_Z = -2.15;
const HORSE_SCALE = 0.00279 * HORSE_SIZE_MULTIPLIER;
const HORSE_VISUAL_CENTER_Y = 0.07875 * HORSE_SIZE_MULTIPLIER;
// The preview floats a full horse-height above its landing surface so the queued
// object reads as "about to drop" rather than as an object already in the pile.
// Placement still uses the unlifted landing pose.
const LANDING_PREVIEW_LIFT = HORSE_HALF_HEIGHT * 2;
// The lifted preview carries its halo ring with it, and at the tightest camera
// distance the pair reached past the top of the frame. This much extra headroom on
// the camera target keeps the whole marker visible; it costs a sliver of pasture at
// the bottom, where there is margin to spare.
const LANDING_MARKER_HEADROOM = 0.075;
// The camera frames the measured stack top, but that measurement is a max over the
// qualifying bodies: when a piece settles, the top can change by centimetres in a single
// step while nothing visibly moves much. Feeding that straight to the camera is what made
// it shudder. The camera follows its own copy of the height instead — deadbanded so
// millimetre flicker is ignored outright, and rate limited so even the worst measured jump
// (about 0.063 units) reaches the camera as at most 0.0023 per frame rather than all at
// once. Rising is quick so a placed piece is framed promptly; falling is slow, because a
// pile that has just lost a few millimetres is exactly the case that should not yank the
// view. Only the camera reads this; scoring and the HUD keep the true measurement.
const CAMERA_HEIGHT_DEADBAND = 0.008;
const CAMERA_HEIGHT_RISE_RATE = 1.1;
const CAMERA_HEIGHT_FALL_RATE = 0.14;
// One lazy turn every fourteen seconds. The sails are ambient scenery, so this is
// slow enough to read as idling wind rather than as something demanding attention.
const WINDMILL_RADIANS_PER_SECOND = (Math.PI * 2) / 14;
// Long enough to swallow the second half of a double-click on "Start stacking",
// short enough that a player who reacts to the first preview never notices it.
const START_INPUT_GUARD_MS = 400;
const GAME_DURATION_MS = 60_000;
const HANDS_PER_EMOJI_COLUMN = 9;
const MIN_RESULT_COUNT_DURATION_MS = 2_200;
const MAX_RESULT_COUNT_DURATION_MS = 4_000;
const RESULT_TICK_INTERVAL_MS = 32;
const RESULT_TICK_POOL_SIZE = 8;
const HORSE_WHINNY_MIN_INTERVAL_MS = 9_000;
const HORSE_WHINNY_INTERVAL_JITTER_MS = 6_000;
const FINAL_WHINNY_CHANCE = 0.28;
// Quiet regions in the source sample separate these four calls. Cueing the
// original file avoids shipping four near-identical derived assets.
const HORSE_WHINNY_CUES = [
  { duration: 2.1, start: 0.08 },
  { duration: 1.2, start: 3.7 },
  { duration: 1.7, start: 5.7 },
  { duration: 1.25, start: 8.82 },
] as const;
const INDICATOR_SPRING = 22;
const INDICATOR_DAMPING = 6.2;
const INDICATOR_MAX_ANGLE = 0.65;
const INDICATOR_MAX_SPIN = 5.5;
const FIXED_STEP_LIMIT = 6;
const GAME_VIEW = {
  azimuth: Math.PI / 2,
  distance: 0.82,
  maxDistance: 3.4,
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
const sceneStatus = requireElement<HTMLDivElement>('scene-status');
const statusCopy = requireElement<HTMLSpanElement>('status-copy');
const startPanel = requireElement<HTMLDivElement>('start-panel');
const startButton = requireElement<HTMLButtonElement>('start-button');
const timeUpPanel = requireElement<HTMLDivElement>('time-up-panel');
const resultPanel = requireElement<HTMLDivElement>('result-panel');
const resultHorseStack = requireElement<HTMLDivElement>('result-horse-stack');
const resultHandCount = requireElement<HTMLElement>('result-hand-count');
const resultScore = requireElement<HTMLSpanElement>('result-score');
const resultCopy = requireElement<HTMLParagraphElement>('result-copy');
const replayButton = requireElement<HTMLButtonElement>('replay-button');
const restartButton = requireElement<HTMLButtonElement>('restart-game');
const dropButton = requireElement<HTMLButtonElement>('drop-horse');
const fullscreenToggle = requireElement<HTMLButtonElement>('fullscreen-toggle');
const horsesLeftCopy = requireElement<HTMLSpanElement>('horses-left');
const timerCopy = requireElement<HTMLSpanElement>('drop-timer');
const timerFill = requireElement<HTMLSpanElement>('timer-fill');
const heightCopy = requireElement<HTMLSpanElement>('stack-height');
const paceCopy = requireElement<HTMLSpanElement>('pace-copy');
const gameCallout = requireElement<HTMLDivElement>('game-callout');
const heroTimer = requireElement<HTMLDivElement>('hero-timer');
const heroTimerCopy = requireElement<HTMLElement>('hero-timer-copy');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Keep these paths indirect so Vite leaves the runtime module-relative URLs untouched
// without warning. Both directories are served straight out of public/.
const modelPathFromModule = '../models/';
const modelRoot = new URL(modelPathFromModule, import.meta.url).href.replace(/\/$/, '');
const soundPathFromModule = '../sounds/';
const soundRoot = new URL(soundPathFromModule, import.meta.url).href;
const soundUrl = (file: string): string => new URL(encodeURIComponent(file), soundRoot).href;

const soundtrack = createAudioTrack(soundUrl("Elijah_K - The Mountain's Happy Song.mp3"), 0.36);
const farmAmbience = createAudioTrack(soundUrl('free-sound-1674978362.mp3'), 0.16, true);
const horseThud = createAudioTrack(soundUrl('free-sound-1674747349.mp3'), 0.24);
const countFanfare = createAudioTrack(soundUrl('free-sound-1674977569.mp3'), 0.46);
const resultTada = createAudioTrack(soundUrl('free-sound-1674895520.mp3'), 0.52);
const horseWhinnies = createAudioTrack(soundUrl('free-sound-effects-HORSE3.mp3'), 0.22);
const resultTickUrl = soundUrl('free-sound-1674778893.mp3');
const resultTicks = Array.from({ length: RESULT_TICK_POOL_SIZE }, () =>
  createAudioTrack(resultTickUrl, 0.1),
);

retryButton.addEventListener('click', () => window.location.reload());
const { canvas, pipeline, renderState } = initializeRenderer();

const scene = createNode3D(Node3DKind);
const stackLayer = createNode3D(Node3DKind, { name: 'horse-stack' });
addNodeChild(scene, stackLayer);
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
  alphaEnd: 0,
  alphaStart: 0.95,
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
  emitterConeAngle: 1.65,
  emitterRadius: 0.16,
  emitterShape: 'cone3d',
  gravityY: -3.2,
  lifetimeMax: 2.1,
  lifetimeMin: 0.9,
  loop: false,
  maxParticles: 240,
  rotationSpeedMax: 8,
  rotationSpeedMin: -8,
  scaleEnd: 0.02,
  scaleMax: 0.48,
  scaleMin: 0.18,
  spawnRate: 0,
  speedMax: 5.2,
  speedMin: 2.1,
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
let finalSurvivors = 0;
let resultAnimationStart = 0;
let resultAnimationDuration = 0;
let resultHands = 0;
let resultHandsShown = 0;
let resultTickIndex = 0;
let nextResultTickAt = 0;
let nextHorseWhinnyAt = 0;
let horseWhinnyStopTimer: number | null = null;
let scheduledHorseWhinnyTimer: number | null = null;
let physicsAccumulator = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
let impactFlashUntil = 0;
let lastImpactAt = 0;
let hudDirty = true;
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
    startPanel.hidden = false;
    startButton.disabled = false;
    sceneStatus.classList.add('is-ready');
    statusCopy.textContent = 'Stable enough';
    updateHud(performance.now());
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
  if (sails === null || reducedMotion.matches) return false;
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
    addNodeChild(pivot, cloneNode3DHierarchy(template, materialOverride));
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
  addNodeChild(modelTransform, cloneNode3DHierarchy(horseTemplate.root, materialOverride));
  addNodeChild(pivot, modelTransform);
  return pivot;
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

function findNodeByName(root: Readonly<Node3D>, name: string): Node3D | null {
  if (root.name === name) return root as Node3D;
  for (const child of getNodeChildren(root)) {
    const match = findNodeByName(child, name);
    if (match !== null) return match;
  }
  return null;
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

function cloneNode3DHierarchy(
  source: Readonly<Node3D>,
  materialOverride: ReturnType<typeof createStandardPbrMaterial> | null = null,
): Node3D {
  const clone = isMesh(source)
    ? cloneMesh(source)
    : createNode3D(source.kind, {
        alpha: source.alpha,
        enabled: source.enabled,
        name: source.name,
        visible: source.visible,
      });

  clone.alpha = source.alpha;
  clone.visible = source.visible;
  if (materialOverride !== null && isMesh(clone)) {
    clone.materials = clone.materials.map(() => materialOverride);
  }
  if (!isMesh(source)) {
    setNodeTransform3D(clone, source);
    if (isNodeLocalMatrix4Detached(source)) {
      setNodeLocalMatrix4(clone, getNodeLocalMatrix4(source));
    }
  }

  for (const child of getNodeChildren(source)) {
    addNodeChild(clone, cloneNode3DHierarchy(child, materialOverride));
  }
  return clone;
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
  startGameAudio(now);
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
  finalSurvivors = 0;
  resultAnimationStart = 0;
  resultAnimationDuration = 0;
  resultHands = 0;
  resultHandsShown = 0;
  impactFlashUntil = 0;
  lastImpactAt = 0;
  removeNodeChildren(stackLayer);
  landingGhost = createNode3D(Node3DKind, { name: 'landing-preview' });
  // A solid silhouette keeps the small chicken readable and prevents the
  // horse's back-facing surfaces from showing through the preview. The halo,
  // beam, emissive material, and point light retain the golden placement cue.
  landingGhost.alpha = 1;
  landingGhost.name = 'landing-preview';
  addNodeChild(stackLayer, landingGhost);
  landingRadiance = createLandingRadiance();
  addNodeChild(stackLayer, landingRadiance);
  indicatorLight.intensity = 0;
  clearParticleEmitter3D(dustEmitter);
  clearParticleEmitter3D(celebrationEmitter);
  dustState = createParticleEmitterState();
  celebrationState = createParticleEmitterState();

  phase = 'playing';
  cameraStackHeight = 0;
  placementArmedAt = (startedFrom?.timeStamp ?? now) + START_INPUT_GUARD_MS;
  startPanel.hidden = true;
  timeUpPanel.hidden = true;
  resultPanel.hidden = true;
  resultPanel.classList.remove('is-total-revealed');
  resultHorseStack.replaceChildren();
  resultHandCount.textContent = '0';
  resultScore.textContent = '0.00 m';
  resultCopy.textContent = 'The pasture is still assessing the situation.';
  replayButton.hidden = true;
  restartButton.hidden = false;
  dropButton.disabled = true;
  dropButton.hidden = false;
  viewer.classList.add('is-playing');
  viewer.classList.remove('is-finished', 'is-time-up', 'is-bumping', 'is-panicking');
  sceneStatus.classList.add('is-ready');
  statusCopy.textContent = '60 seconds. Go!';
  gameCallout.textContent = 'Move fast to make it teeter…';
  hudDirty = true;
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
  dropButton.disabled = false;
  const profile = STACK_OBJECT_PROFILES[kind];
  const label = getStackObjectVisualLabel(kind, variantIndex);
  statusCopy.textContent = `${profile.emoji} ${label} queued`;
  gameCallout.textContent =
    getPaceLevel(objectsDropped) >= 4
      ? `Keep the glowing ${label.toLowerCase()} upright.`
      : `${profile.emoji} Next: ${label}. Move, balance, place.`;
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
  dropButton.disabled = true;
  // The prompt has served its purpose once the player has placed something.
  dropButton.hidden = true;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingRadiance !== null) landingRadiance.enabled = false;
  indicatorLight.intensity = 0;
  objectsDropped++;
  restartAudioTrack(horseThud, 'Stack thud');

  const tilt = Math.abs(current.angle);
  gameCallout.textContent =
    tilt > 0.42
      ? 'Precariously placed!'
      : tilt > 0.16
        ? 'A little crooked.'
        : `${STACK_OBJECT_PROFILES[current.kind].emoji} Placed gently.`;
  nextObjectAt = now + getNextObjectDelay(objectsDropped);
  hudDirty = true;
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
  stopAudioTrack(soundtrack);
  restartAudioTrack(countFanfare, 'Count fanfare');
  activeObject = null;
  finishAt = now + FINAL_SETTLE_SECONDS * 1000;
  dropButton.disabled = true;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingRadiance !== null) landingRadiance.enabled = false;
  indicatorLight.intensity = 0;
  timeUpPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-panicking');
  viewer.classList.add('is-time-up');
  statusCopy.textContent = 'Time up!';
  gameCallout.textContent = 'Hands off the pile!';
  hudDirty = true;
  renderRequested = true;
}

function finishGame(now: number): void {
  phase = 'finished';
  finalHeight = getCurrentStackHeight();
  cachedStackHeight = finalHeight;
  finalSurvivors = stackedObjects.filter(
    ({ body, lost }) =>
      !lost && body.y > -1 && isStackBodyWithinPasture(body),
  ).length;
  resultHands = getStackHeightHands(finalHeight);
  resultHandsShown = 0;
  resultTickIndex = 0;
  nextResultTickAt = now;
  resultAnimationStart = now;
  resultAnimationDuration = reducedMotion.matches
    ? 1
    : clamp(
        1_800 + resultHands * 14,
        MIN_RESULT_COUNT_DURATION_MS,
        MAX_RESULT_COUNT_DURATION_MS,
      );
  resultHorseStack.replaceChildren();
  resultHandCount.textContent = '0';
  resultScore.textContent = '0.00 m';
  resultCopy.textContent = 'Counting the pile, one hand at a time…';
  replayButton.hidden = true;
  resultPanel.classList.remove('is-total-revealed');
  timeUpPanel.hidden = true;
  resultPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-time-up', 'is-panicking', 'is-bumping');
  viewer.classList.add('is-finished');
  indicatorLight.intensity = 0;
  statusCopy.textContent = 'Counting hands…';
  gameCallout.textContent = 'One 🐴 per hand. Keep counting…';
  hudDirty = true;
  renderRequested = true;
}

function updateResultAnimation(now: number): void {
  if (resultAnimationStart === 0) return;
  const progress = clamp((now - resultAnimationStart) / resultAnimationDuration, 0, 1);
  const easedProgress = 1 - Math.pow(1 - progress, 3);
  const handsToShow = Math.min(resultHands, Math.floor(resultHands * easedProgress));
  if (appendHorseHands(handsToShow)) playResultTick(now);
  resultHandCount.textContent = String(handsToShow);
  resultScore.textContent = formatMeters(getStackHeightMeters(finalHeight) * easedProgress);

  if (progress >= 1) completeResultAnimation();
}

function appendHorseHands(targetCount: number): boolean {
  const previousCount = resultHandsShown;
  while (resultHandsShown < targetCount) {
    const columnIndex = Math.floor(resultHandsShown / HANDS_PER_EMOJI_COLUMN);
    let column = resultHorseStack.children.item(columnIndex);
    if (!(column instanceof HTMLElement)) {
      column = document.createElement('span');
      column.className = 'horse-hand-column';
      resultHorseStack.append(column);
    }
    const horse = document.createElement('span');
    horse.className = 'horse-hand';
    horse.textContent = '🐴';
    column.append(horse);
    resultHandsShown++;
  }
  return resultHandsShown > previousCount;
}

function completeResultAnimation(): void {
  resultAnimationStart = 0;
  restartAudioTrack(resultTada, 'Result fanfare');
  maybePlayCelebrationWhinny();
  appendHorseHands(resultHands);
  resultHandCount.textContent = String(resultHands);
  resultScore.textContent = formatHeight(finalHeight);
  resultCopy.textContent = `${getScore(finalHeight).toLocaleString()} points · ${finalSurvivors} of ${objectsDropped} farm things remained in the general vicinity.`;
  replayButton.hidden = false;
  resultPanel.classList.add('is-total-revealed');
  statusCopy.textContent = 'Officially measured';
  gameCallout.textContent =
    finalHeight >= 0.45
      ? 'A monument to poor judgement.'
      : 'Structurally questionable. Perfect.';
  celebrateFinalHeight();
}

function celebrateFinalHeight(): void {
  const burstY = STACK_BASE_Y + Math.max(0.8, finalHeight);
  const colors = [0xffd166ff, 0xef8354ff, 0x7ea16bff, 0xf7ede2ff, 0x8ecae6ff, 0xe5989bff];
  for (let index = 0; index < colors.length; index++) {
    const horizontalOffset = -1.8 + (index / (colors.length - 1)) * 3.6;
    emitParticleBurst3D(
      celebrationEmitter,
      celebrationState,
      celebrationConfig,
      28,
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
  impactFlashUntil = now + 130;
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
  maybePlayCollisionWhinny(now);
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

    setStackObjectVisualTransform(object.node, body.x, body.y, body.angle);
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
  setStackObjectVisualTransform(landingGhost, previewX, previewY, current.angle);
  updateLandingRadiance(previewX, previewY, now);
}

function updateLandingRadiance(x: number, physicsY: number, now: number): void {
  const radiance = landingRadiance;
  if (radiance === null) return;
  const pulse = reducedMotion.matches ? 1 : 1 + Math.sin(now * 0.006) * 0.025;
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
  indicatorLight.intensity = 0.8 + Math.sin(now * 0.008) * 0.14;
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
  const limit = (difference > 0 ? CAMERA_HEIGHT_RISE_RATE : CAMERA_HEIGHT_FALL_RATE) * deltaTime;
  cameraStackHeight += difference > 0 ? Math.min(difference, limit) : Math.max(difference, -limit);
  return cameraStackHeight;
}

function updateCamera(deltaTime: number, measuredHeight: number): void {
  const height = followStackHeight(measuredHeight, deltaTime);
  const rise = clamp(height / 1.1, 0, 1);
  const herdProgress = clamp(objectsDropped / 50, 0, 1);
  const restingHorseTop = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 1.2;
  const desiredTargetY =
    STACK_BASE_Y +
    Math.max(restingHorseTop, height + HORSE_HALF_HEIGHT * 0.2) +
    LANDING_MARKER_HEADROOM;
  if (Math.abs(desiredTargetY - cameraController.target.y) > 0.001) renderRequested = true;
  const follow = 1 - Math.exp(-deltaTime * 2.4);
  cameraController.target.y += (desiredTargetY - cameraController.target.y) * follow;
  cameraController.target.x += (STACK_X - cameraController.target.x) * follow;
  cameraController.target.z = STACK_Z;
  cameraController.goalAzimuth = Math.PI / 2 + rise * 0.18 + herdProgress * 0.04;
  cameraController.goalPolar = 0.06 + rise * 0.14;
  cameraController.goalDistance = Math.min(3.25, 0.82 + height * 0.85 + herdProgress * 0.28);
  updateOrbitCameraController(cameraController, camera, deltaTime);
}

function updateHud(now: number, stackHeight = cachedStackHeight): void {
  setTextIfChanged(horsesLeftCopy, String(objectsDropped));
  setTextIfChanged(heightCopy, formatHeight(stackHeight));
  setTextIfChanged(paceCopy, `${getScore(stackHeight).toLocaleString()} pts`);

  if (phase !== 'playing') {
    setTextIfChanged(timerCopy, phase === 'settling' ? 'TIME UP' : '—');
    setTextIfChanged(heroTimerCopy, '0');
    setStyleTransformIfChanged(timerFill, 'scaleX(0)');
    timerFill.classList.remove('is-urgent');
    heroTimer.classList.remove('is-urgent');
  } else {
    const remainingMs = Math.max(0, gameEndsAt - now);
    const remaining = remainingMs / 1000;
    setTextIfChanged(timerCopy, `${remaining.toFixed(1)}s`);
    setTextIfChanged(heroTimerCopy, String(Math.ceil(remaining)));
    setStyleTransformIfChanged(timerFill, `scaleX(${clamp(remainingMs / GAME_DURATION_MS, 0, 1)})`);
    timerFill.classList.toggle('is-urgent', remaining <= 10);
    heroTimer.classList.toggle('is-urgent', remaining <= 10);
    viewer.classList.toggle('is-panicking', remaining <= 10);
  }

  viewer.classList.toggle('is-bumping', now < impactFlashUntil && !reducedMotion.matches);
  hudDirty = false;
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

function getScore(height: number): number {
  return Math.round(getStackHeightMeters(height) * 1000);
}

function bindGameControls(): void {
  // Window-level, not canvas-level: aiming and placing follow the pointer anywhere on
  // the page while a run is live. setAimFromClientX clamps against the canvas bounds, so
  // a click out in the margin simply aims at that edge.
  window.addEventListener('pointermove', (event: PointerEvent) => {
    if (phase !== 'playing' || activeObject === null) return;
    setAimFromClientX(event.clientX, performance.now());
  });

  window.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || phase !== 'playing') return;
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

  dropButton.addEventListener('click', (event: MouseEvent) =>
    placeActiveStackObject(performance.now(), event.timeStamp),
  );
  bindFullscreenToggle();
  startButton.addEventListener('click', startGame);
  replayButton.addEventListener('click', startGame);
  restartButton.addEventListener('click', startGame);
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
    fullscreenToggle.hidden = true;
    return;
  }
  fullscreenToggle.addEventListener('click', () => {
    const request =
      document.fullscreenElement === viewer ? document.exitFullscreen() : viewer.requestFullscreen();
    request.catch((error: unknown) => {
      console.info('Fullscreen request was refused:', error);
    });
  });
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenToggle();
    // The viewer's box changes before a resize event necessarily arrives, and
    // resizeCanvas also refreshes inputBounds, which pointer aiming maps against.
    resizeCanvas();
    renderRequested = true;
  });
  syncFullscreenToggle();
}

function syncFullscreenToggle(): void {
  const active = document.fullscreenElement === viewer;
  viewer.classList.toggle('is-fullscreen', active);
  fullscreenToggle.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  fullscreenToggle.title = active ? 'Exit fullscreen' : 'Fullscreen';
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
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (camera.projection.kind === 'perspective') camera.projection.aspect = width / height;
    renderRequested = true;
  }
}

function setLoadingState(copy: string): void {
  loadingCopy.textContent = copy;
  statusCopy.textContent = copy.replace('…', '');
}

function renderFrame(): void {
  const ghostEnabled = landingGhost?.enabled ?? false;
  const radianceEnabled = landingRadiance?.enabled ?? false;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingRadiance !== null) landingRadiance.enabled = false;
  drawGlScene3DShadowMap(renderState, scene, shadowCamera, directionalLight);
  if (landingGhost !== null) landingGhost.enabled = ghostEnabled;
  if (landingRadiance !== null) landingRadiance.enabled = radianceEnabled;
  beginGlRenderEffectPipeline(renderState, pipeline, 'linear');
  renderGlBackground(renderState);
  renderState.gl.depthMask(true);
  renderState.gl.clearDepth(1);
  renderState.gl.clear(renderState.gl.DEPTH_BUFFER_BIT);
  drawGlScene3D(renderState, scene, camera, lights);
  endGlRenderEffectPipeline(renderState, pipeline, []);
}

function enterFrame(now: number): void {
  const deltaTime = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  if (phase !== 'loading' && isViewerVisible && document.visibilityState !== 'hidden') {
    const gameIsMoving = phase === 'playing' || phase === 'settling';
    if (gameIsMoving) {
      updateGame(now);
      stepGamePhysics(now, deltaTime);
      synchronizeStackVisuals();
      cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
      renderRequested = true;
    }
    if (phase === 'finished' && resultAnimationStart !== 0) {
      updateResultAnimation(now);
    }

    if (updateWindmill(deltaTime)) renderRequested = true;

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
    if (gameIsMoving || hudDirty) updateHud(now, displayedHeight);
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
  viewer.prepend(nextCanvas);

  try {
    const nextRenderState = createGlRenderState(nextCanvas, {
      pixelRatio: initialPixelRatio,
      backgroundColor: 0xdbe5d1ff,
      contextAttributes: { alpha: false, antialias: false },
      powerPreference: 'high-performance',
    });
    if (import.meta.env.DEV) enableFlightDiagnostics(nextRenderState);
    registerStandardGlTextureResolvers(nextRenderState);
    registerGlStandardPbrMaterial(nextRenderState);
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

function createAudioTrack(source: string, volume: number, loop = false): HTMLAudioElement {
  const audio = new Audio(source);
  audio.preload = 'auto';
  audio.volume = volume;
  audio.loop = loop;
  return audio;
}

function playAudioTrack(audio: HTMLAudioElement, label: string): void {
  void audio.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    // Audio permission or device failures should never prevent a game from running.
    console.info(`${label} could not start.`, error);
  });
}

function restartAudioTrack(audio: HTMLAudioElement, label: string): void {
  stopAudioTrack(audio);
  playAudioTrack(audio, label);
}

function stopAudioTrack(audio: HTMLAudioElement): void {
  audio.pause();
  audio.currentTime = 0;
}

function stopHorseWhinny(): void {
  if (horseWhinnyStopTimer !== null) window.clearTimeout(horseWhinnyStopTimer);
  if (scheduledHorseWhinnyTimer !== null) window.clearTimeout(scheduledHorseWhinnyTimer);
  horseWhinnyStopTimer = null;
  scheduledHorseWhinnyTimer = null;
  stopAudioTrack(horseWhinnies);
}

function playHorseWhinny(): void {
  stopHorseWhinny();
  const cue = HORSE_WHINNY_CUES[Math.floor(Math.random() * HORSE_WHINNY_CUES.length)];
  if (cue === undefined) return;
  horseWhinnies.currentTime = cue.start;
  playAudioTrack(horseWhinnies, 'Horse whinny');
  horseWhinnyStopTimer = window.setTimeout(() => {
    horseWhinnyStopTimer = null;
    stopAudioTrack(horseWhinnies);
  }, cue.duration * 1000);
}

function maybePlayCollisionWhinny(now: number): void {
  if (now < nextHorseWhinnyAt) return;
  playHorseWhinny();
  nextHorseWhinnyAt =
    now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
}

function maybePlayCelebrationWhinny(): void {
  if (Math.random() >= FINAL_WHINNY_CHANCE) return;
  scheduledHorseWhinnyTimer = window.setTimeout(() => {
    scheduledHorseWhinnyTimer = null;
    playHorseWhinny();
  }, 180);
}

function reloadAudioTrack(audio: HTMLAudioElement): void {
  audio.pause();
  // load() clears an ended or interrupted media pipeline and starts a fresh
  // preload. Re-arming short effects here gives them the entire next round to
  // buffer instead of discovering an evicted resource during the result beat.
  audio.load();
}

function playResultTick(now: number): void {
  if (reducedMotion.matches || now < nextResultTickAt) return;
  const tick = resultTicks[resultTickIndex % resultTicks.length];
  if (tick === undefined) return;
  resultTickIndex++;
  nextResultTickAt = now + RESULT_TICK_INTERVAL_MS;
  restartAudioTrack(tick, 'Result tick');
}

function stopResultTicks(): void {
  for (const tick of resultTicks) stopAudioTrack(tick);
  resultTickIndex = 0;
  nextResultTickAt = 0;
}

function reloadGameEffects(): void {
  stopHorseWhinny();
  reloadAudioTrack(horseThud);
  reloadAudioTrack(horseWhinnies);
  reloadAudioTrack(countFanfare);
  reloadAudioTrack(resultTada);
  for (const tick of resultTicks) reloadAudioTrack(tick);
  resultTickIndex = 0;
  nextResultTickAt = 0;
}

function startGameAudio(now: number): void {
  reloadGameEffects();
  nextHorseWhinnyAt =
    now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
  if (farmAmbience.paused) playAudioTrack(farmAmbience, 'Farm ambience');
  restartAudioTrack(soundtrack, 'Background music');
}

function stopAllAudio(): void {
  stopAudioTrack(soundtrack);
  stopAudioTrack(farmAmbience);
  stopAudioTrack(horseThud);
  stopAudioTrack(countFanfare);
  stopAudioTrack(resultTada);
  stopResultTicks();
  stopHorseWhinny();
}

function showSceneError(message: string, error: unknown): void {
  stopAllAudio();
  console.error(message, error);
  loadingPanel.classList.add('is-hidden');
  errorPanel.hidden = false;
  startPanel.hidden = true;
  timeUpPanel.hidden = true;
  resultPanel.hidden = true;
  dropButton.disabled = true;
  sceneStatus.classList.remove('is-ready');
  sceneStatus.classList.add('is-error');
  statusCopy.textContent = 'Game unavailable';
}

function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function setStyleTransformIfChanged(element: HTMLElement, value: string): void {
  if (element.style.transform !== value) element.style.transform = value;
}

function formatHeight(height: number): string {
  return formatMeters(getStackHeightMeters(height));
}

function formatMeters(meters: number): string {
  return `${meters.toFixed(2)} m`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

void start();
requestAnimationFrame(enterFrame);
