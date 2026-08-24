// A DEV-only answer to one question: what is actually in the outermost device pixels of the
// frame, and which pass put it there? An edge artifact is the one class of rendering bug that
// argues well on paper and settles badly — every layer here composites premultiplied over an
// opaque frame on a sky-blue page, so half a dozen plausible mechanisms all predict a PALE
// seam, and none of them predicts a dark one. Rather than reason further, read the pixels.
//
// It is called twice in a frame (see renderFrame in main.ts): once with the 3D present done
// and once with the UI laid over it. Three outcomes, and each names its own culprit:
//   - the border row already differs after the 3D  → the scene pipeline or its present;
//   - it only differs after the UI                 → the UI target or the way it is composited;
//   - it never differs, but the eye still sees it  → nothing in WebGL drew it. It is the page:
//     the focus ring on the full-viewport canvas, or the browser's own compositing of the
//     canvas layer, neither of which readPixels can see.
//
// Not shipped: every use is behind import.meta.env.DEV, so the branch and this import fold away
// in a production build.

/** One edge's reading: the outer line of pixels against the line just inside it. */
interface EdgeReading {
  /** How many of the sampled positions differ from their inner neighbour. */
  changed: number;
  /** The largest per-channel difference seen, 0..255. */
  maxDelta: number;
  /** A few positions along the edge, as "inner → outer" RGBA pairs. */
  samples: string[];
}

// How many positions along each edge to report. Enough to tell "the whole edge" from "one
// corner" without printing a screen's worth of numbers.
const SAMPLE_COUNT = 5;
// Below this a difference is dithering or rounding rather than a line you can see.
const VISIBLE_DELTA = 4;

/**
 * Read the frame's four outermost pixel lines and log what is there.
 *
 * Reads the CURRENTLY BOUND framebuffer, which at both call sites is the canvas — a present
 * pass binds the canvas (`dest = null`) and leaves it bound. On a multisampled canvas
 * readPixels resolves first, so this reads what the compositor will receive.
 */
export function probeFrameEdges(gl: WebGL2RenderingContext, label: string): void {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  if (width < 2 || height < 2) return;
  if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) {
    console.warn(`[edge probe: ${label}] a render target is still bound; reading that, not the canvas.`);
  }

  // GL's origin is bottom-left, so row 0 is the BOTTOM of the screen. Each read takes the
  // outer line and its inner neighbour together, which is the comparison that matters: an
  // edge is only an artifact if it differs from the frame just inside it.
  const bottom = readStrip(gl, 0, 0, width, 2);
  const top = readStrip(gl, 0, height - 2, width, 2);
  const left = readStrip(gl, 0, 0, 2, height);
  const right = readStrip(gl, width - 2, 0, 2, height);

  const readings: Record<string, EdgeReading> = {
    top: compareRows(top, width, 1, 0),
    bottom: compareRows(bottom, width, 0, 1),
    left: compareColumns(left, height, 0, 1),
    right: compareColumns(right, height, 1, 0),
  };

  console.groupCollapsed(
    `[edge probe: ${label}] ${width}×${height} — ` +
      Object.entries(readings)
        .map(([edge, reading]) => `${edge} ${reading.changed}/${SAMPLE_COUNT}`)
        .join(', '),
  );
  for (const [edge, reading] of Object.entries(readings)) {
    const verdict =
      reading.maxDelta >= VISIBLE_DELTA
        ? `DIFFERS from the row inside it (max Δ ${reading.maxDelta})`
        : 'matches the row inside it';
    console.info(`${edge}: ${verdict}`);
    for (const sample of reading.samples) console.info(`    ${sample}`);
  }
  console.groupEnd();
}

function readStrip(
  gl: WebGL2RenderingContext,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

// A horizontal strip is two rows of `width` pixels; `outerRow`/`innerRow` say which is which,
// because the top edge's outer row is the second one and the bottom edge's is the first.
function compareRows(
  strip: Uint8Array,
  width: number,
  outerRow: number,
  innerRow: number,
): EdgeReading {
  return compare(width, (index) => [
    (outerRow * width + index) * 4,
    (innerRow * width + index) * 4,
  ], strip);
}

// A vertical strip is `height` rows of two pixels, so the outer/inner pair sits within a row.
function compareColumns(
  strip: Uint8Array,
  height: number,
  outerColumn: number,
  innerColumn: number,
): EdgeReading {
  return compare(height, (index) => [
    (index * 2 + outerColumn) * 4,
    (index * 2 + innerColumn) * 4,
  ], strip);
}

function compare(
  span: number,
  offsetsAt: (index: number) => [number, number],
  pixels: Uint8Array,
): EdgeReading {
  const samples: string[] = [];
  let changed = 0;
  let maxDelta = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    // Spread the samples across the edge rather than bunching at one end: an artifact from a
    // half-pixel sampling error runs the whole way, one from geometry usually does not.
    const index = Math.round(((i + 0.5) / SAMPLE_COUNT) * (span - 1));
    const [outer, inner] = offsetsAt(index);
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) {
      delta = Math.max(delta, Math.abs(pixels[outer + channel]! - pixels[inner + channel]!));
    }
    maxDelta = Math.max(maxDelta, delta);
    if (delta >= VISIBLE_DELTA) changed++;
    samples.push(
      `at ${index}: inner ${formatPixel(pixels, inner)} → outer ${formatPixel(pixels, outer)}` +
        (delta >= VISIBLE_DELTA ? `  (Δ ${delta})` : ''),
    );
  }
  return { changed, maxDelta, samples };
}

function formatPixel(pixels: Uint8Array, offset: number): string {
  const channels = [0, 1, 2, 3].map((channel) => String(pixels[offset + channel]).padStart(3, ' '));
  return `rgba(${channels.join(', ')})`;
}
