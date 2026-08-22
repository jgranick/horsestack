import type {
  DisplayObject,
  FlowStack,
  FlowState,
  GlRenderState,
  Node2D,
  Shape,
  TextFormat,
  TextLabel,
} from '@flighthq/sdk/core';
import {
  DisplayObjectKind,
  ShapeKind,
  TextLabelKind,
  addNodeChild,
  createMatrix,
  invalidateNodeAppearance,
  invalidateNodeLocalTransform,
  setNodeEnabled,
} from '@flighthq/sdk/core';
import {
  clearFlowStack,
  createFlowStack,
  replaceFlowState,
  updateFlowStack,
} from '@flighthq/sdk/game';
import {
  appendShapeBeginFill,
  appendShapeEndFill,
  appendShapeRectangle,
  clearShapeCommands,
  createDisplayObject,
  createScene2D,
  createShape,
  createTextLabel,
  setScene2DSize,
  setTextLabelFormat,
  setTextLabelHeight,
  setTextLabelString,
  setTextLabelWidth,
} from '@flighthq/sdk/scene2d';
import {
  defaultGlMeshShapeRenderer,
  defaultGlTextLabelRenderer,
  enableGlBlendModeSupport,
  prepareScene2DRender,
  registerGlStandardMaterial,
  registerRenderer,
  renderGlScene2D,
  setGlRenderTransform2D,
} from '@flighthq/sdk/rendering';

export type GameUiPhase = 'ready' | 'playing' | 'settling' | 'finished';

export interface GameUiModel {
  callout: string;
  canPlace: boolean;
  handsShown: number;
  height: string;
  horsesPlaced: number;
  resultComplete: boolean;
  resultCopy: string;
  resultHeight: string;
  score: string;
  secondsRemaining: number;
}

export interface FlightGameUi {
  hide(): void;
  render(): void;
  resize(width: number, height: number, pixelRatio: number): void;
  setPhase(phase: GameUiPhase): void;
  update(deltaTime: number, now: number, model: Readonly<GameUiModel>): boolean;
}

interface PhaseLayer {
  root: DisplayObject;
  state: FlowState;
}

const COLORS = {
  cream: 0xfbf7ecff,
  gold: 0xffd166ff,
  green: 0x1f2d1dff,
  orange: 0xd97143ff,
  red: 0x7e311fff,
  white: 0xffffffff,
} as const;
const UI_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const DISPLAY_FONT = 'Georgia, Times New Roman, serif';
const EMOJI_FONT = 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif';
const PHASE_TRANSITION_SECONDS = 0.46;
const HANDS_PER_COLUMN = 12;
const MAX_HAND_MARKERS = 72;

