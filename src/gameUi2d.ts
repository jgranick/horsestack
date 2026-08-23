// The game's UI, drawn with Flight's 2D renderer instead of DOM and CSS.
//
// It lives on its OWN canvas and its OWN GL context, layered over the 3D one. That is not
// incidental: sharing a GlRenderState with the 3D pipeline corrupts it (props lose their
// textures) because the two passes fight over renderer registrations and per-frame batch
// state, and rendering 2D after the 3D pipeline has composited draws nothing at all
// because no target is bound any more. A separate context sidesteps both.
import type { DisplayObject, GlRenderState, Shape, TextLabel } from '@flighthq/sdk';
import {
  addNodeChild,
  appendShapeBeginFill,
  appendShapeRoundRectangle,
  clearShapeCommands,
  createCanvasShapeRasterizer,
  createCanvasTextureResolvers,
  createDisplayObject,
  createGlCanvasElement,
  createGlRenderState,
  createMatrix,
  createShape,
  createTextLabel,
  defaultGlShapeCommands,
  defaultGlShapeRenderer,
  defaultGlTextLabelRenderer,
  invalidateNodeAppearance,
  invalidateNodeRender,
  invalidateNodeLocalTransform,
  prepareScene2DRender,
  registerGlShapeCommands,
  registerGlShapeRasterizer,
  registerGlStandardMaterial,
  registerRenderer,
  renderGlBackground,
  renderGlScene2D,
  setTextLabelFormat,
  setTextLabelHeight,
  setTextLabelString,
  setTextLabelWidth,
  ShapeKind,
  TextLabelKind,
} from '@flighthq/sdk';

export type UiScreen = 'loading' | 'title' | 'playing' | 'timeup' | 'result';

export interface UiButton {
  height: number;
  id: 'play' | 'again' | 'restart' | 'fullscreen' | 'credits';
  width: number;
  x: number;
  y: number;
}

export interface UiState {
  buttons: UiButton[];
  canvas: HTMLCanvasElement;
  render: () => void;
  resize: (width: number, height: number, pixelRatio: number) => void;
  update: (model: UiModel) => void;
}

export interface UiModel {
  creditsOpen: boolean;
  // 0..1 across the result count-up, used for the score slam on arrival.
  countProgress: number;
  creditsText?: string;
  handsShown: number;
  handsText: string;
  heightText: string;
  pointsText: string;
  now: number;
  screen: UiScreen;
  secondsLeft: number;
  // 0..1 over the TIME UP arrival, driving its overshoot.
  timeUpProgress: number;
}

const HANDS_PER_EMOJI_COLUMN = 9;
const GOLD = 0xffd166;

// The DOM original eased each of these with CSS keyframes; recreated here so the beats
// survive the move to Flight 2D. See docs/result-screen-reference.png.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// time-up-arrive: 1.18 -> 0.97 at 55% -> 1.0, with the panel fading in.
function timeUpScale(t: number): number {
  if (t >= 1) return 1;
  if (t <= 0) return 1.18;
  return t < 0.55
    ? 1.18 + (0.97 - 1.18) * easeOutCubic(t / 0.55)
    : 0.97 + 0.03 * easeOutCubic((t - 0.55) / 0.45);
}

// total-score-slam: 0.58 -> 1.16 at 68% -> 1.0.
function slamScale(t: number): number {
  if (t >= 1 || t <= 0) return 1;
  return t < 0.68
    ? 0.58 + (1.16 - 0.58) * easeOutCubic(t / 0.68)
    : 1.16 - 0.16 * easeOutCubic((t - 0.68) / 0.32);
}

const INK = 0xfbf7ec;
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

function label(text: string, size: number, color: number, font: string, bold = false): TextLabel {
  const node = createTextLabel();
  setTextLabelString(node, text);
  setTextLabelFormat(node, { align: 'center', bold, color, font, size });
  setTextLabelWidth(node, 10);
  setTextLabelHeight(node, size * 1.6);
  return node;
}

function place(node: DisplayObject, x: number, y: number): void {
  node.x = x;
  node.y = y;
  invalidateNodeLocalTransform(node);
}

