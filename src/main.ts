import type {
  Camera3D,
  ImportDiagnostic,
  Node3D,
  ParticleEmitter3D,
  ParticleEmitterConfig,
  ParticleEmitterState,
  Physics2DWorld,
  RigidBody2D,
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
  createBoxMeshGeometry,
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
  removeNodeChildren,
  removePhysics2DBody,
  renderGlBackground,
  setNodeLocalMatrix4,
  setNodeTransform3D,
  setQuaternionFromEuler,
  stepParticleEmitter3D,
  updateOrbitCameraController,
} from '@flighthq/sdk';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { drawGlScene3D, drawGlScene3DShadowMap } from '@flighthq/sdk/rendering';
import {
  addHorseBody,
  createHorseStackWorld,
  FINAL_SETTLE_SECONDS,
  getDropWindow,
  getHorseDropMotion,
  getHorseSpawnY,
  getNextHorseDelay,
  getPaceLevel,
  getSupportedStackHeight,
  getSweepSpeed,
  HORSE_HALF_HEIGHT,
  HORSE_HALF_WIDTH,
  PASTURE_HALF_WIDTH,
  PASTURE_TOP_Y,
  PHYSICS_GRAVITY,
  PHYSICS_STEP,
  PLATFORM_HALF_WIDTH,
  stepHorseStack,
  TOTAL_HORSES,
} from './horseStackPhysics';
import './styles.css';

type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';

interface ActiveHorse {
  angle: number;
  deadline: number;
  horizontalJitter: number;
  node: Node3D;
  seed: number;
  spinJitter: number;
  spawnY: number;
  x: number;
  y: number;
}

interface StackedHorse {
  body: RigidBody2D;
  lost: boolean;
  node: Node3D;
}

