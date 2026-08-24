// The GL side of a frame: the render state, the post-process pipeline, the backdrop
// defocus, and the one function that draws the 3D scene. src/scene/SceneRenderer.hx in the
// Haxe sibling.
//
// This is the only module that knows a frame has PASSES. Before the split, renderFrame() ran
// the shadow pass, the pipeline, the effect list and then the UI-model update in one
// function, so the two halves of "what the frame does" were interleaved with the two halves
// of "what the game currently is". Here drawScene() is entirely the former, and main.ts's
// frame is the latter plus two calls.
import type {
  BlurEffect,
  GlRenderEffectPipeline,
  GlRenderState,
  RenderEffect,
  VignetteEffect,
} from '@flighthq/sdk';
import {
  addNodeChildAt,
  beginGlRenderEffectPipeline,
  beginGlRenderPass,
  createBlurEffect,
  createGlCanvasElement,
  createGlRenderEffectPipeline,
  createGlRenderState,
  createVignetteEffect,
  enableFlightDiagnostics,
  endGlRenderEffectPipeline,
  endGlRenderPass,
  getNodeParent,
  registerGlBlurEffect,
  registerGlStandardPbrMaterial,
  registerGlVertexColorMaterial,
  registerGlVignetteEffect,
  registerStandardGlTextureResolvers,
  removeNodeChild,
  renderGlBackground,
} from '@flighthq/sdk';
import { drawGlScene3D, drawGlScene3DShadowMap } from '@flighthq/sdk/rendering';
import type { SceneGraph } from './sceneGraph';

export interface SceneRenderer {
  canvas: HTMLCanvasElement;
  renderState: GlRenderState;
  pipeline: GlRenderEffectPipeline;
  /**
   * Draw one 3D frame. `backdropFocus` is 0 during play and ramps to 1 behind the menus;
   * at 0 the effect list is empty, which is the pipeline's own fast path.
   */
  drawScene: (sceneGraph: SceneGraph, backdropFocus: number) => void;
  /** Match the backing store to a new CSS size. Returns false when nothing changed. */
  resize: (width: number, height: number, pixelRatio: number) => boolean;
}

// The title and score screens used to sit behind a flat black wash. The scene is the nicest
// thing on screen, so instead of hiding it the pipeline defocuses it: a real blur, plus a
// vignette to pull the eye to the middle and keep light text legible over bright grass.
// Both are Flight render effects, which is what the effect list on endGlRenderEffectPipeline
// is for — the game ran it empty until now.
const BACKDROP_BLUR_MAX = 13;
// Just defocus, and nothing else. A colour grade behind the blur — desaturation, an
// exposure drop, a warm tint — all read as a filter laid over the game rather than as depth
// of field, so the scene keeps its own colour and the vignette alone does the separating.
// It buys the type less contrast than a grade would; the scene staying itself is worth it.
const NO_EFFECTS: readonly RenderEffect[] = [];

/**
 * Builds the canvas, the GL state and the pipeline, appending the canvas to `viewer`.
 * Throws if WebGL2 is unavailable — the caller owns the error panel, so it catches rather
 * than this module reaching for the DOM it does not otherwise touch.
 */
