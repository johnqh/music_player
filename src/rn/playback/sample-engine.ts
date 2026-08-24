/**
 * React Native playback: FluidR3, played from samples.
 *
 * The web engine runs libfluidsynth (WebAssembly) inside an `AudioWorklet`.
 * React Native has neither — `react-native-audio-api` exposes no `addModule`
 * and Hermes has no WebAssembly — so that engine cannot be ported, only
 * replaced. See `spikes/rn-sample-playback.md`.
 *
 * What it is replaced with is **the same soundfont**, pre-rendered. Benjamin
 * Gleitzman's packs are per-note recordings taken from `FluidR3_GM.sf2`, the
 * font the web engine plays as `FluidR3Mono_GM.sf3`. Every one of the 128 GM
 * programs is covered, at every key from A0 to C8, so a note here is the same
 * recording the browser plays rather than an approximation of it. That
 * distinction is the whole reason this engine exists: the RN engine that was
 * deleted synthesised its own instruments from oscillators and could never
 * match the web, and a wrong sound is worse than a clear error.
 *
 * What is *not* reproduced is SF2's per-zone filtering, LFOs and modulator
 * envelopes — fluidsynth applies those live and a pre-rendered sample cannot.
 * In practice that costs some expressive variation, not the instrument's
 * identity.
 *
 * The transport half — flattening a score, the note cursor, the dispatch
 * window, the master trim — is `shared/playback/`, the same code the web
 * engine runs. This file is only the part that turns a due note into sound.
 *
 * It deliberately does *not* reuse `SoundfontPlaybackEngine`'s pump by
 * refactoring it behind a synth port. That engine is verified on real devices
 * and this one cannot be until it runs on a phone; destabilising the working
 * one to serve the unproven one is the wrong order. Once this is device-tested,
 * merging the two transports is the obvious follow-up.
 */
import type {
  MetronomeClick,
  PlaybackNote as ScheduledNote,
  PlaybackLoadState,
  PlaybackPlan,
  PlaybackTrack,
  ScoreRange,
  SoundingNote,
  TempoConversion,
  TransportPlaybackState,
} from '@sudobility/music_types';
import type {
  AuditionVoice,
  PlaybackEngine,
  PlaybackObserver,
} from '../../engine.js';
import { NoteQueue } from '../../shared/note-queue.js';
import { SoundingSet } from '../../shared/sounding-set.js';
import { planDispatch } from '../../shared/pump-window.js';
import { headroomTrimFor } from '../../shared/mix.js';
import { gmPackName, percussionPackName } from './gm-pack-name.js';
import { PackLibrary } from './pack-library.js';
import { RELEASE_SECONDS, planVoice } from './voice-plan.js';
import type { VoicePlan } from './voice-plan.js';
import { sustains } from './expression.js';
import { loadAudioApi } from './audio-api.js';
export { base64ToBytes } from './pack-library.js';
import type {
  AudioApi,
  RNAudioBuffer,
  RNAudioContext,
  RNAudioNode,
  RNGainNode,
  RNStereoPanner,
} from './audio-api.js';
import { applySustainLoop } from './sustain-loop.js';
import {
  SOUNDING_INTERVAL_MS,
  visualSoundingOffsetSeconds,
} from '../../shared/visual-sync.js';

/** How often the pump looks for notes to schedule. */
const PUMP_INTERVAL_MS = 50;
/** How far ahead of the clock notes are handed to the audio graph. */
const LOOKAHEAD_SECONDS = 0.2;
/** How late a note may be and still be played rather than skipped. */
const GRACE_SECONDS = 0.2;
const POSITION_TICK_INTERVAL_MS = 1000 / 30;
/** Metronome click pitches, accented downbeat first. */
const CLICK_HZ = { accent: 1600, normal: 1200 };
const CLICK_SECONDS = 0.03;

