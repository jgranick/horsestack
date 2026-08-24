// The round's state machine, as five names. src/game/GamePhase.hx in the Haxe sibling.
//
// Its own file so the phase can be named without importing the module that advances it —
// game/game.ts re-exports it through the Game interface, which is how main.ts reads it when
// mapping a phase to a UI screen.
//
//   loading   — models still downloading; no input, no frames
//   ready     — models in, title screen up, waiting for PLAY
//   playing   — the clock is running and pieces are being placed
//   settling  — the clock ran out; the pile is given FINAL_SETTLE_SECONDS to fall over
//   finished  — height measured, result screen counting up
export type GamePhase = 'loading' | 'ready' | 'playing' | 'settling' | 'finished';
