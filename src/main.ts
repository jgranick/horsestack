import type {
  Camera3D,
  ImportDiagnostic,
  Node3D,
  ParticleEmitter3D,
  ParticleEmitterConfig,
  ParticleEmitterState,
  Physics3DWorld,
  RigidBody3D,
  Scene3D,
  Scene3DLightsLike,
} from '@flighthq/sdk';
import {
  addNodeChild,
  beginGlRenderEffectPipeline,
  clearParticleEmitter3D,
  cloneMesh,
  configureDirectionalShadowCamera3D,
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
  createPlaneMeshGeometry,
  createRingMeshGeometry,
  createStandardPbrMaterial,
  createVector3,
  emitParticleBurst3D,
  enableFlightDiagnostics,
  endGlRenderEffectPipeline,
  getCamera3DScreenToWorldRay,
  getNodeChildren,
  getNodeLocalMatrix4,
  intersectCamera3DRayWithPlane,
  invalidateNodeLocalTransform,
  isMesh,
  isNodeLocalMatrix4Detached,
  Node3DKind,
  normalizeVector3,
  registerGlStandardPbrMaterial,
  registerStandardGlTextureResolvers,
  removeNodeChildren,
  removePhysics3DBody,
  renderGlBackground,
  setNodeLocalMatrix4,
  setNodeTransform3D,
  setQuaternionFromEuler,
  setQuaternionFromUnitVectors,
  stepParticleEmitter3D,
  updateOrbitCameraController,
} from '@flighthq/sdk';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { drawGlScene3D, drawGlScene3DShadowMap } from '@flighthq/sdk/rendering';
import { createFlightGameUi } from './gameUi';
import type { FlightGameUi, GameUiModel } from './gameUi';
import type { HorsePlacementResult } from './horseStackPhysics';
import {
  addHorseBody,
  attachHorseToPile,
  createHorsePlacementResult,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getNextHorseDelay,
  getPaceLevel,
  getRandomHorsePlacementAngle,
  getRandomHorsePlacementYaw,
  getHorseTopY,
  getStackHeightHands,
  getStackHeightMeters,
  getSupportedStackHeight,
  HORSE_COLLIDER_HALF_LENGTH,
  HORSE_HALF_DEPTH,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  isHorseWithinPasture,
  PASTURE_BACK_DEPTH,
  PASTURE_FRONT_DEPTH,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_STEP,
  resolveHorsePlacement,
  stabilizeHorseStack,
  stepHorseStack,
} from './horseStackPhysics';
import soundtrackUrl from "../Elijah_K - The Mountain's Happy Song.mp3?url";
import horseThudUrl from '../free-sound-1674747349.mp3?url';
import resultTickUrl from '../free-sound-1674778893.mp3?url';
import resultTadaUrl from '../free-sound-1674895520.mp3?url';
import countFanfareUrl from '../free-sound-1674977569.mp3?url';
import farmAmbienceUrl from '../free-sound-1674978362.mp3?url';
import horseWhinniesUrl from '../free-sound-effects-HORSE3.mp3?url';
import './styles.css';

type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';

interface ActiveHorse {
  angle: number;
  baseAngle: number;
  depth: number;
  lateral: number;
  yaw: number;
}

interface LandingGuide {
  contact: Node3D;
  footprint: Node3D;
  root: Node3D;
}

interface StackedHorse {
  body: RigidBody3D;
  lost: boolean;
  node: Node3D;
}

