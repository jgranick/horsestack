// The browser shell. Everything here is about being a web page rather than about being a
// game: finding the DOM elements, wiring pointer and keyboard events, fullscreen, the
// animation frame, the error panel, and mapping game state onto the UI's model each frame.
// The round's own rules live in game/game.ts. Main.hx plays exactly this part in the Haxe
// sibling, over lime's Application instead of the DOM.
//
// This file is also where the object graph is assembled, once, top to bottom: renderer, UI,
// scene, then the pieces that read the scene, then the game that drives them. The order is
// the dependency order, and nothing below reaches back up.
import { createVector3, easeOutCubic, getCamera3DWorldToScreen } from '@flighthq/sdk';
import { createAudioManager } from './audio/audioManager';
import { createGame } from './game/game';
import type { GameMode } from './game/gameMode';
import { STACK_BASE_Y, STACK_X, STACK_Z } from './game/gameConfig';
import type { StackObjectKind } from './physics/stackObjectKind';
import { getStackHeightMeters } from './physics/stackObjectProfile';
import { createCameraRig } from './scene/cameraRig';
import { probeFrameEdges } from './scene/edgeProbe';
import { createLandingIndicator } from './scene/landingIndicator';
import { extractFarmPropTemplates, loadGltfScene, mountFarm } from './scene/modelLoader';
import { createParticleEffects } from './scene/particleEffects';
import { createSceneGraph } from './scene/sceneGraph';
import type { PlayPlanePoint } from './scene/playPlane';
import { unprojectToPlayPlane } from './scene/playPlane';
import { createSceneRenderer } from './scene/sceneRenderer';
import { sampleFarmTerrain } from './scene/terrainProfile';
import { createStackObjectVisuals } from './scene/stackObjectVisual';
import { createWindmill } from './scene/windmill';
import type { Windmill } from './scene/windmill';
import { createGameUi2D } from './ui/gameUi';
import type { UiScreen } from './ui/gameUi';
import './styles.css';

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

retryButton.addEventListener('click', () => window.location.reload());

// The object graph, in dependency order. createSceneRenderer throws if WebGL2 is missing,
// which is caught below rather than inside it — the renderer does not own the error panel.
const audio = createAudioManager(soundRoot);
const sceneRenderer = createSceneRenderer(viewer);
const { canvas, contextState, glPipeline, renderState } = sceneRenderer;
const gameUi = createGameUi2D(contextState, glPipeline, renderState.pixelRatio);
const sceneGraph = createSceneGraph();
const scene = sceneGraph.root;
const { camera } = sceneGraph;
const particles = createParticleEffects(scene);
const cameraRig = createCameraRig();
const visuals = createStackObjectVisuals();
const indicator = createLandingIndicator(visuals, sceneGraph.previewLayer, sceneGraph.indicatorLight);
const game = createGame({
  // The only DOM the game gets: a screen-reader announcement for the queued piece.
  announce: (text) => {
    statusCopy.textContent = text;
  },
  audio,
  cameraRig,
  indicator,
  particles,
  sceneGraph,
  visuals,
});

// How far one arrow-key press moves the held piece, in world units.
const KEYBOARD_NUDGE = 0.05;

// What each kind looks like in the NEXT readout. Emoji rather than a rendered thumbnail: the
// HUD is the 2D layer, which has no way to draw a 3D prop, and the result screen's tally
// already sets the precedent of standing in for a horse with one.
const PIECE_GLYPHS: Readonly<Record<StackObjectKind, string>> = {
  chickens: '🐔',
  cow: '🐄',
  hay: '🌾',
  horse: '🐴',
};