function show(node: DisplayObject, visible: boolean): void {
  if (node.visible === visible) return;
  node.visible = visible;
  invalidateNodeAppearance(node);
}

function setText(node: TextLabel, text: string): void {
  if (node.data.text === text) return;
  setTextLabelString(node, text);
}

function fill(shape: Shape, colour: number, alpha: number, x: number, y: number, w: number, h: number, r: number): void {
  clearShapeCommands(shape);
  appendShapeBeginFill(shape, colour, alpha);
  appendShapeRoundRectangle(shape, x, y, w, h, r, r);
  invalidateNodeRender(shape);
}

export function createGameUi2D(host: HTMLElement, pixelRatio: number): UiState {
  const canvas = createGlCanvasElement(1, 1, pixelRatio);
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '8';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const state: GlRenderState = createGlRenderState(canvas, {
    pixelRatio,
    backgroundColor: 0x00000000,
    contextAttributes: { alpha: true, antialias: true },
  });
  registerRenderer(state, ShapeKind, defaultGlShapeRenderer);
  registerRenderer(state, TextLabelKind, defaultGlTextLabelRenderer);
  registerGlShapeCommands(state, defaultGlShapeCommands);
  registerGlShapeRasterizer(state, createCanvasShapeRasterizer(createCanvasTextureResolvers()));
  registerGlStandardMaterial(state);
  state.renderTransform2D = createMatrix(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const root = createDisplayObject();
  const scrim = createShape();
  // Same treatment as TIME UP and the result height: big gold serif, so the three
  // screens read as one family. Upright rather than tilted — the tilt is TIME UP's.
  const titleText = label('Horse Stacker', 96, GOLD, SERIF, true);
  const playPill = createShape();
  const playText = label('PLAY', 13, 0x252420, SANS, true);
  const timerPill = createShape();
  const timerCaption = label('TIME LEFT', 9, 0xd8e0d2, SANS, true);
  const timerValue = label('60', 34, INK, SERIF);
  const restartPill = createShape();
  const restartText = label('START OVER', 10, INK, SANS, true);
  const timeUpScrim = createShape();
  const timeUpText = label('TIME UP!', 112, GOLD, SERIF, true);
  const tallyRule = createShape();
  // One label per hand, like the DOM original's one span per hand: it is what lets each
  // horse pop in as the count reaches it. TextLabel has no multiline switch on its data,
  // so a column cannot be one label with newlines.
  const TALLY_CAPACITY = 126;
  const tallyHorses: TextLabel[] = [];
  for (let index = 0; index < TALLY_CAPACITY; index += 1) {
    tallyHorses.push(label('🐴', 15, INK, SANS));
  }
  const horseAppearedAt = new Float64Array(TALLY_CAPACITY);
  const handsCaption = label('HANDS HIGH', 10, 0xd8e0d2, SANS, true);
  const pointsText = label('', 12, 0xd8e0d2, SERIF);
  const resultHeight = label('0.00 m', 74, 0xffd166, SERIF);
  const resultHands = label('0', 22, GOLD, SERIF);
  const againPill = createShape();
  const againText = label('PLAY AGAIN', 13, 0x252420, SANS, true);
  const creditsPill = createShape();
  const creditsText = label('i', 15, INK, SERIF);
  const creditsBody = createShape();
  const creditsCopy = label('', 11, 0xd8e0d2, SANS);
  const fullscreenPill = createShape();
  const fullscreenText = label('⛶', 15, INK, SANS);

  for (const node of [
    scrim, titleText, playPill, playText, timerPill, timerCaption, timerValue,
    restartPill, restartText, timeUpScrim, timeUpText,
    ...tallyHorses, tallyRule, resultHands, handsCaption, resultHeight, pointsText,
    againPill, againText,
    creditsBody, creditsCopy, creditsPill, creditsText, fullscreenPill, fullscreenText,
  ]) {
    addNodeChild(root, node);
  }

  let width = 1;
  let height = 1;
  const buttons: UiButton[] = [];

  function centreLabel(node: TextLabel, y: number): void {
    setTextLabelWidth(node, width);
    place(node, 0, y);
  }

  function pill(shape: Shape, text: TextLabel, id: UiButton['id'], x: number, y: number, w: number, h: number, colour: number, alpha: number): void {
    fill(shape, colour, alpha, 0, 0, w, h, h / 2);
    place(shape, x, y);
    setTextLabelWidth(text, w);
    place(text, x, y + (h - (text.data.textFormat.size ?? 12) * 1.35) / 2);
    buttons.push({ height: h, id, width: w, x, y });
  }

  function update(model: UiModel): void {
    buttons.length = 0;
    const onTitle = model.screen === 'title';
    const onResult = model.screen === 'result';
    const onTimeUp = model.screen === 'timeup';
    const playing = model.screen === 'playing';
    const dim = onTitle || onResult;

    show(scrim, dim);
    if (dim) {
      fill(scrim, 0x1c2a1b, onTitle ? 0.72 : 0.78, 0, 0, width, height, 0);
      place(scrim, 0, 0);
    }

    show(titleText, onTitle);
    show(playPill, onTitle);
    show(playText, onTitle);
    if (onTitle) {
      centreLabel(titleText, height * 0.5 - 120);
      pill(playPill, playText, 'play', width / 2 - 84, height * 0.5 + 30, 168, 44, INK, 1);
    }

    show(timeUpScrim, onTimeUp);
    show(timeUpText, onTimeUp);
    if (onTimeUp) {
      const t = Math.min(1, Math.max(0, model.timeUpProgress));
      const scale = timeUpScale(t);
      fill(timeUpScrim, 0x7e311f, 0.88 * Math.min(1, t * 3), 0, 0, width, height, 0);
      place(timeUpScrim, 0, 0);
      setTextLabelWidth(timeUpText, width);
      timeUpText.scaleX = scale;
      timeUpText.scaleY = scale;
      timeUpText.alpha = Math.min(1, t * 2.4);
      timeUpText.pivotX = width / 2;
      timeUpText.pivotY = 60;
      timeUpText.rotation = -0.052;
      place(timeUpText, width / 2, height * 0.5);
      invalidateNodeAppearance(timeUpText);
    }

    const showAgain = onResult && model.countProgress >= 1;
    show(resultHeight, onResult);
    show(resultHands, onResult);
    show(handsCaption, onResult);
    show(pointsText, showAgain);
    show(tallyRule, onResult);
    show(againPill, showAgain);
    show(againText, showAgain);
    if (!onResult) {
      for (const horse of tallyHorses) show(horse, false);
    }
    if (onResult) {
      // Column-major, bottom-up, nine to a column — the DOM tally's layout.
      const ruleY = height * 0.5 - 42;
      const cell = 17;
      const columnWidth = 19;
      const shown = Math.min(model.handsShown, TALLY_CAPACITY);
      const columns = Math.max(1, Math.ceil(shown / HANDS_PER_EMOJI_COLUMN));
      const startX = width / 2 - (columns * columnWidth) / 2;
      for (let index = 0; index < TALLY_CAPACITY; index += 1) {
        const horse = tallyHorses[index];
        if (horse === undefined) continue;
        if (index >= shown) {
          show(horse, false);
          horseAppearedAt[index] = 0;
          continue;
        }
        if (horseAppearedAt[index] === 0) horseAppearedAt[index] = model.now;
        const column = Math.floor(index / HANDS_PER_EMOJI_COLUMN);
        const row = index % HANDS_PER_EMOJI_COLUMN;
        // horse-hand-pop: rises into place from below with a slight overshoot.
        const age = Math.min(1, (model.now - (horseAppearedAt[index] ?? 0)) / 340);
        const pop = age < 0.7
          ? 0.2 + 0.98 * easeOutCubic(age / 0.7)
          : 1.18 - 0.18 * easeOutCubic((age - 0.7) / 0.3);
        show(horse, true);
        setTextLabelWidth(horse, columnWidth);
        horse.scaleX = pop;
        horse.scaleY = pop;
        horse.alpha = Math.min(1, age * 3);
        place(
          horse,
          startX + column * columnWidth,
          ruleY - (row + 1) * cell - 4 + (1 - age) * 18,
        );
        invalidateNodeAppearance(horse);
      }
      fill(tallyRule, GOLD, 0.42, 0, 0, Math.min(430, width - 48), 1, 0);
      place(tallyRule, width / 2 - Math.min(430, width - 48) / 2, ruleY);

      // The gold count and its caption sit on one line, as in the DOM original:
      // a right-aligned number butted against a left-aligned label.
      setTextLabelFormat(resultHands, {
        align: 'right', color: GOLD, font: SERIF, size: 22,
      });
      setTextLabelWidth(resultHands, width / 2 - 34);
      setText(resultHands, model.handsText);
      place(resultHands, 0, ruleY + 10);
      setTextLabelFormat(handsCaption, {
        align: 'left', bold: true, color: 0xd8e0d2, font: SANS, size: 10,
      });
      setTextLabelWidth(handsCaption, width / 2);
      place(handsCaption, width / 2 - 28, ruleY + 22);

      const slam = slamScale(Math.min(1, model.countProgress * 1.02));
      setTextLabelWidth(resultHeight, width);
      setText(resultHeight, model.heightText);
      resultHeight.scaleX = slam;
      resultHeight.scaleY = slam;
      resultHeight.pivotX = width / 2;
      resultHeight.pivotY = 40;
      // pivot is the anchor, so x/y address the pivot rather than the top-left corner
      place(resultHeight, width / 2, ruleY + 52 + 40);

      centreLabel(pointsText, ruleY + 150);
      setText(pointsText, model.pointsText);
      pill(againPill, againText, 'again', width / 2 - 96, ruleY + 186, 192, 44, INK, 1);
    }

    show(timerPill, playing);
    show(timerCaption, playing);
    show(timerValue, playing);
    show(restartPill, playing);
    show(restartText, playing);
    if (playing) {
      const w = 104;
      const x = width - w - 24;
      fill(timerPill, 0x1f2d1d, 0.72, 0, 0, w, 62, 18);
      place(timerPill, x, 18);
      setTextLabelWidth(timerCaption, w);
      place(timerCaption, x, 26);
      setTextLabelWidth(timerValue, w);
      place(timerValue, x, 38);
      setText(timerValue, String(Math.max(0, Math.ceil(model.secondsLeft))));
      pill(restartPill, restartText, 'restart', width - 128, 92, 104, 30, 0x1f2d1d, 0.5);
    }

    pill(creditsPill, creditsText, 'credits', 24, height - 54, 30, 30, 0x1f2d1d, 0.42);
    pill(fullscreenPill, fullscreenText, 'fullscreen', width - 54, height - 54, 30, 30, 0x1f2d1d, 0.42);

    show(creditsBody, model.creditsOpen);
    show(creditsCopy, model.creditsOpen);
    if (model.creditsOpen) {
      const w = Math.min(420, width - 48);
      fill(creditsBody, 0x182217, 0.9, 0, 0, w, 96, 16);
      place(creditsBody, 24, height - 162);
      setText(
        creditsCopy,
        'Built with Flight · Models by EdwinRC and SleepyPineapple, CC BY 4.0 · ' +
          'Music “The Mountain’s Happy Song” by Elijah_K via Free Music Archive, CC BY · ' +
          'Ambience and effects via Free Sound Effects',
      );
      setTextLabelFormat(creditsCopy, { ...creditsCopy.data.textFormat, align: 'left' });
      setTextLabelWidth(creditsCopy, w - 32);
      setTextLabelHeight(creditsCopy, 80);
      place(creditsCopy, 40, height - 146);
    }
  }

  function resize(nextWidth: number, nextHeight: number, nextPixelRatio: number): void {
    width = Math.max(1, Math.round(nextWidth));
    height = Math.max(1, Math.round(nextHeight));
    canvas.width = Math.round(width * nextPixelRatio);
    canvas.height = Math.round(height * nextPixelRatio);
    state.pixelRatio = nextPixelRatio;
    state.renderTransform2D = createMatrix(nextPixelRatio, 0, 0, nextPixelRatio, 0, 0);
  }

  function render(): void {
    if (!prepareScene2DRender(state, root)) return;
    renderGlBackground(state);
    renderGlScene2D(state, root);
  }

  return { buttons, canvas, render, resize, update };
}
