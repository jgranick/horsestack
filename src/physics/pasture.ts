// The floor the pile stands on, in physics space.
//
// Its own leaf because both stackObjectProfile.ts (which measures height above the pasture)
// and stackPhysics.ts (which builds the static body and reads it for the stability ramp)
// need it, along with the game and the camera — so it cannot sit in either without the two
// importing each other.

// How far the play area reaches each way, measured off the farm glTF's Ground/Ground2
// triangles by casting a ray down at each point along the pile line.
//
// ASYMMETRIC, because the island is. Walking the profile outward from the middle, the
// ground stays a gentle 4.7 degrees out to x = +1.60 and then falls off a 37 degree cliff
// by +1.65; the other side is 7.0 degrees out to -1.55 with its cliff at -1.60. So the
// island's flat top reaches about 60mm further one way than the other, and squaring that
// off to one symmetric +/-1.55 gave away the difference on the RIGHT — a strip of pasture
// you could see but not build on, which read as the map ending early.
//
// Set to the SHELF, not to the last triangle. Pasture friction is 0.38, so anything past
// 20.8 degrees is a slide rather than a surface: extending onto the rim itself would hand
// the player ground that quietly tips every piece off the edge. These sit ~30mm inside the
// cliff, and placement insets further still — the aim clamps by 1.2x the piece's half
// width, so nothing is ever set down overhanging.
export const PASTURE_MIN_X = -1.56;
export const PASTURE_MAX_X = 1.62;
/** Width of the play area. Not a half width — the pasture is not centred on the origin. */
export const PASTURE_WIDTH = PASTURE_MAX_X - PASTURE_MIN_X;

// STACK_BASE_Y maps physics space into the rendered scene, putting this surface level with
// the mounted farm terrain. Where the ground mesh could be sampled the floor follows it
// instead (see scene/terrainProfile.ts); this is the flat fallback for a model whose ground
// cannot be found, and for the headless validation scripts, which have no mesh to sample.
export const PASTURE_TOP_Y = -0.035;
