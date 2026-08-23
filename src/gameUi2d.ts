// The game's UI, drawn with Flight's 2D renderer instead of DOM and CSS.
//
// One canvas. The UI is drawn into its own offscreen render target using a SECOND render
// state over the SAME GL context, then composited onto the finished 3D frame as a single
// blended quad.
//
// Three things make that work, each of which broke an earlier attempt:
//   - the second state comes from createGlOffscreenRenderState, so its renderer/material
//     registrations and per-frame batch state are its own. Sharing one state with the 3D
//     pipeline corrupts the 3D — props lose their textures.
//   - the 2D pass targets its OWN framebuffer, so it cannot disturb the frame the 3D
//     pipeline just composited. Drawing 2D straight into the default framebuffer after the
//     pipeline drew nothing at all; drawing it inside the pipeline corrupted the 3D.
//   - the composite saves and restores every piece of GL state it touches, so nothing
//     leaks into the next frame's 3D pass.
import type { DisplayObject, GlRenderState, GlRenderTarget, RichText, Shape, TextLabel } from '@flighthq/sdk';
import {
  addNodeChild,
  appendShapeBeginFill,
  appendShapeRoundRectangle,
  clearShapeCommands,
  createCanvasShapeRasterizer,
  createCanvasTextureResolvers,
  createDisplayObject,
  createGlOffscreenRenderState,
  createGlRenderTarget,
  createRichText,
  createMatrix,
  createShape,
  createTextLabel,
  defaultGlShapeCommands,
  defaultGlRichTextRenderer,
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
  renderGlScene2D,
  RichTextKind,
  setRichTextDefaultTextFormat,
  setRichTextMultiline,
  setRichTextString,
  setRichTextWidth,
  setRichTextWordWrap,
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
  id: 'play' | 'again' | 'fullscreen' | 'credits';
  width: number;
  x: number;
  y: number;
}

export interface UiState {
  buttons: UiButton[];
  render: () => void;
  resize: (width: number, height: number, pixelRatio: number) => void;
  /** Returns true while the UI still has something to animate, so the host keeps drawing. */
  update: (model: UiModel) => boolean;
}

