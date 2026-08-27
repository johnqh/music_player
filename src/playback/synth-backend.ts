/**
 * Everything the soundfont scheduler needs from the thing that makes sound.
 *
 * This is `SynthHostLike` grown up. That interface was already almost
 * platform-free — instances, channels, programs, timestamped notes — but the
 * engine reached around it for four things that are not: it created its own
 * `AudioContext` for a clock, fetched the soundfont itself, handed the host
 * web-only worklet URLs, and synthesized the metronome click with Web Audio
 * oscillators. Each of those is a different answer on a platform with no
 * `AudioContext` at all, and each was the reason a second engine looked
 * necessary.
 *
 * They are all here instead, so the scheduler — the tempo map, the lookahead,
 * the loop, the seek, the governor, the sounding set — exists once and runs
 * unchanged wherever a backend can be built. `web/playback/web-backend.ts`
 * builds one over `AudioContext` and js-synthesizer; `rn/playback/native-backend.ts`
 * builds one over the native synth.
 */
import type { PlaybackLoadState } from '@sudobility/music_types';

/**
 * A click that has been placed in the future.
 *
 * Abstract because a click is a tuned oscillator on the web and a percussion
 * note natively; the scheduler only ever needs to know when it has finished
 * sounding and how to take it back.
 */
export type ScheduledClick = {
  /** When it has finished sounding, so a caller knows when to forget it. */
  readonly endsAt: number;
  /** Silences it from `atSeconds`, whether or not it has begun. */
  cancel(atSeconds: number): void;
};

/**
 * Whether the backend actually came up.
 *
 * `deferred` is not a failure: a browser starts an `AudioContext` suspended
 * unless it was created inside a user gesture, and a suspended context never
 * runs its `AudioWorklet` — so the font load would hang rather than fail. The
 * scheduler does the cheap part and tries again from the next gesture. A
 * backend with no such rule simply never returns it.
 */
export type PrepareResult = 'ready' | 'deferred';

export type SynthBackend = {
  /**
   * Brings up the device, the synths and the soundfont, reporting progress.
   *
   * The backend owns the font: a browser fetches bytes and hands them to a
   * worklet, while a native synth is given a file URI and reads it itself —
   * copying 23MB through a bridge would cost more than reading it does. The
   * scheduler only forwards what comes back to `PlaybackLoadState`, which is
   * what the "Preparing instruments" readout shows.
   */
  prepare(options: {
    instanceCount: number;
    onProgress: (state: PlaybackLoadState) => void;
  }): Promise<PrepareResult>;
  /** Grows the pool. Never shrinks: a sounding note must not lose its synth. */
  ensureInstances(count: number): Promise<void>;

  /**
   * The clock every scheduled time below is measured against.
   *
   * The audio device's own, not a JS timer: those drift against it, and a
   * playhead is exactly what reveals the drift.
   */
  now(): number;
  /**
   * Seconds between a sound being scheduled and it reaching the speaker, or
   * `undefined` where the platform does not report it. `shared/visual-sync.ts`
   * turns it into the offset that makes lit keys match the ear.
   */
  outputLatency(): number | undefined;

  /**
   * A note that starts `delaySeconds` from `now()` and releases itself after
   * `durationSeconds` — the scheduled-playback call.
   *
   * Self-releasing so that a note needs one crossing rather than two: on the
   * web the pair goes to fluidsynth's sequencer on the audio thread, and
   * natively it goes over a bridge, where a separate note-off could arrive
   * late on its own.
   */
  noteAt(
    instance: number,
    channel: number,
    midi: number,
    velocity: number,
    delaySeconds: number,
    durationSeconds: number
  ): void;
  /** Sounds now and holds — auditioning a key, independent of the transport. */
  noteOn(
    instance: number,
    channel: number,
    midi: number,
    velocity: number
  ): void;
  noteOff(instance: number, channel: number, midi: number): void;

  programSelect(instance: number, channel: number, program: number): void;
  /** A percussion channel addresses a drum bank; `kit` is resolved by the caller. */
  setChannelPercussion(instance: number, channel: number, kit?: number): void;
  controlChange(
    instance: number,
    channel: number,
    control: number,
    value: number
  ): void;

  /** Places a click at `atSeconds` on `now()`'s clock. */
  scheduleClick(atSeconds: number, accent: boolean): ScheduledClick;

  allSoundOff(): void;
  /** Interpolation order, lowered under load — see `governor.ts`. */
  setInterpolation(order: number): void;
  setMasterVolume(volume: number): void;
  /** How many tracks are playing, for whatever headroom the backend applies. */
  setTrackCount(count: number): void;
  dispose(): void;
};
