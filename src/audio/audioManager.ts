// Every sound the game makes, on Flight's own audio stack.
//
// This was six raw HTMLAudioElements. Moving to @flighthq/media bought three things the DOM
// version could not do at all, and each is a feature rather than a tidy-up:
//   - a MIXER with buses, so "mute" is one call on the master rather than six pause() calls
//     that then have to be un-paused in the right order;
//   - GAIN FADES, so the ambience can die away instead of being cut off;
//   - decoded BUFFERS, so a sound can play twice at once. The result ticks used to need a
//     pool of eight elements because restarting one 32ms after the last swallowed its own
//     previous play; now each tick is just another channel off the same buffer.
//
// The tradeoff is that buffers must be decoded before they can play, so loading is async and
// every play call is a no-op until its resource lands. That is why the whole surface is
// fire-and-forget: nothing here returns a promise, and a sound that is not ready yet is
// simply not heard rather than queued to arrive late and out of context.
import type { AudioBus, AudioChannel, AudioMixer, AudioResource } from '@flighthq/sdk';
import { loadAudioResourceFromUrl } from '@flighthq/sdk';
import {
  addAudioBusToMixer,
  createAudioBus,
  createAudioMixer,
  fadeAudioBusGain,
  playAudioResource,
  routeAudioChannelToMixerBus,
  setAudioBusGain,
  setAudioMixerMasterMuted,
  stopAudioChannel,
} from '@flighthq/sdk/media';
import {
  AMBIENCE_FADE_AFTER_MS,
  AMBIENCE_FADE_MS,
  FINAL_WHINNY_CHANCE,
  HORSE_PLACEMENT_WHINNY_CHANCE,
  HORSE_WHINNY_CUES,
  HORSE_WHINNY_INTERVAL_JITTER_MS,
  HORSE_WHINNY_MIN_INTERVAL_MS,
  RESULT_TICK_INTERVAL_MS,
} from '../game/gameConfig';
import type { GameMode } from '../game/gameMode';
import { prefersReducedMotion } from '../reducedMotion';

export interface AudioManager {
  /** A piece has landed in the pile. */
  playStackThud: () => void;
  /** The round is over and the height count-up is starting: music out, fanfare in. */
  beginResultCount: () => void;
  /** The count-up is about to run: let the first tick fire at `now`. */
  armResultTicks: (now: number) => void;
  /** One tick of the height count-up. Rate limited, and silent under reduce-motion. */
  playResultTick: (now: number) => void;
  /** The count-up has landed on the final number. */
  celebrateResult: () => void;
  /**
   * A horse has just been set down — it may say something about it. A chance rather than a
   * certainty, and throttled, so it stays a flourish instead of a sound effect.
   *
   * This replaced a whinny fired off physics COLLISIONS, which went off for hay landing on
   * hay and turned into ambient chatter under a long build. Tying it to placing a horse means
   * it only comments on the thing the game is named after, and only when the player acted.
   */
  maybePlayHorseWhinny: (now: number) => void;
  /** A round is starting: bring the sound up. The soundtrack is TIME CHALLENGE only. */
  startRound: (now: number, mode: GameMode) => void;
  /** The player left a round for the title screen: music out, ambience stays. */
  leaveRound: () => void;
  /** Everything off. Also the error path. */
  stopAll: () => void;
  /**
   * Called every frame with whether a round is currently being played. Drives the ambience
   * fade: the farm keeps murmuring for a while after you stop, then dies away rather than
   * droning at an abandoned tab forever.
   */
  update: (now: number, playing: boolean) => void;
  setMuted: (muted: boolean) => void;
  readonly muted: boolean;
}

// The track opens on two seconds of near-silence; skipping it means the music arrives on
// the beat the player pressed PLAY.
const SOUNDTRACK_SKIP_SECONDS = 2;
const MUTED_KEY = 'horse-stacker.muted';

// Per-sound gains, carried over from the element volumes they replaced.
const GAIN = {
  ambience: 0.16,
  fanfare: 0.46,
  soundtrack: 0.36,
  tada: 0.52,
  thud: 0.24,
  tick: 0.1,
  whinny: 0.22,
} as const;

type SoundName = 'ambience' | 'fanfare' | 'soundtrack' | 'tada' | 'thud' | 'tick' | 'whinny';

const SOUND_FILES: Readonly<Record<SoundName, string>> = {
  ambience: 'free-sound-1674978362.mp3',
  fanfare: 'free-sound-1674977569.mp3',
  soundtrack: "Elijah_K - The Mountain's Happy Song.mp3",
  tada: 'free-sound-1674895520.mp3',
  thud: 'free-sound-1674747349.mp3',
  tick: 'free-sound-1674778893.mp3',
  whinny: 'free-sound-effects-HORSE3.mp3',
};