const STACK_BASE_Y = 0.015;
// At a 90° camera azimuth, +X is toward the viewer and Z runs horizontally.
// The barn's near wall is around x = 0.03; the pile sits just ahead of it and
// centered across the farm's z = -4…-0.4 footprint.
const STACK_X = 0.9;
const STACK_Z = -2.15;
const PLACEMENT_HALF_DEPTH = 0.34;
const HORSE_SCALE = 0.00279;
const HORSE_VISUAL_CENTER_Y = 0.07875;
const GAME_DURATION_MS = 60_000;
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
  distance: 0.95,
  maxDistance: 3.4,
  minDistance: 0.78,
  minPolar: 0.14,
  polar: 0.42,
  smoothTime: 0.2,
  target: createVector3(STACK_X, 0.055, STACK_Z),
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
const resultHandCount = requireElement<HTMLElement>('result-hand-count');
const resultScore = requireElement<HTMLSpanElement>('result-score');
const resultCopy = requireElement<HTMLParagraphElement>('result-copy');
const replayButton = requireElement<HTMLButtonElement>('replay-button');
const restartButton = requireElement<HTMLButtonElement>('restart-game');
const dropButton = requireElement<HTMLButtonElement>('drop-horse');
const horsesLeftCopy = requireElement<HTMLSpanElement>('horses-left');
const timerCopy = requireElement<HTMLSpanElement>('drop-timer');
const timerFill = requireElement<HTMLSpanElement>('timer-fill');
const heightCopy = requireElement<HTMLSpanElement>('stack-height');
const paceCopy = requireElement<HTMLSpanElement>('pace-copy');
const gameCallout = requireElement<HTMLDivElement>('game-callout');
const heroTimer = requireElement<HTMLDivElement>('hero-timer');
const heroTimerCopy = requireElement<HTMLElement>('hero-timer-copy');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const soundtrack = createAudioTrack(soundtrackUrl, 0.36);
const farmAmbience = createAudioTrack(farmAmbienceUrl, 0.16, true);
const horseThud = createAudioTrack(horseThudUrl, 0.24);
const countFanfare = createAudioTrack(countFanfareUrl, 0.46);
const resultTada = createAudioTrack(resultTadaUrl, 0.52);
const horseWhinnies = createAudioTrack(horseWhinniesUrl, 0.22);
const resultTicks = Array.from({ length: RESULT_TICK_POOL_SIZE }, () =>
  createAudioTrack(resultTickUrl, 0.1),
);
// Keep this path indirect so Vite leaves the runtime module-relative URL untouched without warning.
const modelPathFromModule = '../models/';
const modelRoot = new URL(modelPathFromModule, import.meta.url).href.replace(/\/$/, '');

retryButton.addEventListener('click', () => window.location.reload());
let gameUiForError: FlightGameUi | null = null;
const { canvas, pipeline, renderState } = initializeRenderer();
const gameUi = createFlightGameUi(renderState, reducedMotion.matches);
gameUiForError = gameUi;
const gameUiModel: GameUiModel = {
  callout: 'Awaiting horses…',
  canPlace: false,
  handsShown: 0,
  height: '0.00 m',
  horsesPlaced: 0,
  resultComplete: false,
  resultCopy: 'The pasture is still assessing the situation.',
  resultHeight: '0.00 m',
  score: '0 pts',
  secondsRemaining: 0,
};

