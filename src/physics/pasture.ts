// The floor the pile stands on, in physics space.
//
// Its own leaf because both stackObjectProfile.ts (which measures height above the pasture)
// and stackPhysics.ts (which builds the static body and reads it for the stability ramp)
// need it, along with the game and the camera — so it cannot sit in either without the two
// importing each other.
// Measured off the farm glTF's Ground/Ground2 triangles along the play line: the modelled
// ground runs from about -1.61 to +1.71 in physics X at world x=1.55, and closes in to
// +/-1.60 across the depth a piece actually occupies. At 1.75 the platform hung 0.14 past
// the left edge of the floating map, so pieces rested on nothing. This sits inside it.
export const PASTURE_HALF_WIDTH = 1.55;
// STACK_BASE_Y maps physics space into the rendered scene. Its 0.015 offset
// puts this surface at world Y -0.02, level with the mounted farm terrain.
export const PASTURE_TOP_Y = -0.035;
