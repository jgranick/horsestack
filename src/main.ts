import type {
  Camera3D,
  ImportDiagnostic,
  Node3D,
  Scene3D,
  Scene3DLightsLike,
} from '@flighthq/sdk';
import {
  addNodeChild,
  beginGlRenderEffectPipeline,
  configureDirectionalShadowCamera3D,
  createAabb,
  createAmbientLight,
  createCamera3D,
  createDirectionalLight,
  createGlCanvasElement,
  createGlRenderEffectPipeline,
  createGlRenderState,
  createNode3D,
  createOrbitCameraController,
  createOrthographicProjection,
  createPerspectiveProjection,
  createPlaneMeshGeometry,
  createMesh,
  createStandardPbrMaterial,
  createVector3,
  dollyOrbitCameraController,
  enableFlightDiagnostics,
  endGlRenderEffectPipeline,
  invalidateNodeLocalTransform,
  normalizeVector3,
  Node3DKind,
  prepareScene3DRender,
  registerGlStandardPbrMaterial,
  registerStandardGlTextureResolvers,
  renderGlBackground,
  resetOrbitCameraController,
  rotateOrbitCameraController,
  setQuaternionFromEuler,
  updateOrbitCameraController,
} from '@flighthq/sdk';
import { createScene3DFromGltf } from '@flighthq/sdk/formats';
import { drawGlScene3D, drawGlScene3DShadowMap } from '@flighthq/sdk/rendering';
import './styles.css';

const viewer = requireElement<HTMLDivElement>('viewer');
const loadingPanel = requireElement<HTMLDivElement>('loading-panel');
const loadingCopy = requireElement<HTMLParagraphElement>('loading-copy');
const errorPanel = requireElement<HTMLDivElement>('error-panel');
const retryButton = requireElement<HTMLButtonElement>('retry-button');
const resetViewButton = requireElement<HTMLButtonElement>('reset-view');
const sceneStatus = requireElement<HTMLDivElement>('scene-status');
const statusCopy = requireElement<HTMLSpanElement>('status-copy');

const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
const canvas = createGlCanvasElement(1, 1, pixelRatio);
canvas.setAttribute('aria-label', 'Interactive low-poly farm and horse');
viewer.prepend(canvas);

const renderState = createGlRenderState(canvas, {
  pixelRatio,
  backgroundColor: 0xdbe5d1ff,
  contextAttributes: { alpha: false, preserveDrawingBuffer: true },
  powerPreference: 'high-performance',
});
enableFlightDiagnostics(renderState);
registerStandardGlTextureResolvers(renderState);
registerGlStandardPbrMaterial(renderState);

const pipeline = createGlRenderEffectPipeline(renderState, {
  sampleCount: 4,
  format: 'rgba16f',
  depth: 'depth-stencil',
});

const scene = createNode3D(Node3DKind);
const camera: Camera3D = createCamera3D({
  far: 80,
  near: 0.1,
  projection: createPerspectiveProjection({ aspect: 1, fovY: Math.PI / 5.4 }),
});

const cameraController = createOrbitCameraController({
  azimuth: 0.72,
  distance: 9.1,
  maxDistance: 14,
  minDistance: 5.8,
  polar: 0.42,
  smoothTime: 0.14,
  target: createVector3(0.15, -0.15, 0),
});

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
  far: 28,
  near: 0.1,
  projection: createOrthographicProjection({ halfHeight: 6.5, halfWidth: 6.5 }),
});
configureDirectionalShadowCamera3D(
  shadowCamera,
  sunDirection,
  createAabb(-6.5, -2.4, -6.5, 6.5, 4.5, 6.5),
);

addGround(scene);
bindCameraControls();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

let modelsLoaded = false;
let previousTime = performance.now();
let isDragging = false;
let lastInteraction = performance.now();

