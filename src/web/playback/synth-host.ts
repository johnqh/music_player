/**
 * The one module that talks to `js-synthesizer`.
 *
 * Hosts N libfluidsynth instances inside an `AudioWorklet`, so synthesis runs
 * on the audio thread where React and the garbage collector cannot starve it.
 * Everything above this only knows about instances, channels and notes.
 *
 * **The worklet module URLs are injected, not resolved here.** `music_io` is a
 * library and cannot assume how a consuming app serves assets; the app decides
 * (a `?url` import, a copy into its public directory) and passes them in.
 *
 * The synth factory is injected too, which lets the rules that matter be
 * tested against a stub instead of being verifiable only by ear. The
 * percussion guard below is the one that most needs it.
 */
import { headroomTrimFor, LIMITER_CEILING_DB } from '../../shared/mix.js';
import { CHANNELS_PER_INSTANCE } from './channel-allocator.js';
import { createWorkletQuietModuleUrl } from './quiet-stub-notices.js';

/**
 * The subset of `js-synthesizer`'s `SynthesizerSettings` this host sets.
 *
 * Both are init-time only. `ISynthesizer` exposes `setInterpolation` and
 * `setGain` and nothing else, so neither can be changed on a running synth.
 */
export type SynthSettings = {
  /** int [16-256], and a multiple of 16. */
  midiChannelCount?: number;
  /** int [1-65535]. Above it, fluidsynth steals by its own overflow priority. */
  polyphony?: number;
};

/** The slice of `AudioWorkletNodeSynthesizer` this host uses. */
export type SynthInstance = {
  init(sampleRate: number, settings?: SynthSettings): void;
  createAudioNode(context: BaseAudioContext, bufferSize: number): AudioNode;
  loadSFont(data: ArrayBuffer): Promise<number>;
  createSequencer?(): Promise<SynthSequencer>;
  midiNoteOn(channel: number, midi: number, velocity: number): void;
  midiNoteOff(channel: number, midi: number): void;
  midiProgramSelect(channel: number, sfontId: number, bank: number, preset: number): void;
  midiControl(channel: number, control: number, value: number): void;
  midiSetChannelType(channel: number, isDrum: boolean): void;
  midiAllSoundsOff(channel?: number): void;
  setInterpolation(order: number): void;
  close(): void;
};

export type SynthSequencer = {
  registerSynthesizer(synth: SynthInstance): Promise<number>;
  setTimeScale(scale: number): void;
  sendEventAt(
    event:
      | { type: 'noteon'; channel: number; key: number; vel: number }
      | { type: 'note'; channel: number; key: number; vel: number; duration: number },
    tick: number,
    isAbsolute: boolean,
  ): void;
  removeAllEvents(): void;
  close(): void;
};

export type SynthHostOptions = {
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  soundfont: ArrayBuffer;
  instanceCount: number;
};

/** Big enough that the worklet is not woken constantly, small enough not to add audible latency. */
const RENDER_BUFFER_SIZE = 8192;

/** Channels each instance addresses; the allocator's own constant, so the two cannot drift. */
const MIDI_CHANNEL_COUNT = CHANNELS_PER_INSTANCE;
/**
 * The voice ceiling, chosen once at init because fluidsynth exposes no runtime
 * setter for it.
 *
 * Its default of 256 is low for a score with hundreds of parts. Set generously
 * instead: a voice slot is a small struct, only *sounding* voices cost CPU, and
 * above the ceiling fluidsynth steals by its own overflow priority — quietest
 * and oldest first — rather than refusing the newest note.
 */
const POLYPHONY = 2048;

/**
 * Where General MIDI keeps its drum kits. Channel 9 is already there in GM
 * mode; any other channel has to be sent there explicitly.
 */
const DRUM_BANK = 128;
/** The kit channel 9 defaults to, so a switched channel matches it. */
const STANDARD_KIT = 0;
/** The one channel General MIDI reserves for drums, and the one that may never go melodic. */
const PERCUSSION_CHANNEL = 9;

