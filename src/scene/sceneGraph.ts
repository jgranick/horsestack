// What the world is made of, built once at startup: the scene root, the sky dome, the two
// layers pieces get parented into, the game and shadow cameras, and the lights. The Haxe
// sibling calls this src/scene/SceneGraph.hx and it holds the same things.
//
// Everything here is CONSTRUCTION. Nothing in this module runs per frame and nothing reads
// game state, which is what makes it worth its own file: it is the longest stretch of
// main.ts that was pure setup, and the sky dome in particular (a layout conversion, a
// per-vertex gradient bake and a culling subtlety) reads as a self-contained thing once it
// is not sandwiched between the emitters and the lights.
import type {
  Camera3D,
  DirectionalLight,
  Mesh,
  Node3D,
  PointLight,
  Scene3DLightsLike,
  VertexAttributeLayout,
} from '@flighthq/sdk';
import {
  addNodeChild,
  clamp,
  configureDirectionalShadowCamera3DTightFit,
  convertMeshGeometryLayout,
  createAabb,
  createAmbientLight,
  createCamera3D,
  createDirectionalLight,
  createMesh,
  createNode3D,
  createOrthographicProjection,
  createPerspectiveProjection,
  createPointLight,
  createSphereMeshGeometry,
  createVector3,
  createVertexColorMaterial,
  getMeshGeometryVertexCount,
  getMeshGeometryVertexPosition,
  Node3DKind,
  normalizeVector3,
  setMeshGeometryVertexColor0,
  srgbChannelToLinear,
} from '@flighthq/sdk';
import { STACK_X, STACK_Z } from '../game/gameConfig';

export interface SceneGraph {
  root: Node3D;
  /** Placed pieces are parented here, so the pile can be cleared in one call. */
  stackLayer: Node3D;
  /**
   * The hovering preview and its halo ring share one parent so a single detach keeps both
   * out of the shadow pass. They must LEAVE the graph to be excluded:
   * drawGlScene3DShadowMap walks every descendant carrying geometry and never consults
   * `enabled`, `visible`, or the material's alpha mode, so hiding a node does not stop it
   * casting. That is why the halo used to lay a ring of shadow across the pasture despite
   * being switched off for the pass.
   */
  previewLayer: Node3D;
  /** Held separately because it too has to leave the graph for the shadow pass. */
  skyDome: Mesh;
  camera: Camera3D;
  shadowCamera: Camera3D;
  directionalLight: DirectionalLight;
  /** The warm glow under the drop marker. Intensity is driven per frame by the indicator. */
  indicatorLight: PointLight;
  lights: Scene3DLightsLike;
}

// The sky, in Flight rather than in CSS. It used to be a linear-gradient on the viewer
// showing through a transparent canvas, which meant the game's own background lived
// outside the renderer and could not travel with it. It is now a vertex-coloured dome
// inside the scene: an inverted sphere big enough to sit outside the farm and inside the
// camera's far plane, lit by nothing (createVertexColorMaterial is unlit), with the
// gradient written into color0 by height. The forward pass renders with culling off, so
// looking at the sphere from inside shows its back faces normally.
//
// The canonical mesh layout has no color0, so the geometry is converted to one that does.
const SKY_RADIUS = 40;
const SKY_LAYOUT = {
  attributes: [
    { byteOffset: 0, format: 'float32x3', semantic: 'position' },
    { byteOffset: 12, format: 'float32x3', semantic: 'normal' },
    { byteOffset: 24, format: 'float32x4', semantic: 'tangent' },
    { byteOffset: 40, format: 'float32x2', semantic: 'uv0' },
    { byteOffset: 48, format: 'float32x4', semantic: 'color0' },
  ],
  stride: 64,
} as const satisfies VertexAttributeLayout;
// A deeper blue overhead easing to a pale, almost warm horizon. The stylesheet's original
// stops are still in here in the middle, but the ramp now RESOLVES over the band the camera
// actually sees: mapping it pole to pole spent almost all of it below the island, and the
// visible sliver above the horizon came out as one flat blue.
const SKY_STOPS = [
  { at: 0, color: [0x2b8ce0] },
  { at: 0.42, color: [0x49a6ea] },
  { at: 0.74, color: [0x74c1f1] },
  { at: 1, color: [0xa6dbf8] },
] as const;

