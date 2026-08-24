// The game's UI: what is on each of the five screens, where it sits, and how it animates in.
// src/ui/GameUi.hx in the Haxe sibling, which splits the UI the same three ways — this file
// is the layout, ui/uiRenderer.ts is the GL plumbing that gets it onto the canvas, and
// ui/uiElements.ts holds the node helpers and the palette it is written with.
//
// Everything below is one long layout pass. It runs every frame and is deliberately
// straight-line: `update` reads a UiModel snapshot, positions every node for the screen it
// names, and returns whether anything is still animating. There is no retained widget tree
// and no diffing — the nodes are built once, and each frame decides afresh what is shown.
import type { GlRenderState, RichText, Shape, TextLabel } from '@flighthq/sdk';
import type { GameMode } from '../game/gameMode';
import {
  addNodeChild,
  createDisplayObject,
  createRichText,
  createShape,
  easeOutBack,
  easeOutCubic,
  easePiecewise,
  easeScaleOutput,
  invalidateNodeAppearance,
  saturate,
  setRichTextDefaultTextFormat,
  setRichTextMultiline,
  setRichTextString,
  setRichTextWidth,
  setRichTextWordWrap,
  setTextLabelWidth,
} from '@flighthq/sdk';
import { createUiRenderer } from './uiRenderer';
import {
  fill,
  drawFullscreen,
  drawSpeaker,
  fitLabelToWidth,
  GOLD,
  INK,
  label,
  place,
  SANS,
  SERIF,
  setText,
  show,
} from './uiElements';

export type UiScreen = 'loading' | 'title' | 'playing' | 'timeup' | 'result';

export interface UiButton {
  height: number;
  id: 'time' | 'steady' | 'again' | 'menu' | 'fullscreen' | 'credits' | 'mute';
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
  /** Which game is being played, which decides the playing screen's HUD. */
  mode: GameMode;
  /**
   * The pile's height right now, for the Steady Hands readout. Live rather than best-so-far:
   * with no clock, this number is the only thing on screen that moves, and a best-so-far
   * reading sits still exactly when you are building. The best is still what the run SCORES.
   */
  liveHeightText: string;
  /** The kind coming up next, as an emoji for the NEXT readout. */
  nextPieceGlyph: string;
  /** Whether sound is muted, for the speaker control. */
  muted: boolean;
  // Empty when there is nothing worth showing: a first ever round, or one that set a new
  // record (where the height on screen already IS the record).
  bestText: string;
  creditsOpen: boolean;
  // 0..1 across the result count-up, used for the score slam on arrival.
  countProgress: number;
  creditsText?: string;
  handsShown: number;
  heightText: string;
  isRecord: boolean;
  now: number;
  pointerDown: boolean;
  pointerX: number;
  pointerY: number;
  screen: UiScreen;
  secondsLeft: number;
  // 0..1 over the TIME UP arrival, driving its overshoot.
  timeUpProgress: number;
}

// Display type is authored at a desktop size and shrunk to fit a narrow window; see
// fitLabelToWidth in uiElements.ts. The minimums are the point below which the line stops
// reading as a title and would be better wrapped — no window this game runs in gets there,
// but a floor beats a one-pixel title if one ever does.
const SCREEN_GUTTER = 20;
const TITLE_MAX_SIZE = 96;
const TITLE_MIN_SIZE = 30;
const TIME_UP_MAX_SIZE = 112;
const TIME_UP_MIN_SIZE = 34;
// Where the line's own centre sits within its box, as a fraction of the font size. The
// layout used to hard-code 60 against a 96pt line; this is that same ratio, kept honest as
// the size changes.
const TITLE_PIVOT_RATIO = 60 / 96;
// Wide enough for "TIME CHALLENGE" at 13px with room either side; narrowed on a phone by
// the gutter, which is why the pills read their width rather than carrying a fixed one.
const MODE_PILL_WIDTH = 216;
// The STEADY HANDS readout is the timed pill's caption and value with no clock above them.
const STEADY_PILL_HEIGHT = 62;
// The NEXT readout, off for now. See the note where it is laid out.
const SHOW_NEXT_PREVIEW = false;