export interface UiModel {
  creditsOpen: boolean;
  // 0..1 across the result count-up, used for the score slam on arrival.
  countProgress: number;
  creditsText?: string;
  handsShown: number;
  handsText: string;
  heightText: string;
  now: number;
  pointerDown: boolean;
  pointerX: number;
  pointerY: number;
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

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Overshoots past 1 then settles, so a screen arrives with a bit of bounce instead of
// simply appearing.
function easeOutBack(t: number): number {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
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

export function createGameUi2D(screenState: GlRenderState, pixelRatio: number): UiState {
  const gl = screenState.gl;
  const state: GlRenderState = createGlOffscreenRenderState(screenState);
  let target: GlRenderTarget | null = null;
  const composite = createCompositor(gl);
  registerRenderer(state, ShapeKind, defaultGlShapeRenderer);
  registerRenderer(state, TextLabelKind, defaultGlTextLabelRenderer);
  registerRenderer(state, RichTextKind, defaultGlRichTextRenderer);
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
  const timerValue = label('30', 34, INK, SERIF);
  const timeUpScrim = createShape();
  const timeUpText = label('TIME UP!', 112, GOLD, SERIF, true);
  const tallyRule = createShape();
  // One label per hand, like the DOM original's one span per hand: it is what lets each
  // horse pop in as the count reaches it. A column could be a single multiline node —
  // that is what RichText is for, and the credits copy below uses it — but then the
  // whole column would animate as one block instead of horse by horse.
  const TALLY_CAPACITY = 126;
  const tallyHorses: TextLabel[] = [];
  for (let index = 0; index < TALLY_CAPACITY; index += 1) {
    tallyHorses.push(label('🐴', 15, INK, SANS));
  }
  const horseAppearedAt = new Float64Array(TALLY_CAPACITY);
  const handsCaption = label('HANDS HIGH', 10, 0xd8e0d2, SANS, true);
  const resultHeight = label('0.00 m', 74, 0xffd166, SERIF);
  const resultHands = label('0', 22, GOLD, SERIF);
  const againPill = createShape();
  const againText = label('PLAY AGAIN', 13, 0x252420, SANS, true);
  const creditsPill = createShape();
  const creditsText = label('i', 15, INK, SERIF);
  const creditsBody = createShape();
  const creditsCopy: RichText = createRichText();
  setRichTextMultiline(creditsCopy, true);
  setRichTextWordWrap(creditsCopy, true);
  setRichTextDefaultTextFormat(creditsCopy, {
    align: 'left', color: 0xd8e0d2, font: SANS, leading: 3, size: 11,
  });
  const fullscreenPill = createShape();
  const fullscreenText = label('⛶', 15, INK, SANS);

  for (const node of [
    scrim, titleText, playPill, playText, timerPill, timerCaption, timerValue,
    timeUpScrim, timeUpText,
    ...tallyHorses, tallyRule, resultHands, handsCaption, resultHeight,
    againPill, againText,
    creditsBody, creditsCopy, creditsPill, creditsText, fullscreenPill, fullscreenText,
  ]) {
    addNodeChild(root, node);
  }

  let width = 1;
  let height = 1;
  const buttons: UiButton[] = [];
  // When the current screen appeared, so each one animates in rather than cutting in.
  let screenShownAt = 0;
  let lastScreen: UiScreen | null = null;
  let pointer = { down: false, x: -1, y: -1 };
  let hoveringAnything = false;

  function hovering(x: number, y: number, w: number, h: number): boolean {
    return pointer.x >= x && pointer.x <= x + w && pointer.y >= y && pointer.y <= y + h;
  }

  function pill(shape: Shape, text: TextLabel, id: UiButton['id'], x: number, y: number, w: number, h: number, colour: number, alpha: number): void {
    // A control that does nothing until you click it feels dead. Hovering swells it and
    // brightens the fill; pressing sinks it. The rounded rect is redrawn every frame
    // anyway, so this needs no pivot juggling — just draw it a size bigger.
    const hovered = hovering(x, y, w, h);
    if (hovered) hoveringAnything = true;
    const pressed = hovered && pointer.down;
    const grow = pressed ? -1.5 : hovered ? 2.5 : 0;
    const sink = pressed ? 1.5 : 0;
    fill(
      shape, colour, Math.min(1, alpha + (hovered ? 0.14 : 0)),
      -grow, -grow, w + grow * 2, h + grow * 2, (h + grow * 2) / 2,
    );
    place(shape, x, y + sink);
    setTextLabelWidth(text, w);
    place(text, x, y + sink + (h - (text.data.textFormat.size ?? 12) * 1.35) / 2);
    buttons.push({ height: h, id, width: w, x, y });
  }

  function update(model: UiModel): boolean {
    const wasHovering = hoveringAnything;
    hoveringAnything = false;
    pointer = { down: model.pointerDown, x: model.pointerX, y: model.pointerY };
    if (model.screen !== lastScreen) {
      lastScreen = model.screen;
      screenShownAt = model.now;
    }
    // 0..1 as the current screen arrives; `pop` overshoots so things land with a bounce.
    const intro = clamp01((model.now - screenShownAt) / 380);
    const pop = easeOutBack(intro);
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
      // Drops in with an overshoot, then breathes so the screen is never quite still.
      const breathe = Math.sin(model.now * 0.0016) * 4;
      setTextLabelWidth(titleText, width);
      titleText.alpha = intro;
      titleText.scaleX = 0.86 + 0.14 * pop;
      titleText.scaleY = titleText.scaleX;
      titleText.pivotX = width / 2;
      titleText.pivotY = 60;
      place(titleText, width / 2, height * 0.5 - 120 + 60 + (1 - pop) * 26 + breathe);
      invalidateNodeAppearance(titleText);
      const nudge = Math.sin(model.now * 0.0016 + 1.1) * 2;
      pill(
        playPill, playText, 'play',
        width / 2 - 84, height * 0.5 + 30 + (1 - intro) * 20 + nudge, 168, 44, INK, intro,
      );
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
      // The rule wipes out from the centre rather than appearing whole.
      const ruleWidth = Math.min(430, width - 48) * clamp01(intro * 1.4);
      fill(tallyRule, GOLD, 0.42, 0, 0, Math.max(1, ruleWidth), 1, 0);
      place(tallyRule, width / 2 - ruleWidth / 2, ruleY);

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

      // The count runs at rest scale so the number stays readable, then the height itself
      // pops on the beat the points used to arrive on.
      const settle = clamp01((model.countProgress - 0.86) / 0.14);
      const slam = slamScale(settle);
      setTextLabelWidth(resultHeight, width);
      setText(resultHeight, model.heightText);
      resultHeight.scaleX = slam;
      resultHeight.scaleY = slam;
      resultHeight.pivotX = width / 2;
      resultHeight.pivotY = 40;
      // pivot is the anchor, so x/y address the pivot rather than the top-left corner
      place(resultHeight, width / 2, ruleY + 52 + 40);

      pill(
        againPill, againText, 'again',
        width / 2 - 96, ruleY + 186 + (1 - easeOutBack(settle)) * 16, 192, 44, INK, settle,
      );
    }

    show(timerPill, playing);
    show(timerCaption, playing);
    show(timerValue, playing);
    if (playing) {
      const w = 104;
      const x = width - w - 24;
      const drop = (1 - pop) * 40;
      // Under ten seconds the pill turns hot and jitters; each new second gives the number
      // a kick, so the clock reads as running rather than just counting.
      const urgent = clamp01((10 - model.secondsLeft) / 4);
      const fraction = model.secondsLeft - Math.floor(model.secondsLeft);
      const kick = Math.max(0, 1 - (1 - fraction) * 7);
      const shake = urgent * Math.sin(model.now * 0.045) * 2.5;
      fill(
        timerPill,
        urgent > 0 ? 0x8c3a24 : 0x1f2d1d,
        0.72 + urgent * 0.14,
        0, 0, w, 62, 18,
      );
      place(timerPill, x + shake, 18 - drop);
      setTextLabelWidth(timerCaption, w);
      place(timerCaption, x + shake, 26 - drop);
      setTextLabelWidth(timerValue, w);
      const beat = 1 + kick * (0.14 + urgent * 0.12);
      timerValue.scaleX = beat;
      timerValue.scaleY = beat;
      timerValue.pivotX = w / 2;
      timerValue.pivotY = 20;
      place(timerValue, x + shake + w / 2, 38 - drop + 20);
      setText(timerValue, String(Math.max(0, Math.ceil(model.secondsLeft))));
    }

    pill(creditsPill, creditsText, 'credits', 24, height - 54, 30, 30, 0x1f2d1d, 0.42);
    pill(fullscreenPill, fullscreenText, 'fullscreen', width - 54, height - 54, 30, 30, 0x1f2d1d, 0.42);

    show(creditsBody, model.creditsOpen);
    show(creditsCopy, model.creditsOpen);
    if (model.creditsOpen) {
      const w = Math.min(420, width - 48);
      fill(creditsBody, 0x182217, 0.9, 0, 0, w, 82, 16);
      place(creditsBody, 24, height - 148);
      setRichTextWidth(creditsCopy, w - 32);
      setRichTextString(
        creditsCopy,
        'Built with Flight · Models by EdwinRC and SleepyPineapple, CC BY 4.0 · ' +
          'Music “The Mountain’s Happy Song” by Elijah_K via Free Music Archive, CC BY · ' +
          'Ambience and effects via Free Sound Effects',
      );
      place(creditsCopy, 40, height - 134);
    }

    // The host only draws on demand, so the UI has to ask for the next frame or anything
    // that breathes, ticks or counts would freeze after one.
    const settling = model.screen === 'result' && model.countProgress < 1;
    const arriving = intro < 1;
    const idleMotion = model.screen === 'title' || model.screen === 'playing';
    return arriving || settling || idleMotion || hoveringAnything || wasHovering;
  }

  function resize(nextWidth: number, nextHeight: number, nextPixelRatio: number): void {
    width = Math.max(1, Math.round(nextWidth));
    height = Math.max(1, Math.round(nextHeight));
    state.pixelRatio = nextPixelRatio;
    state.renderTransform2D = createMatrix(nextPixelRatio, 0, 0, nextPixelRatio, 0, 0);
    // The target matches the drawing buffer exactly, so UI text lands on whole device
    // pixels and stays crisp rather than being resampled by the composite. Resizing
    // allocates a new one, so the old one has to go back or every resize leaks a
    // screen-sized texture.
    if (target !== null) releaseTarget(gl, target);
    target = createGlRenderTarget(state, {
      width: Math.round(width * nextPixelRatio),
      height: Math.round(height * nextPixelRatio),
      depth: 'none',
    });
  }

  function render(): void {
    const surface = target;
    if (surface === null || !prepareScene2DRender(state, root)) return;

    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const previousVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const blendWasOn = gl.isEnabled(gl.BLEND);
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    const cullWasOn = gl.isEnabled(gl.CULL_FACE);
    const scissorWasOn = gl.isEnabled(gl.SCISSOR_TEST);

    // 1. Draw the UI into its own target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer);
    gl.viewport(0, 0, surface.width, surface.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderGlScene2D(state, root);

    // 2. Lay it over the frame the 3D pipeline already composited.
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    gl.viewport(previousViewport[0] ?? 0, previousViewport[1] ?? 0, previousViewport[2] ?? 1, previousViewport[3] ?? 1);
    composite.draw(surface.textures[0] ?? null);

    // 3. Hand the context back exactly as it was found.
    gl.bindVertexArray(previousVertexArray);
    gl.useProgram(previousProgram);
    gl.activeTexture(previousActiveTexture);
    if (blendWasOn) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    if (cullWasOn) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    if (scissorWasOn) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  }

  return { buttons, render, resize, update };
}

// destroyGlRenderTarget is not on the SDK's public surface, so the GL objects go back by
// hand. Without this every resize would strand a screen-sized texture and its framebuffer.
function releaseTarget(gl: WebGL2RenderingContext, target: GlRenderTarget): void {
  gl.deleteFramebuffer(target.framebuffer);
  if (target.resolveFramebuffer !== null) gl.deleteFramebuffer(target.resolveFramebuffer);
  for (const texture of target.textures) gl.deleteTexture(texture);
}

// A full-screen triangle sampling the UI target. The UI is drawn into a transparent target
// with ordinary source-alpha blending, which leaves premultiplied colour, so it composites
// with ONE / ONE_MINUS_SRC_ALPHA.
function createCompositor(gl: WebGL2RenderingContext): { draw: (texture: WebGLTexture | null) => void } {
  const program = gl.createProgram();
  const attach = (type: number, source: string): void => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('UI compositor: could not create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`UI compositor: ${gl.getShaderInfoLog(shader) ?? 'shader failed to compile'}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  };
  attach(gl.VERTEX_SHADER, `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`);
  attach(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
uniform sampler2D u_ui;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  fragColor = texture(u_ui, v_uv);
}`);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`UI compositor: ${gl.getProgramInfoLog(program) ?? 'program failed to link'}`);
  }
  const sampler = gl.getUniformLocation(program, 'u_ui');
  const vertexArray = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    draw(texture) {
      if (texture === null) return;
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(sampler, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