const scene = createNode3D(Node3DKind);
const horseLayer = createNode3D(Node3DKind, { name: 'horse-stack' });
addNodeChild(scene, horseLayer);
const landingGhostMaterial = createStandardPbrMaterial({
  alphaMode: 'blend',
  baseColor: 0xe8c65aff,
  doubleSided: true,
  emissive: 0x6b4b0dff,
  emissiveStrength: 0.18,
  metallic: 0,
  roughness: 0.72,
});
const landingFootprintMaterial = createStandardPbrMaterial({
  alphaMode: 'blend',
  baseColor: 0xffd166ff,
  doubleSided: true,
  emissive: 0x7a5410ff,
  emissiveStrength: 0.18,
  metallic: 0,
  roughness: 0.9,
});
const landingContactMaterial = createStandardPbrMaterial({
  alphaMode: 'blend',
  baseColor: 0xffe49aff,
  doubleSided: true,
  emissive: 0xb77b18ff,
  emissiveStrength: 0.4,
  metallic: 0,
  roughness: 0.75,
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
  scaleMax: 0.24,
  scaleMin: 0.09,
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
  scaleMax: 0.018,
  scaleMin: 0.004,
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
const lights: Scene3DLightsLike = {
  ambient: createAmbientLight({ color: 0xbdd0b5ff, intensity: 0.72 }),
  directional: directionalLight,
};
const shadowCamera = createCamera3D({
  far: 55,
  near: 0.1,
  projection: createOrthographicProjection({ halfHeight: 15, halfWidth: 9 }),
});
configureDirectionalShadowCamera3D(
  shadowCamera,
  sunDirection,
  createAabb(-9, -3, -9, 9, 26, 9),
);

let phase: GamePhase = 'loading';
let horseTemplate: Scene3D | null = null;
let landingGhost: Node3D | null = null;
let landingGuide: LandingGuide | null = null;
let physicsWorld: Physics3DWorld = createHorseStackWorld();
let activeHorse: ActiveHorse | null = null;
let stackedHorses: StackedHorse[] = [];
let horsesDropped = 0;
let aimDepth = 0;
let aimLateral = 0;
let indicatorAngle = 0;
let indicatorAngularVelocity = 0;
let indicatorUpdatedAt = performance.now();
let lastAimAt = performance.now();
let nextHorseAt = 0;
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
const measurementBodies: RigidBody3D[] = [];
const activePlacement = createHorsePlacementResult();
const placementContactNormal = createVector3(0, 1, 0);
const placementContactUp = createVector3(0, 1, 0);
const inputBounds = { height: 1, left: 0, top: 0, width: 1 };
const placementRay = {
  direction: createVector3(),
  origin: createVector3(),
};
const placementHit = createVector3();
const placementPlane = { a: 0, b: 1, c: 0, d: 0 };
let lastPointerClientX: number | null = null;
let lastPointerClientY: number | null = null;

bindGameControls();
bindRenderingLifecycle();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

async function start(): Promise<void> {
  setLoadingState('Herding the horses…');

  try {
    const [farm, horse] = await Promise.all([
      loadGltfScene(`${modelRoot}/farm`),
      loadGltfScene(`${modelRoot}/horse`),
    ]);

    mountFarm(farm);
    horseTemplate = horse;
    phase = 'ready';
    gameUi.setPhase('ready');
    updateCamera(1, cachedStackHeight);
    loadingPanel.classList.add('is-hidden');
    startPanel.hidden = false;
    startButton.disabled = false;
    sceneStatus.classList.add('is-ready');
    statusCopy.textContent = 'Stable enough';
    const now = performance.now();
    updateHud(now);
    updateFlightUi(0, now, cachedStackHeight);
    renderFrame();
  } catch (error) {
    showSceneError('Unable to load Horse Stacker.', error);
  }
}

function mountFarm(model: Scene3D): void {
  const wrapper = createNode3D(Node3DKind);
  const scale = 0.018;
  wrapper.scale.x = scale;
  wrapper.scale.y = scale;
  wrapper.scale.z = scale;
  wrapper.position.x = 0.5;
  wrapper.position.y = -0.02;
  wrapper.position.z = -2.2;
  invalidateNodeLocalTransform(wrapper);
  addNodeChild(wrapper, model.root);
  addNodeChild(scene, wrapper);
}

function createHorseVisual(
  materialOverride: ReturnType<typeof createStandardPbrMaterial> | null = null,
  alpha = 1,
): Node3D {
  if (horseTemplate === null) throw new Error('Horse model is not loaded');

  const pivot = createNode3D(Node3DKind);
  pivot.alpha = alpha;
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

function createLandingGuide(): LandingGuide {
  const root = createNode3D(Node3DKind, { name: 'landing-guide' });
  const footprint = createMesh(
    createPlaneMeshGeometry(HORSE_HALF_DEPTH * 2, HORSE_COLLIDER_HALF_LENGTH * 2),
    [landingFootprintMaterial],
  );
  footprint.alpha = 0.24;
  footprint.name = 'placement-footprint';
  addNodeChild(root, footprint);

  const contact = createMesh(
    createRingMeshGeometry(0.011, 0.019, 20),
    [landingContactMaterial],
  );
  contact.alpha = 0.78;
  contact.name = 'placement-contact';
  addNodeChild(root, contact);
  return { contact, footprint, root };
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

function startGame(): void {
  if (horseTemplate === null || phase === 'loading') return;

  const now = performance.now();
  startGameAudio(now);
  physicsWorld = createHorseStackWorld();
  physicsAccumulator = 0;
  activeHorse = null;
  stackedHorses = [];
  horsesDropped = 0;
  aimDepth = 0;
  aimLateral = 0;
  indicatorAngle = 0;
  indicatorAngularVelocity = 0;
  indicatorUpdatedAt = now;
  lastAimAt = now;
  nextHorseAt = 0;
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
  removeNodeChildren(horseLayer);
  landingGhost = createHorseVisual(landingGhostMaterial, 0.62);
  landingGhost.name = 'landing-preview';
  addNodeChild(horseLayer, landingGhost);
  landingGuide = createLandingGuide();
  addNodeChild(horseLayer, landingGuide.root);
  clearParticleEmitter3D(dustEmitter);
  clearParticleEmitter3D(celebrationEmitter);
  dustState = createParticleEmitterState();
  celebrationState = createParticleEmitterState();

  phase = 'playing';
  gameUi.setPhase('playing');
  startPanel.hidden = true;
  timeUpPanel.hidden = true;
  resultPanel.hidden = true;
  resultPanel.classList.remove('is-total-revealed');
  resultHandCount.textContent = '0';
  resultScore.textContent = '0.00 m';
  resultCopy.textContent = 'The pasture is still assessing the situation.';
  replayButton.hidden = true;
  restartButton.hidden = false;
  dropButton.disabled = true;
  viewer.classList.add('is-playing');
  viewer.classList.remove('is-finished', 'is-time-up', 'is-bumping', 'is-panicking');
  sceneStatus.classList.add('is-ready');
  statusCopy.textContent = '60 seconds. Go!';
  gameCallout.textContent = 'Gold horse = exact placement.';
  hudDirty = true;
  spawnHorse(now);
  renderRequested = true;
}

function spawnHorse(now: number): void {
  if (phase !== 'playing' || now >= gameEndsAt) return;

  indicatorAngle = 0;
  indicatorAngularVelocity = 0;
  indicatorUpdatedAt = now;
  lastAimAt = now;
  const baseAngle = getRandomHorsePlacementAngle();
  activeHorse = {
    angle: baseAngle,
    baseAngle,
    depth: aimDepth,
    lateral: aimLateral,
    yaw: getRandomHorsePlacementYaw(),
  };
  if (landingGhost !== null) landingGhost.enabled = true;
  if (landingGuide !== null) landingGuide.root.enabled = true;
  dropButton.disabled = false;
  statusCopy.textContent = `Horse ${String(horsesDropped + 1).padStart(2, '0')} queued`;
  gameCallout.textContent =
    getPaceLevel(horsesDropped) >= 4
      ? 'Ring marks first contact.'
      : 'Gold horse = exact placement.';
  if (lastPointerClientX !== null && lastPointerClientY !== null) {
    setAimFromClientPoint(lastPointerClientX, lastPointerClientY, now);
  }
  updateActiveHorse(now);
}

function updateActiveHorse(now: number): void {
  const current = activeHorse;
  if (current === null) return;

  updateIndicatorTeeter(now);
  const horizontalLimit = getAimHalfWidth();
  current.lateral = clamp(aimLateral, -horizontalLimit, horizontalLimit);
  current.depth = clamp(aimDepth, -PLACEMENT_HALF_DEPTH, PLACEMENT_HALF_DEPTH);
  current.angle = current.baseAngle + indicatorAngle;
  updateLandingGhost(current);
}

function commitHorsePlacement(now: number): void {
  const current = activeHorse;
  if (current === null || phase !== 'playing') return;

  resolveActiveHorsePlacement(current);
  const landingY = activePlacement.centerY;
  const body = addHorseBody(
    physicsWorld,
    current.lateral,
    landingY,
    current.angle,
    current.depth,
    current.yaw,
  );
  body.velocityX = 0;
  body.velocityY = 0;
  body.velocityZ = 0;
  body.angularVelocityX = 0;
  body.angularVelocityY = 0;
  body.angularVelocityZ = 0;
  const lassoCount = attachHorseToPile(
    physicsWorld,
    body,
    activePlacement,
  );
  stabilizeHorseStack(physicsWorld);
  const node = createHorseVisual();
  setHorseVisualPlacement(
    node,
    current.lateral,
    current.depth,
    landingY,
    current.angle,
    current.yaw,
  );
  addNodeChild(horseLayer, node);
  stackedHorses.push({ body, lost: false, node });
  activeHorse = null;
  dropButton.disabled = true;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingGuide !== null) landingGuide.root.enabled = false;
  horsesDropped++;
  restartAudioTrack(horseThud, 'Horse thud');

  const tilt = Math.abs(current.angle);
  gameCallout.textContent =
    lassoCount > 1
      ? 'DOUBLE HORSE LASSO!'
      : lassoCount > 0
        ? 'Horse magnet engaged!'
        : tilt > 0.42
          ? 'Precariously placed!'
          : tilt > 0.16
            ? 'A little crooked.'
            : 'Placed gently.';
  nextHorseAt = now + getNextHorseDelay(horsesDropped);
  hudDirty = true;
  renderRequested = true;
}

function updateGame(now: number): void {
  if (phase === 'playing') {
    if (now >= gameEndsAt) {
      beginSettling(now);
      return;
    }
    if (activeHorse === null && now >= nextHorseAt) {
      spawnHorse(now);
    }
  } else if (phase === 'settling' && now >= finishAt) {
    finishGame(now);
  }
}

function beginSettling(now: number): void {
  phase = 'settling';
  gameUi.setPhase('settling');
  stopAudioTrack(soundtrack);
  restartAudioTrack(countFanfare, 'Count fanfare');
  activeHorse = null;
  finishAt = now + FINAL_SETTLE_SECONDS * 1000;
  dropButton.disabled = true;
  restartButton.hidden = true;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingGuide !== null) landingGuide.root.enabled = false;
  timeUpPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-panicking');
  viewer.classList.add('is-time-up');
  statusCopy.textContent = 'Time up!';
  gameCallout.textContent = 'Hands off the herd!';
  hudDirty = true;
  renderRequested = true;
}

function finishGame(now: number): void {
  phase = 'finished';
  gameUi.setPhase('finished');
  finalHeight = getCurrentStackHeight();
  cachedStackHeight = finalHeight;
  finalSurvivors = stackedHorses.filter(
    ({ body, lost }) =>
      !lost && body.y > -1 && isHorseWithinPasture(body, HORSE_HALF_WIDTH),
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
  resultHandCount.textContent = '0';
  resultScore.textContent = '0.00 m';
  resultCopy.textContent = 'Counting the herd, one hand at a time…';
  replayButton.hidden = true;
  resultPanel.classList.remove('is-total-revealed');
  timeUpPanel.hidden = true;
  resultPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-time-up', 'is-panicking', 'is-bumping');
  viewer.classList.add('is-finished');
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
  resultHandsShown = Math.max(resultHandsShown, targetCount);
  return resultHandsShown > previousCount;
}

function completeResultAnimation(): void {
  resultAnimationStart = 0;
  restartAudioTrack(resultTada, 'Result fanfare');
  maybePlayCelebrationWhinny();
  appendHorseHands(resultHands);
  resultHandCount.textContent = String(resultHands);
  resultScore.textContent = formatHeight(finalHeight);
  resultCopy.textContent = `${getScore(finalHeight).toLocaleString()} points · ${finalSurvivors} of ${horsesDropped} horses remained in the general vicinity.`;
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
    STACK_X + point.x,
    STACK_BASE_Y + point.y,
    STACK_Z + point.z,
    0xe8d6a9cc,
  );
  maybePlayCollisionWhinny(now);
}

function synchronizeHorseVisuals(): void {
  let retainedCount = 0;
  for (const horse of stackedHorses) {
    if (horse.lost) continue;
    const body = horse.body;

    // Leave enough void beyond the collider for the whole tumble to remain visible.
    if (body.y < -1 || !isHorseWithinPasture(body, 1.5)) {
      horse.lost = true;
      horse.node.enabled = false;
      removePhysics3DBody(physicsWorld, body);
      continue;
    }

    setHorseVisualFromBody(horse.node, body);
    stackedHorses[retainedCount++] = horse;
  }
  // Fallen horses have already left the physics world and score calculation;
  // keep them out of every subsequent placement, height, and visual scan too.
  stackedHorses.length = retainedCount;
}

function updateLandingGhost(current: Readonly<ActiveHorse>): void {
  if (landingGhost === null) return;

  landingGhost.enabled =
    Math.abs(current.lateral) <= PASTURE_HALF_WIDTH &&
    current.depth >= PASTURE_BACK_DEPTH &&
    current.depth <= PASTURE_FRONT_DEPTH;
  if (!landingGhost.enabled) {
    if (landingGuide !== null) landingGuide.root.enabled = false;
    return;
  }
  resolveActiveHorsePlacement(current);
  setHorseVisualPlacement(
    landingGhost,
    current.lateral,
    current.depth,
    activePlacement.centerY,
    current.angle,
    current.yaw,
  );
  updateLandingGuide(current, activePlacement);
}

function resolveActiveHorsePlacement(current: Readonly<ActiveHorse>): void {
  let startY = Math.max(PASTURE_TOP_Y + 0.5, cachedStackHeight + 0.4);
  for (const horse of stackedHorses) {
    if (!horse.lost) startY = Math.max(startY, getHorseTopY(horse.body) + 0.24);
  }
  resolveHorsePlacement(
    activePlacement,
    physicsWorld,
    current.lateral,
    current.depth,
    current.angle,
    current.yaw,
    startY,
  );
}

function updateLandingGuide(
  current: Readonly<ActiveHorse>,
  placement: Readonly<HorsePlacementResult>,
): void {
  const guide = landingGuide;
  if (guide === null) return;
  guide.root.enabled = true;

  guide.footprint.position.x = STACK_X + current.depth;
  guide.footprint.position.y = STACK_BASE_Y + placement.contactY + 0.0015;
  guide.footprint.position.z = STACK_Z - current.lateral;
  const projectedHalfLength =
    Math.abs(Math.cos(current.angle)) * HORSE_COLLIDER_HALF_LENGTH +
    Math.abs(Math.sin(current.angle)) * HORSE_HALF_HEIGHT;
  guide.footprint.scale.z = projectedHalfLength / HORSE_COLLIDER_HALF_LENGTH;
  setQuaternionFromEuler(guide.footprint.rotation, 0, current.yaw, 0);
  invalidateNodeLocalTransform(guide.footprint);

  guide.contact.position.x = STACK_X + placement.contactX;
  guide.contact.position.y = STACK_BASE_Y + placement.contactY + 0.0025;
  guide.contact.position.z = STACK_Z + placement.contactZ;
  placementContactNormal.x = placement.normalX;
  placementContactNormal.y = placement.normalY;
  placementContactNormal.z = placement.normalZ;
  setQuaternionFromUnitVectors(
    guide.contact.rotation,
    placementContactUp,
    placementContactNormal,
  );
  invalidateNodeLocalTransform(guide.contact);
}

function setHorseVisualPlacement(
  node: Node3D,
  lateral: number,
  depth: number,
  physicsY: number,
  angle: number,
  yaw: number,
): void {
  node.position.x = STACK_X + depth;
  node.position.y = STACK_BASE_Y + physicsY;
  node.position.z = STACK_Z - lateral;
  setQuaternionFromEuler(node.rotation, angle, yaw, 0, 'YXZ');
  invalidateNodeLocalTransform(node);
}

function setHorseVisualFromBody(node: Node3D, body: Readonly<RigidBody3D>): void {
  node.position.x = STACK_X + body.x;
  node.position.y = STACK_BASE_Y + body.y;
  node.position.z = STACK_Z + body.z;
  node.rotation.x = body.orientationX;
  node.rotation.y = body.orientationY;
  node.rotation.z = body.orientationZ;
  node.rotation.w = body.orientationW;
  invalidateNodeLocalTransform(node);
}

function updateCamera(deltaTime: number, height: number): void {
  const rise = clamp(height / 1.1, 0, 1);
  const herdProgress = clamp(horsesDropped / 50, 0, 1);
  const restingHorseTop = PASTURE_TOP_Y + HORSE_HALF_HEIGHT * 1.2;
  const stackTop = Math.max(restingHorseTop, height);
  // Frame the useful pasture-to-placement interval instead of centering the
  // empty air above the newest horse. The focus rises from 44% to 54% of the
  // stack so the ground remains visible even when the pile gets tall.
  const groundFocus = 0.44 + rise * 0.1;
  const desiredTargetY =
    STACK_BASE_Y +
    PASTURE_TOP_Y +
    (stackTop - PASTURE_TOP_Y) * groundFocus;
  if (Math.abs(desiredTargetY - cameraController.target.y) > 0.001) renderRequested = true;
  const follow = 1 - Math.exp(-deltaTime * 2.4);
  cameraController.target.y += (desiredTargetY - cameraController.target.y) * follow;
  cameraController.target.x += (STACK_X - cameraController.target.x) * follow;
  cameraController.target.z = STACK_Z;
  cameraController.goalAzimuth = Math.PI / 2 + rise * 0.08 + herdProgress * 0.02;
  cameraController.goalPolar = 0.42 + rise * 0.08;
  cameraController.goalDistance = Math.min(3.25, 0.95 + height * 0.88 + herdProgress * 0.28);
  updateOrbitCameraController(cameraController, camera, deltaTime);
}

function updateHud(now: number, stackHeight = cachedStackHeight): void {
  setTextIfChanged(horsesLeftCopy, String(horsesDropped));
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
  for (const horse of stackedHorses) {
    if (!horse.lost) measurementBodies.push(horse.body);
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
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    if (phase !== 'playing' || activeHorse === null) return;
    setAimFromClientPoint(event.clientX, event.clientY, performance.now());
  });

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || phase !== 'playing') return;
    canvas.focus({ preventScroll: true });
    const now = performance.now();
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    setAimFromClientPoint(event.clientX, event.clientY, now);
    placeActiveHorse(now);
  });

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    if (phase !== 'playing') return;
    const now = performance.now();
    if (event.key === 'ArrowLeft') {
      const horizontalLimit = getAimHalfWidth();
      setAimPosition(aimLateral - 0.06, aimDepth, horizontalLimit, now);
    } else if (event.key === 'ArrowRight') {
      const horizontalLimit = getAimHalfWidth();
      setAimPosition(aimLateral + 0.06, aimDepth, horizontalLimit, now);
    } else if (event.key === 'ArrowUp') {
      setAimPosition(aimLateral, aimDepth - 0.055, getAimHalfWidth(), now);
    } else if (event.key === 'ArrowDown') {
      setAimPosition(aimLateral, aimDepth + 0.055, getAimHalfWidth(), now);
    } else if (event.key === ' ' || event.key === 'Enter') {
      placeActiveHorse(now);
    } else {
      return;
    }
    event.preventDefault();
  });

  dropButton.addEventListener('click', () => placeActiveHorse(performance.now()));
  startButton.addEventListener('click', startGame);
  replayButton.addEventListener('click', startGame);
  restartButton.addEventListener('click', startGame);
}