const STACK_BASE_Y = 0.015;
// At a 90° camera azimuth, +X is toward the viewer and Z runs horizontally.
// The barn's near wall is around x = 0.03; the pile sits just ahead of it and
// centered across the farm's z = -4…-0.4 footprint.
const STACK_X = 0.9;
const STACK_Z = -2.15;
const HORSE_SCALE = 0.00124;
const HORSE_VISUAL_CENTER_Y = 0.035;
const FIXED_STEP_LIMIT = 6;
const GAME_VIEW = {
  azimuth: Math.PI / 2,
  distance: 2.95,
  maxDistance: 7,
  minDistance: 2.4,
  minPolar: 0.02,
  polar: 0.1,
  smoothTime: 0.18,
  target: createVector3(STACK_X, 0.68, STACK_Z),
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
const resultPanel = requireElement<HTMLDivElement>('result-panel');
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
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Keep this path indirect so Vite leaves the runtime module-relative URL untouched without warning.
const modelPathFromModule = '../models/';
const modelRoot = new URL(modelPathFromModule, import.meta.url).href.replace(/\/$/, '');

retryButton.addEventListener('click', () => window.location.reload());
const { canvas, pipeline, renderState } = initializeRenderer();

const scene = createNode3D(Node3DKind);
const horseLayer = createNode3D(Node3DKind, { name: 'horse-stack' });
addNodeChild(scene, horseLayer);
const landingGhostMaterial = createStandardPbrMaterial({
  alphaMode: 'blend',
  baseColor: 0xffd447ff,
  doubleSided: true,
  emissive: 0x5b3b00ff,
  emissiveStrength: 0.45,
  metallic: 0,
  roughness: 0.48,
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
  point: [],
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
let physicsWorld: Physics2DWorld = createHorseStackWorld();
let activeHorse: ActiveHorse | null = null;
let stackedHorses: StackedHorse[] = [];
let horsesDropped = 0;
let aimOffset = 0;
let nextHorseAt = 0;
let finishAt = 0;
let finalHeight = 0;
let cachedStackHeight = 0;
let physicsAccumulator = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
let impactFlashUntil = 0;
let panicFlashUntil = 0;
let lastImpactAt = 0;
let hudDirty = true;
const measurementBodies: RigidBody2D[] = [];
const inputBounds = { left: 0, width: 1 };

addStage(scene);
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

function addStage(root: Node3D): void {
  const platform = createMesh(
    createBoxMeshGeometry(0.22, 0.015, PLATFORM_HALF_WIDTH * 2),
    [
      createStandardPbrMaterial({
        baseColor: 0xb79a66ff,
        metallic: 0,
        roughness: 0.9,
      }),
    ],
  );
  platform.position.x = STACK_X;
  platform.position.y = STACK_BASE_Y - 0.0075;
  platform.position.z = STACK_Z;
  invalidateNodeLocalTransform(platform);
  addNodeChild(root, platform);
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

  physicsWorld = createHorseStackWorld();
  physicsAccumulator = 0;
  activeHorse = null;
  stackedHorses = [];
  horsesDropped = 0;
  aimOffset = 0;
  nextHorseAt = 0;
  finishAt = 0;
  finalHeight = 0;
  cachedStackHeight = 0;
  impactFlashUntil = 0;
  panicFlashUntil = 0;
  lastImpactAt = 0;
  removeNodeChildren(horseLayer);
  landingGhost = createHorseVisual(landingGhostMaterial, 0.36);
  landingGhost.name = 'landing-preview';
  addNodeChild(horseLayer, landingGhost);
  clearParticleEmitter3D(dustEmitter);
  clearParticleEmitter3D(celebrationEmitter);
  dustState = createParticleEmitterState();
  celebrationState = createParticleEmitterState();

  phase = 'playing';
  startPanel.hidden = true;
  resultPanel.hidden = true;
  restartButton.hidden = false;
  dropButton.disabled = false;
  viewer.classList.add('is-playing');
  viewer.classList.remove('is-finished', 'is-bumping', 'is-panicking');
  sceneStatus.classList.add('is-ready');
  statusCopy.textContent = 'Horse 01 incoming';
  gameCallout.textContent = 'Follow the yellow horse…';
  hudDirty = true;
  spawnHorse(performance.now());
  renderRequested = true;
}

function spawnHorse(now: number): void {
  if (phase !== 'playing' || horsesDropped >= TOTAL_HORSES) return;

  const node = createHorseVisual();
  addNodeChild(horseLayer, node);
  const dropWindow = getDropWindow(horsesDropped);
  const spawnY = getHorseSpawnY(cachedStackHeight);
  activeHorse = {
    angle: 0,
    deadline: now + dropWindow * 1000,
    horizontalJitter: Math.random() - 0.5,
    node,
    seed: Math.random() * Math.PI * 2,
    spinJitter: Math.random() - 0.5,
    spawnY,
    x: 0,
    y: spawnY,
  };
  if (landingGhost !== null) landingGhost.enabled = true;
  aimOffset = (Math.random() - 0.5) * 0.16;
  statusCopy.textContent = `Horse ${String(horsesDropped + 1).padStart(2, '0')} incoming`;
  gameCallout.textContent =
    getPaceLevel(horsesDropped) >= 4
      ? 'The sky is mostly horse.'
      : 'Guide it onto the yellow ghost.';
  updateActiveHorse(now);
}

function updateActiveHorse(now: number, allowAutoDrop = true): void {
  const current = activeHorse;
  if (current === null) return;

  const sweep = getAutoSweep(current, now);
  const horizontalLimit = PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH * 1.2;
  current.x = clamp(sweep + aimOffset, -horizontalLimit, horizontalLimit);
  current.angle = Math.sin(now * 0.0051 + current.seed) * (0.09 + getPaceLevel(horsesDropped) * 0.018);
  const dropWindowMs = getDropWindow(horsesDropped) * 1000;
  const descentProgress = clamp(1 - (current.deadline - now) / dropWindowMs, 0, 1);
  const surfaceY = getLandingSurfaceY(current.x);
  const lockY = surfaceY + getHorseVerticalExtent(current.angle) + HORSE_HALF_HEIGHT * 2.5;
  current.y = current.spawnY + (lockY - current.spawnY) * descentProgress;
  setHorseVisualTransform(current.node, current.x, current.y, current.angle);
  updateLandingGhost(current, now);

  if (allowAutoDrop && now >= current.deadline) {
    dropActiveHorse(now, true);
  }
}

function dropActiveHorse(now: number, forced: boolean): void {
  const current = activeHorse;
  if (current === null || phase !== 'playing') return;

  const body = addHorseBody(physicsWorld, current.x, current.y, current.angle);
  const sweepDirection = Math.cos(now * 0.001 * getSweepSpeed(horsesDropped) + current.seed);
  const motion = getHorseDropMotion(
    horsesDropped,
    sweepDirection,
    current.horizontalJitter,
    current.spinJitter,
    forced,
  );
  body.velocityX = motion.velocityX;
  body.velocityY = motion.velocityY;
  body.angularVelocity = motion.angularVelocity;
  stackedHorses.push({ body, lost: false, node: current.node });
  activeHorse = null;
  if (landingGhost !== null) landingGhost.enabled = false;
  horsesDropped++;

  if (forced) {
    panicFlashUntil = now + 440;
    gameCallout.textContent = 'PANIC DROP!';
  } else {
    gameCallout.textContent = horsesDropped % 4 === 0 ? 'Faster now!' : 'Neigh problem.';
  }

  if (horsesDropped >= TOTAL_HORSES) {
    phase = 'settling';
    finishAt = now + FINAL_SETTLE_SECONDS * 1000;
    dropButton.disabled = true;
    statusCopy.textContent = 'Everybody hold still';
    gameCallout.textContent = 'The judges are measuring…';
  } else {
    nextHorseAt = now + getNextHorseDelay(horsesDropped);
  }
  hudDirty = true;
  renderRequested = true;
}

function updateGame(now: number): void {
  if (phase === 'playing') {
    if (activeHorse !== null) {
      updateActiveHorse(now);
    } else if (now >= nextHorseAt) {
      spawnHorse(now);
    }
  } else if (phase === 'settling' && now >= finishAt) {
    finishGame();
  }
}

function finishGame(): void {
  phase = 'finished';
  finalHeight = getCurrentStackHeight();
  cachedStackHeight = finalHeight;
  const survivors = stackedHorses.filter(
    ({ body, lost }) =>
      !lost && body.y > -1 && Math.abs(body.x) <= PASTURE_HALF_WIDTH + HORSE_HALF_WIDTH,
  ).length;
  resultScore.textContent = formatHeight(finalHeight);
  resultCopy.textContent = `${survivors} of ${TOTAL_HORSES} horses remained in the general vicinity.`;
  resultPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-panicking', 'is-bumping');
  viewer.classList.add('is-finished');
  statusCopy.textContent = 'Officially measured';
  gameCallout.textContent =
    finalHeight >= 0.45
      ? 'A monument to poor judgement.'
      : 'Structurally questionable. Perfect.';

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
  hudDirty = true;
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
}

function synchronizeHorseVisuals(): void {
  for (const horse of stackedHorses) {
    if (horse.lost) continue;
    const body = horse.body;
    setHorseVisualTransform(horse.node, body.x, body.y, body.angle);

    // Leave enough void beyond the collider for the whole tumble to remain visible.
    if (body.y < -1 || Math.abs(body.x) > PASTURE_HALF_WIDTH + 1.5) {
      horse.lost = true;
      horse.node.enabled = false;
      removePhysics2DBody(physicsWorld, body);
    }
  }
}

function updateLandingGhost(current: Readonly<ActiveHorse>, now: number): void {
  if (landingGhost === null) return;

  const sweepDirection = Math.cos(now * 0.001 * getSweepSpeed(horsesDropped) + current.seed);
  const motion = getHorseDropMotion(
    horsesDropped,
    sweepDirection,
    current.horizontalJitter,
    current.spinJitter,
    false,
  );
  let previewX = current.x;
  let previewAngle = current.angle;

  // Two inexpensive passes account for horizontal drift changing which part of
  // the irregular pile the horse is projected to meet.
  for (let pass = 0; pass < 2; pass++) {
    const landingY = getLandingSurfaceY(previewX) + getHorseVerticalExtent(previewAngle);
    const fallDistance = Math.max(0, current.y - landingY);
    const flightTime =
      (motion.velocityY +
        Math.sqrt(motion.velocityY * motion.velocityY + 2 * PHYSICS_GRAVITY * fallDistance)) /
      PHYSICS_GRAVITY;
    previewX = current.x + motion.velocityX * flightTime;
    previewAngle = current.angle + motion.angularVelocity * flightTime;
  }

  landingGhost.enabled = Math.abs(previewX) <= PASTURE_HALF_WIDTH;
  if (!landingGhost.enabled) return;
  const previewY = getLandingSurfaceY(previewX) + getHorseVerticalExtent(previewAngle) + 0.003;
  setHorseVisualTransform(landingGhost, previewX, previewY, previewAngle);
}

function getLandingSurfaceY(x: number): number {
  let surfaceY = Math.abs(x) <= PLATFORM_HALF_WIDTH + HORSE_HALF_WIDTH ? 0 : PASTURE_TOP_Y;
  const horizontalReach = HORSE_HALF_WIDTH * 1.85;

  for (const horse of stackedHorses) {
    const body = horse.body;
    if (
      horse.lost ||
      body.y < PASTURE_TOP_Y ||
      Math.abs(body.x - x) > horizontalReach ||
      Math.abs(body.velocityY) > 1.2
    ) {
      continue;
    }
    surfaceY = Math.max(surfaceY, body.y + getHorseVerticalExtent(body.angle));
  }
  return surfaceY;
}

function getHorseVerticalExtent(angle: number): number {
  return (
    Math.abs(Math.cos(angle)) * HORSE_HALF_HEIGHT +
    Math.abs(Math.sin(angle)) * HORSE_HALF_WIDTH
  );
}

function setHorseVisualTransform(node: Node3D, x: number, physicsY: number, angle: number): void {
  node.position.x = STACK_X;
  node.position.y = STACK_BASE_Y + physicsY;
  node.position.z = STACK_Z - x;
  setQuaternionFromEuler(node.rotation, angle, 0, 0);
  invalidateNodeLocalTransform(node);
}

function updateCamera(deltaTime: number, height: number): void {
  const desiredTargetY = STACK_BASE_Y + 0.72 + Math.max(0, height - 0.12) * 0.7;
  if (Math.abs(desiredTargetY - cameraController.target.y) > 0.001) renderRequested = true;
  const follow = 1 - Math.exp(-deltaTime * 2.4);
  cameraController.target.y += (desiredTargetY - cameraController.target.y) * follow;
  cameraController.target.x += (STACK_X - cameraController.target.x) * follow;
  cameraController.target.z = STACK_Z;
  cameraController.goalDistance = Math.min(5.2, 2.95 + height * 0.65);
  updateOrbitCameraController(cameraController, camera, deltaTime);
}

function updateHud(now: number, stackHeight = cachedStackHeight): void {
  setTextIfChanged(horsesLeftCopy, String(Math.max(0, TOTAL_HORSES - horsesDropped)));
  setTextIfChanged(heightCopy, formatHeight(stackHeight));
  setTextIfChanged(paceCopy, `Pace ${String(getPaceLevel(horsesDropped)).padStart(2, '0')}`);

  if (activeHorse === null || phase !== 'playing') {
    setTextIfChanged(timerCopy, phase === 'settling' ? 'measuring' : '—');
    setStyleTransformIfChanged(timerFill, 'scaleX(0)');
  } else {
    const windowSeconds = getDropWindow(horsesDropped);
    const remaining = Math.max(0, (activeHorse.deadline - now) / 1000);
    setTextIfChanged(timerCopy, `${remaining.toFixed(1)}s`);
    setStyleTransformIfChanged(timerFill, `scaleX(${clamp(remaining / windowSeconds, 0, 1)})`);
  }

  viewer.classList.toggle('is-bumping', now < impactFlashUntil && !reducedMotion.matches);
  viewer.classList.toggle('is-panicking', now < panicFlashUntil && !reducedMotion.matches);
  hudDirty = false;
}

function getCurrentStackHeight(): number {
  measurementBodies.length = 0;
  for (const horse of stackedHorses) {
    if (!horse.lost) measurementBodies.push(horse.body);
  }
  return getSupportedStackHeight(physicsWorld, measurementBodies);
}

function getAutoSweep(horse: Readonly<ActiveHorse>, now: number): number {
  return (
    Math.sin(now * 0.001 * getSweepSpeed(horsesDropped) + horse.seed) *
    (PLATFORM_HALF_WIDTH * 0.35)
  );
}

function bindGameControls(): void {
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (phase !== 'playing' || activeHorse === null) return;
    setAimFromClientX(event.clientX);
  });

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || phase !== 'playing') return;
    canvas.focus({ preventScroll: true });
    const now = performance.now();
    setAimFromClientX(event.clientX);
    hardDropActiveHorse(now);
  });

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    if (phase !== 'playing') return;
    if (event.key === 'ArrowLeft') {
      const horizontalLimit = PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH * 1.2;
      aimOffset = clamp(
        aimOffset - 0.08,
        -horizontalLimit,
        horizontalLimit,
      );
    } else if (event.key === 'ArrowRight') {
      const horizontalLimit = PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH * 1.2;
      aimOffset = clamp(
        aimOffset + 0.08,
        -horizontalLimit,
        horizontalLimit,
      );
    } else if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowDown') {
      hardDropActiveHorse(performance.now());
    } else {
      return;
    }
    event.preventDefault();
  });

  dropButton.addEventListener('click', () => hardDropActiveHorse(performance.now()));
  startButton.addEventListener('click', startGame);
  replayButton.addEventListener('click', startGame);
  restartButton.addEventListener('click', startGame);
}