export function createSceneRenderer(viewer: HTMLElement): SceneRenderer {
  const initialPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = createGlCanvasElement(1, 1, initialPixelRatio);
  canvas.setAttribute(
    'aria-label',
    'Farm Stacker game. Move with the pointer or arrow keys, then click, tap, Space, or Enter to place the next random farm object.',
  );
  canvas.tabIndex = 0;
  // createGlCanvasElement writes an inline pixel size, which would beat the stylesheet's
  // 100%/100%. Set it to fill once, here, so resize never has to touch the CSS size and can
  // never round it a fraction short of the viewer (see the note in resize).
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  viewer.prepend(canvas);

  const renderState = createGlRenderState(canvas, {
    pixelRatio: initialPixelRatio,
    backgroundColor: 0x00000000,
    contextAttributes: { alpha: true, antialias: false },
    powerPreference: 'high-performance',
  });
  if (import.meta.env.DEV) enableFlightDiagnostics(renderState);
  registerStandardGlTextureResolvers(renderState);
  registerGlStandardPbrMaterial(renderState);
  registerGlVertexColorMaterial(renderState);
  registerGlBlurEffect(renderState);
  registerGlVignetteEffect(renderState);
  const pipeline = createGlRenderEffectPipeline(renderState, {
    sampleCount: 4,
    format: 'rgba16f',
    depth: 'depth-stencil',
  });

  const backdropBlurEffect: BlurEffect = createBlurEffect({ blurX: 0, blurY: 0 });
  const backdropVignetteEffect: VignetteEffect = createVignetteEffect({
    color: 0x0d1622ff,
    intensity: 0,
    radius: 0.5,
    softness: 0.85,
  });
  // Rebuilt only while the ramp is moving: brightness/contrast bake their matrix at
  // construction, so a mutated field would not take.
  let backdropEffects: RenderEffect[] = [];
  let backdropEffectsAt = -1;

  function getBackdropEffects(focus: number): readonly RenderEffect[] {
    const quantized = Math.round(focus * 60);
    if (quantized === backdropEffectsAt) return backdropEffects;
    backdropEffectsAt = quantized;
    const amount = quantized / 60;
    backdropBlurEffect.blurX = BACKDROP_BLUR_MAX * amount;
    backdropBlurEffect.blurY = BACKDROP_BLUR_MAX * amount;
    backdropVignetteEffect.intensity = 0.7 * amount;
    backdropEffects = [backdropBlurEffect, backdropVignetteEffect];
    return backdropEffects;
  }

  return {
    canvas,
    pipeline,
    renderState,

    drawScene(sceneGraph, backdropFocus) {
      const { camera, directionalLight, lights, previewLayer, root, shadowCamera, skyDome } =
        sceneGraph;
      // Lift the preview and its halo out of the graph for the depth pass, then put them
      // back at the index they held so forward draw order is untouched. See previewLayer in
      // sceneGraph.ts for why switching them off is not enough.
      const previewParent = getNodeParent(previewLayer);
      const skyParent = getNodeParent(skyDome);
      if (previewParent !== null) removeNodeChild(previewParent, previewLayer);
      // The sky has to come out too, and for a sharper reason than the halo: the shadow pass
      // draws every node with geometry, and a dome that ENCLOSES the shadow camera would
      // write depth in front of the whole farm and shadow all of it.
      if (skyParent !== null) removeNodeChild(skyParent, skyDome);
      drawGlScene3DShadowMap(renderState, root, shadowCamera, directionalLight);
      if (previewParent !== null) addNodeChildAt(previewParent, previewLayer, 0);
      if (skyParent !== null) addNodeChildAt(skyParent, skyDome, 0);

      beginGlRenderEffectPipeline(renderState, pipeline, 'linear');
      renderGlBackground(renderState);
      // The pipeline opens its pass preserving BOTH aspects, so last frame's depth is still
      // in the target and the scene has to start from a cleared one. A nested pass that
      // spares only the colour does exactly that, using the target's own clear values — the
      // same job three raw depthMask/clearDepth/clear calls used to do by hand.
      const sceneTarget = pipeline.sceneTarget;
      if (sceneTarget !== null) {
        beginGlRenderPass(renderState, sceneTarget, { preserveColor: true });
        drawGlScene3D(renderState, root, camera, lights);
        endGlRenderPass(renderState);
      }
      // An empty list is the fast path: no ping-pong targets are acquired and no pass runs,
      // so the game pays for the defocus only on the screens that show it.
      endGlRenderEffectPipeline(
        renderState,
        pipeline,
        backdropFocus > 0.002 ? getBackdropEffects(backdropFocus) : NO_EFFECTS,
      );
    },

    resize(width, height, pixelRatio) {
      const backingWidth = Math.round(width * pixelRatio);
      const backingHeight = Math.round(height * pixelRatio);
      if (canvas.width === backingWidth && canvas.height === backingHeight) return false;
      renderState.pixelRatio = pixelRatio;
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      // Deliberately NOT setting canvas.style.width/height. The backing store has to be a
      // whole number of device pixels, but pinning the CSS size to that rounded value leaves
      // the canvas a fraction of a pixel short of a viewer whose own width is fractional —
      // which happens with browser zoom or a HiDPI window — and the page shows through as a
      // hairline stripe along the edge. The `.viewer canvas` rule sizes it at 100%/100%
      // instead, so it always covers exactly, and the slight sampling stretch is invisible.
      return true;
    },
  };
}