const HANDS_PER_EMOJI_COLUMN = 7;
// One horse per TWO hands, seven to a column. At one apiece the grid saturated at its
// 126-emoji capacity on any decent run — a 10m tower and a 16m tower both showed the same
// full wall, which is the opposite of what a tally is for. Four per horse fixed the top end
// and ruined the bottom: a weak run collapsed to a single lonely column. Two per horse with
// a shorter column keeps the block growing sideways across the whole range — roughly three
// columns for a poor run, a dozen for a good one — and does not saturate until about 26m,
// which nothing has reached.
const HANDS_PER_EMOJI = 2;

// The DOM original eased each of these with CSS keyframes; recreated here on Flight's
// easing primitives so the beats survive the move to Flight 2D, and so the curves are the
// library's rather than four hand-rolled polynomials. See docs/result-screen-reference.png.
// time-up-arrive: 1.18 -> 0.97 at 55% -> 1.0, with the panel fading in.
const timeUpScale = easePiecewise([
  { ease: easeScaleOutput(easeOutCubic, 1.18, 0.97), weight: 0.55 },
  { ease: easeScaleOutput(easeOutCubic, 0.97, 1), weight: 0.45 },
]);

// total-score-slam: 0.58 -> 1.16 at 68% -> 1.0.
const slamCurve = easePiecewise([
  { ease: easeScaleOutput(easeOutCubic, 0.58, 1.16), weight: 0.68 },
  { ease: easeScaleOutput(easeOutCubic, 1.16, 1), weight: 0.32 },
]);

// Before the beat the height sits at rest scale; the slam starts the moment it begins, so
// t == 0 is "not yet" rather than the bottom of the curve.
function slamScale(t: number): number {
  return t <= 0 ? 1 : slamCurve(t);
}

