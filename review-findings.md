# InstancedMesh Invisible on ANGLE/Mesa/llvmpipe — Root Cause Found

## Bug

Instanced meshes (InstancedMesh for batching stacked pieces — hay, cow, chickens, horse) are invisible on ANGLE backends that use Mesa/llvmpipe (software rendering). Affects Chrome on Linux without GPU acceleration. The preview piece (a non-instanced Node3D clone) renders fine, masking the problem — only placed/stacked pieces are invisible.

## Root Cause

**`UNPACK_PREMULTIPLY_ALPHA_WEBGL` is set to `true` by the image texture loader and never reset before uploading the instance palette texture.**

### What happens

1. `@flighthq/render-gl` image loading code (`glDraw.js`) sets `gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)` when uploading image textures (lines 121, 191, 273 in the dist file).

2. This WebGL pixel store state is **sticky** — it persists on the context until explicitly changed.

3. When `uploadGlSkinPaletteTexture()` in `glSkinPaletteTexture.js` later uploads the instance matrix palette via `texImage2D`/`texSubImage2D`, the premultiply state is still `true`.

4. The instance matrix is stored as RGBA32F texels. In a 4x4 affine transformation matrix stored column-major, the 4th component (alpha channel) of each texel is the bottom row of the matrix: `[0, 0, 0, 1]`. The first 3 columns have alpha=0, and only the 4th column (translation) has alpha=1.

5. With premultiply active, all RGB values are multiplied by the alpha channel during upload:
   - Columns 0-2 (rotation/scale): alpha=0 → all values become 0
   - Column 3 (translation): alpha=1 → values preserved

6. The resulting degenerate matrix collapses all vertices to the translation point, producing zero-area triangles → invisible mesh.

### Why it only fails on ANGLE/Mesa/llvmpipe

On native GPU drivers and most ANGLE backends, `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is likely either:
- Ignored for `FLOAT` type uploads (not spec-compliant but common)
- Handled differently in the driver's texture upload path

On llvmpipe (Mesa's software rasterizer), the premultiply is faithfully applied to FLOAT data, exposing the bug. This is arguably more correct behavior — the WebGL spec says `UNPACK_PREMULTIPLY_ALPHA_WEBGL` applies to all pixel unpack operations.

### Evidence

GPU readback confirmed the corruption:
```
CPU data: [0.1332, 0.0000, 0.0000, 0.0000,  0.0000, -0.0009, -0.1332, 0.0000,  0.0000, 0.1332, -0.0009, 0.0000,  0.0007, 0.2443, 0.0086, 1.0000]
GPU data: [0.0000, 0.0000, 0.0000, 0.0000,  0.0000,  0.0000,  0.0000, 0.0000,  0.0000, 0.0000,  0.0000, 0.0000,  0.0007, 0.2443, 0.0086, 1.0000]
```

After adding `gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)` before the upload: GPU data matches CPU data exactly, and instanced meshes render correctly.

## Fix

In `@flighthq/render-gl`, in `uploadGlSkinPaletteTexture()` (`glSkinPaletteTexture.js`), add before the `texImage2D`/`texSubImage2D` call:

```javascript
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
```

This fix is needed for ALL palette texture uploads — instance matrices (unit 14), instance colors (unit 15), and skeletal joint matrices (unit 12) — since they all flow through `uploadGlSkinPaletteTexture`.

The same fix should be considered wherever the SDK uploads non-image data via `texImage2D`/`texSubImage2D`, since the premultiply state can be left `true` by any prior image load.

## Affected Files

- **Source**: `@flighthq/render-gl/dist/glSkinPaletteTexture.js` — `uploadGlSkinPaletteTexture()` function (missing premultiply reset)
- **Sets premultiply=true**: `@flighthq/render-gl/dist/glDraw.js` — image upload functions at lines 121, 191, 273
- **SDK version**: `@flighthq/sdk` 0.5.1-next.1050
