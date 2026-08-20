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
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const modelRoot = `${import.meta.env.BASE_URL}models`;
const HOME_VIEW = {
  azimuth: 0.72,
  distance: 9.1,
  maxDistance: 14,
  minDistance: 5.8,
  minPolar: 0.06,
  polar: 0.42,
  smoothTime: 0.14,
  target: createVector3(0.15, -0.15, 0),
} as const;

retryButton.addEventListener('click', () => window.location.reload());
const { canvas, pipeline, renderState } = initializeRenderer();
let pixelRatio = renderState.pixelRatio;

const scene = createNode3D(Node3DKind);
const camera: Camera3D = createCamera3D({
  far: 80,
  near: 0.1,
  projection: createPerspectiveProjection({ aspect: 1, fovY: Math.PI / 5.4 }),
});

const cameraController = createOrbitCameraController(HOME_VIEW);

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

let modelsLoaded = false;
let previousTime = performance.now();
let isDragging = false;
let isViewerVisible = true;
let lastInteraction = performance.now();
let renderRequested = true;

addGround(scene);
bindCameraControls();
bindRenderingLifecycle();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

async function start(): Promise<void> {
  setLoadingState('Unpacking the farm…');

  try {
    const [farm, horse] = await Promise.all([
      loadGltfScene(`${modelRoot}/farm`),
      loadGltfScene(`${modelRoot}/horse`),
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
    showSceneError('Unable to load the farm scene.', error);
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
    if (!event.isPrimary || event.button !== 0) return;
    isDragging = true;
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
    lastInteraction = performance.now();
    canvas.focus({ preventScroll: true });
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
      const delta = normalizeWheelDelta(event);
      const atNearLimit = delta < 0 && cameraController.goalDistance <= cameraController.minDistance;
      const atFarLimit = delta > 0 && cameraController.goalDistance >= cameraController.maxDistance;
      if (atNearLimit || atFarLimit) return;

      event.preventDefault();
      lastInteraction = performance.now();
      dollyOrbitCameraController(cameraController, delta * 0.006);
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowLeft':
        rotateOrbitCameraController(cameraController, 0.08, 0);
        break;
      case 'ArrowRight':
        rotateOrbitCameraController(cameraController, -0.08, 0);
        break;
      case 'ArrowUp':
        rotateOrbitCameraController(cameraController, 0, 0.06);
        break;
      case 'ArrowDown':
        rotateOrbitCameraController(cameraController, 0, -0.06);
        break;
      case '+':
      case '=':
        dollyOrbitCameraController(cameraController, -0.45);
        break;
      case '-':
      case '_':
        dollyOrbitCameraController(cameraController, 0.45);
        break;
      case 'Home':
        resetCamera();
        event.preventDefault();
        return;
      default:
        return;
    }

    event.preventDefault();
    lastInteraction = performance.now();
  });

  resetViewButton.addEventListener('click', resetCamera);
}

function resetCamera(): void {
  resetOrbitCameraController(cameraController, HOME_VIEW);
  lastInteraction = performance.now();
  renderRequested = true;
}

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const backingWidth = Math.round(width * nextPixelRatio);
  const backingHeight = Math.round(height * nextPixelRatio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    pixelRatio = nextPixelRatio;
    renderState.pixelRatio = pixelRatio;
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (camera.projection.kind === 'perspective') {
      camera.projection.aspect = width / height;
    }
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

  if (modelsLoaded && isViewerVisible && document.visibilityState !== 'hidden') {
    const canDrift = !reducedMotion.matches && !isDragging && now - lastInteraction > 5500;
    const cameraIsMoving =
      Math.abs(cameraController.azimuth - cameraController.goalAzimuth) > 0.0001 ||
      Math.abs(cameraController.polar - cameraController.goalPolar) > 0.0001 ||
      Math.abs(cameraController.distance - cameraController.goalDistance) > 0.001;

    if (canDrift) {
      rotateOrbitCameraController(cameraController, deltaTime * 0.025, 0);
    }

    if (canDrift || cameraIsMoving || renderRequested) {
      updateOrbitCameraController(cameraController, camera, deltaTime);
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
    'Interactive low-poly farm and horse. Use arrow keys to orbit and plus or minus to zoom.',
  );
  nextCanvas.tabIndex = 0;
  viewer.prepend(nextCanvas);

  try {
    const nextRenderState = createGlRenderState(nextCanvas, {
      pixelRatio: initialPixelRatio,
      backgroundColor: 0xdbe5d1ff,
      contextAttributes: { alpha: false },
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
    modelsLoaded = false;
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
    if (document.visibilityState === 'visible') renderRequested = true;
  });
}

function normalizeWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * Math.max(viewer.clientHeight, 1);
  }
  return event.deltaY;
}

function showSceneError(message: string, error: unknown): void {
  console.error(message, error);
  loadingPanel.classList.add('is-hidden');
  errorPanel.hidden = false;
  sceneStatus.classList.remove('is-ready');
  sceneStatus.classList.add('is-error');
  statusCopy.textContent = 'Scene unavailable';
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

void start();
requestAnimationFrame(enterFrame);