export type SampleEngineDeps = {
  /** Overridable so tests can drive the engine with a fake audio graph. */
  loadAudioApi?: () => Promise<AudioApi>;
  /** Fetches a pack body. Overridable for tests and for self-hosting. */
  fetchPack?: (url: string) => Promise<string>;
  /** Base URL for the melodic packs. An app may host its own copy; they are CC-BY 3.0. */
  packBase?: string;
  /**
   * Base URL for the drum-kit packs.
   *
   * No default, because there is nowhere to default *to*: no CDN publishes
   * pre-rendered GM percussion under a usable licence, so these are rendered
   * by `scripts/build-percussion-packs.mjs` and hosted by the app alongside
   * its other audio assets. An app with percussion in its scores must set this.
   */
  percussionBase?: string;
  /** Overridable so tests can step the pump by hand instead of waiting. */
  startPump?: (tick: () => void, intervalMs: number) => () => void;
};

type Voice = {
  source: { stop(when?: number): void; disconnect(): unknown };
  gain: RNGainNode;
  endsAt: number;
};

/**
 * A track's own strip: level, then position, then the master.
 *
 * One pair per track rather than per voice. Per-voice panners are what the
 * offline renderer does, because it schedules everything once and never has to
 * change its mind; live, a fader has to move under notes that are already
 * sounding, which only a node the voices share can do.
 */
type TrackStrip = { gain: RNGainNode; panner: RNStereoPanner };

