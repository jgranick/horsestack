import {
  HORSE_HALF_HEIGHT,
  HORSE_SIZE_MULTIPLIER,
} from '../physics/stackObjectProfile';

// Every tuning number the game is played on, gathered in one place — the shape the Haxe
// sibling settles on in src/game/GameConfig.hx. Pulling these out of main.ts is what makes
// the rest of the split work: scene/, ui/ and the game loop all read the same numbers, and
// a module that needs only a number should not have to import the module that owns the
// scene graph to get it.
//
// Physics tuning deliberately does NOT live here. PHYSICS_STEP, PASTURE_*, HORSE_HALF_*,
// HORSE_SIZE_MULTIPLIER and FINAL_SETTLE_SECONDS stay in physics/horseStackPhysics.ts,
// because the headless validation scripts import that module on its own and it has to keep
// standing up with no game around it. The reference hoists them into GameConfig and has
// physics read upward; leaving them below is the one place this split diverges on purpose.

// Maps physics Y into world Y, and so decides where the play surface sits against the
// rendered farm. PASTURE_TOP_Y is -0.015, putting the platform at world Y -0.072 — the
// height of the modelled grass under the play band, sampled by ray-casting the farm
// glTF's Ground/Ground2 triangles along the pile line (world x=1.55): the terrain runs
// -0.045 to -0.079 there, mean -0.066, and this sits just under that so pieces settle
// into the grass rather than hovering over it. Deliberately fixed HERE and not by moving
// PASTURE_TOP_Y: the physics and scoring code treats y=0 as the floor in several places
// (getSupportedStackHeight's empty-pile sentinel, its fall-off test, getStackHeightMeters'
// guard), so lowering the pasture itself would read a settled chicken as fallen.
export const STACK_BASE_Y = -0.057;
// At a 90° camera azimuth, +X is toward the viewer and Z runs horizontally.
// Pull the 2D play plane close to the island's front edge at roughly x=1.8,
// while retaining a small strip of visible pasture beneath the pieces.
export const STACK_X = 1.55;
export const STACK_Z = -2.15;
export const HORSE_SCALE = 0.00279 * HORSE_SIZE_MULTIPLIER;
export const HORSE_VISUAL_CENTER_Y = 0.07875 * HORSE_SIZE_MULTIPLIER;
// The preview floats a full horse-height above its landing surface so the queued
// object reads as "about to drop" rather than as an object already in the pile.
// Placement still uses the unlifted landing pose.
// Was a full horse-height. Once the camera fills the frame with the tower, a marker that
// high sat off the top edge in all but 4 samples in 45 — and with the header and the
// in-viewer callout both hidden, the marker is the only remaining cue to what is queued.
// At this lift it is back inside the frame in about 7 samples in 10, still clearly
// hovering above the landing pose rather than resting on it.
export const LANDING_PREVIEW_LIFT = HORSE_HALF_HEIGHT * 1.2;
// The camera used to hold a constant lift above the pile so the raised marker always
// cleared the top of the frame. Measured over a played run, that spent 56% of the screen
// on empty sky and pushed the base of the pile off the bottom edge in 32 of 41 samples.
// Framing is pulled toward the pile instead: the target sits this share of the visible
// half-height BELOW the pile top, and the camera starts a little further back so the
// marker still fits. Measured after: 40% sky, the pile top at +0.19 of the frame instead
// of -0.13, and the ground never leaving the frame at all. The marker's centre grazes the
// top edge somewhat more often (8 samples in 43 against 3), which is the deliberate trade
// — the pile is the subject, the marker is a cue.
// Share of the frame height the tower should occupy, and how far above the tower's middle
// to sit. Measured over played runs against the previous top-tracking camera: the tower
// goes from filling 54% of the frame to about 70%, the pasture stays in frame throughout,
// and the pile top is inside the frame in roughly nine samples in ten.
// How much of the frame the tower fills. It EASES OFF with height on purpose: a tall pile
// framed as tightly as a short one crowds the barn and silo out of shot, and the joke is
// the pile reaching them. Backing off keeps them behind it.
export const CAMERA_PILE_FILL = 0.8;
export const CAMERA_PILE_FILL_AT_HEIGHT = 0.56;
export const CAMERA_TOP_BIAS = 0.16;
export const CAMERA_MIN_DISTANCE = 1.05;
// High enough that the fit is never the thing that binds in real play. It used to be
// 3.25, which the fit reached at a 12m pile — from there the camera stopped backing off
// and the tower simply climbed the frame instead. Measured over played runs at the old
// limit, the pile top sat 91% of the way to the top edge above 20m and the piece waiting
// to drop was off screen in every sample. Piles now reach past 20m routinely, so the
// ceiling has to clear that with room. GAME_VIEW.maxDistance below must stay above this:
// the controller clamps again on its own, and that second clamp is the easier one to miss.
export const CAMERA_MAX_DISTANCE = 7.5;
// The camera frames the measured stack top, but that measurement is a max over the
// qualifying bodies: when a piece settles, the top can change by centimetres in a single
// step while nothing visibly moves much. Feeding that straight to the camera is what made
// it shudder. The camera follows its own copy of the height instead — deadbanded so
// millimetre flicker is ignored outright, and rate limited so even the worst measured jump
// (about 0.063 units) reaches the camera as at most 0.0023 per frame rather than all at
// once. Rising is quick so a placed piece is framed promptly; falling is slow, because a
// pile that has just lost a few millimetres is exactly the case that should not yank the
// view. Only the camera reads this; scoring and the HUD keep the true measurement.
export const CAMERA_HEIGHT_DEADBAND = 0.008;
export const CAMERA_HEIGHT_RISE_RATE = 1.1;
export const CAMERA_HEIGHT_FALL_RATE = 0.14;
// A flat fall rate treats losing a couple of centimetres and losing the whole tower as the
// same event. At 0.14 a unit-and-a-half collapse takes twelve seconds to walk back down,
// which is most of a round spent framed for a pile that is no longer there. So the fall
// gets a term proportional to how far behind the camera is: a settling wobble still
// crawls, while a genuine collapse is chased down in a second or two and eases as it
// closes, since the term shrinks with the gap it is closing.
export const CAMERA_HEIGHT_COLLAPSE_RATE = 1.6;
// One lazy turn every fourteen seconds. The sails are ambient scenery, so this is
// slow enough to read as idling wind rather than as something demanding attention.
export const WINDMILL_RADIANS_PER_SECOND = (Math.PI * 2) / 14;
// Long enough to swallow the second half of a double-click on "Start stacking",
// short enough that a player who reacts to the first preview never notices it.
export const START_INPUT_GUARD_MS = 400;
export const GAME_DURATION_MS = 30_000;
export const MIN_RESULT_COUNT_DURATION_MS = 2_200;
export const MAX_RESULT_COUNT_DURATION_MS = 4_000;
export const RESULT_TICK_INTERVAL_MS = 32;
// How long the farm keeps murmuring after you stop playing, and how long it then takes to
// die away. Long enough that stepping away between rounds does not kill the atmosphere;
// short enough that a tab left open all afternoon eventually goes quiet.
export const AMBIENCE_FADE_AFTER_MS = 45_000;
export const AMBIENCE_FADE_MS = 6_000;
export const HORSE_WHINNY_MIN_INTERVAL_MS = 9_000;
export const HORSE_WHINNY_INTERVAL_JITTER_MS = 6_000;
export const FINAL_WHINNY_CHANCE = 0.28;
// How often setting a horse down gets a whinny out of it. Well under half, because the point
// is that it is a surprise — at every placement it stops being a reaction and becomes the
// sound a horse makes when you put it down, which is a different and much duller thing.
export const HORSE_PLACEMENT_WHINNY_CHANCE = 0.3;
// Quiet regions in the source sample separate these four calls. Cueing the
// original file avoids shipping four near-identical derived assets.
export const HORSE_WHINNY_CUES = [
  { duration: 2.1, start: 0.08 },
  { duration: 1.2, start: 3.7 },
  { duration: 1.7, start: 5.7 },
  { duration: 1.25, start: 8.82 },
] as const;
export const INDICATOR_SPRING = 22;
export const INDICATOR_DAMPING = 6.2;
export const INDICATOR_MAX_ANGLE = 0.65;
export const INDICATOR_MAX_SPIN = 5.5;
export const FIXED_STEP_LIMIT = 6;

// How many pieces STEADY HANDS lets you lose before the run is over. The fourth ends it.
//
// Not sudden death, and the reason is the physics rather than mercy: a piece can be nudged
// off the pasture seconds after the placement that doomed it, while the pile settles. Ending
// on the first loss would regularly end a run on a wobble the player did not cause and could
// not see coming. Three is enough slack to absorb that and still short enough that every
// loss is felt.
export const STEADY_HANDS_ALLOWANCE = 3;