export function createAudioManager(soundRootUrl: string): AudioManager {
  // Created lazily, not at construction. A browser hands back a SUSPENDED context when there
  // has been no user gesture yet, and a suspended context decodes but never sounds — so the
  // first round would play silently and every later one would be fine, which is the most
  // confusing possible version of this bug.
  let context: AudioContext | null = null;
  let mixer: AudioMixer | null = null;
  let musicBus: AudioBus | null = null;
  let ambienceBus: AudioBus | null = null;
  let effectsBus: AudioBus | null = null;

  const resources = new Map<SoundName, AudioResource>();
  let soundtrackChannel: AudioChannel | null = null;
  let ambienceChannel: AudioChannel | null = null;
  let whinnyChannel: AudioChannel | null = null;
  let whinnyStopTimer: number | null = null;
  let scheduledWhinnyTimer: number | null = null;
  let nextHorseWhinnyAt = 0;
  let nextResultTickAt = 0;
  // When play stopped, for the ambience fade. Zero means "not counting".
  let idleSince = 0;
  let ambienceFaded = false;
  let muted = readMuted();
  // What SHOULD be looping, as against what is. The two come apart on the very first round:
  // the buffers are still decoding then, so the calls that start these return nothing and
  // the round plays silent. See reconcileLoops.
  let wantSoundtrack = false;
  let wantAmbience = false;

  function ensureContext(): AudioContext | null {
    if (context === null) {
      // Safari still only has the prefixed constructor.
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor === undefined) return null;
      context = new Ctor();
      mixer = createAudioMixer(context, { masterMuted: muted });
      musicBus = createAudioBus({ gain: 1, name: 'music' });
      ambienceBus = createAudioBus({ gain: 1, name: 'ambience' });
      effectsBus = createAudioBus({ gain: 1, name: 'effects' });
      addAudioBusToMixer(mixer, musicBus);
      addAudioBusToMixer(mixer, ambienceBus);
      addAudioBusToMixer(mixer, effectsBus);
      void loadAll(context);
    }
    // A context can be suspended again when a tab is backgrounded, so this is not only a
    // first-run concern.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    return context;
  }

  async function loadAll(target: AudioContext): Promise<void> {
    await Promise.all(
      (Object.keys(SOUND_FILES) as SoundName[]).map(async (name) => {
        const url = new URL(encodeURIComponent(SOUND_FILES[name]), soundRootUrl).href;
        try {
          resources.set(name, await loadAudioResourceFromUrl(target, url));
        } catch (error) {
          // A sound that will not decode is not a reason for the game to stop.
          console.info(`${name} could not be loaded.`, error);
        }
      }),
    );
  }

  function play(name: SoundName, bus: AudioBus | null, loops = 0, startAt = 0): AudioChannel | null {
    const target = ensureContext();
    const resource = resources.get(name);
    if (target === null || resource === undefined || mixer === null || bus === null) return null;
    const channel = playAudioResource(target, resource, {
      currentTime: startAt,
      gain: GAIN[name],
      loops,
    });
    if (channel === null) return null;
    routeAudioChannelToMixerBus(mixer, channel, bus);
    return channel;
  }

  function stop(channel: AudioChannel | null): null {
    if (channel !== null) stopAudioChannel(channel);
    return null;
  }

  // Both whinny timers go together. One stops the clip at the end of its cue, the other is a
  // celebration call queued 180ms out; cancelling only the first leaves the queued one to
  // fire over whatever comes next.
  function stopWhinny(): void {
    if (whinnyStopTimer !== null) window.clearTimeout(whinnyStopTimer);
    if (scheduledWhinnyTimer !== null) window.clearTimeout(scheduledWhinnyTimer);
    whinnyStopTimer = null;
    scheduledWhinnyTimer = null;
    whinnyChannel = stop(whinnyChannel);
  }

  function playWhinny(): void {
    stopWhinny();
    const cue = HORSE_WHINNY_CUES[Math.floor(Math.random() * HORSE_WHINNY_CUES.length)];
    if (cue === undefined) return;
    // Quiet regions in the source sample separate four calls; playing from an offset and
    // stopping after its length picks one out without shipping four derived files.
    whinnyChannel = play('whinny', effectsBus, 0, cue.start);
    whinnyStopTimer = window.setTimeout(() => {
      whinnyStopTimer = null;
      whinnyChannel = stop(whinnyChannel);
    }, cue.duration * 1000);
  }

  function raiseAmbience(): void {
    if (ambienceBus === null) return;
    setAudioBusGain(ambienceBus, 1);
    ambienceFaded = false;
    idleSince = 0;
    wantAmbience = true;
    if (ambienceChannel === null) ambienceChannel = play('ambience', ambienceBus, Infinity);
  }

  /**
   * Start any loop that should be running and is not.
   *
   * THE FIRST ROUND IS SILENT WITHOUT THIS. The AudioContext is built on the first user
   * gesture — it has to be, since one built earlier arrives suspended — and the sounds can
   * only be decoded once there is a context to decode them into. But the gesture that builds
   * it is the same click that starts round one, so at the moment the music is asked for its
   * buffer is still being fetched, play() finds nothing in `resources` and returns null, and
   * the round runs without music. By the second round the decode has long finished, which is
   * exactly the shape of the bug: fine on every play but the first.
   *
   * Retrying each frame rather than queueing a callback per sound keeps it honest about
   * INTENT: a loop starts if it is still wanted by the time it can be heard, and a round
   * that ended while its music was still decoding stays quiet, which is what you want.
   * One-shot effects are deliberately not retried — a thud that arrives half a second late
   * is worse than one that never comes.
   */
  function reconcileLoops(): void {
    if (wantAmbience && ambienceChannel === null) {
      ambienceChannel = play('ambience', ambienceBus, Infinity);
    }
    if (wantSoundtrack && soundtrackChannel === null) {
      soundtrackChannel = play('soundtrack', musicBus, 0, SOUNDTRACK_SKIP_SECONDS);
    }
  }

  return {
    get muted() {
      return muted;
    },

    setMuted(next) {
      muted = next;
      // Touching the context here as well as in play(): the mute button is a user gesture,
      // and it is a perfectly reasonable first thing to press.
      ensureContext();
      if (mixer !== null) setAudioMixerMasterMuted(mixer, muted);
      try {
        window.localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
      } catch {
        // A preference that cannot be persisted still holds for the rest of the session.
      }
    },

    playStackThud() {
      play('thud', effectsBus);
    },

    beginResultCount() {
      wantSoundtrack = false;
      soundtrackChannel = stop(soundtrackChannel);
      play('fanfare', effectsBus);
    },

    armResultTicks(now) {
      nextResultTickAt = now;
    },

    playResultTick(now) {
      if (prefersReducedMotion() || now < nextResultTickAt) return;
      nextResultTickAt = now + RESULT_TICK_INTERVAL_MS;
      // No pool any more. Each tick is its own channel off the shared buffer, so ticks 32ms
      // apart overlap instead of cutting each other off.
      play('tick', effectsBus);
    },

    celebrateResult() {
      play('tada', effectsBus);
      // Not every round — a whinny on all of them stops reading as a flourish.
      if (Math.random() >= FINAL_WHINNY_CHANCE) return;
      scheduledWhinnyTimer = window.setTimeout(() => {
        scheduledWhinnyTimer = null;
        playWhinny();
      }, 180);
    },

    maybePlayHorseWhinny(now) {
      if (now < nextHorseWhinnyAt) return;
      if (Math.random() >= HORSE_PLACEMENT_WHINNY_CHANCE) return;
      playWhinny();
      nextHorseWhinnyAt =
        now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
    },

    startRound(now, mode) {
      ensureContext();
      stopWhinny();
      nextHorseWhinnyAt =
        now + HORSE_WHINNY_MIN_INTERVAL_MS + Math.random() * HORSE_WHINNY_INTERVAL_JITTER_MS;
      raiseAmbience();
      soundtrackChannel = stop(soundtrackChannel);
      // STEADY HANDS has no clock, and a three minute song under an open-ended session turns
      // into a loop you notice. Stopping rather than merely not starting matters because the
      // previous round may have been a timed one whose music is still playing.
      wantSoundtrack = mode !== 'steady';
      if (!wantSoundtrack) return;
      // The track opens on two seconds of near-silence, which reads as the music failing to
      // start on the very beat the player pressed PLAY.
      soundtrackChannel = play('soundtrack', musicBus, 0, SOUNDTRACK_SKIP_SECONDS);
    },

    leaveRound() {
      wantSoundtrack = false;
      soundtrackChannel = stop(soundtrackChannel);
      stopWhinny();
    },

    stopAll() {
      wantSoundtrack = false;
      wantAmbience = false;
      soundtrackChannel = stop(soundtrackChannel);
      ambienceChannel = stop(ambienceChannel);
      stopWhinny();
    },

    update(now, playing) {
      reconcileLoops();
      if (playing) {
        if (ambienceFaded || idleSince !== 0) raiseAmbience();
        return;
      }
      if (ambienceChannel === null || ambienceFaded) return;
      if (idleSince === 0) {
        idleSince = now;
        return;
      }
      if (now - idleSince < AMBIENCE_FADE_AFTER_MS) return;
      ambienceFaded = true;
      if (mixer !== null && ambienceBus !== null) {
        fadeAudioBusGain(mixer, ambienceBus, 0, AMBIENCE_FADE_MS);
      }
    },
  };
}

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}