function defaultFetchPack(url: string): Promise<string> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Sample pack ${url} responded ${r.status}`);
    return r.text();
  });
}

function defaultStartPump(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

export class RNSamplePlaybackEngine implements PlaybackEngine {
  private readonly deps: Required<Omit<SampleEngineDeps, 'packBase' | 'percussionBase'>> & {
    packBase?: string;
    percussionBase?: string;
  };

  private api: AudioApi | null = null;
  private ctx: RNAudioContext | null = null;
  private master: RNGainNode | null = null;

  private plan: PlaybackPlan | null = null;
  private tempo: TempoConversion | null = null;
  private readonly queue = new NoteQueue();
  private clicks: readonly MetronomeClick[] = [];
  private clickCursor = 0;

  private library: PackLibrary | null = null;

  private observer: PlaybackObserver | null = null;
  private state: TransportPlaybackState = 'stopped';
  private loadState: PlaybackLoadState = { status: 'idle' };

  private stopPump: (() => void) | null = null;
  private stopSoundingTimer: (() => void) | null = null;
  private stopPositionTimer: (() => void) | null = null;
  /** Context time corresponding to `originTick`. */
  private originContextTime = 0;
  private originTick = 0;
  private positionTick = 0;
  private tempoMultiplier = 1;
  private loop: ScoreRange | null = null;
  private masterVolume = 1;
  private metronomeOn = false;
  private headroom = 1;

  private readonly muted = new Set<string>();
  private readonly soloed = new Set<string>();
  /**
   * Volume and pan per track, held apart from `plan` because `applyMix` is
   * allowed to change them without the plan being rebuilt — that is the whole
   * reason it exists.
   */
  private readonly mix = new Map<string, { volume: number; pan: number }>();
  private readonly strips = new Map<string, TrackStrip>();
  private readonly voices: Voice[] = [];
  /** Clicks already on the graph, so pause and stop can take them back. */
  private readonly pendingClicks: Array<{ osc: { stop(when?: number): void }; endsAt: number }> = [];
  private readonly auditioned = new Map<number, Voice>();
  /**
   * What is sounding, read off the clock rather than off the voice list.
   *
   * Deriving it from the voices lit every note the moment it was *scheduled* —
   * a lookahead early — and held it lit through the release tail, so the
   * notation ran ahead of the sound and lagged behind its end. The web engine
   * has always used this; sharing it is what stops the two drifting.
   */
  private readonly sounding = new SoundingSet();
  private activeNotes: SoundingNote[] = [];

  constructor(deps: SampleEngineDeps = {}) {
    this.deps = {
      loadAudioApi: deps.loadAudioApi ?? loadAudioApi,
      fetchPack: deps.fetchPack ?? defaultFetchPack,
      startPump: deps.startPump ?? defaultStartPump,
      packBase: deps.packBase,
      percussionBase: deps.percussionBase,
    };
  }

  // ---- lifecycle ---------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.ctx) return;
    const api = await this.deps.loadAudioApi();
    const ctx = new api.AudioContext();
    const master = ctx.createGain();
    master.gain.value = this.masterVolume * this.headroom;
    master.connect(ctx.destination);
    this.api = api;
    this.ctx = ctx;
    this.master = master;
    this.library = new PackLibrary({
      fetchPack: this.deps.fetchPack,
      decodeAudioData: (bytes) => api.decodeAudioData(bytes),
      packBase: this.deps.packBase,
      percussionBase: this.deps.percussionBase,
    });
  }

  async load(plan: PlaybackPlan): Promise<void> {
    this.stopAllVoices();
    // The strips belong to the tracks of the plan being replaced; keeping them
    // would leave a departed track's fader in the graph and a returning one
    // holding the old score's level.
    this.releaseStrips();
    this.plan = plan;
    this.tempo = plan.tempo;
    this.queue.load(plan.notes);
    this.sounding.load(plan.notes, (tick) => plan.tempo.ticksToSeconds(tick));
    this.clicks = plan.clicks;
    this.clickCursor = 0;
    this.headroom = headroomTrimFor(plan.tracks.length);
    this.applyMasterGain();
    this.mix.clear();
    for (const track of plan.tracks) {
      this.mix.set(track.id, { volume: track.volume, pan: track.pan });
    }
    this.seek(0);
  }

  // ---- sample packs ------------------------------------------------------

  /** The pack name for a track, honouring the percussion/kit distinction. */
  private packNameForTrack(trackId: string): string | null {
    const track = this.plan?.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    // The kit-versus-instrument distinction is already resolved into
    // `voiceProgram`/`voiceName` by music_lib, which owns the GM tables.
    return track.isPercussion
      ? percussionPackName(track.voiceProgram)
      : gmPackName(track.voiceProgram, track.voiceName);
  }

  /** Loads every pack the score needs, reporting progress across all of them. */
  private async ensureScorePacks(): Promise<void> {
    const names = new Set<string>();
    for (const track of this.plan?.tracks ?? []) {
      const name = this.packNameForTrack(track.id);
      if (name && !this.library!.has(name)) names.add(name);
    }
    if (names.size === 0) {
      this.reportLoad({ status: 'ready' });
      return;
    }

    this.reportLoad({ status: 'loading', fraction: 0 });
    let done = 0;
    try {
      for (const name of names) {
        await this.library!.ensure(name);
        done += 1;
        this.reportLoad({ status: 'loading', fraction: done / names.size });
      }
      this.reportLoad({ status: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportLoad({ status: 'failed', message });
      throw error;
    }
  }

  private reportLoad(state: PlaybackLoadState): void {
    this.loadState = state;
    this.observer?.onLoadStateChange?.(state);
  }

  // ---- transport ---------------------------------------------------------

  /**
   * Reports `playing` only once a note can actually sound.
   *
   * The same rule the web engine follows, and for the same reason: the caret
   * dead-reckons from elapsed real time between position reports, so announcing
   * `playing` before the packs are decoded would glide it silently through
   * several bars and snap it back when the music finally started.
   */
  async play(fromTick?: number): Promise<void> {
    await this.initialize();
    if (fromTick !== undefined) this.seek(fromTick);
    await this.ensureScorePacks();
    await this.ctx!.resume();

    this.originContextTime = this.ctx!.currentTime;
    this.originTick = this.positionTick;
    this.setState('playing');
    // Pressing play while already playing must not leave the first pump
    // running: its handle would be overwritten and nothing could ever stop it.
    this.haltPump();
    this.stopPump = this.deps.startPump(() => this.pump(), PUMP_INTERVAL_MS);
    this.stopPositionTimer = this.deps.startPump(() => this.reportPosition(), POSITION_TICK_INTERVAL_MS);
    // Its own cadence, faster than the position report: the caret interpolates
    // between position ticks and does not need them often, while a key light
    // is a discrete event with nothing to interpolate it.
    this.stopSoundingTimer = this.deps.startPump(
      () => this.reportSounding(),
      SOUNDING_INTERVAL_MS
    );
    this.pump();
    this.reportPosition();
    // Immediately, not on the timer's first tick: pressing play lights the
    // downbeat now. `reportPosition` used to carry this, and separating the
    // two cadences is what took it away.
    this.reportSounding();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const tick = this.currentTick();
    this.haltPump();
    this.stopAllVoices();
    this.seek(tick);
    this.setState('paused');
  }

  stop(): void {
    this.haltPump();
    this.stopAllVoices();
    this.seek(0);
    this.setState('stopped');
  }

  seek(tick: number): void {
    this.positionTick = Math.max(0, tick);
    this.queue.seekToTick(this.positionTick);
    this.clickCursor = this.clicks.findIndex((c) => c.tick >= this.positionTick);
    if (this.clickCursor < 0) this.clickCursor = this.clicks.length;
    this.originTick = this.positionTick;
    this.originContextTime = this.ctx?.currentTime ?? 0;
    // A note spanning this moment is deliberately not restored: a seek silences
    // the voices, so colouring it would be a lie. See `sounding-set.ts`.
    this.sounding.reset(this.tempo?.ticksToSeconds(this.positionTick) ?? 0);
    this.setActiveNotes([]);
    this.observer?.onPositionTick(this.positionTick);
  }

  private haltPump(): void {
    this.stopPump?.();
    this.stopPump = null;
    this.stopPositionTimer?.();
    this.stopPositionTimer = null;
    this.stopSoundingTimer?.();
    this.stopSoundingTimer = null;
  }

  private setState(next: TransportPlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.observer?.onStateChange(next);
  }

  /** Score tick at the context's current time, from the tempo map and speed. */
  private currentTick(): number {
    if (!this.ctx || !this.tempo) return this.positionTick;
    const elapsed = (this.ctx.currentTime - this.originContextTime) * this.tempoMultiplier;
    const originSeconds = this.tempo.ticksToSeconds(this.originTick);
    return this.tempo.secondsToTicks(originSeconds + elapsed);
  }

  private secondsForTick(tick: number): number {
    if (!this.tempo || !this.ctx) return 0;
    const fromOrigin =
      (this.tempo.ticksToSeconds(tick) - this.tempo.ticksToSeconds(this.originTick)) /
      this.tempoMultiplier;
    return this.originContextTime + fromOrigin;
  }

  private reportPosition(): void {
    this.positionTick = this.currentTick();
    this.observer?.onPositionTick(this.positionTick);
  }

  /**
   * The lit set, at the position the listener is actually hearing, and only
   * when it has changed.
   *
   * Reads the clock itself rather than trusting `positionTick`: it runs on its
   * own timer now, so the field would be up to a position-tick stale — which
   * is exactly the lag this exists to remove.
   */
  private reportSounding(): void {
    if (!this.tempo) return;
    const at =
      this.tempo.ticksToSeconds(this.currentTick()) +
      visualSoundingOffsetSeconds(this.ctx?.outputLatency);
    const notes = this.sounding.advanceTo(at);
    if (notes) this.setActiveNotes(notes);
  }

  // ---- the pump ----------------------------------------------------------

  private pump(): void {
    if (!this.ctx || this.state !== 'playing') return;
    const now = this.ctx.currentTime;
    this.reapVoices(now);

    const horizonTick = this.tickAtContextTime(now + LOOKAHEAD_SECONDS);

    if (this.loop && horizonTick >= this.loop.endTick) {
      // The end tick itself belongs to the next pass, where it is the loop's
      // own first beat — dispatching it here plays it twice at the same moment.
      this.drainThrough(this.loop.endTick - 1, now);
      // Read *before* the seek. `seek` re-anchors the origin on the current
      // moment, so asking afterwards answers "when would the end come round if
      // the loop started this instant" — a whole loop late — and the engine
      // then played nothing at all until real time caught up with its answer.
      const wrapsAt = this.secondsForTick(this.loop.endTick);
      this.seek(this.loop.startTick);
      this.originContextTime = wrapsAt;
      this.originTick = this.loop.startTick;
      return;
    }

    this.drainThrough(horizonTick, now);

    if (this.queue.exhausted && this.voices.length === 0 && !this.loop) {
      this.stop();
    }
  }

  private drainThrough(horizonTick: number, now: number): void {
    const drained = this.queue.drainUntil(horizonTick);
    const { due } = planDispatch({
      notes: drained,
      secondsForTick: (tick) => this.secondsForTick(tick),
      positionSeconds: now,
      graceSeconds: GRACE_SECONDS,
    });
    for (const { note, atSeconds } of due) {
      if (this.audibleTrack(note.trackId)) this.startNote(note, atSeconds);
    }
    if (this.metronomeOn) this.scheduleClicks(horizonTick);
  }

  private tickAtContextTime(contextTime: number): number {
    if (!this.tempo) return this.positionTick;
    const elapsed = (contextTime - this.originContextTime) * this.tempoMultiplier;
    return this.tempo.secondsToTicks(this.tempo.ticksToSeconds(this.originTick) + elapsed);
  }

  /** Mute/solo, with solo winning: any solo means everything unsoloed is silent. */
  private audibleTrack(trackId: string): boolean {
    if (this.soloed.size > 0) return this.soloed.has(trackId);
    return !this.muted.has(trackId);
  }

  private startNote(note: ScheduledNote, atSeconds: number): void {
    const packName = this.packNameForTrack(note.trackId);
    if (!packName) return;
    const track = this.plan?.tracks.find((t) => t.id === note.trackId);
    const voicing = this.library?.voice(packName, note.midi, Boolean(track?.isPercussion));
    if (!voicing) return;
    const { choice, buffer } = voicing;

    const durationSeconds =
      this.secondsForTick(note.tick + note.durTicks) - this.secondsForTick(note.tick);
    const program = track?.midiProgram;
    const plan = planVoice({
      atSeconds,
      durationSeconds,
      velocity: note.velocity,
      // Unity here: the track's level lives on its strip, where a fader can
      // still move it after the note has started, and the headroom lives on the
      // master — the same division the web engine and the offline renderer use.
      trackGain: 1,
      choice,
      // Percussion has no melodic expression: a kit's programs address kits,
      // and a drum is a one-shot whose decay is already in the recording.
      program: track?.isPercussion ? undefined : program,
    });

    const voice = this.buildVoiceFromPlan(
      buffer,
      plan,
      program !== undefined && sustains(program),
      this.stripFor(note.trackId),
    );
    this.voices.push(voice);
  }

  /**
   * The track's gain-and-pan pair, built on first use.
   *
   * Lazily, because a plan can be loaded before there is an audio context to
   * build nodes in — `load` does not await `initialize`.
   */
  private stripFor(trackId: string): RNAudioNode {
    const existing = this.strips.get(trackId);
    if (existing) return existing.gain;
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    gain.connect(panner);
    panner.connect(this.master!);
    const strip: TrackStrip = { gain, panner };
    this.strips.set(trackId, strip);
    this.applyStrip(trackId, strip);
    return gain;
  }

  /** Volume, pan, mute and solo, resolved onto one track's strip. */
  private applyStrip(trackId: string, strip: TrackStrip): void {
    const level = this.mix.get(trackId);
    strip.gain.gain.value = this.audibleTrack(trackId) ? (level?.volume ?? 1) : 0;
    strip.panner.pan.value = Math.max(-1, Math.min(1, level?.pan ?? 0));
  }

  /** Pushes the whole mix, for a fader move or a mute that must land at once. */
  private applyAllStrips(): void {
    for (const [trackId, strip] of this.strips) this.applyStrip(trackId, strip);
  }

  private releaseStrips(): void {
    for (const strip of this.strips.values()) {
      strip.gain.disconnect();
      strip.panner.disconnect();
    }
    this.strips.clear();
  }

  private applyMasterGain(): void {
    if (this.master) this.master.gain.value = this.masterVolume * this.headroom;
  }

  /**
   * One voice: source -> [low-pass] -> gain -> master.
   *
   * The filter is only built when this velocity actually calls for one (71 of
   * the 128 instruments never do), because a node per voice is real cost in a
   * dense passage.
   */
  private buildVoiceFromPlan(
    buffer: RNAudioBuffer,
    plan: VoicePlan,
    mayLoop: boolean,
    destination: RNAudioNode = this.master!,
  ): Voice {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // `detune` rather than `playbackRate`: it is already in cents, so no
    // exponential conversion here to get subtly wrong. Packs cover every key,
    // so this is normally 0 and only matters for a pack with gaps.
    if (plan.detuneCents !== 0) source.detune.value = plan.detuneCents;
    if (mayLoop) applySustainLoop(source, buffer, plan.releaseAt - plan.startAt, plan.sampleMidi);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(plan.gain, plan.startAt);
    // Hold flat, then release. Linear rather than exponential: exponential
    // ramps cannot reach zero, and the residual is what clicks.
    amp.gain.setValueAtTime(plan.gain, plan.releaseAt);
    amp.gain.linearRampToValueAtTime(0, plan.endAt);

    if (plan.cutoffHz === null) {
      source.connect(amp);
    } else {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = plan.cutoffHz;
      source.connect(filter);
      filter.connect(amp);
    }
    amp.connect(destination);
    source.start(plan.startAt);
    source.stop(plan.endAt);

    return { source, gain: amp, endsAt: plan.endAt };
  }

  /** The flat-envelope form, for the metronome and for auditioning a key. */
  private buildVoice(
    buffer: RNAudioBuffer,
    detuneCents: number,
    gain: number,
    startAt: number,
    releaseAt: number,
  ): Voice {
    return this.buildVoiceFromPlan(
      buffer,
      {
        startAt,
        releaseAt,
        endAt: releaseAt + RELEASE_SECONDS,
        gain,
        cutoffHz: null,
        uri: '',
        detuneCents,
        sampleMidi: 0,
      },
      false,
    );
  }

  /**
   * Drops voices whose release has finished.
   *
   * Nothing about the *lit* set any more — that comes off the clock. A voice
   * outlives its written note by the instrument's release, which is exactly
   * the discrepancy that made deriving the lit set from here wrong.
   */
  private reapVoices(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i -= 1) {
      if (this.voices[i]!.endsAt <= now) {
        this.voices[i]!.gain.disconnect();
        this.voices.splice(i, 1);
      }
    }
  }

  private setActiveNotes(notes: SoundingNote[]): void {
    const same =
      notes.length === this.activeNotes.length &&
      notes.every((n, i) => n.noteId === this.activeNotes[i].noteId);
    if (same) return;
    this.activeNotes = notes;
    this.observer?.onActiveNotes(notes);
  }

  private stopAllVoices(): void {
    for (const voice of this.voices) {
      try {
        voice.source.stop();
      } catch {
        // Already stopped; nothing to undo.
      }
      voice.gain.disconnect();
    }
    this.voices.length = 0;
    this.setActiveNotes([]);
    this.cancelPendingClicks();
  }

  /**
   * Takes back clicks already placed on the graph.
   *
   * An oscillator started with `start(at)` sounds at that moment whatever the
   * transport does next, and a click goes nowhere near a voice — so without
   * this, pausing kept ticking for the length of the lookahead.
   */
  private cancelPendingClicks(): void {
    if (this.pendingClicks.length === 0) return;
    const now = this.ctx?.currentTime ?? 0;
    for (const { osc } of this.pendingClicks) {
      try {
        osc.stop(now);
      } catch {
        // Already finished; nothing to take back.
      }
    }
    this.pendingClicks.length = 0;
  }

  // ---- metronome ---------------------------------------------------------

  private scheduleClicks(horizonTick: number): void {
    // Forget the ones that have sounded: only what is still ahead of the clock
    // can be taken back, and a piece is minutes of beats.
    const cutoff = this.ctx!.currentTime;
    for (let i = this.pendingClicks.length - 1; i >= 0; i -= 1) {
      if (this.pendingClicks[i]!.endsAt <= cutoff) this.pendingClicks.splice(i, 1);
    }
    while (this.clickCursor < this.clicks.length && this.clicks[this.clickCursor]!.tick <= horizonTick) {
      const click = this.clicks[this.clickCursor]!;
      this.clickCursor += 1;
      const at = this.secondsForTick(click.tick);
      if (at < this.ctx!.currentTime) continue;
      this.scheduleClick(at, click.accent);
    }
  }

  /**
   * A short sine blip. Synthesised rather than sampled because the packs are
   * instruments and carry no click, and a metronome is one of the few sounds
   * where a plain tone is what is wanted anyway.
   */
  private scheduleClick(at: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = accent ? CLICK_HZ.accent : CLICK_HZ.normal;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(accent ? 0.5 : 0.3, at);
    amp.gain.linearRampToValueAtTime(0, at + CLICK_SECONDS);
    osc.connect(amp);
    // Straight to the output, past the master — the same routing the web click
    // takes, for the same reason. A click is a monitoring aid rather than part
    // of the music, so the headroom trim has no business making it quieter on a
    // score with more parts. Before the trim moved onto the master this reached
    // the same place by accident.
    amp.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + CLICK_SECONDS);
    this.pendingClicks.push({ osc, endsAt: at + CLICK_SECONDS });
  }

  // ---- settings ----------------------------------------------------------

  setTempoMultiplier(multiplier: number): void {
    // Re-anchor first, or the elapsed time already played would be reinterpreted
    // at the new speed and the position would jump.
    if (this.ctx) {
      this.originTick = this.currentTick();
      this.originContextTime = this.ctx.currentTime;
    }
    this.tempoMultiplier = multiplier;
  }

  setLoop(range: ScoreRange | null): void {
    this.loop = range;
  }

  setTrackMute(trackId: string, muted: boolean): void {
    if (muted) this.muted.add(trackId);
    else this.muted.delete(trackId);
    // Every strip, not just this one. Mute is local and solo is global, and
    // pushing the whole mix either way means the audibility rule lives in
    // `applyStrip` alone rather than being restated per setter.
    this.applyAllStrips();
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    if (solo) this.soloed.add(trackId);
    else this.soloed.delete(trackId);
    this.applyAllStrips();
  }

  /**
   * Re-reads the mix off the tracks it is handed, scheduling nothing.
   *
   * All four properties, as the interface promises. Volume and pan used to be
   * missing here — the engine had no per-track node to put them on, so a fader
   * moved during playback moved the fader and not the sound, exactly the bug
   * `applyMix` exists to fix on the web side. They land on the track's strip,
   * so they reach notes that are already sounding.
   *
   * A track the engine does not know is still recorded: `load` builds its strip
   * later, reading the level from here.
   */
  applyMix(tracks: readonly PlaybackTrack[]): void {
    this.muted.clear();
    this.soloed.clear();
    for (const track of tracks) {
      if (track.muted) this.muted.add(track.id);
      if (track.solo) this.soloed.add(track.id);
      this.mix.set(track.id, { volume: track.volume, pan: track.pan });
    }
    this.applyAllStrips();
  }

  setMetronome(enabled: boolean): void {
    this.metronomeOn = enabled;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.min(1, Math.max(0, volume));
    this.applyMasterGain();
  }

  // ---- audition ----------------------------------------------------------

  /**
   * Sounds a pitch now and holds it, touching no transport state — no seek, no
   * state change, no active-note report. Fire-and-forget: the caller is a
   * keypress handler and cannot await a pack download.
   */
  noteOn(midi: number, auditionVoice: AuditionVoice): void {
    void this.auditionNote(midi, auditionVoice);
  }

  private async auditionNote(midi: number, auditionVoice: AuditionVoice): Promise<void> {
    await this.initialize();
    // Already resolved by the caller: a percussion `program` addresses a kit,
    // and only music_lib's GM tables know which kit an address falls in.
    const name = auditionVoice.isPercussion
      ? percussionPackName(auditionVoice.program)
      : gmPackName(auditionVoice.program, auditionVoice.name);
    await this.library!.ensure(name);

    const voicing = this.library!.voice(name, midi, auditionVoice.isPercussion);
    if (!voicing) return;
    const { choice, buffer } = voicing;

    this.auditioned.get(midi)?.source.stop();
    const now = this.ctx!.currentTime;
    // Held until noteOff: released far enough out that an ordinary key press
    // ends it first, and bounded so a lost noteOff cannot ring forever.
    // Unity, not `masterVolume`: this connects to the master, which already
    // carries it. Passing it here again played every audition at the square of
    // the fader — a quarter of the level at half volume.
    const voice = this.buildVoice(buffer, choice.detuneCents, 1, now, now + 30);
    this.auditioned.set(midi, voice);
  }

  noteOff(midi: number): void {
    const voice = this.auditioned.get(midi);
    if (!voice) return;
    this.auditioned.delete(midi);
    const now = this.ctx?.currentTime ?? 0;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
    try {
      voice.source.stop(now + RELEASE_SECONDS);
    } catch {
      // Already stopped.
    }
  }

  // ---- observer / teardown -----------------------------------------------

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
    observer?.onLoadStateChange?.(this.loadState);
  }

  dispose(): void {
    this.haltPump();
    this.stopAllVoices();
    this.releaseStrips();
    for (const voice of this.auditioned.values()) voice.gain.disconnect();
    this.auditioned.clear();
    this.master?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.api = null;
  }
}
