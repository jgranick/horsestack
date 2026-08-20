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
  createPlaneMeshGeometry,
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
  getSupportedStackHeight,
  PHYSICS_STEP,
  PLATFORM_HALF_WIDTH,
  stepHorseStack,
} from './horseStackPhysics';
import './styles.css';

type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';

interface ActiveHorse {
  angle: number;
  deadline: number;
  node: Node3D;
  seed: number;
  spawnY: number;
  x: number;
}

interface StackedHorse {
  body: RigidBody2D;
  lost: boolean;
  node: Node3D;
}

const TOTAL_HORSES = 18;
const GROUND_Y = -1.9;
const STACK_Z = 1.35;
const HORSE_SCALE = 0.031;
const HORSE_VISUAL_CENTER_Y = 0.87;
const FIXED_STEP_LIMIT = 6;
const GAME_VIEW = {
  azimuth: 0.08,
  distance: 11.5,
  maxDistance: 20,
  minDistance: 9,
  minPolar: 0.02,
  polar: 0.1,
  smoothTime: 0.18,
  target: createVector3(0, -0.1, STACK_Z),
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

const celebrationEmitter: ParticleEmitter3D = createParticleEmitter3D({
  blendMode: 'normal',
  data: { worldSpace: true },
  name: 'horse-confetti',
});
addNodeChild(scene, celebrationEmitter);
const particleConfig: ParticleEmitterConfig = createParticleEmitterConfig({
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
let particleState: ParticleEmitterState = createParticleEmitterState();

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
let physicsWorld: Physics2DWorld = createHorseStackWorld();
let activeHorse: ActiveHorse | null = null;
let stackedHorses: StackedHorse[] = [];
let horsesDropped = 0;
let horsesLost = 0;
let aimOffset = 0;
let nextHorseAt = 0;
let finishAt = 0;
let finalHeight = 0;
let physicsAccumulator = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
let impactFlashUntil = 0;
let panicFlashUntil = 0;
let lastImpactAt = 0;

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
    updateCamera(1);
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
  const ground = createMesh(createPlaneMeshGeometry(22, 22, 1, 1), [
    createStandardPbrMaterial({
      baseColor: 0x718260ff,
      metallic: 0,
      roughness: 0.98,
    }),
  ]);
  ground.position.y = GROUND_Y;
  invalidateNodeLocalTransform(ground);
  addNodeChild(root, ground);

  const platform = createMesh(
    createBoxMeshGeometry(PLATFORM_HALF_WIDTH * 2, 0.34, 2.5),
    [
      createStandardPbrMaterial({
        baseColor: 0xb79a66ff,
        metallic: 0,
        roughness: 0.9,
      }),
    ],
  );
  platform.position.y = GROUND_Y - 0.17;
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

function createHorseVisual(): Node3D {
  if (horseTemplate === null) throw new Error('Horse model is not loaded');

  const pivot = createNode3D(Node3DKind);
  const modelTransform = createNode3D(Node3DKind);
  modelTransform.scale.x = HORSE_SCALE;
  modelTransform.scale.y = HORSE_SCALE;
  modelTransform.scale.z = HORSE_SCALE;
  modelTransform.position.y = -HORSE_VISUAL_CENTER_Y;
  setQuaternionFromEuler(modelTransform.rotation, 0, Math.PI / 2, 0);
  invalidateNodeLocalTransform(modelTransform);
  addNodeChild(modelTransform, cloneNode3DHierarchy(horseTemplate.root));
  addNodeChild(pivot, modelTransform);
  return pivot;
}

function cloneNode3DHierarchy(source: Readonly<Node3D>): Node3D {
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
  if (!isMesh(source)) {
    setNodeTransform3D(clone, source);
    if (isNodeLocalMatrix4Detached(source)) {
      setNodeLocalMatrix4(clone, getNodeLocalMatrix4(source));
    }
  }

  for (const child of getNodeChildren(source)) {
    addNodeChild(clone, cloneNode3DHierarchy(child));
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
  horsesLost = 0;
  aimOffset = 0;
  nextHorseAt = 0;
  finishAt = 0;
  finalHeight = 0;
  impactFlashUntil = 0;
  panicFlashUntil = 0;
  lastImpactAt = 0;
  removeNodeChildren(horseLayer);
  clearParticleEmitter3D(celebrationEmitter);
  particleState = createParticleEmitterState();

  phase = 'playing';
  startPanel.hidden = true;
  resultPanel.hidden = true;
  restartButton.hidden = false;
  dropButton.disabled = false;
  viewer.classList.add('is-playing');
  viewer.classList.remove('is-finished', 'is-bumping', 'is-panicking');
  sceneStatus.classList.add('is-ready');
  statusCopy.textContent = 'Horse 01 incoming';
  gameCallout.textContent = 'Easy does it…';
  spawnHorse(performance.now());
  renderRequested = true;
}

function spawnHorse(now: number): void {
  if (phase !== 'playing' || horsesDropped >= TOTAL_HORSES) return;

  const supportedHeight = getCurrentStackHeight();
  const node = createHorseVisual();
  addNodeChild(horseLayer, node);
  const dropWindow = getDropWindow();
  activeHorse = {
    angle: 0,
    deadline: now + dropWindow * 1000,
    node,
    seed: Math.random() * Math.PI * 2,
    spawnY: Math.max(3.25, supportedHeight + 3.25),
    x: 0,
  };
  aimOffset = (Math.random() - 0.5) * 0.35;
  statusCopy.textContent = `Horse ${String(horsesDropped + 1).padStart(2, '0')} incoming`;
  gameCallout.textContent = getPaceLevel() >= 4 ? 'This seems unsafe.' : 'Pick a spot. Quickly.';
  updateActiveHorse(now);
}

function updateActiveHorse(now: number): void {
  const current = activeHorse;
  if (current === null) return;

  const sweep = getAutoSweep(current, now);
  current.x = clamp(sweep + aimOffset, -PLATFORM_HALF_WIDTH + 0.48, PLATFORM_HALF_WIDTH - 0.48);
  current.angle = Math.sin(now * 0.0043 + current.seed) * (0.06 + getPaceLevel() * 0.012);
  setHorseVisualTransform(current.node, current.x, current.spawnY, current.angle);

  if (now >= current.deadline) {
    dropActiveHorse(now, true);
  }
}

function dropActiveHorse(now: number, forced: boolean): void {
  const current = activeHorse;
  if (current === null || phase !== 'playing') return;

  const body = addHorseBody(physicsWorld, current.x, current.spawnY, current.angle);
  const pace = getPaceLevel();
  const sweepDirection = Math.cos(now * 0.001 * getSweepSpeed() + current.seed);
  body.velocityX = sweepDirection * (0.12 + pace * 0.035) + (Math.random() - 0.5) * 0.14;
  body.velocityY = forced ? -0.55 : -0.1;
  body.angularVelocity = (Math.random() - 0.5) * (0.75 + pace * 0.22) + (forced ? 0.25 : 0);
  stackedHorses.push({ body, lost: false, node: current.node });
  activeHorse = null;
  horsesDropped++;

  if (forced) {
    panicFlashUntil = now + 440;
    gameCallout.textContent = 'PANIC DROP!';
  } else {
    gameCallout.textContent = horsesDropped % 4 === 0 ? 'Faster now!' : 'Neigh problem.';
  }

  if (horsesDropped >= TOTAL_HORSES) {
    phase = 'settling';
    finishAt = now + 3800;
    dropButton.disabled = true;
    statusCopy.textContent = 'Everybody hold still';
    gameCallout.textContent = 'The judges are measuring…';
  } else {
    nextHorseAt = now + Math.max(210, 560 - horsesDropped * 18);
  }
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
  const survivors = TOTAL_HORSES - horsesLost;
  resultScore.textContent = `${finalHeight.toFixed(1)} m`;
  resultCopy.textContent = `${survivors} of ${TOTAL_HORSES} horses remained in the general vicinity.`;
  resultPanel.hidden = false;
  viewer.classList.remove('is-playing', 'is-panicking');
  viewer.classList.add('is-finished');
  statusCopy.textContent = 'Officially measured';
  gameCallout.textContent = finalHeight >= 8 ? 'A monument to poor judgement.' : 'Structurally questionable. Perfect.';

  const burstY = GROUND_Y + Math.max(1.2, finalHeight);
  const colors = [0xffd166ff, 0xef8354ff, 0x7ea16bff, 0xf7ede2ff, 0x8ecae6ff, 0xe5989bff];
  for (let index = 0; index < colors.length; index++) {
    const x = -2 + (index / (colors.length - 1)) * 4;
    emitParticleBurst3D(
      celebrationEmitter,
      particleState,
      particleConfig,
      28,
      x,
      burstY,
      STACK_Z + (Math.random() - 0.5) * 0.4,
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
    celebrationEmitter,
    particleState,
    particleConfig,
    6,
    point.x,
    GROUND_Y + point.y,
    STACK_Z,
    0xe8d6a9cc,
  );
}

function synchronizeHorseVisuals(): void {
  for (const horse of stackedHorses) {
    if (horse.lost) continue;
    const body = horse.body;
    setHorseVisualTransform(horse.node, body.x, body.y, body.angle);

    if (body.y < -10 || Math.abs(body.x) > 14) {
      horse.lost = true;
      horse.node.enabled = false;
      horsesLost++;
      removePhysics2DBody(physicsWorld, body);
    }
  }
}

function setHorseVisualTransform(node: Node3D, x: number, physicsY: number, angle: number): void {
  node.position.x = x;
  node.position.y = GROUND_Y + physicsY;
  node.position.z = STACK_Z;
  setQuaternionFromEuler(node.rotation, 0, 0, angle);
  invalidateNodeLocalTransform(node);
}

function updateCamera(deltaTime: number): void {
  const height = phase === 'finished' ? finalHeight : getCurrentStackHeight();
  const desiredTargetY = GROUND_Y + Math.max(1.8, height - 1);
  if (Math.abs(desiredTargetY - cameraController.target.y) > 0.001) renderRequested = true;
  const follow = 1 - Math.exp(-deltaTime * 2.4);
  cameraController.target.y += (desiredTargetY - cameraController.target.y) * follow;
  cameraController.target.x += (0 - cameraController.target.x) * follow;
  cameraController.target.z = STACK_Z;
  cameraController.goalDistance = Math.min(18, 11.5 + height * 0.18);
  updateOrbitCameraController(cameraController, camera, deltaTime);
}

function updateHud(now: number): void {
  const stackHeight = phase === 'finished' ? finalHeight : getCurrentStackHeight();
  horsesLeftCopy.textContent = String(Math.max(0, TOTAL_HORSES - horsesDropped));
  heightCopy.textContent = `${stackHeight.toFixed(1)} m`;
  paceCopy.textContent = `Pace ${String(getPaceLevel()).padStart(2, '0')}`;

  if (activeHorse === null || phase !== 'playing') {
    timerCopy.textContent = phase === 'settling' ? 'measuring' : '—';
    timerFill.style.transform = 'scaleX(0)';
  } else {
    const windowSeconds = getDropWindow();
    const remaining = Math.max(0, (activeHorse.deadline - now) / 1000);
    timerCopy.textContent = `${remaining.toFixed(1)}s`;
    timerFill.style.transform = `scaleX(${clamp(remaining / windowSeconds, 0, 1)})`;
  }

  viewer.classList.toggle('is-bumping', now < impactFlashUntil && !reducedMotion.matches);
  viewer.classList.toggle('is-panicking', now < panicFlashUntil && !reducedMotion.matches);
}

function getCurrentStackHeight(): number {
  return getSupportedStackHeight(
    physicsWorld,
    stackedHorses.filter((horse) => !horse.lost).map((horse) => horse.body),
  );
}

function getDropWindow(): number {
  return Math.max(1.25, 4 - horsesDropped * 0.16);
}

function getPaceLevel(): number {
  return Math.min(5, 1 + Math.floor(horsesDropped / 4));
}

function getSweepSpeed(): number {
  return 1.05 + horsesDropped * 0.075;
}

function getAutoSweep(horse: Readonly<ActiveHorse>, now: number): number {
  return Math.sin(now * 0.001 * getSweepSpeed() + horse.seed) * 1.72;
}

function bindGameControls(): void {
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (phase !== 'playing' || activeHorse === null) return;
    setAimFromClientX(event.clientX);
  });

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || phase !== 'playing') return;
    canvas.focus({ preventScroll: true });
    setAimFromClientX(event.clientX);
    dropActiveHorse(performance.now(), false);
  });

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    if (phase !== 'playing') return;
    if (event.key === 'ArrowLeft') {
      aimOffset = clamp(aimOffset - 0.28, -1.15, 1.15);
    } else if (event.key === 'ArrowRight') {
      aimOffset = clamp(aimOffset + 0.28, -1.15, 1.15);
    } else if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowDown') {
      dropActiveHorse(performance.now(), false);
    } else {
      return;
    }
    event.preventDefault();
  });

  dropButton.addEventListener('click', () => dropActiveHorse(performance.now(), false));
  startButton.addEventListener('click', startGame);
  replayButton.addEventListener('click', startGame);
  restartButton.addEventListener('click', startGame);
}

function setAimFromClientX(clientX: number): void {
  const current = activeHorse;
  if (current === null) return;
  const bounds = canvas.getBoundingClientRect();
  const normalized = clamp((clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1) * 2 - 1;
  const targetX = normalized * (PLATFORM_HALF_WIDTH - 0.48);
  aimOffset = clamp(targetX - getAutoSweep(current, performance.now()), -1.15, 1.15);
}

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
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
  drawGlScene3DShadowMap(renderState, scene, shadowCamera, directionalLight);
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
      renderRequested = true;
    }

    const particlesAreMoving = celebrationEmitter.data.particleCount > 0;
    if (particlesAreMoving) {
      stepParticleEmitter3D(celebrationEmitter, particleState, particleConfig, deltaTime);
      renderRequested = true;
    }

    updateCamera(deltaTime);
    updateHud(now);
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
