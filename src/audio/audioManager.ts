// Every sound the game makes, and the timers that keep them from tripping over each other.
// The Haxe sibling files this as src/audio/AudioManager.hx; this is the same boundary with
// a closure instead of a class, matching createGameUi2D in ui/gameUi.ts.
//
// The whole point of the module is that NOTHING outside it holds an HTMLAudioElement. The
// callers ask for game events — "a piece landed", "the count is running", "the round is
// over" — and the cue-picking, the retrigger, the pool rotation and the three cancellable
// timers stay behind that. Before the split main.ts reached into six raw elements from
// eleven places, and the whinny in particular has two timers that must both be cancelled
// together or a queued call fires over the next round's music.
//
// These are still raw HTMLAudioElements rather than @flighthq/media. That swap is a
// separately scoped piece of work, and doing it here would have meant changing what the
// audio does in the same commit as changing where it lives.
import {
  FINAL_WHINNY_CHANCE,
  HORSE_WHINNY_CUES,
  HORSE_WHINNY_INTERVAL_JITTER_MS,
  HORSE_WHINNY_MIN_INTERVAL_MS,
  RESULT_TICK_INTERVAL_MS,
  RESULT_TICK_POOL_SIZE,
} from '../game/gameConfig';
import type { GameMode } from '../game/gameMode';
import { prefersReducedMotion } from '../reducedMotion';

export interface AudioManager {
  /** A piece has landed in the pile. */
  playStackThud: () => void;
  /** The round is over and the height count-up is starting: music out, fanfare in. */
  beginResultCount: () => void;
  /**
   * The count-up is about to run: rewind the tick pool and let the first tick fire at `now`.
   * Separate from beginResultCount because the fanfare starts when the round ends, while the
   * ticks start when the number actually begins climbing a couple of seconds later.
   */
  armResultTicks: (now: number) => void;
  /** One tick of the height count-up. Rate limited internally, and silent under reduce-motion. */
  playResultTick: (now: number) => void;
  /** The count-up has landed on the final number. */
  celebrateResult: () => void;
  /** Two pieces hit hard enough to be worth a whinny — throttled to one every few seconds. */
  maybePlayCollisionWhinny: (now: number) => void;
  /**
   * A round is starting: re-arm the effects and bring the sound up. The soundtrack is a
   * TIME CHALLENGE thing — endless runs get the farm's ambience and nothing else, because a
   * three minute song under an open-ended session turns into a loop you notice.
   */
  startRound: (now: number, mode: GameMode) => void;
  /** The player left a round for the title screen: music out, ambience stays. */
  leaveRound: () => void;
  /** Everything off, every timer cancelled. Also the error path. */
  stopAll: () => void;
}