function placeActiveHorse(now: number): void {
  if (activeHorse === null) return;
  if (now >= gameEndsAt) {
    beginSettling(now);
    return;
  }
  // Touch devices do not necessarily send a pointermove before pointerdown, so refresh
  // the hidden horse's projected landing pose at the exact moment it is placed.
  updateActiveHorse(now);
  commitHorsePlacement(now);
}

function setAimFromClientPoint(clientX: number, clientY: number, now: number): void {
  if (activeHorse === null) return;
  const normalizedX = clamp((clientX - inputBounds.left) / inputBounds.width, 0, 1);
  const normalizedY = clamp((clientY - inputBounds.top) / inputBounds.height, 0, 1);
  const aspect = inputBounds.width / inputBounds.height;
  if (
    !getCamera3DScreenToWorldRay(
      placementRay,
      camera,
      normalizedX * 2 - 1,
      1 - normalizedY * 2,
      aspect,
    )
  ) {
    return;
  }

  // Aim on a horizontal slice through the camera's current lower-stack focus.
  // This keeps screen center pinned to the useful placement field while making
  // vertical pointer motion move toward or away from the camera.
  placementPlane.d = -cameraController.target.y;
  if (!intersectCamera3DRayWithPlane(placementHit, placementRay, placementPlane)) return;

  const horizontalLimit = getAimHalfWidth();
  setAimPosition(
    STACK_Z - placementHit.z,
    placementHit.x - STACK_X,
    horizontalLimit,
    now,
  );
}

