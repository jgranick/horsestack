// The round's state machine, as five names. src/game/GamePhase.hx in the Haxe sibling.
//
// Its own file because both game/game.ts (which advances it) and main.ts (which maps it to a
// UI screen) need it, and neither should have to import the other to name a phase.
//
//   loading   — models still downloading; no input, no frames
//   ready     — models in, title screen up, waiting for PLAY
//   playing   — the clock is running and pieces are being placed
//   settling  — the clock ran out; the pile is given FINAL_SETTLE_SECONDS to fall over
//   finished  — height measured, result screen counting up
export type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';