export class SynthHost {
  private synths: SynthInstance[] = [];
  private sequencers: Array<SynthSequencer | null> = [];
  private sfontIds: number[] = [];
  /** `instance:channel` for every channel that is percussion — see `programSelect`. */
  private percussionChannels = new Set<string>();
  private master: GainNode | null = null;
  private masterVolume = 1;
  private trackCount = 1;
  /** Kept so instances can be added later; see `ensureInstances`. */
  private context: BaseAudioContext | null = null;
  private soundfont: ArrayBuffer | null = null;
  /** The governor's current setting, so an instance opened later starts where the others are. */
  private interpolation: number | null = null;
  /** Serialises growth, so two scores loading at once cannot both build instance 1. */
  private growing: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      /** May be async: the real factory imports `js-synthesizer` on first use. */
      createSynth: () => SynthInstance | Promise<SynthInstance>;
    },
  ) {}

  async init(context: BaseAudioContext, options: SynthHostOptions): Promise<void> {
    // Before libfluidsynth, so its emscripten module adopts a printErr that
    // drops the build-stub notices. Best-effort: if blobs are unavailable the
    // notices stay and nothing else changes.
    const quietUrl = createWorkletQuietModuleUrl();
    if (quietUrl) {
      try {
        await context.audioWorklet.addModule(quietUrl);
      } finally {
        URL.revokeObjectURL(quietUrl);
      }
    }
    // Order matters: the worklet build expects libfluidsynth already present.
    await context.audioWorklet.addModule(options.fluidsynthModuleUrl);
    await context.audioWorklet.addModule(options.workletModuleUrl);

    // Master chain, same arithmetic as the engine it replaces: a headroom trim
    // sized by how many channels sum into it, then a limiter catching the
    // phase-aligned peaks the trim cannot predict. The spike measured 64 voices
    // peaking at 1.004, so the limiter is not optional.
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_CEILING_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(context.destination);
    this.master = master;
    this.context = context;
    this.soundfont = options.soundfont;

    await this.ensureInstances(options.instanceCount);
    this.applyMasterGain();
  }

  /**
   * Opens instances until there are at least `count` of them.
   *
   * Scores outgrow sixteen channels, and which channel a track lands on is
   * decided per score — so the number of synths needed is not known at init
   * time. Growing here rather than sizing up front is what keeps the common
   * case cheap: every extra instance is another copy of the font in WASM
   * memory and seconds of loading, so one is opened only when a score genuinely
   * has more parts than one synth can address. Without this, a track allocated
   * to instance 1 reached `synths[1]`, found nothing, and played silently — no
   * error, no missing note, just a part that was not there.
   */
  ensureInstances(count: number): Promise<void> {
    this.growing = this.growing.then(() => this.grow(count));
    return this.growing;
  }

  private async grow(count: number): Promise<void> {
    const context = this.context;
    const soundfont = this.soundfont;
    // Before `init`, so there is nothing to build on yet; `init` sizes it.
    if (!context || !soundfont || !this.master) return;
    for (let i = this.synths.length; i < count; i += 1) {
      const synth = await this.deps.createSynth();
      synth.init(context.sampleRate, { midiChannelCount: MIDI_CHANNEL_COUNT, polyphony: POLYPHONY });
      synth.createAudioNode(context, RENDER_BUFFER_SIZE).connect(this.master);
      this.sfontIds[i] = await synth.loadSFont(soundfont);
      this.sequencers[i] = await this.createSequencerFor(synth);
      // The governor speaks for every instance, and it may already have spoken.
      if (this.interpolation !== null) synth.setInterpolation(this.interpolation);
      this.synths[i] = synth;
    }
  }

  private async createSequencerFor(synth: SynthInstance): Promise<SynthSequencer | null> {
    if (!synth.createSequencer) return null;
    try {
      const sequencer = await synth.createSequencer();
      await sequencer.registerSynthesizer(synth);
      sequencer.setTimeScale(1000);
      return sequencer;
    } catch {
      // Timed dispatch is an optimisation. If the worklet sequencer is not
      // available, immediate MIDI calls still play correctly.
      return null;
    }
  }

  /**
   * Marks a channel as percussion.
   *
   * Channel 9 already is one in fluidsynth's GM mode and needs no call; any
   * other channel does, which is what lets a second drum track share an
   * instance rather than costing a whole synth for its own channel 9.
   */
  setChannelPercussion(instance: number, channel: number, kit = STANDARD_KIT): void {
    this.percussionChannels.add(`${instance}:${channel}`);
    const synth = this.synths[instance];
    if (!synth) return;
    // Channel 9 is a drum channel already in GM mode; any other has to be told.
    if (channel !== 9) synth.midiSetChannelType(channel, true);
    // Switching the type is not enough on its own. It tells fluidsynth to read
    // later program changes from the drum bank, but leaves the channel on the
    // preset it already had — bank 0, program 0, a piano. A second drum track
    // therefore played its congas and cowbells as piano notes at those pitches,
    // which is exactly what it sounded like.
    //
    // Measured against a real synth: the same conga on channel 9 peaked 0.1229
    // at 0.01187 RMS, this channel with only the type switch gave 0.1115 at
    // 0.01437 — a different instrument — and with the select below it matched
    // channel 9 to the digit.
    // Standard first, then the kit the file asked for. A kit that the font does
    // not have leaves fluidsynth's selection untouched, and "untouched" on a
    // switched channel is the piano it started on — so the guaranteed kit goes
    // on first and a failed switch falls back to drums rather than to a piano.
    //
    // Measured: on channel 9 this select is bit-identical to leaving it alone
    // (peak 0.1883, rms 0.01815 either way), and preset 8 gives the Room kit
    // (0.4027) — so honouring the kit costs nothing and ignoring it was simply
    // wrong. The older rule, "never select a program on a percussion channel",
    // was too broad: it is selecting from the *melodic* bank that breaks a drum
    // channel, and that one is still refused in `programSelect`.
    synth.midiProgramSelect(channel, this.sfontIds[instance], DRUM_BANK, STANDARD_KIT);
    if (kit !== STANDARD_KIT) {
      synth.midiProgramSelect(channel, this.sfontIds[instance], DRUM_BANK, kit);
    }
  }

  /**
   * Selects a GM program — **never on channel 9**.
   *
   * The spike measured this directly: selecting a melodic program on channel 9
   * replaces fluidsynth's working default with a preset that is not at that
   * address, and the channel goes silent. Every explicit selection route gave
   * peak 0.0000; leaving it alone gave 0.3120. This guard is why drums sound.
   *
   * Any *other* channel that was made percussion is switched back rather than
   * refused. Channel assignment is per score, so the channel a second drum
   * track borrowed is handed to a pitched track by the next score that has one
   * fewer kit — and refusing here left that track playing congas under a violin
   * label, permanently, because nothing ever cleared the flag. Switching the
   * type back before the select is exactly what the offline renderer already
   * does for the same situation.
   */
  programSelect(instance: number, channel: number, program: number): void {
    if (channel === PERCUSSION_CHANNEL) return;
    if (this.percussionChannels.delete(`${instance}:${channel}`)) {
      this.synths[instance]?.midiSetChannelType(channel, false);
    }
    this.synths[instance]?.midiProgramSelect(channel, this.sfontIds[instance], 0, program);
  }

  noteOn(instance: number, channel: number, midi: number, velocity: number): void {
    this.synths[instance]?.midiNoteOn(channel, midi, velocity);
  }

  /**
   * Schedules a note and its release together, ahead of time.
   *
   * The sequencer's `note` event carries its own duration, so fluidsynth
   * releases the note on the audio thread. Note-offs used to be fired from the
   * main thread as the pump noticed them, which made every note's length track
   * main-thread lateness — and a stall that held notes long added voices,
   * loading the audio thread in turn.
   *
   * The time scale is milliseconds (`setTimeScale(1000)` in
   * `createSequencerFor`). A negative delay clamps to now rather than being
   * refused: a note whose moment passed during a stall should still sound, and
   * the sequencer still holds its release.
   */
  noteAt(
    instance: number,
    channel: number,
    midi: number,
    velocity: number,
    delaySeconds: number,
    durationSeconds: number,
  ): void {
    const sequencer = this.sequencers[instance];
    if (!sequencer) {
      // No timed dispatch here; the note sounds immediately and holds until
      // `allSoundOff`. Better than silence, and the real worklet always has one.
      this.noteOn(instance, channel, midi, velocity);
      return;
    }
    sequencer.sendEventAt(
      {
        type: 'note',
        channel,
        key: midi,
        vel: velocity,
        // Never zero: a note fluidsynth is told lasts no time at all may not
        // sound, and a rest is expressed by there being no note, not by one of
        // no length.
        duration: Math.max(1, Math.round(durationSeconds * 1000)),
      },
      Math.max(0, Math.round(delaySeconds * 1000)),
      false,
    );
  }

  noteOff(instance: number, channel: number, midi: number): void {
    this.synths[instance]?.midiNoteOff(channel, midi);
  }

  controlChange(instance: number, channel: number, control: number, value: number): void {
    this.synths[instance]?.midiControl(channel, control, value);
  }

  /** Silences everything immediately — stop, seek, and panic all go through here. */
  allSoundOff(): void {
    for (const sequencer of this.sequencers) sequencer?.removeAllEvents();
    for (const synth of this.synths) synth.midiAllSoundsOff();
  }

  /** The governor's one confirmed knob; applies to every instance at once. */
  setInterpolation(order: number): void {
    this.interpolation = order;
    for (const synth of this.synths) synth.setInterpolation(order);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    this.applyMasterGain();
  }

  /** How many channels are summing, which sizes the headroom trim. */
  setTrackCount(count: number): void {
    this.trackCount = count;
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (this.master) this.master.gain.value = this.masterVolume * headroomTrimFor(this.trackCount);
  }

  dispose(): void {
    for (const sequencer of this.sequencers) sequencer?.close();
    for (const synth of this.synths) synth.close();
    this.synths = [];
    this.sequencers = [];
    this.sfontIds = [];
    this.percussionChannels.clear();
    this.master = null;
    this.context = null;
    this.soundfont = null;
  }
}