function setAimPosition(
  targetLateral: number,
  targetDepth: number,
  horizontalLimit: number,
  now: number,
): void {
  const nextLateral = clamp(targetLateral, -horizontalLimit, horizontalLimit);
  const elapsed = clamp((now - lastAimAt) / 1000, 0.008, 0.08);
  const pointerVelocity = (nextLateral - aimLateral) / elapsed;
  indicatorAngularVelocity = clamp(
    indicatorAngularVelocity - clamp(pointerVelocity * 0.32, -4.2, 4.2),
    -INDICATOR_MAX_SPIN,
    INDICATOR_MAX_SPIN,
  );
  aimLateral = nextLateral;
  aimDepth = clamp(targetDepth, -PLACEMENT_HALF_DEPTH, PLACEMENT_HALF_DEPTH);
  lastAimAt = now;
}

function getAimHalfWidth(): number {
  if (camera.projection.kind !== 'perspective') return 0.36;
  const visibleHalfWidth =
    cameraController.distance *
    Math.tan(camera.projection.fovY / 2) *
    camera.projection.aspect;
  return Math.min(PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH * 1.2, visibleHalfWidth * 0.88);
}

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  inputBounds.left = bounds.left;
  inputBounds.top = bounds.top;
  inputBounds.width = Math.max(bounds.width, 1);
  inputBounds.height = Math.max(bounds.height, 1);
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
  gameUi.resize(width, height, nextPixelRatio);
}

