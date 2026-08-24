// Getting the 2D UI onto the same canvas as the 3D scene. src/ui/UiRenderer.hx in the Haxe
// sibling — though that one still carries the hand-rolled GLSL compositor this no longer
// needs.
//
// One canvas. The UI is drawn into its own offscreen render target using a SECOND render
// state over the SAME GL context, then presented onto the finished 3D frame as a single
// blended quad. All public SDK: beginGlRenderPass/endGlRenderPass own the target, its clear
// and the save/restore of enclosing state; presentGlRenderTarget lays the finished target
// over the canvas; destroyGlRenderTarget hands its GL objects back.
//
// present reads the target's DECLARED colour space, so an 'srgb' target — which a 2D scene
// is, because Flight's 2D tower composites in the encoded domain by policy
// (render/SCENE2D_WORKING_COLOR_SPACE) — is copied straight through with premultiplied
// blending rather than gamma-encoded a second time. That seam is why the alternatives failed,
// and it is worth recording:
//   - rendering 2D straight at the canvas after the pipeline presents draws nothing;
//   - rendering it into the pipeline's own target, nested pass or not, destroys the 3D;
//   - handing the UI target to the pipeline as a DestinationOver CompositeEffect backdrop
//     works and is public API too — but the pipeline composites in LINEAR, and while our own
//     colours can be converted on the way in, sRGB texture content cannot, so the emoji tally
//     came out washed.
//
// Two more things make this work, each of which broke an earlier attempt:
//   - the second state comes from createGlOffscreenRenderState, so its renderer/material
//     registrations and per-frame batch state are its own. Sharing one state with the 3D
//     pipeline corrupts the 3D — props lose their textures.
//   - present runs immediately after the 2D pass closes, which is where renderGlScene2D has
//     already left blending on and depth/cull off — the state the blend needs. It also owns
//     its own VAO and unbinds what it sampled, so nothing leaks into the next frame's 3D.
import type { DisplayObject, GlRenderState, GlRenderTarget } from '@flighthq/sdk';
import {
  beginGlRenderPass,
  createCanvasShapeRasterizer,
  createCanvasTextureResolvers,
  createGlOffscreenRenderState,
  createGlRenderTarget,
  createMatrix,
  defaultGlRichTextRenderer,
  defaultGlShapeCommands,
  defaultGlShapeRenderer,
  defaultGlTextLabelRenderer,
  destroyGlRenderTarget,
  endGlRenderPass,
  prepareScene2DRender,
  presentGlRenderTarget,
  registerGlShapeCommands,
  registerGlShapeRasterizer,
  registerGlStandardMaterial,
  registerRenderer,
  renderGlScene2D,
  RichTextKind,
  setGlRenderTransform2D,
  ShapeKind,
  TextLabelKind,
} from '@flighthq/sdk';

export interface UiRenderer {
  /** The offscreen state the UI's nodes are prepared and drawn against. */
  state: GlRenderState;
  /** Reallocate the target for a new size. Call before the next render. */
  resize: (width: number, height: number, pixelRatio: number) => void;
  /** Draw `root` into the target and lay it over whatever is already on the canvas. */
  render: (root: DisplayObject) => void;
}

export function createUiRenderer(screenState: GlRenderState, pixelRatio: number): UiRenderer {
  const state: GlRenderState = createGlOffscreenRenderState(screenState);
  let target: GlRenderTarget | null = null;
  let deviceTransform = createMatrix(pixelRatio, 0, 0, pixelRatio, 0, 0);

  registerRenderer(state, ShapeKind, defaultGlShapeRenderer);
  registerRenderer(state, TextLabelKind, defaultGlTextLabelRenderer);
  registerRenderer(state, RichTextKind, defaultGlRichTextRenderer);
  registerGlShapeCommands(state, defaultGlShapeCommands);
  registerGlShapeRasterizer(state, createCanvasShapeRasterizer(createCanvasTextureResolvers()));
  registerGlStandardMaterial(state);

  return {
    state,

    resize(width, height, nextPixelRatio) {
      state.pixelRatio = nextPixelRatio;
      deviceTransform = createMatrix(nextPixelRatio, 0, 0, nextPixelRatio, 0, 0);
      // The target matches the drawing buffer exactly, so UI text lands on whole device
      // pixels and stays crisp rather than being resampled by the composite. Resizing
      // allocates a new one, so the old one has to go back or every resize leaks a
      // screen-sized texture.
      if (target !== null) destroyGlRenderTarget(state, target);
      target = createGlRenderTarget(state, {
        width: Math.round(width * nextPixelRatio),
        height: Math.round(height * nextPixelRatio),
        depth: 'none',
      });
    },

    render(root) {
      const surface = target;
      if (surface === null) return;
      // The device transform must be set BEFORE prepare, not after begin: it is an input to
      // every prepared proxy transform, so setting it later leaves the frame laid out at 1:1
      // in a target sized in device pixels — on a 2x display the whole UI drew into the
      // top-left quarter, and the buttons stopped being where their hit boxes were.
      setGlRenderTransform2D(state, deviceTransform);
      if (!prepareScene2DRender(state, root)) return;

      // Draw the UI into its own target. begin binds and clears it, end resolves and puts the
      // enclosing binding and viewport back, so the frame the 3D pipeline just presented is
      // untouched. The bracket also saves and restores the transform set above.
      beginGlRenderPass(state, surface);
      renderGlScene2D(state, root);
      endGlRenderPass(state);

      // Lay it over that frame. See the colour-space note at the top of the file.
      presentGlRenderTarget(state, surface);
    },
  };
}