export function createFlightGameUi(
  renderState: GlRenderState,
  reduceMotion = false,
): FlightGameUi {
  enableGlBlendModeSupport(renderState);
  registerGlStandardMaterial(renderState);
  registerRenderer(renderState, DisplayObjectKind, {
    createData: () => null,
    submit: () => undefined,
  });
  registerRenderer(renderState, ShapeKind, defaultGlMeshShapeRenderer);
  registerRenderer(renderState, TextLabelKind, defaultGlTextLabelRenderer);

  const scene = createScene2D({ align: 'topleft', scaleMode: 'noscale' });
  const root = scene.root;
  root.name = 'horse-stacker-flight-ui';

  const readyRoot = createDisplayObject({ name: 'ready-ui' });
  const playingRoot = createDisplayObject({ name: 'playing-ui' });
  const settlingRoot = createDisplayObject({ name: 'time-up-ui' });
  const finishedRoot = createDisplayObject({ name: 'result-ui' });
  addNodeChild(root, readyRoot);
  addNodeChild(root, playingRoot);
  addNodeChild(root, settlingRoot);
  addNodeChild(root, finishedRoot);

  const readyScrim = createSolidShape(readyRoot);
  const readyRule = createSolidShape(readyRoot);
  const readyKicker = createLabel(readyRoot, '', kickerFormat(COLORS.cream));
  const readyTitleTop = createLabel(readyRoot, '', displayFormat(60, COLORS.cream));
  const readyTitleBottom = createLabel(readyRoot, '', displayFormat(60, COLORS.cream));
  const readyDescription = createLabel(readyRoot, '', bodyFormat(16, COLORS.cream));
  const readyButton = createSolidShape(readyRoot);
  const readyButtonLabel = createLabel(readyRoot, '', buttonFormat(COLORS.green));
  const readyFooter = createLabel(readyRoot, '', kickerFormat(COLORS.cream));
  setTextLabelString(readyKicker, 'FLIGHT 3D PHYSICS PRESENTS');
  setTextLabelString(readyTitleTop, 'Ready to make');
  setTextLabelString(readyTitleBottom, 'poor choices?');
  setTextLabelString(
    readyDescription,
    '60 seconds. Unlimited horses. Build the tallest pile.',
  );
  setTextLabelString(readyButtonLabel, 'START STACKING');
  setTextLabelString(readyFooter, 'AIM IN 3D · BALANCE · CLICK / TAP / SPACE TO PLACE');

  const hudCallout = createSolidShape(playingRoot);
  const hudCalloutLabel = createLabel(playingRoot, '', buttonFormat(COLORS.white));
  const timerRoot = createDisplayObject({ name: 'hero-timer' });
  addNodeChild(playingRoot, timerRoot);
  const timerCard = createSolidShape(timerRoot);
  const timerKicker = createLabel(timerRoot, 'TIME LEFT', kickerFormat(COLORS.white));
  const timerValue = createLabel(timerRoot, '60', displayFormat(42, COLORS.white));
  const timerTrack = createSolidShape(playingRoot);
  const timerFill = createSolidShape(playingRoot);
  const statsCard = createSolidShape(playingRoot);
  const horsesLabel = createLabel(playingRoot, 'HORSES', kickerFormat(COLORS.cream));
  const horsesValue = createLabel(playingRoot, '0', displayFormat(24, COLORS.white));
  const heightLabel = createLabel(playingRoot, 'HEIGHT', kickerFormat(COLORS.cream));
  const heightValue = createLabel(playingRoot, '0.00 m', displayFormat(24, COLORS.white));
  const scoreLabel = createLabel(playingRoot, 'SCORE', kickerFormat(COLORS.cream));
  const scoreValue = createLabel(playingRoot, '0 pts', bodyFormat(15, COLORS.gold, true));
  const dropRoot = createDisplayObject({ name: 'place-control-visual' });
  addNodeChild(playingRoot, dropRoot);
  const dropButton = createSolidShape(dropRoot);
  const dropButtonLabel = createLabel(dropRoot, 'PLACE HORSE', buttonFormat(COLORS.white));
  setNodeEnabled(scoreLabel, false);
  setNodeEnabled(scoreValue, false);
  setNodeEnabled(dropRoot, false);
  const restartButton = createSolidShape(playingRoot);
  const restartButtonLabel = createLabel(playingRoot, '↺  START OVER', buttonFormat(COLORS.white));
  const viewerBrand = createLabel(playingRoot, 'FLIGHT PHYSICS 3D', kickerFormat(COLORS.cream));
  const viewerProtocol = createLabel(
    playingRoot,
    '60-SECOND PILE PROTOCOL',
    buttonFormat(COLORS.white),
  );

  const timeUpScrim = createSolidShape(settlingRoot);
  const timeUpGlow = createSolidShape(settlingRoot);
  const timeUpKicker = createLabel(settlingRoot, 'HANDS OFF THE HERD', kickerFormat(COLORS.cream));
  const timeUpTitle = createLabel(settlingRoot, 'TIME UP!', displayFormat(112, COLORS.gold, true));
  const timeUpCopy = createLabel(
    settlingRoot,
    'Hold everything. The pasture is counting.',
    bodyFormat(17, COLORS.cream),
  );

  const resultScrim = createSolidShape(finishedRoot);
  const resultFlash = createSolidShape(finishedRoot);
  const resultKicker = createLabel(finishedRoot, 'OFFICIAL-ISH HEIGHT', kickerFormat(COLORS.cream));
  const resultBaseline = createSolidShape(finishedRoot);
  const handMarkers: TextLabel[] = [];
  for (let index = 0; index < MAX_HAND_MARKERS; index++) {
    const marker = createLabel(finishedRoot, '🐴', {
      align: 'center',
      color: COLORS.white,
      font: EMOJI_FONT,
      size: 17,
    });
    setNodeEnabled(marker, false);
    handMarkers.push(marker);
  }
  const resultOverflow = createLabel(finishedRoot, '', bodyFormat(13, COLORS.gold, true));
  const resultHands = createLabel(finishedRoot, '0 HANDS HIGH', buttonFormat(COLORS.cream));
  const resultHeight = createLabel(finishedRoot, '0.00 m', displayFormat(76, COLORS.gold));
  const resultCopyTop = createLabel(finishedRoot, '', bodyFormat(12, COLORS.cream));
  const resultCopyBottom = createLabel(finishedRoot, '', bodyFormat(12, COLORS.cream));
  const replayButton = createSolidShape(finishedRoot);
  const replayButtonLabel = createLabel(finishedRoot, 'STACK AGAIN', buttonFormat(COLORS.green));

  const flow: FlowStack = createFlowStack();
  let width = 1;
  let height = 1;
  let phase: GameUiPhase | null = null;
  let phaseTime = 0;
  let resultRevealTime = 0;
  let resultWasComplete = false;
  let markerCountShown = -1;
  let currentModel: Readonly<GameUiModel> | null = null;
  const transitionDuration = reduceMotion ? 0.001 : PHASE_TRANSITION_SECONDS;

  const layers: Record<GameUiPhase, PhaseLayer> = {
    ready: createPhaseLayer('ready', readyRoot),
    playing: createPhaseLayer('playing', playingRoot),
    settling: createPhaseLayer('settling', settlingRoot),
    finished: createPhaseLayer('finished', finishedRoot),
  };

  for (const layer of Object.values(layers)) setNodeEnabled(layer.root, false);
  setNodeEnabled(root, false);

  function createPhaseLayer(name: GameUiPhase, layerRoot: DisplayObject): PhaseLayer {
    const state: FlowState = {
      name: `horse-stacker-${name}`,
      onEnter: () => {
        phaseTime = 0;
        layerRoot.alpha = 0;
        invalidateNodeAppearance(layerRoot);
        setNodeEnabled(layerRoot, true);
        setLayerScale(layerRoot, 0.965);
      },
      onExit: () => {
        setNodeEnabled(layerRoot, false);
      },
      onUpdate: (deltaTime) => {
        if (phaseTime >= transitionDuration) return;
        phaseTime = Math.min(transitionDuration, phaseTime + deltaTime);
        const progress = Math.min(1, phaseTime / transitionDuration);
        const eased = 1 - Math.pow(1 - progress, 3);
        layerRoot.alpha = eased;
        invalidateNodeAppearance(layerRoot);
        setLayerScale(layerRoot, 0.965 + eased * 0.035);
      },
    };
    return { root: layerRoot, state };
  }

  function setLayerScale(layer: DisplayObject, scale: number): void {
    if (layer.scaleX === scale && layer.scaleY === scale) return;
    layer.scaleX = scale;
    layer.scaleY = scale;
    invalidateNodeLocalTransform(layer);
  }

  function setPhase(nextPhase: GameUiPhase): void {
    if (phase === nextPhase) return;
    phase = nextPhase;
    setNodeEnabled(root, true);
    replaceFlowState(flow, layers[nextPhase].state);
    if (nextPhase === 'finished') {
      resultRevealTime = 0;
      resultWasComplete = false;
    }
  }

  function hide(): void {
    clearFlowStack(flow);
    phase = null;
    setNodeEnabled(root, false);
  }

  function resize(nextWidth: number, nextHeight: number, pixelRatio: number): void {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    setScene2DSize(scene, width, height);
    setGlRenderTransform2D(renderState, createMatrix(pixelRatio, 0, 0, pixelRatio, 0, 0));
    layoutReadyScene();
    layoutPlayingScene();
    layoutTimeUpScene();
    layoutResultScene();
    for (const layer of Object.values(layers)) {
      layer.root.pivotX = width / 2;
      layer.root.pivotY = height / 2;
      layer.root.x = width / 2;
      layer.root.y = height / 2;
      invalidateNodeLocalTransform(layer.root);
    }
  }

  function layoutReadyScene(): void {
    const compact = width < 560;
    const centerX = width / 2;
    const titleSize = compact ? 42 : 60;
    const titleWidth = Math.min(width - 34, 620);
    const titleY = Math.max(104, height / 2 - (compact ? 132 : 158));
    redrawRectangle(readyScrim, 0, 0, width, height, COLORS.green, 0.82);
    redrawRectangle(readyRule, centerX - 43, titleY - 32, 86, 1, COLORS.white, 0.48);
    setLabelBox(readyKicker, centerX - titleWidth / 2, titleY - 20, titleWidth, 20);
    setLabelStyle(readyTitleTop, displayFormat(titleSize, COLORS.cream));
    setLabelStyle(readyTitleBottom, displayFormat(titleSize, COLORS.cream));
    setLabelBox(readyTitleTop, centerX - titleWidth / 2, titleY + 8, titleWidth, titleSize + 12);
    setLabelBox(
      readyTitleBottom,
      centerX - titleWidth / 2,
      titleY + titleSize * 0.88,
      titleWidth,
      titleSize + 12,
    );
    setLabelBox(
      readyDescription,
      centerX - Math.min(width - 40, 500) / 2,
      titleY + titleSize * 2 + 18,
      Math.min(width - 40, 500),
      30,
    );
    const buttonY = Math.min(height - 98, titleY + titleSize * 2 + 68);
    redrawRectangle(readyButton, centerX - 91, buttonY, 182, 44, COLORS.cream, 1);
    setLabelBox(readyButtonLabel, centerX - 91, buttonY + 12, 182, 22);
    setLabelBox(readyFooter, 18, height - 32, width - 36, 18);
  }

  function layoutPlayingScene(): void {
    const compact = width < 560;
    const margin = compact ? 16 : 24;
    const calloutWidth = Math.min(compact ? width - 132 : 286, width - margin * 2);
    redrawRectangle(hudCallout, margin, margin, calloutWidth, 34, COLORS.green, 0.64);
    setLabelBox(hudCalloutLabel, margin + 10, margin + 8, calloutWidth - 20, 20);

    const timerWidth = compact ? 86 : 106;
    const timerX = (width - timerWidth) / 2;
    const timerY = compact ? 70 : 18;
    redrawRectangle(timerCard, 0, 0, timerWidth, compact ? 72 : 84, COLORS.green, 0.78);
    setLabelBox(timerKicker, 0, 8, timerWidth, 16);
    setLabelBox(timerValue, 0, 20, timerWidth, 52);
    timerRoot.pivotX = timerWidth / 2;
    timerRoot.pivotY = (compact ? 72 : 84) / 2;
    moveNode(timerRoot, timerX + timerRoot.pivotX, timerY + timerRoot.pivotY);

    const trackY = timerY + (compact ? 78 : 90);
    const trackWidth = Math.max(1, width - margin * 2);
    redrawRectangle(timerTrack, margin, trackY, trackWidth, 4, COLORS.white, 0.24);
    redrawRectangle(timerFill, margin, trackY, trackWidth, 4, COLORS.orange, 1);
    timerFill.pivotX = 0;
    timerFill.pivotY = 0;

    const statsWidth = compact ? Math.min(width - margin * 2, 230) : 252;
    const statsY = height - (compact ? 166 : 174);
    redrawRectangle(statsCard, margin, statsY, statsWidth, 66, COLORS.green, 0.68);
    const statWidth = statsWidth / 2;
    layoutStat(horsesLabel, horsesValue, margin, statsY, statWidth);
    layoutStat(heightLabel, heightValue, margin + statWidth, statsY, statWidth);

    const dropWidth = 168;
    redrawRectangle(dropButton, 0, 0, dropWidth, 46, COLORS.orange, 1);
    setLabelBox(dropButtonLabel, 0, 13, dropWidth, 22);
    dropRoot.pivotX = dropWidth / 2;
    dropRoot.pivotY = 23;
    moveNode(dropRoot, width / 2, height - 68 + dropRoot.pivotY);

    redrawRectangle(restartButton, width - margin - 118, margin, 118, 34, COLORS.green, 0.58);
    setLabelBox(restartButtonLabel, width - margin - 118, margin + 8, 118, 20);
    setLabelBox(viewerBrand, margin, height - 32, 180, 14);
    setLabelBox(viewerProtocol, margin, height - 19, 210, 15);
  }

  function layoutStat(
    label: TextLabel,
    value: TextLabel,
    x: number,
    y: number,
    statWidth: number,
  ): void {
    setLabelBox(label, x + 10, y + 9, statWidth - 20, 15);
    setLabelBox(value, x + 10, y + 27, statWidth - 20, 32);
  }

  function layoutTimeUpScene(): void {
    const compact = width < 560;
    const centerX = width / 2;
    const titleSize = compact ? 72 : Math.min(124, width * 0.15);
    redrawRectangle(timeUpScrim, 0, 0, width, height, COLORS.red, 0.9);
    redrawRectangle(
      timeUpGlow,
      width * 0.14,
      height * 0.28,
      width * 0.72,
      height * 0.44,
      COLORS.gold,
      0.1,
    );
    setLabelBox(timeUpKicker, 20, height / 2 - titleSize * 0.9, width - 40, 20);
    setLabelStyle(timeUpTitle, displayFormat(titleSize, COLORS.gold, true));
    const timeUpTitleTop = height / 2 - titleSize * 0.58;
    setLabelBox(timeUpTitle, 20, timeUpTitleTop, width - 40, titleSize + 24);
    timeUpTitle.pivotX = timeUpTitle.data.width / 2;
    timeUpTitle.pivotY = timeUpTitle.data.height / 2;
    moveNode(timeUpTitle, centerX, timeUpTitleTop + timeUpTitle.pivotY);
    setLabelBox(timeUpCopy, centerX - Math.min(width - 40, 460) / 2, height / 2 + titleSize * 0.54, Math.min(width - 40, 460), 30);
  }

  function layoutResultScene(): void {
    const compact = width < 560;
    const centerX = width / 2;
    const tallyWidth = Math.min(width - 36, compact ? 330 : 440);
    const tallyTop = compact ? 72 : 86;
    const tallyHeight = compact ? 150 : Math.min(205, height * 0.28);
    redrawRectangle(resultScrim, 0, 0, width, height, COLORS.green, 0.88);
    redrawRectangle(resultFlash, 0, 0, width, height, COLORS.gold, 0.12);
    setLabelBox(resultKicker, 20, compact ? 30 : 42, width - 40, 20);
    redrawRectangle(
      resultBaseline,
      centerX - tallyWidth / 2,
      tallyTop + tallyHeight,
      tallyWidth,
      1,
      COLORS.gold,
      0.46,
    );

    const markerWidth = compact ? 15 : 19;
    const markerHeight = compact ? 14 : 17;
    const columns = Math.floor(MAX_HAND_MARKERS / HANDS_PER_COLUMN);
    const gridWidth = columns * markerWidth;
    for (let index = 0; index < handMarkers.length; index++) {
      const marker = handMarkers[index];
      if (marker === undefined) continue;
      const column = Math.floor(index / HANDS_PER_COLUMN);
      const row = index % HANDS_PER_COLUMN;
      setLabelBox(
        marker,
        centerX - gridWidth / 2 + column * markerWidth,
        tallyTop + tallyHeight - (row + 1) * markerHeight,
        markerWidth,
        markerHeight + 5,
      );
    }
    setLabelBox(resultOverflow, centerX + gridWidth / 2 + 4, tallyTop + 10, 76, 22);
    const detailsTop = tallyTop + tallyHeight + 12;
    setLabelBox(resultHands, 20, detailsTop, width - 40, 28);
    setLabelStyle(resultHeight, displayFormat(compact ? 58 : 76, COLORS.gold));
    const resultHeightBoxHeight = compact ? 72 : 90;
    setLabelBox(resultHeight, 20, detailsTop + 27, width - 40, resultHeightBoxHeight);
    resultHeight.pivotX = resultHeight.data.width / 2;
    resultHeight.pivotY = resultHeight.data.height / 2;
    moveNode(resultHeight, centerX, detailsTop + 27 + resultHeightBoxHeight / 2);
    const copyTop = detailsTop + (compact ? 94 : 116);
    setLabelBox(resultCopyTop, 18, copyTop, width - 36, 20);
    setLabelBox(resultCopyBottom, 18, copyTop + 18, width - 36, 20);
    const replayY = height - (compact ? 70 : 76);
    redrawRectangle(replayButton, centerX - 82, replayY, 164, 42, COLORS.cream, 1);
    setLabelBox(replayButtonLabel, centerX - 82, replayY + 11, 164, 22);
  }

  function update(
    deltaTime: number,
    now: number,
    model: Readonly<GameUiModel>,
  ): boolean {
    currentModel = model;
    updateFlowStack(flow, deltaTime);
    if (phase === 'playing') updatePlayingUi(now, model);
    if (phase === 'finished') updateResultUi(deltaTime, model);
    if (phase === 'settling') updateSettlingUi(now);
    return (
      phaseTime < transitionDuration ||
      (!reduceMotion && phase === 'playing' && model.secondsRemaining <= 10) ||
      (phase === 'finished' && (!model.resultComplete || (!reduceMotion && resultRevealTime < 0.8))) ||
      (!reduceMotion && phase === 'settling')
    );
  }

  function updatePlayingUi(now: number, model: Readonly<GameUiModel>): void {
    const urgent = model.secondsRemaining <= 10;
    setTextLabelString(timerValue, String(Math.ceil(model.secondsRemaining)));
    setTextLabelString(hudCalloutLabel, model.callout);
    setTextLabelString(horsesValue, String(model.horsesPlaced));
    setTextLabelString(heightValue, model.height);
    setTextLabelString(scoreValue, model.score);
    const progress = Math.max(0, Math.min(1, model.secondsRemaining / 60));
    if (timerFill.scaleX !== progress) {
      timerFill.scaleX = progress;
      invalidateNodeLocalTransform(timerFill);
    }
    const timerPulse = urgent && !reduceMotion ? 1 + Math.sin(now * 0.014) * 0.045 : 1;
    if (timerRoot.scaleX !== timerPulse || timerRoot.scaleY !== timerPulse) {
      timerRoot.scaleX = timerPulse;
      timerRoot.scaleY = timerPulse;
      invalidateNodeLocalTransform(timerRoot);
    }
    const placeAlpha = model.canPlace ? 1 : 0.42;
    if (dropRoot.alpha !== placeAlpha) {
      dropRoot.alpha = placeAlpha;
      invalidateNodeAppearance(dropRoot);
    }
  }

  function updateSettlingUi(now: number): void {
    const pulse = reduceMotion ? 1 : 1 + Math.sin(now * 0.01) * 0.018;
    if (timeUpTitle.scaleX !== pulse || timeUpTitle.scaleY !== pulse) {
      timeUpTitle.scaleX = pulse;
      timeUpTitle.scaleY = pulse;
      invalidateNodeLocalTransform(timeUpTitle);
    }
  }

  function updateResultUi(deltaTime: number, model: Readonly<GameUiModel>): void {
    setTextLabelString(resultHands, `${model.handsShown} HANDS HIGH`);
    setTextLabelString(resultHeight, model.resultHeight);
    const resultCopyBreak = model.resultCopy.indexOf(' · ');
    setTextLabelString(
      resultCopyTop,
      resultCopyBreak === -1 ? model.resultCopy : model.resultCopy.slice(0, resultCopyBreak),
    );
    setTextLabelString(
      resultCopyBottom,
      resultCopyBreak === -1 ? '' : model.resultCopy.slice(resultCopyBreak + 3),
    );
    const markerCount = Math.min(MAX_HAND_MARKERS, model.handsShown);
    if (markerCount !== markerCountShown) {
      markerCountShown = markerCount;
      for (let index = 0; index < handMarkers.length; index++) {
        const marker = handMarkers[index];
        if (marker !== undefined) setNodeEnabled(marker, index < markerCount);
      }
    }
    setTextLabelString(
      resultOverflow,
      model.handsShown > MAX_HAND_MARKERS ? `+${model.handsShown - MAX_HAND_MARKERS}` : '',
    );
    if (model.resultComplete && !resultWasComplete) resultRevealTime = 0;
    resultWasComplete = model.resultComplete;
    if (model.resultComplete) {
      resultRevealTime = reduceMotion ? 0.8 : Math.min(0.8, resultRevealTime + deltaTime);
    }
    const revealProgress = Math.min(1, resultRevealTime / 0.72);
    const slam = model.resultComplete
      ? 1 + Math.sin(revealProgress * Math.PI) * 0.16 * (1 - revealProgress * 0.35)
      : 1;
    resultHeight.scaleX = slam;
    resultHeight.scaleY = slam;
    invalidateNodeLocalTransform(resultHeight);
    resultFlash.alpha = model.resultComplete ? Math.max(0, 1 - revealProgress) : 0;
    invalidateNodeAppearance(resultFlash);
    replayButton.alpha = model.resultComplete ? 1 : 0;
    replayButtonLabel.alpha = model.resultComplete ? 1 : 0;
    invalidateNodeAppearance(replayButton);
    invalidateNodeAppearance(replayButtonLabel);
  }

  function render(): void {
    if (phase === null || !root.enabled || currentModel === null) return;
    prepareScene2DRender(renderState, root);
    renderGlScene2D(renderState, root);
  }

  return { hide, render, resize, setPhase, update };
}