let windmill: Windmill | null = null;
let creditsOpen = false;
// Where the pointer is and whether it is held, so 2D controls can light up and press in.
let pointerX = -1;
let pointerY = -1;
let pointerDown = false;
// How far the menus have defocused the scene behind them, 0..1, eased toward its goal.
let backdropFocus = 0;
let previousTime = performance.now();
let isViewerVisible = true;
let renderRequested = true;
// The viewer's box in client coordinates, which pointer aiming maps against. Refreshed by
// resizeCanvas rather than measured per event: getBoundingClientRect in a pointermove handler
// is a layout read on every move.
const inputBounds = { height: 1, left: 0, top: 0, width: 1 };
// Scratch for the pointer unprojection, reused so aiming allocates nothing per move.
const aimPoint: PlayPlanePoint = { x: 0, y: 0 };

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

    visuals.setTemplates(extractFarmPropTemplates(farm), horse);
    windmill = createWindmill(farm);
    mountFarm(farm, scene);
    // Sampled AFTER mounting: the sampler reads each ground mesh's world matrix, and until
    // the farm is under the scene wrapper that matrix is the model's own, not the game's.
    game.markReady(sampleFarmTerrain(farm) ?? undefined);
    cameraRig.update(camera, 1, game.displayedHeight, game.objectsDropped);
    renderFrame();
    loadingPanel.classList.add('is-hidden');
    statusCopy.textContent = 'Stable enough';
  } catch (error) {
    showSceneError('Unable to load Horse Stacker.', error);
  }
}

function startGame(mode: GameMode, startedFrom?: Event): void {
  if (!game.isReady || game.phase === 'loading') return;
  // The credits only exist on the score screen now, so a panel left open there must not
  // still be open when the next score screen arrives.
  creditsOpen = false;
  game.startRound(mode, startedFrom);
  renderRequested = true;
}

function returnToMenu(): void {
  creditsOpen = false;
  game.leaveRound();
  renderRequested = true;
}

function bindGameControls(): void {
  // Window-level, not canvas-level: aiming and placing follow the pointer anywhere on
  // the page while a run is live. aimFromClientX clamps against the canvas bounds, so
  // a click out in the margin simply aims at that edge.
  window.addEventListener('pointermove', (event: PointerEvent) => {
    trackPointer(event);
    renderRequested = true;
    if (game.phase !== 'playing') return;
    aimFromClient(event.clientX, event.clientY, performance.now());
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
    if (game.phase !== 'playing') return;
    // Controls and links keep their own meaning: Start over must restart, the place
    // prompt has its own handler, and a credit link must still open.
    if (isInteractiveEventTarget(event.target)) return;
    // Deliberately NOT focusing the canvas. It used to, so the keys would work after a click;
    // they come off the window now and do not need it. Focusing by hand is read as a KEYBOARD
    // focus — :focus-visible matches a programmatic focus() — and this canvas is the whole
    // viewport, so the ring framed the entire screen from the first placement onward.
    const now = performance.now();
    aimFromClient(event.clientX, event.clientY, now);
    game.place(now, event.timeStamp);
    renderRequested = true;
  });

  // On the window rather than the canvas, for the same reason aiming is: the keys should work
  // whenever a run is live, without the game having to take focus to earn them. Anything the
  // page owns keeps its own keys — the error panel's button still takes Space and Enter.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (isInteractiveEventTarget(event.target)) return;
    // Escape is the STEADY HANDS run's other way out, matching the MENU pill. A timed round
    // ends on its own, so it keeps Escape's browser-default meaning.
    if (event.key === 'Escape' && game.mode === 'steady' && game.isRunning) {
      returnToMenu();
      event.preventDefault();
      return;
    }
    if (game.phase !== 'playing') return;
    const now = performance.now();
    // Placement is free in the plane, so the arrows steer in both axes and dropping moved off
    // ArrowDown onto Space/Enter. Without this a keyboard player could not set a height at all.
    if (event.key === 'ArrowLeft') {
      game.nudgeAim(-KEYBOARD_NUDGE, 0, now);
    } else if (event.key === 'ArrowRight') {
      game.nudgeAim(KEYBOARD_NUDGE, 0, now);
    } else if (event.key === 'ArrowUp') {
      game.nudgeAim(0, KEYBOARD_NUDGE, now);
    } else if (event.key === 'ArrowDown') {
      game.nudgeAim(0, -KEYBOARD_NUDGE, now);
    } else if (event.key === ' ' || event.key === 'Enter') {
      game.place(now, event.timeStamp);
    } else {
      return;
    }
    renderRequested = true;
    event.preventDefault();
  });

  bindFullscreenToggle();
}