export function createSceneGraph(): SceneGraph {
  const root = createNode3D(Node3DKind);

  const skyDome = createSkyDome();
  addNodeChild(root, skyDome);
  const stackLayer = createNode3D(Node3DKind, { name: 'horse-stack' });
  addNodeChild(root, stackLayer);
  const previewLayer = createNode3D(Node3DKind, { name: 'landing-preview-layer' });

  const camera: Camera3D = createCamera3D({
    far: 90,
    near: 0.1,
    projection: createPerspectiveProjection({ aspect: 1, fovY: Math.PI / 5.4 }),
  });

  const sunDirection = createVector3(-0.75, -1, -0.5);
  normalizeVector3(sunDirection, sunDirection);
  const directionalLight = createDirectionalLight({
    castsShadow: true,
    color: 0xfff1d4ff,
    direction: sunDirection,
    intensity: 2.8,
    normalBias: 0.65,
    pcfRadius: 1,
    shadowBias: 0.001,
  });
  const indicatorLight: PointLight = createPointLight({
    color: 0xffd56aff,
    intensity: 0,
    position: createVector3(STACK_X + 0.16, 0.2, STACK_Z),
    range: 0.68,
  });
  const lights: Scene3DLightsLike = {
    ambient: createAmbientLight({ color: 0xbdd0b5ff, intensity: 0.72 }),
    directional: directionalLight,
    point: [indicatorLight],
  };

  const shadowCamera = createCamera3D({
    far: 55,
    near: 0.1,
    projection: createOrthographicProjection({ halfHeight: 15, halfWidth: 9 }),
  });
  // Flight's directional shadow map is a fixed 1024x1024 (DIRECTIONAL_SHADOW_MAP_SIZE),
  // so sharpness is entirely a question of how much world those texels cover. The farm's
  // own world bounds are only about 3.7 x 3.7 x 3.6, and the pile lives inside them, so
  // the shadow volume is that plus a margin — not the far larger box a whole-level scene
  // would need. Underside geometry below y=-0.7 is excluded: it casts nothing visible.
  // Tight-fit rather than the bounding-sphere fit, because it fits the light-space X and Y
  // extents independently and keeps noticeably more texel density. These are static bounds
  // fitted once, so there is no per-frame refit to shimmer.
  configureDirectionalShadowCamera3DTightFit(
    shadowCamera,
    sunDirection,
    createAabb(-1.95, -0.7, -4.05, 1.95, 2.25, -0.35),
    1.05,
  );

  return {
    camera,
    directionalLight,
    indicatorLight,
    lights,
    previewLayer,
    root,
    shadowCamera,
    skyDome,
    stackLayer,
  };
}

function createSkyDome(): Mesh {
  const geometry = convertMeshGeometryLayout(
    createSphereMeshGeometry(SKY_RADIUS, 32, 20),
    SKY_LAYOUT,
  );
  const position = { x: 0, y: 0, z: 0 };
  const vertexCount = getMeshGeometryVertexCount(geometry);
  for (let index = 0; index < vertexCount; index += 1) {
    getMeshGeometryVertexPosition(position, geometry, index);
    // The stylesheet ran its gradient top to bottom, so t is 0 at the zenith.
    // Zenith at 0, horizon at 1: the whole ramp lands in the band above the island, and
    // everything below the horizon — which the island covers — holds the last stop.
    const height = position.y / SKY_RADIUS;
    const [r, g, b] = sampleSkyGradient(clamp(1 - height * 1.35, 0, 1));
    setMeshGeometryVertexColor0(geometry, index, r, g, b, 1);
  }
  // Double-sided because the camera lives INSIDE this sphere: the forward pass culls back
  // faces, and every face of a dome seen from within is a back face. Without this the mesh
  // is present, correct and completely invisible — which is what it was, and why the blur
  // was fringing every silhouette with the transparent background behind it.
  const dome = createMesh(geometry, [
    createVertexColorMaterial({ doubleSided: true, tint: 0xffffffff }),
  ]);
  dome.name = 'sky';
  return dome;
}

function sampleSkyGradient(t: number): readonly [number, number, number] {
  for (let index = 1; index < SKY_STOPS.length; index += 1) {
    const previous = SKY_STOPS[index - 1];
    const next = SKY_STOPS[index];
    if (previous === undefined || next === undefined || t > next.at) continue;
    const span = next.at - previous.at;
    const mix = span > 0 ? (t - previous.at) / span : 0;
    const from = previous.color[0];
    const to = next.color[0];
    return [16, 8, 0].map((shift) => {
      const a = (from >>> shift) & 0xff;
      const b = (to >>> shift) & 0xff;
      // The stops are sRGB; the scene composites linear, so decode rather than lerp bytes.
      return srgbChannelToLinear((a + (b - a) * mix) / 255);
    }) as unknown as readonly [number, number, number];
  }
  return [1, 1, 1];
}
