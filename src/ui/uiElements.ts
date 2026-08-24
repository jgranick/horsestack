// The five node helpers the UI layout is written in, plus the palette and fonts it is
// written with. src/ui/UiElements.hx in the Haxe sibling.
//
// Small, but it earns a file: gameUi.ts is one long layout pass, and these are the verbs it
// speaks rather than part of what it says. Two of them exist purely to avoid needless
// invalidation — setText and show both compare before writing, because a label re-strung
// with the same text still re-shapes and a node re-shown still dirties its appearance, and
// the layout pass touches every node every frame.
import type { DisplayObject, Shape, TextLabel } from '@flighthq/sdk';
import {
  appendShapeBeginFill,
  appendShapeLineStyle,
  appendShapeLineTo,
  appendShapeMoveTo,
  appendShapePolygon,
  appendShapeRoundRectangle,
  clearShapeCommands,
  computeTextFormatFontString,
  createTextLabel,
  invalidateNodeAppearance,
  invalidateNodeLocalTransform,
  invalidateNodeRender,
  setTextLabelFormat,
  setTextLabelHeight,
  setTextLabelString,
  setTextLabelWidth,
} from '@flighthq/sdk';

// Colours are 0xRRGGBBAA — Flight's packed colour word, alpha in the low byte. The trailing
// ff is load-bearing, not decoration: a bare 0xRRGGBB is read as 0x00RRGGBB, which shifts the
// channels one place (gold arrives as cyan) AND lands the blue byte in alpha, where the fill
// commands MULTIPLY it into the alpha argument. Dropping it therefore misses twice over, and
// the second miss is the quiet one.
export const GOLD = 0xffd166ff;
export const INK = 0xfbf7ecff;
export const SERIF = 'Georgia, "Times New Roman", serif';
export const SANS = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

export function label(
  text: string,
  size: number,
  color: number,
  font: string,
  bold = false,
): TextLabel {
  const node = createTextLabel();
  setTextLabelString(node, text);
  setTextLabelFormat(node, { align: 'center', bold, color, font, size });
  setTextLabelWidth(node, 10);
  setTextLabelHeight(node, size * 1.6);
  return node;
}

export function place(node: DisplayObject, x: number, y: number): void {
  node.x = x;
  node.y = y;
  invalidateNodeLocalTransform(node);
}

export function show(node: DisplayObject, visible: boolean): void {
  if (node.visible === visible) return;
  node.visible = visible;
  invalidateNodeAppearance(node);
}

export function setText(node: TextLabel, text: string): void {
  if (node.data.text === text) return;
  setTextLabelString(node, text);
}

export function fill(
  shape: Shape,
  colour: number,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  clearShapeCommands(shape);
  appendShapeBeginFill(shape, colour, alpha);
  appendShapeRoundRectangle(shape, x, y, w, h, r, r);
  invalidateNodeRender(shape);
}

// The display text — the title, TIME UP, the result height — is set at a size chosen for a
// desktop window, and Flight's TextLabel does not shrink to fit: `align: 'center'` centres
// the line in the box and lets it overhang both edges. On a phone the title ran off both
// sides of the screen.
//
// So the size is chosen from the width actually available. It is measured with a canvas 2D
// context because that is the same text engine the shape/label rasterizer uses, so the
// number agrees with what will be drawn — rather than a ratio-per-character guess that
// drifts between fonts.
const measureContext: CanvasRenderingContext2D | null =
  typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');

function measureTextWidth(text: string, font: string): number {
  if (measureContext === null) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Re-sizes `node` so its single line fits inside `maxWidth`, never larger than `maxSize` and
 * never smaller than `minSize`. Returns the size in use.
 *
 * Re-formatting re-rasterizes the glyphs, so the format is only written when the size
 * actually changes — this is called every frame from the layout pass.
 */
export function fitLabelToWidth(
  node: TextLabel,
  maxSize: number,
  minSize: number,
  maxWidth: number,
): number {
  const format = node.data.textFormat;
  const currentSize = format.size ?? maxSize;
  const text = node.data.text;
  if (text === '' || maxWidth <= 0) return currentSize;

  // Advance width is linear in font size, so one measurement gives the ratio outright.
  const widthAtMax = measureTextWidth(text, computeTextFormatFontString({ ...format, size: maxSize }));
  const fitted =
    widthAtMax <= maxWidth || widthAtMax === 0
      ? maxSize
      : Math.max(minSize, Math.floor((maxSize * maxWidth) / widthAtMax));

  if (fitted !== currentSize) {
    setTextLabelFormat(node, { ...format, size: fitted });
    setTextLabelHeight(node, fitted * 1.6);
  }
  return fitted;
}

/**
 * The speaker icon on the mute control, drawn rather than typed.
 *
 * It was an emoji to begin with. An emoji is not a glyph the page can colour: the font
 * paints its own multi-colour bitmap, so it arrived blue-and-grey beside the flat near-white
 * marks of the controls either side of it, and no `color` on the label could touch it.
 *
 * Drawn as an OUTLINE — a line style and no fill — so it reads as line work of the same
 * weight as the ⛶ beside it rather than as a solid blob.
 *
 * WHY THE MARKS ARE UPRIGHT BARS. The shape rasterizer does no coverage blending, so nothing
 * here is antialiased, unlike the neighbouring glyphs, which arrive from the font atlas
 * already smoothed. An earlier version put curved arcs and a diagonal cross beside the
 * speaker, and at this size those are the worst thing you can ask an unantialiased
 * rasterizer for: every one of them is a staircase. A vertical edge lands on whole pixels at
 * any size and cannot alias at all, and two bars beside a speaker read as sound while a bar
 * across them reads as cut off. Multisampling the UI target was tried as a fix and is not
 * one — it left a black border around the frame and did nothing for the arcs.
 *
 * Centred on the shape's own origin, so the caller places its middle.
 */
export function drawSpeaker(shape: Shape, colour: number, alpha: number, muted: boolean): void {
  clearShapeCommands(shape);
  appendShapeLineStyle(shape, 1.5, colour, alpha, false, undefined, 'round', 'round');
  // Body and cone as one closed outline: back of the box, along the top of the cone, down
  // its face, and back. Wound clockwise in the 2D frame, where +y is down.
  appendShapePolygon(shape, [-6, -2.5, -3, -2.5, 1, -6.5, 1, 6.5, -3, 2.5, -6, 2.5]);
  if (muted) {
    // One stroke straight across where the sound would be.
    appendShapeMoveTo(shape, 3.5, 0);
    appendShapeLineTo(shape, 8.5, 0);
  } else {
    appendShapeMoveTo(shape, 4, -3);
    appendShapeLineTo(shape, 4, 3);
    appendShapeMoveTo(shape, 7.5, -5.5);
    appendShapeLineTo(shape, 7.5, 5.5);
  }
  invalidateNodeRender(shape);
}
