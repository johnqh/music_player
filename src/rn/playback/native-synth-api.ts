/**
 * The slice of the native soundfont synth this package drives.
 *
 * Declared structurally, like `audio-api.ts` beside it and `skia-api.ts` in
 * music_drawing: nothing here imports the native module, so it can be driven
 * in a test with a fake and this package's dev tree needs no React Native.
 *
 * **This is a synth, not a player.** It owns sound and a clock and knows
 * nothing about plans, repeats, loops, tempo maps or which notes are sounding.
 * All of that already exists once, in the scheduler `soundfont-engine.ts`
 * drives through `SynthHostLike` — so this contract is deliberately shaped to
 * what *that* interface needs, and `native-synth-host.ts` adapts one to the
 * other. A native module that scheduled a `PlaybackPlan` itself would be a
 * second copy of the whole transport, in C++, where none of the existing tests
 * can reach.
 *
 * **Instances and channels come from the caller.** libfluidsynth runs a fixed
 * number of MIDI channels per synth, so the scheduler allocates across several
 * instances (`channel-allocator.ts`) and addresses every call by both. The
 * native side allocates nothing and keeps no catalogue: which kit a percussion
 * program means is resolved before it gets here, exactly as on the web.
 */

export type NativeSynthSettings = {
  /** int [16-256] and a multiple of 16, as fluidsynth requires. */
  midiChannelCount: number;
  /** Maximum simultaneous voices before the synth steals by its own priority. */
  polyphony: number;
  /** Output level before our own master gain. */
  initialGain: number;
  /** Both colour every note; on, for parity with the web engine's output. */
  chorusActive: boolean;
  reverbActive: boolean;
};

export type NativeSynth = {
  /**
   * Brings up the audio device and `instanceCount` synths, and loads the
   * soundfont.
   *
   * The font is named by **file URI, not bytes**: it is ~23MB, and copying it
   * through the bridge would cost more than reading it does — where the web
   * host is handed an `ArrayBuffer` because a browser has no path to give it.
   * The host supplies the URI, for the same reason it supplies the web host's
   * worklet URLs: a library cannot know how an app bundles its assets.
   *
   * `onProgress` reports the load, because the first press of Play waits on it
   * — that is what `PlaybackLoadState` and the "Preparing instruments" readout
   * exist for, and a native load is no faster than a fetch.
   */
  initialize(options: {
    soundfontUri: string;
    instanceCount: number;
    settings: NativeSynthSettings;
    onProgress?: (fraction: number) => void;
  }): Promise<void>;
  /** Grows the pool. Never shrinks it: a sounding note must not lose its synth. */
  ensureInstances(count: number): Promise<void>;

  /**
   * The synth's own clock, in seconds, monotonic while running.
   *
   * `noteAt`'s delay is measured from this. Deliberately not a JS timer: those
   * drift against the audio device, and a playhead is exactly what reveals it.
   */
  currentTime(): number;
  /**
   * Seconds between an event sounding and it reaching the speaker, so lit keys
   * can match the ear rather than the scheduler — `shared/visual-sync.ts`
   * already does this arithmetic for the web engine.
   */
  outputLatency(): number;

  /**
   * A note that starts `delaySeconds` from now and releases itself after
   * `durationSeconds`.
   *
   * The scheduled-playback call, and the reason every event is timestamped.
   * The web host hands the same thing to fluidsynth's sequencer, which runs on
   * the audio thread; here it crosses a bridge, so a bare "play now" would put
   * the bridge's jitter onto the notes instead of onto the scheduler.
   * Self-releasing for the same reason: a separate note-off would be a second
   * crossing that can arrive late on its own.
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

  /**
   * Drops everything scheduled on one instance, without touching the others.
   *
   * The metronome's, and the reason it is not just `allSoundOff`: switching the
   * click off must not silence the music. The click gets an instance of its
   * own precisely so this can be a blunt instrument — see `native-backend.ts`.
   */
  cancelScheduledOn(instance: number): void;
  /**
   * Silences everything sounding and drops everything scheduled.
   *
   * One call rather than a note-off per voice: a stop or a seek has to undo a
   * whole lookahead window, and walking it from JS would send a burst of
   * bridge calls at the moment the user is waiting on the transport.
   */
  allSoundOff(): void;
  /** Interpolation order, lowered under load — see `governor.ts`. */
  setInterpolation(order: number): void;
  setMasterVolume(volume: number): void;
  dispose(): void;
};

/** What the host needs from the module, and nothing else. */
export type NativeSynthApi = {
  createSynth(): NativeSynth;
  /**
   * False where no native synth is built in, so the caller can say so rather
   * than fail obscurely — the same courtesy `MidiInput` does with
   * `isSupported()` in music_io.
   */
  isSupported(): boolean;
};