function setLoadingState(copy: string): void {
  loadingCopy.textContent = copy;
  statusCopy.textContent = copy.replace('…', '');
}

function renderFrame(): void {
  const ghostEnabled = landingGhost?.enabled ?? false;
  const guideEnabled = landingGuide?.root.enabled ?? false;
  if (landingGhost !== null) landingGhost.enabled = false;
  if (landingGuide !== null) landingGuide.root.enabled = false;
  drawGlScene3DShadowMap(renderState, scene, shadowCamera, directionalLight);
  if (landingGhost !== null) landingGhost.enabled = ghostEnabled;
  if (landingGuide !== null) landingGuide.root.enabled = guideEnabled;
  beginGlRenderEffectPipeline(renderState, pipeline, 'linear');
  renderGlBackground(renderState);
  renderState.gl.depthMask(true);
  renderState.gl.clearDepth(1);
  renderState.gl.clear(renderState.gl.DEPTH_BUFFER_BIT);
  drawGlScene3D(renderState, scene, camera, lights);
  endGlRenderEffectPipeline(renderState, pipeline, []);
  // Composite the sRGB Scene2D UI directly onto the presented frame so it
  // remains crisp and is not gamma-encoded a second time.
  renderState.gl.disable(renderState.gl.DEPTH_TEST);
  renderState.gl.disable(renderState.gl.CULL_FACE);
  renderState.gl.enable(renderState.gl.BLEND);
  renderState.gl.depthMask(false);
  gameUi.render();
  renderState.gl.depthMask(true);
  renderState.gl.disable(renderState.gl.BLEND);
  renderState.gl.enable(renderState.gl.CULL_FACE);
  renderState.gl.enable(renderState.gl.DEPTH_TEST);
}

