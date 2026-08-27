/**
 * A `SynthBackend` over the native soundfont synth — macOS today, and any
 * platform whose module satisfies `NativeSynthApi`.
 *
 * There is no engine here. The scheduler in `playback/soundfont-engine.ts` —
 * the tempo map, the lookahead, the loop, the seek, the governor, the sounding
 * set — is the same one the browser runs; this supplies only the sound, the
 * clock and the click. That is the whole reason `SynthBackend` exists.
 */
import type {
  PrepareResult,
  ScheduledClick,
  SynthBackend,
} from '../../playback/synth-backend.js';
import { CHANNELS_PER_INSTANCE } from '../../playback/channel-allocator.js';
import type { PlaybackLoadState } from '@sudobility/music_types';
import { PERCUSSION_CHANNEL } from '@sudobility/music_types';
import type {
  NativeSynth,
  NativeSynthApi,
  NativeSynthSettings,
} from './native-synth-api.js';

/**
 * Matched to the web host's, so a score sounds the same on both.
 *
 * These are not defaults inherited by omission: every one is stated because a
 * setting left out is fluidsynth's own silently adopted, which is how the web
 * synth once ran on sixteen channels while the allocator handed out channel 25.
 */
const SETTINGS: NativeSynthSettings = {
  midiChannelCount: CHANNELS_PER_INSTANCE,
  polyphony: 2048,
  initialGain: 0.2,
  chorusActive: true,
  reverbActive: true,
};

/**
 * The click, as General MIDI percussion.
 *
 * The web click is a tuned sine built from oscillators, which has no native
 * counterpart short of writing one — so the metronome is played through the
 * synth that is already there. Wood blocks because that is what a metronome
 * sounds like, and because they are short: a click that rings would smear
 * against the beat it is marking.
 */
const CLICK_ACCENT_MIDI = 76;
const CLICK_BEAT_MIDI = 77;
const CLICK_VELOCITY = 100;
const CLICK_SECONDS = 0.05;

export class NativeSynthBackend implements SynthBackend {
  private readonly api: NativeSynthApi;
  private readonly soundfontUri: string;
  private synth: NativeSynth | null = null;
  /**
   * The instance the metronome owns, and nothing else does.
   *
   * One synth is reserved past whatever the score needs, so switching the
   * click off can drop everything scheduled on it without touching a note —
   * and so a percussion track that has selected some other kit cannot change
   * what the click sounds like.
   */
  private clickInstance = 0;

  constructor(options: { api: NativeSynthApi; soundfontUri: string }) {
    this.api = options.api;
    this.soundfontUri = options.soundfontUri;
  }

  async prepare({
    instanceCount,
    onProgress,
  }: {
    instanceCount: number;
    onProgress: (state: PlaybackLoadState) => void;
  }): Promise<PrepareResult> {
    if (!this.api.isSupported()) {
      throw new Error('No native synth on this platform');
    }
    this.synth ??= this.api.createSynth();
    onProgress({ status: 'loading', fraction: 0 });
    await this.synth.initialize({
      soundfontUri: this.soundfontUri,
      instanceCount: instanceCount + 1,
      settings: SETTINGS,
      onProgress: fraction => onProgress({ status: 'loading', fraction }),
    });
    this.adoptClickInstance(instanceCount);
    // No deferred case: nothing here waits on a user gesture the way a
    // browser's suspended AudioContext does.
    return 'ready';
  }

  async ensureInstances(count: number): Promise<void> {
    await this.require().ensureInstances(count + 1);
    this.adoptClickInstance(count);
  }

  /** The click sits past the last instance the score uses, on the drum channel. */
  private adoptClickInstance(instanceCount: number): void {
    this.clickInstance = instanceCount;
    this.require().setChannelPercussion(this.clickInstance, PERCUSSION_CHANNEL);
  }

  now(): number {
    return this.synth?.currentTime() ?? 0;
  }

  outputLatency(): number | undefined {
    return this.synth?.outputLatency();
  }

  scheduleClick(atSeconds: number, accent: boolean): ScheduledClick {
    const synth = this.synth;
    const endsAt = atSeconds + CLICK_SECONDS;
    if (!synth) return { endsAt, cancel: () => undefined };
    synth.noteAt(
      this.clickInstance,
      PERCUSSION_CHANNEL,
      accent ? CLICK_ACCENT_MIDI : CLICK_BEAT_MIDI,
      CLICK_VELOCITY,
      Math.max(0, atSeconds - synth.currentTime()),
      CLICK_SECONDS
    );
    return {
      endsAt,
      // Everything queued on the click's own instance, which is only ever
      // clicks. Per-click cancellation would need the native side to hand back
      // a handle per event, for no gain: they are all being taken back at once.
      cancel: () => synth.cancelScheduledOn(this.clickInstance),
    };
  }

  noteAt(
    i: number,
    c: number,
    m: number,
    v: number,
    delay: number,
    dur: number
  ): void {
    this.require().noteAt(i, c, m, v, delay, dur);
  }
  noteOn(i: number, c: number, m: number, v: number): void {
    this.require().noteOn(i, c, m, v);
  }
  noteOff(i: number, c: number, m: number): void {
    this.require().noteOff(i, c, m);
  }
  programSelect(i: number, c: number, program: number): void {
    this.require().programSelect(i, c, program);
  }
  setChannelPercussion(i: number, c: number, kit?: number): void {
    this.require().setChannelPercussion(i, c, kit);
  }
  controlChange(i: number, c: number, control: number, value: number): void {
    this.require().controlChange(i, c, control, value);
  }
  allSoundOff(): void {
    this.synth?.allSoundOff();
  }
  setInterpolation(order: number): void {
    this.synth?.setInterpolation(order);
  }
  setMasterVolume(volume: number): void {
    this.synth?.setMasterVolume(volume);
  }
  /**
   * Nothing to do: the native synth applies no per-track headroom of its own.
   *
   * Declared rather than omitted because the interface requires it, and a
   * backend that quietly did nothing where the web one trims gain would be a
   * difference nobody could see. The trim lives in `shared/mix.ts` and reaches
   * both backends through the plan.
   */
  setTrackCount(): void {}

  dispose(): void {
    this.synth?.dispose();
    this.synth = null;
  }

  private require(): NativeSynth {
    if (!this.synth) throw new Error('Native synth not prepared');
    return this.synth;
  }
}