export function createGameUi2D(screenState: GlRenderState, pixelRatio: number): UiState {
  const renderer = createUiRenderer(screenState, pixelRatio);

  const root = createDisplayObject();
  // Same treatment as TIME UP and the result height: big gold serif, so the three
  // screens read as one family. Upright rather than tilted — the tilt is TIME UP's.
  const titleText = label('Horse Stacker', TITLE_MAX_SIZE, GOLD, SERIF, true);
  const timePill = createShape();
  const timeText = label('TIME CHALLENGE', 13, 0x252420ff, SANS, true);
  const steadyPill = createShape();
  const steadyText = label('STEADY HANDS', 13, 0x252420ff, SANS, true);
  // One line under each option. This is where the rules go: the moment the player has the
  // question "what is the difference between these two" is the moment they are looking at
  // the two buttons, and a line here answers it without a screen or a click in the way.
  const timeBlurb = label('Stack as high as you can in 30 seconds', 11, INK, SANS);
  const steadyBlurb = label('No time and no horse may fall', 11, INK, SANS);
  const menuPill = createShape();
  const menuText = label('MENU', 12, INK, SANS, true);
  // What is coming after the piece in hand.
  const nextPill = createShape();
  const nextCaption = label('NEXT', 8, 0xd8e0d2ff, SANS, true);
  const nextGlyph = label('', 20, INK, SANS);
  const timerPill = createShape();
  const timerCaption = label('TIME LEFT', 9, 0xd8e0d2ff, SANS, true);
  const timerValue = label('30', 34, INK, SERIF);
  // STEADY HANDS replaces the clock with the same pill reading the pile instead, plus a row
  // of dots for the pieces it can still afford to lose.
  const heightPill = createShape();
  // BEST, not HEIGHT: the number is the run's high-water mark, which is the score. The current
  // height needs no readout — it is the tower, right there.
  const heightCaption = label('HEIGHT', 9, 0xd8e0d2ff, SANS, true);
  const heightValue = label('0.00 m', 22, INK, SERIF);
  const timeUpScrim = createShape();
  const timeUpText = label('TIME UP!', TIME_UP_MAX_SIZE, GOLD, SERIF, true);
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
  const resultHeight = label('0.00 m', 74, 0xffd166ff, SERIF);
  // The badge is a container so the pill and its text tilt and pulse as one piece. The
  // alternative — transforming both nodes about matching pivots — has to reconcile the
  // pill's box with the text's own line box, and drifts apart the moment either changes.
  const recordBadge = createDisplayObject();
  const recordPill = createShape();
  const recordText = label('NEW RECORD!', 12, 0x3a2c07ff, SANS, true);
  addNodeChild(recordBadge, recordPill);
  addNodeChild(recordBadge, recordText);
  const bestLabel = label('', 11, GOLD, SANS, true);
  const againPill = createShape();
  const againText = label('PLAY AGAIN', 13, 0x252420ff, SANS, true);
  const menuFromResultPill = createShape();
  const menuFromResultText = label('MENU', 13, INK, SANS, true);
  const creditsPill = createShape();
  const creditsText = label('i', 15, INK, SERIF);
  const creditsBody = createShape();
  const creditsCopy: RichText = createRichText();
  setRichTextMultiline(creditsCopy, true);
  setRichTextWordWrap(creditsCopy, true);
  setRichTextDefaultTextFormat(creditsCopy, {
    align: 'left', color: 0xd8e0d2ff, font: SANS, leading: 3, size: 11,
  });
  const fullscreenPill = createShape();
  const fullscreenIcon = createShape();
  const mutePill = createShape();
  const muteIcon = createShape();

  for (const node of [
    titleText, timePill, timeText, steadyPill, steadyText, timeBlurb, steadyBlurb,
    timerPill, timerCaption, timerValue,
    heightPill, heightCaption, heightValue, menuPill, menuText,
    nextPill, nextCaption, nextGlyph,
    timeUpScrim, timeUpText,
    ...tallyHorses, resultHeight,
    recordBadge, bestLabel, againPill, againText,
    creditsBody, creditsCopy, creditsPill, creditsText, fullscreenPill, fullscreenIcon,
    mutePill, muteIcon,
    menuFromResultPill, menuFromResultText,
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

  /**
   * A round control whose face is a drawn icon rather than a glyph. Same hover swell and
   * press sink as `pill`, so the two sit together without looking like different widgets;
   * the only difference is that the icon is centred on the pill's middle, because a shape
   * has no baseline to bias against the way a text label does.
   */
  function iconPill(
    shape: Shape, icon: Shape, id: UiButton['id'], x: number, y: number, size: number,
    colour: number, alpha: number, draw: (target: Shape, ink: number, inkAlpha: number) => void,
  ): void {
    const hovered = hovering(x, y, size, size);
    if (hovered) hoveringAnything = true;
    const pressed = hovered && pointer.down;
    const grow = pressed ? -1.5 : hovered ? 2.5 : 0;
    const sink = pressed ? 1.5 : 0;
    fill(
      shape, colour, Math.min(1, alpha + (hovered ? 0.14 : 0)),
      -grow, -grow, size + grow * 2, size + grow * 2, (size + grow * 2) / 2,
    );
    place(shape, x, y + sink);
    draw(icon, INK, 1);
    place(icon, x + size / 2, y + sink + size / 2);
    buttons.push({ height: size, id, width: size, x, y });
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
    const intro = saturate((model.now - screenShownAt) / 380);
    const pop = easeOutBack(intro);
    buttons.length = 0;
    const onTitle = model.screen === 'title';
    const onResult = model.screen === 'result';
    const onTimeUp = model.screen === 'timeup';
    const playing = model.screen === 'playing';
    // No wash over the scene on these screens: main.ts defocuses the 3D with a blur and a
    // vignette instead, which separates the UI from the background without hiding it.

    show(titleText, onTitle);
    show(timePill, onTitle);
    show(timeText, onTitle);
    show(steadyPill, onTitle);
    show(steadyText, onTitle);
    show(timeBlurb, onTitle);
    show(steadyBlurb, onTitle);
    if (onTitle) {
      // Drops in with an overshoot, then breathes so the screen is never quite still.
      const breathe = Math.sin(model.now * 0.0016) * 4;
      setTextLabelWidth(titleText, width);
      // TITLE_MAX_SIZE is a desktop size; on a narrow window the line is re-set smaller so
      // it fits. The budget allows for the gutter AND for the arrival overshoot — `pop`
      // peaks a little above 1, so fitting to the full width would still clip on the bounce.
      const titleSize = fitLabelToWidth(
        titleText, TITLE_MAX_SIZE, TITLE_MIN_SIZE, (width - SCREEN_GUTTER * 2) / 1.02,
      );
      titleText.alpha = intro;
      titleText.scaleX = 0.86 + 0.14 * pop;
      titleText.scaleY = titleText.scaleX;
      titleText.pivotX = width / 2;
      // Pivot follows the size, so the line stays centred on its own baseline as it shrinks.
      titleText.pivotY = titleSize * TITLE_PIVOT_RATIO;
      place(
        titleText,
        width / 2,
        height * 0.5 - 120 + titleSize * TITLE_PIVOT_RATIO + (1 - pop) * 26 + breathe,
      );
      invalidateNodeAppearance(titleText);
      const nudge = Math.sin(model.now * 0.0016 + 1.1) * 2;
      // Two modes, stacked rather than side by side: the labels are different lengths, and
      // a row of two would either be ragged or force the shorter one to a width its word
      // does not fill. Stacked they share one width and read as a menu.
      const menuWidth = Math.min(MODE_PILL_WIDTH, width - SCREEN_GUTTER * 2);
      const menuX = width / 2 - menuWidth / 2;
      const menuY = height * 0.5 + 24 + (1 - intro) * 20 + nudge;
      // Both wear the same fill. They are two ways to play the same game, not a primary
      // action and a secondary one, and styling one of them down said otherwise.
      // Each pill carries its line just beneath it, so the pair reads button-then-explanation
      // twice rather than as two buttons and a block of prose.
      const blurbWidth = Math.min(width - SCREEN_GUTTER * 2, MODE_PILL_WIDTH + 150);
      const blurbX = width / 2 - blurbWidth / 2;
      pill(timePill, timeText, 'time', menuX, menuY, menuWidth, 44, INK, intro);
      setTextLabelWidth(timeBlurb, blurbWidth);
      timeBlurb.alpha = intro * 0.72;
      place(timeBlurb, blurbX, menuY + 48);
      invalidateNodeAppearance(timeBlurb);

      pill(steadyPill, steadyText, 'steady', menuX, menuY + 82, menuWidth, 44, INK, intro);
      setTextLabelWidth(steadyBlurb, blurbWidth);
      steadyBlurb.alpha = intro * 0.72;
      place(steadyBlurb, blurbX, menuY + 130);
      invalidateNodeAppearance(steadyBlurb);
    }

    show(timeUpScrim, onTimeUp);
    show(timeUpText, onTimeUp);
    if (onTimeUp) {
      const t = Math.min(1, Math.max(0, model.timeUpProgress));
      const scale = timeUpScale(t);
      fill(timeUpScrim, 0x7e311fff, 0.88 * Math.min(1, t * 3), 0, 0, width, height, 0);
      place(timeUpScrim, 0, 0);
      setTextLabelWidth(timeUpText, width);
      // Same treatment as the title, and with more headroom to find: the arrival curve
      // overshoots to 1.18 and the line is tilted, so both eat into the usable width.
      const timeUpSize = fitLabelToWidth(
        timeUpText, TIME_UP_MAX_SIZE, TIME_UP_MIN_SIZE, (width - SCREEN_GUTTER * 2) / 1.2,
      );
      timeUpText.scaleX = scale;
      timeUpText.scaleY = scale;
      timeUpText.alpha = Math.min(1, t * 2.4);
      timeUpText.pivotX = width / 2;
      timeUpText.pivotY = timeUpSize * TITLE_PIVOT_RATIO;
      timeUpText.rotation = -0.052;
      place(timeUpText, width / 2, height * 0.5);
      invalidateNodeAppearance(timeUpText);
    }

    const showAgain = onResult && model.countProgress >= 1;
    show(resultHeight, onResult);
    // The record furniture arrives on the same beat as the height's pop, so the result
    // lands as one moment instead of trickling in a piece at a time.
    const showRecord = onResult && model.countProgress >= 0.86;
    show(recordBadge, showRecord && model.isRecord);
    show(bestLabel, showRecord && model.bestText !== '');
    show(againPill, showAgain);
    show(againText, showAgain);
    show(menuFromResultPill, showAgain);
    show(menuFromResultText, showAgain);
    if (!onResult) {
      for (const horse of tallyHorses) show(horse, false);
    }
    if (onResult) {
      // Column-major, bottom-up, nine to a column — the DOM tally's layout.
      const ruleY = height * 0.5 - 42;
      const cell = 17;
      const columnWidth = 19;
      const shown = Math.min(Math.floor(model.handsShown / HANDS_PER_EMOJI), TALLY_CAPACITY);
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
      // The count runs at rest scale so the number stays readable, then the height itself
      // pops on the beat the points used to arrive on.
      const settle = saturate((model.countProgress - 0.86) / 0.14);
      const slam = slamScale(settle);
      setTextLabelWidth(resultHeight, width);
      setText(resultHeight, model.heightText);
      resultHeight.scaleX = slam;
      resultHeight.scaleY = slam;
      resultHeight.pivotX = width / 2;
      resultHeight.pivotY = 40;
      // pivot is the anchor, so x/y address the pivot rather than the top-left corner
      place(resultHeight, width / 2, ruleY + 12 + 40);

      // Narrower and shorter than PLAY AGAIN below it, so it reads as a chip rather than a
      // second button competing for the click.
      const badgeWidth = 152;
      const badgeHeight = 26;
      const badgeY = ruleY + 98;
      const badgeShowing = showRecord && model.isRecord;
      if (badgeShowing) {
        const swagger = Math.sin(model.now * 0.005);
        // The pill shimmers and the badge bobs, but its SCALE settles to exactly 1 and it
        // is never tilted. Both would resample the glyph raster every frame, and at 12px
        // that shows up as colour fringing on the letters — the tilt TIME UP wears is only
        // free because it is nine times the size.
        fill(recordPill, GOLD, 0.9 + swagger * 0.1, 0, 0, badgeWidth, badgeHeight, badgeHeight / 2);
        place(recordPill, 0, 0);
        setTextLabelWidth(recordText, badgeWidth);
        place(recordText, 0, (badgeHeight - 12 * 1.35) / 2);
        const arrive = easeOutBack(settle);
        recordBadge.scaleX = arrive;
        recordBadge.scaleY = arrive;
        recordBadge.pivotX = badgeWidth / 2;
        recordBadge.pivotY = badgeHeight / 2;
        recordBadge.alpha = saturate(settle * 2.2);
        // Rounded so the bob lands on whole pixels and the text stays crisp through it.
        place(recordBadge, width / 2, badgeY + badgeHeight / 2 + Math.round(swagger * 2));
        invalidateNodeAppearance(recordBadge);
      }
      if (showRecord && model.bestText !== '') {
        setTextLabelWidth(bestLabel, width);
        setText(bestLabel, model.bestText);
        // Quiet, but not invisible: it sits over the blurred scene rather than a dark wash
        // now, so it cannot afford to give away opacity as well as size and colour.
        bestLabel.alpha = saturate(settle * 1.6);
        place(bestLabel, 0, badgeY + 8 + (1 - easeOutCubic(settle)) * 10);
        invalidateNodeAppearance(bestLabel);
      }

      // The badge inserts a row, so the buttons drop to keep clear of it.
      const buttonsY = ruleY + (badgeShowing ? 160 : 150) + (1 - easeOutBack(settle)) * 16;
      // PLAY AGAIN keeps the width and the cream fill it had — it is still what most people
      // want next. MENU sits beside it, narrower and dark, so the pair reads as one primary
      // action and one way out rather than two equal choices.
      const againWidth = Math.min(192, Math.max(120, width - SCREEN_GUTTER * 2 - 108));
      const menuWidth = 96;
      const pairWidth = againWidth + 8 + menuWidth;
      const pairX = width / 2 - pairWidth / 2;
      pill(againPill, againText, 'again', pairX, buttonsY, againWidth, 44, INK, settle);
      pill(
        menuFromResultPill, menuFromResultText, 'menu',
        pairX + againWidth + 8, buttonsY, menuWidth, 44, 0x1f2d1dff, settle * 0.82,
      );
    }

    const timedPlaying = playing && model.mode === 'time';
    const steadyPlaying = playing && model.mode === 'steady';
    show(timerPill, timedPlaying);
    show(timerCaption, timedPlaying);
    show(timerValue, timedPlaying);
    if (timedPlaying) {
      const w = 104;
      const x = width - w - 24;
      const drop = (1 - pop) * 40;
      // Under ten seconds the pill turns hot and jitters; each new second gives the number
      // a kick, so the clock reads as running rather than just counting.
      const urgent = saturate((10 - model.secondsLeft) / 4);
      const fraction = model.secondsLeft - Math.floor(model.secondsLeft);
      const kick = Math.max(0, 1 - (1 - fraction) * 7);
      const shake = urgent * Math.sin(model.now * 0.045) * 2.5;
      fill(
        timerPill,
        urgent > 0 ? 0x8c3a24ff : 0x1f2d1dff,
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

    // Endless: the clock's slot holds a live height instead, and the corner carries the way
    // out — with no clock to end the round, leaving has to be something the player can see.
    show(heightPill, steadyPlaying);
    show(heightCaption, steadyPlaying);
    show(heightValue, steadyPlaying);
    show(menuPill, steadyPlaying);
    show(menuText, steadyPlaying);
      if (steadyPlaying) {
      const w = 104;
      const x = width - w - 24;
      const drop = (1 - pop) * 40;
      fill(heightPill, 0x1f2d1dff, 0.72, 0, 0, w, STEADY_PILL_HEIGHT, 18);
      place(heightPill, x, 18 - drop);
      setTextLabelWidth(heightCaption, w);
      place(heightCaption, x, 26 - drop);
      setTextLabelWidth(heightValue, w);
      place(heightValue, x, 44 - drop);
      setText(heightValue, model.liveHeightText);

      pill(menuPill, menuText, 'menu', 24, 18 - drop, 84, 32, 0x1f2d1dff, 0.62);
    }

    // NEXT is built and wired but switched off for now at the user's request. The model still
    // carries nextPieceGlyph and the nodes still exist, so turning it back on is this one
    // constant — that is cheaper than deleting it and writing it again.
    const showNext = SHOW_NEXT_PREVIEW && playing;
    show(nextPill, showNext);
    show(nextCaption, showNext);
    show(nextGlyph, showNext);
    if (showNext) {
      const w = 62;
      // Right edge flush with the readout above it, which sits 24 in from the window edge.
      // (This used to add the difference between the two pill widths on top of an x that was
      // already right-aligned, and pushed itself off the screen.)
      const x = width - 24 - w;
      const drop = (1 - pop) * 40;
      const y = 18 + (steadyPlaying ? STEADY_PILL_HEIGHT : 62) + 8 - drop;
      fill(nextPill, 0x1f2d1dff, 0.62, 0, 0, w, 42, 14);
      place(nextPill, x, y);
      setTextLabelWidth(nextCaption, w);
      place(nextCaption, x, y + 6);
      setTextLabelWidth(nextGlyph, w);
      place(nextGlyph, x, y + 15);
      setText(nextGlyph, model.nextPieceGlyph);
    }

    // Attribution belongs on the screen you land on when the round is over, not over the
    // title art and not over the game. Skipping the pill() call also keeps 'credits' out of
    // the hit-test list, so the corner is not quietly clickable while it is invisible.
    show(creditsPill, onResult);
    show(creditsText, onResult);
    if (onResult) {
      pill(creditsPill, creditsText, 'credits', 24, height - 54, 30, 30, 0x1f2d1dff, 0.42);
    }
    iconPill(
      fullscreenPill, fullscreenIcon, 'fullscreen', width - 54, height - 54, 30,
      0x1f2d1dff, 0.42, drawFullscreen,
    );
    // Beside fullscreen, and on every screen: the moment you want to mute is whenever the
    // sound is bothering you, which is not a moment the game gets to choose.
    iconPill(
      mutePill, muteIcon, 'mute', width - 92, height - 54, 30, 0x1f2d1dff, 0.42,
      (target, ink, inkAlpha) => drawSpeaker(target, ink, inkAlpha, model.muted),
    );

    const creditsShowing = onResult && model.creditsOpen;
    show(creditsBody, creditsShowing);
    show(creditsCopy, creditsShowing);
    if (creditsShowing) {
      const w = Math.min(420, width - 48);
      fill(creditsBody, 0x182217ff, 0.9, 0, 0, w, 82, 16);
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
    // The record badge keeps swaggering after the count finishes, so the result screen
    // stays live for as long as one is on it — the title screen breathes for the same reason.
    const idleMotion =
      model.screen === 'title' || model.screen === 'playing' ||
      (model.screen === 'result' && model.isRecord);
    return arriving || settling || idleMotion || hoveringAnything || wasHovering;
  }

  function resize(nextWidth: number, nextHeight: number, nextPixelRatio: number): void {
    width = Math.max(1, Math.round(nextWidth));
    height = Math.max(1, Math.round(nextHeight));
    renderer.resize(width, height, nextPixelRatio);
  }

  function render(): void {
    renderer.render(root);
  }

  return { buttons, render, resize, update };
}