async function start(): Promise<void> {
  setLoadingState('Unpacking the farm…');

  try {
    const [farm, horse] = await Promise.all([
      loadGltfScene('/models/farm'),
      loadGltfScene('/models/horse'),
    ]);

    mountFarm(farm);
    setLoadingState('Letting the horse out…');
    mountHorse(horse);
    modelsLoaded = true;

    updateOrbitCameraController(cameraController, camera, 1);
    renderFrame();
    loadingPanel.classList.add('is-hidden');
    sceneStatus.classList.remove('is-error');
    sceneStatus.classList.add('is-ready');
    statusCopy.textContent = 'Pasture open';
  } catch (error) {
    console.error('Unable to load the farm scene.', error);
    loadingPanel.classList.add('is-hidden');
    errorPanel.hidden = false;
    sceneStatus.classList.remove('is-ready');
    sceneStatus.classList.add('is-error');
    statusCopy.textContent = 'Scene unavailable';
  }
}

function addGround(root: Node3D): void {
  const ground = createMesh(createPlaneMeshGeometry(18, 18, 1, 1), [
    createStandardPbrMaterial({
      baseColor: 0x728461ff,
      metallic: 0,
      roughness: 0.96,
    }),
  ]);
  ground.position.y = -1.9;
  invalidateNodeLocalTransform(ground);
  addNodeChild(root, ground);
}

function mountFarm(model: Scene3D): void {
  const wrapper = createNode3D(Node3DKind);
  const scale = 0.022;
  wrapper.scale.x = scale;
  wrapper.scale.y = scale;
  wrapper.scale.z = scale;
  wrapper.position.x = 0.651;
  wrapper.position.y = -0.01;
  wrapper.position.z = -0.35;
  invalidateNodeLocalTransform(wrapper);
  addNodeChild(wrapper, model.root);
  addNodeChild(scene, wrapper);
}

function mountHorse(model: Scene3D): void {
  const wrapper = createNode3D(Node3DKind);
  const scale = 0.031;
  wrapper.scale.x = scale;
  wrapper.scale.y = scale;
  wrapper.scale.z = scale;
  wrapper.position.x = 2.25;
  wrapper.position.y = -1.915;
  wrapper.position.z = 1.25;
  setQuaternionFromEuler(wrapper.rotation, 0, -0.5, 0);
  invalidateNodeLocalTransform(wrapper);
  addNodeChild(wrapper, model.root);
  addNodeChild(scene, wrapper);
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

function bindCameraControls(): void {
  let previousPointerX = 0;
  let previousPointerY = 0;

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    isDragging = true;
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
    lastInteraction = performance.now();
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!isDragging) return;
    rotateOrbitCameraController(
      cameraController,
      -(event.clientX - previousPointerX) * 0.006,
      (event.clientY - previousPointerY) * 0.006,
    );
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
    lastInteraction = performance.now();
  });

  canvas.addEventListener('pointerup', (event: PointerEvent) => {
    isDragging = false;
    lastInteraction = performance.now();
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointercancel', () => {
    isDragging = false;
  });

  canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault();
      lastInteraction = performance.now();
      dollyOrbitCameraController(cameraController, event.deltaY * 0.006);
    },
    { passive: false },
  );

  resetViewButton.addEventListener('click', resetCamera);
  retryButton.addEventListener('click', () => window.location.reload());
}

function resetCamera(): void {
  resetOrbitCameraController(cameraController, {
    azimuth: 0.72,
    distance: 9.1,
    maxDistance: 14,
    minDistance: 5.8,
    polar: 0.42,
    smoothTime: 0.14,
    target: createVector3(0.15, -0.15, 0),
  });
  lastInteraction = performance.now();
}

function resizeCanvas(): void {
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const backingWidth = Math.round(width * pixelRatio);
  const backingHeight = Math.round(height * pixelRatio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (camera.projection.kind === 'perspective') {
      camera.projection.aspect = width / height;
    }
  }
}

function setLoadingState(copy: string): void {
  loadingCopy.textContent = copy;
  statusCopy.textContent = copy.replace('…', '');
}

function renderFrame(): void {
  prepareScene3DRender(renderState, scene, camera, lights);
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

  if (modelsLoaded) {
    const canDrift = !isDragging && now - lastInteraction > 5500;
    if (canDrift) {
      rotateOrbitCameraController(cameraController, deltaTime * 0.025, 0);
    }
    updateOrbitCameraController(cameraController, camera, deltaTime);
    renderFrame();
  }

  requestAnimationFrame(enterFrame);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

void start();
requestAnimationFrame(enterFrame);
