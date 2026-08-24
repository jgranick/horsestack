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
  appendShapeRoundRectangle,
  clearShapeCommands,
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