/**
 * Put the held piece under the pointer.
 *
 * The pointer is unprojected onto the play plane rather than mapped across the viewer as a
 * fraction. A fraction is a linear map onto what is really a projective one, so the piece
 * drifted from the cursor toward the screen edges and drifted further the more the camera
 * pulled back — see scene/playPlane.ts.
 */
function aimFromClient(clientX: number, clientY: number, now: number): void {
  const aspect = camera.projection.kind === 'perspective' ? camera.projection.aspect : 1;
  // Normalized device coordinates: -1..1 with +Y up, which is the convention the SDK's
  // camera ray and world-to-screen calls both use.
  const ndcX = ((clientX - inputBounds.left) / inputBounds.width) * 2 - 1;
  const ndcY = 1 - ((clientY - inputBounds.top) / inputBounds.height) * 2;
  if (!unprojectToPlayPlane(aimPoint, camera, ndcX, ndcY, aspect)) return;
  game.aimAt(aimPoint.x, aimPoint.y, now);
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
    if (button.id === 'mute') {
      audio.setMuted(!audio.muted);
      renderRequested = true;
      return true;
    }
    if (button.id === 'time' && screen === 'title') {
      startGame('time', event);
      return true;
    }
    if (button.id === 'steady' && screen === 'title') {
      startGame('steady', event);
      return true;
    }
    // PLAY AGAIN replays whatever was just played rather than always the timed game.
    if (button.id === 'again' && screen === 'result') {
      startGame(game.mode, event);
      return true;
    }
    if (button.id === 'menu') {
      returnToMenu();
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

function resizeCanvas(): void {
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = viewer.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  inputBounds.left = bounds.left;
  inputBounds.top = bounds.top;
  inputBounds.width = Math.max(bounds.width, 1);
  inputBounds.height = Math.max(bounds.height, 1);

  if (sceneRenderer.resize(width, height, nextPixelRatio)) {
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
  sceneRenderer.drawScene(sceneGraph, backdropFocus);
  // Between the two presents, so a border pixel that is already wrong here is the scene's
  // and one that only goes wrong below is the UI's. See scene/edgeProbe.ts.
  if (import.meta.env.DEV && edgeProbeRequested) probeFrameEdges(renderState.gl, 'after 3D');
  const countProgress = game.countProgress;
  const finalMeters = getStackHeightMeters(game.finalHeight);
  const shownMeters = finalMeters * easeOutCubic(countProgress);
  const uiWantsAnotherFrame = gameUi.update({
    // Blank on a first ever round: there is no previous best to measure this one against,
    // and echoing the number already on screen back as "BEST" says nothing.
    bestText:
      game.recordBeforeRound === null || game.beatTheRecord
        ? ''
        : `BEST ${formatMeters(game.recordBeforeRound)}`,
    countProgress,
    creditsOpen,
    isRecord: game.beatTheRecord,
    handsShown: game.resultHandsShown,
    now: performance.now(),
    pointerDown,
    pointerX,
    pointerY,
    heightText: formatMeters(countProgress >= 1 ? finalMeters : shownMeters),
    liveHeightText: formatMeters(getStackHeightMeters(game.displayedHeight)),
    nextPieceGlyph: PIECE_GLYPHS[game.nextKind],
    mode: game.mode,
    muted: audio.muted,
    screen: getUiScreen(),
    secondsLeft: game.secondsLeft,
    timeUpProgress: import.meta.env.DEV && forcedScreen === 'timeup' ? 1 : game.timeUpProgress,
  });
  gameUi.render();
  if (import.meta.env.DEV && edgeProbeRequested) {
    probeFrameEdges(renderState.gl, 'after UI');
    edgeProbeRequested = false;
  }
  if (uiWantsAnotherFrame) renderRequested = true;
}

// DEV only: set by __game.probeEdges() and cleared by the frame it reads, so the probe costs
// four readPixels calls once rather than a stall on every frame.
let edgeProbeRequested = false;

// DEV only: pins the UI to one screen so a short-lived one (TIME UP lasts 2.35s) can be
// held still and inspected instead of raced with a screenshot.
let forcedScreen: UiScreen | null = null;

function getUiScreen(): UiScreen {
  if (import.meta.env.DEV && forcedScreen !== null) return forcedScreen;
  if (game.phase === 'loading') return 'loading';
  if (game.phase === 'playing') return 'playing';
  if (game.phase === 'settling') return 'timeup';
  if (game.phase === 'finished') return 'result';
  return 'title';
}

function enterFrame(now: number): void {
  const deltaTime = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  if (game.phase !== 'loading' && isViewerVisible && document.visibilityState !== 'hidden') {
    // Read before update: a round that ends this frame still owes the frame that shows it.
    const gameIsMoving = game.isRunning;
    game.update(now, deltaTime);
    if (gameIsMoving) renderRequested = true;

    if (windmill?.update(deltaTime) === true) renderRequested = true;
    // The ambience fade is time-based, not event-based, so it needs a heartbeat rather than
    // a callback at the moment play stops.
    audio.update(now, game.isRunning);

    const screen = getUiScreen();
    const wantsBackdrop = screen === 'title' || screen === 'result' ? 1 : 0;
    const focused =
      backdropFocus + (wantsBackdrop - backdropFocus) * (1 - Math.exp(-deltaTime * 5.5));
    if (Math.abs(focused - backdropFocus) > 0.0005) {
      backdropFocus = focused;
      renderRequested = true;
    } else if (backdropFocus !== wantsBackdrop) {
      backdropFocus = wantsBackdrop;
      renderRequested = true;
    }

    const particlesAreMoving = particles.step(deltaTime);
    if (particlesAreMoving) renderRequested = true;

    if (cameraRig.update(camera, deltaTime, game.displayedHeight, game.objectsDropped)) {
      renderRequested = true;
    }
    const cameraIsMoving = cameraRig.isMoving();
    if (renderRequested || gameIsMoving || particlesAreMoving || cameraIsMoving) {
      renderFrame();
      renderRequested = false;
    }
  }

  requestAnimationFrame(enterFrame);
}

function bindRenderingLifecycle(): void {
  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    game.markLost();
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
    game.resetStepAccumulator();
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

function formatMeters(meters: number): string {
  return `${meters.toFixed(2)} m`;
}

// The HUD used to double as a test surface — harnesses read the placed count and height
// out of the DOM. Those elements are gone, so dev builds expose the same few numbers
// directly. Not shipped: production has no reason to carry it.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game = {
    get height() {
      return getStackHeightMeters(game.displayedHeight);
    },
    get phase() {
      return game.phase;
    },
    get placed() {
      return game.objectsDropped;
    },
    // Reads the frame's outermost pixels on the next frame and logs what is in them, before
    // and after the UI is composited. For chasing an edge artifact without a screenshot.
    probeEdges() {
      edgeProbeRequested = true;
      renderRequested = true;
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
      const aspect = camera.projection.kind === 'perspective' ? camera.projection.aspect : 1;
      const probe = createVector3(0, 0, 0);
      const ndcY = (physicsY: number): number => {
        const point = createVector3(STACK_X, STACK_BASE_Y + physicsY, STACK_Z);
        return getCamera3DWorldToScreen(probe, camera, point, aspect) ? probe.y : NaN;
      };
      return {
        distance: cameraRig.controller.distance,
        followed: cameraRig.followedHeight(),
        measured: game.displayedHeight,
        preview: ndcY(indicator.previewTopY()),
        targetY: cameraRig.controller.target.y,
        top: ndcY(game.displayedHeight),
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