function enterFrame(now: number): void {
  const deltaTime = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  if (phase !== 'loading' && isViewerVisible && document.visibilityState !== 'hidden') {
    const gameIsMoving = phase === 'playing' || phase === 'settling';
    if (gameIsMoving) {
      updateGame(now);
      stepGamePhysics(now, deltaTime);
      synchronizeHorseVisuals();
      cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
      // Resolve the indicator after this frame's physics movement so its exact
      // shape-cast stop matches the pile that is about to be rendered.
      if (phase === 'playing' && activeHorse !== null) updateActiveHorse(now);
      renderRequested = true;
    }
    if (phase === 'finished' && resultAnimationStart !== 0) {
      updateResultAnimation(now);
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
    if (gameIsMoving || hudDirty) updateHud(now, displayedHeight);
    const uiIsAnimating = updateFlightUi(deltaTime, now, displayedHeight);
    const cameraIsMoving =
      Math.abs(cameraController.distance - cameraController.goalDistance) > 0.001 ||
      Math.abs(cameraController.polar - cameraController.goalPolar) > 0.0001 ||
      Math.abs(cameraController.azimuth - cameraController.goalAzimuth) > 0.0001;
    if (renderRequested || gameIsMoving || particlesAreMoving || cameraIsMoving || uiIsAnimating) {
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
    'Horse Stacker game. Aim across the field with the pointer or arrow keys, then click, tap, Space, or Enter to place.',
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
  gameUiForError?.hide();
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

function updateFlightUi(deltaTime: number, now: number, stackHeight: number): boolean {
  gameUiModel.callout = gameCallout.textContent ?? '';
  gameUiModel.canPlace = phase === 'playing' && activeHorse !== null;
  gameUiModel.handsShown = resultHandsShown;
  gameUiModel.height = heightCopy.textContent ?? formatHeight(stackHeight);
  gameUiModel.horsesPlaced = horsesDropped;
  gameUiModel.resultComplete = phase === 'finished' && resultAnimationStart === 0;
  gameUiModel.resultCopy = resultCopy.textContent ?? '';
  gameUiModel.resultHeight = resultScore.textContent ?? '0.00 m';
  gameUiModel.score = paceCopy.textContent ?? `${getScore(stackHeight).toLocaleString()} pts`;
  gameUiModel.secondsRemaining =
    phase === 'playing' ? Math.max(0, gameEndsAt - now) / 1000 : 0;
  return gameUi.update(deltaTime, now, gameUiModel);
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