function hardDropActiveHorse(now: number): void {
  if (activeHorse === null) return;
  // Touch devices do not necessarily send a pointermove before pointerdown. Refreshing
  // here also commits the current descent height for keyboard and button hard drops.
  updateActiveHorse(now, false);
  dropActiveHorse(now, false);
}

function setAimFromClientX(clientX: number): void {
  const current = activeHorse;
  if (current === null) return;
  const normalized = clamp((clientX - inputBounds.left) / inputBounds.width, 0, 1) * 2 - 1;
  const horizontalLimit = PASTURE_HALF_WIDTH - HORSE_HALF_WIDTH * 1.2;
  const targetX = normalized * horizontalLimit;
  aimOffset = clamp(
    targetX - getAutoSweep(current, performance.now()),
    -horizontalLimit,
    horizontalLimit,
  );
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
  if (landingGhost !== null) landingGhost.enabled = false;
  drawGlScene3DShadowMap(renderState, scene, shadowCamera, directionalLight);
  if (landingGhost !== null) landingGhost.enabled = ghostEnabled;
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
      synchronizeHorseVisuals();
      cachedStackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
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
    'Horse Stacker game. Move with the pointer or arrow keys, then click, tap, Space, or Enter to drop.',
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

function showSceneError(message: string, error: unknown): void {
  console.error(message, error);
  loadingPanel.classList.add('is-hidden');
  errorPanel.hidden = false;
  startPanel.hidden = true;
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
  return `${height.toFixed(2)} m`;
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
