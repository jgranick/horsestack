// Which of the two games you are playing. Chosen on the title screen and fixed for the
// round; PLAY AGAIN replays the same one, MENU comes back here to pick again.
//
//   time     — the original: a 30 second clock, then the pile is given FINAL_SETTLE_SECONDS
//              to fall over and whatever is standing is the score.
//   endless  — no clock and no music, just the farm's own ambience and a live height
//              readout. It runs until the tower is gone or you leave.
//
// The distinction is deliberately narrow. Endless is not a second game: it is the same
// placement loop with the timer removed, which is why nothing below this needs to branch on
// it beyond the three places that actually differ (the clock, the soundtrack, the HUD).
export type GameMode = 'time' | 'endless';