export function createAudioManager(soundRootUrl: string): AudioManager {
  const soundUrl = (file: string): string =>
    new URL(encodeURIComponent(file), soundRootUrl).href;

  const soundtrack = createAudioTrack(soundUrl("Elijah_K - The Mountain's Happy Song.mp3"), 0.36);
  const farmAmbience = createAudioTrack(soundUrl('free-sound-1674978362.mp3'), 0.16, true);
  const horseThud = createAudioTrack(soundUrl('free-sound-1674747349.mp3'), 0.24);
  const countFanfare = createAudioTrack(soundUrl('free-sound-1674977569.mp3'), 0.46);
  const resultTada = createAudioTrack(soundUrl('free-sound-1674895520.mp3'), 0.52);
  const horseWhinnies = createAudioTrack(soundUrl('free-sound-effects-HORSE3.mp3'), 0.22);
  // A pool, not one element: the ticks land 32ms apart and one element restarted that fast
  // swallows its own previous play, so the count-up went silent at speed.
  const resultTickUrl = soundUrl('free-sound-1674778893.mp3');
  const resultTicks = Array.from({ length: RESULT_TICK_POOL_SIZE }, () =>
    createAudioTrack(resultTickUrl, 0.1),
  );

  let nextHorseWhinnyAt = 0;
  let horseWhinnyStopTimer: number | null = null;
  let scheduledHorseWhinnyTimer: number | null = null;
  let resultTickIndex = 0;
  let nextResultTickAt = 0;

  // Both whinny timers go together. One stops the clip mid-file at the end of its cue, the
  // other is a celebration call queued 180ms out; cancelling only the first leaves the
  // queued one to fire over whatever comes next.
  function stopHorseWhinny(): void {
    if (horseWhinnyStopTimer !== null) window.clearTimeout(horseWhinnyStopTimer);
    if (scheduledHorseWhinnyTimer !== null) window.clearTimeout(scheduledHorseWhinnyTimer);
    horseWhinnyStopTimer = null;
    scheduledHorseWhinnyTimer = null;
    stopAudioTrack(horseWhinnies);
  }

  function playHorseWhinny(): void {
    stopHorseWhinny();
    const cue = HORSE_WHINNY_CUES[Math.floor(Math.random() * HORSE_WHINNY_CUES.length)];
    if (cue === undefined) return;
    horseWhinnies.currentTime = cue.start;
    playAudioTrack(horseWhinnies, 'Horse whinny');
    horseWhinnyStopTimer = window.setTimeout(() => {
      horseWhinnyStopTimer = null;
      stopAudioTrack(horseWhinnies);
    }, cue.duration * 1000);
  }

  function stopResultTicks(): void {
    for (const tick of resultTicks) stopAudioTrack(tick);
    resultTickIndex = 0;
    nextResultTickAt = 0;
  }

  function reloadGameEffects(): void {
    stopHorseWhinny();
    reloadAudioTrack(horseThud);
    reloadAudioTrack(horseWhinnies);
    reloadAudioTrack(countFanfare);
    reloadAudioTrack(resultTada);
    for (const tick of resultTicks) reloadAudioTrack(tick);
    resultTickIndex = 0;
    nextResultTickAt = 0;
  }

  return {
    playStackThud() {
      restartAudioTrack(horseThud, 'Stack thud');
    },

    beginResultCount() {
      stopAudioTrack(soundtrack);
      restartAudioTrack(countFanfare, 'Count fanfare');
    },

    armResultTicks(now) {
      resultTickIndex = 0;
      nextResultTickAt = now;
    },

    playResultTick(now) {
      if (prefersReducedMotion() || now < nextResultTickAt) return;
      const tick = resultTicks[resultTickIndex % resultTicks.length];
      if (tick === undefined) return;
      resultTickIndex++;
      nextResultTickAt = now + RESULT_TICK_INTERVAL_MS;
      restartAudioTrack(tick, 'Result tick');
    },

    celebrateResult() {
      restartAudioTrack(resultTada, 'Result fanfare');
      // Not every round — a whinny on all of them stops reading as a flourish.
      if (Math.random() >= FINAL_WHINNY_CHANCE) return;
      scheduledHorseWhinnyTimer = window.setTimeout(() => {
        scheduledHorseWhinnyTimer = null;
        playHorseWhinny();
      }, 180);
    },

    maybePlayCollisionWhinny(now) {
      if (now < nextHorseWhinnyAt) return;
      playHorseWhinny();
      nextHorseWhinnyAt =
        now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
    },

    startRound(now, mode) {
      reloadGameEffects();
      nextHorseWhinnyAt =
        now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
      if (farmAmbience.paused) playAudioTrack(farmAmbience, 'Farm ambience');
      if (mode === 'endless') {
        // Not just "do not start it": the previous round may have been a timed one whose
        // music is still playing when PLAY AGAIN or MENU lands here.
        stopAudioTrack(soundtrack);
        return;
      }
      restartAudioTrack(soundtrack, 'Background music');
      // The track opens on two seconds of near-silence, which reads as the music failing
      // to start on the very beat the player pressed PLAY.
      soundtrack.currentTime = 2;
    },

    leaveRound() {
      stopAudioTrack(soundtrack);
      stopResultTicks();
      stopHorseWhinny();
    },

    stopAll() {
      stopAudioTrack(soundtrack);
      stopAudioTrack(farmAmbience);
      stopAudioTrack(horseThud);
      stopAudioTrack(countFanfare);
      stopAudioTrack(resultTada);
      stopResultTicks();
      stopHorseWhinny();
    },
  };
}

function createAudioTrack(source: string, volume: number, loop = false): HTMLAudioElement {
  const audio = new Audio(source);
  audio.preload = 'auto';
  audio.volume = volume;
  audio.loop = loop;
  return audio;
}

function playAudioTrack(audio: HTMLAudioElement, label: string): void {
  void audio.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    // Audio permission or device failures should never prevent a game from running.
    console.info(`${label} could not start.`, error);
  });
}

function restartAudioTrack(audio: HTMLAudioElement, label: string): void {
  stopAudioTrack(audio);
  playAudioTrack(audio, label);
}

function stopAudioTrack(audio: HTMLAudioElement): void {
  audio.pause();
  audio.currentTime = 0;
}

function reloadAudioTrack(audio: HTMLAudioElement): void {
  audio.pause();
  // load() clears an ended or interrupted media pipeline and starts a fresh
  // preload. Re-arming short effects here gives them the entire next round to
  // buffer instead of discovering an evicted resource during the result beat.
  audio.load();
}
