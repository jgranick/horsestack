// Which of the two games you are playing. Chosen on the title screen and fixed for the
// round; PLAY AGAIN replays the same one, MENU comes back here to pick again.
//
//   time    — a 30 second clock, then the pile is given FINAL_SETTLE_SECONDS to fall over
//             and whatever is standing is the score.
//   steady  — no clock and no music. It ends the moment a horse goes off the map, and
//             scores the tallest the tower ever stood.
//
// Two pressures on one verb, which is the whole point of having two: `time` asks how high
// you can get in half a minute, `steady` asks how high you can get without dropping any.
// Neither is a different game, which is why nothing below this branches on the mode beyond
// the four places that actually differ — the clock, the soundtrack, the HUD, and what ends
// the round.
//
// `steady` was called `endless` for one commit. It was a true sandbox then, and a sandbox
// turned out to have nothing to score: the height readout and the per-mode record both want
// a run that ENDS, and without one the "record" only measures how long someone was willing
// to keep clicking. Its name is the game's own unit — a horse is measured in hands, and the
// score is reported in them.
export type GameMode = 'time' | 'steady';