function createSolidShape(parent: Node2D): Shape {
  const shape = createShape();
  addNodeChild(parent, shape);
  return shape;
}

function createLabel(parent: Node2D, text: string, format: TextFormat): TextLabel {
  const label = createTextLabel({
    data: {
      height: 24,
      text,
      textFormat: format,
      verticalAlign: 'middle',
      width: 100,
    },
  });
  addNodeChild(parent, label);
  return label;
}

function redrawRectangle(
  shape: Shape,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
  alpha: number,
): void {
  clearShapeCommands(shape);
  appendShapeBeginFill(shape, color, alpha);
  appendShapeRectangle(shape, x, y, Math.max(0, width), Math.max(0, height));
  appendShapeEndFill(shape);
}

function setLabelBox(
  label: TextLabel,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  setTextLabelWidth(label, Math.max(1, width));
  setTextLabelHeight(label, Math.max(1, height));
  moveNode(label, x, y);
}

function setLabelStyle(label: TextLabel, format: TextFormat): void {
  const current = label.data.textFormat;
  if (
    current.align === format.align &&
    current.bold === format.bold &&
    current.color === format.color &&
    current.font === format.font &&
    current.letterSpacing === format.letterSpacing &&
    current.size === format.size
  ) {
    return;
  }
  setTextLabelFormat(label, format);
}

function moveNode(node: Node2D, x: number, y: number): void {
  if (node.x === x && node.y === y) return;
  node.x = x;
  node.y = y;
  invalidateNodeLocalTransform(node);
}

function kickerFormat(color: number): TextFormat {
  return {
    align: 'center',
    bold: true,
    color,
    font: UI_FONT,
    letterSpacing: 1.4,
    size: 9,
  };
}

function buttonFormat(color: number): TextFormat {
  return {
    align: 'center',
    bold: true,
    color,
    font: UI_FONT,
    letterSpacing: 1.05,
    size: 10,
  };
}

function bodyFormat(size: number, color: number, bold = false): TextFormat {
  return {
    align: 'center',
    bold,
    color,
    font: bold ? UI_FONT : DISPLAY_FONT,
    size,
  };
}

function displayFormat(size: number, color: number, bold = false): TextFormat {
  return {
    align: 'center',
    bold,
    color,
    font: bold ? UI_FONT : DISPLAY_FONT,
    size,
  };
}
