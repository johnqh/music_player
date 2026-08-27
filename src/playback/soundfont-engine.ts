/**
 * `PlaybackEngine` over a worklet-hosted soundfont synth.
 *
 * The shape is: a note queue with a cursor, a clock we own, and a pump that
 * keeps a multi-second horizon of timed notes topped up in the worklet's
 * sequencer. Timing therefore lives on the audio thread, and the pump's only
 * job — refilling a buffer — is one that tolerates being late. Voice
 * allocation and stealing belong to fluidsynth, which is the point: every
 * note-loss bug in the engine this replaces came from our own voice management
 * refusing a note.
 *
 * Everything time-related is injected (`now`, `startPump`, `createContext`,
 * `loadFont`) so the transport can be tested without an audio device or real
 * time. The alternative is an engine verifiable only by ear, which is how the
 * last one accumulated four silent-failure bugs.
 */
import type {
  MetronomeClick,
  PlaybackLoadState,
  PlaybackPlan,
  PlaybackTrack,
  ScoreRange,
  TempoConversion,
} from '@sudobility/music_types';
import type {
  AuditionVoice,
  PlaybackEngine,
  PlaybackObserver,
} from '../engine.js';
import {
  allocateChannels,
  CHANNELS_PER_INSTANCE,
} from './channel-allocator.js';
import type { ChannelAssignment } from './channel-allocator.js';
import { PlaybackClock } from './clock.js';
import { NoteQueue } from '../shared/note-queue.js';
import { SoundingSet } from '../shared/sounding-set.js';
import {
  SOUNDING_INTERVAL_MS,
  visualSoundingOffsetSeconds,
} from '../shared/visual-sync.js';
import { Governor } from './governor.js';
import type { ScheduledClick, SynthBackend } from './synth-backend.js';
import { CC_PAN, CC_VOLUME } from '@sudobility/music_types';

export type SoundfontEngineDeps = {
  /** Everything that makes sound: the synths, the clock, the font, the click. */
  backend: SynthBackend;
  /** Defaults to the backend's own clock, which is what the audio is rendered against. */
  now?: () => number;
  /** Starts the pump and returns a function that stops it. */
  startPump?: (tick: () => void, intervalMs: number) => () => void;
};

/** How often the pump runs. */
const PUMP_INTERVAL_MS = 50;

/* The lit keys' cadence and the two delays it corrects for live in
   `shared/visual-sync.ts`, so this engine and the React Native one cannot
   drift apart on arithmetic that is invisible when it is wrong. */
/**
 * How far ahead the sequencer is kept filled.
 *
 * Deep enough that a main-thread stall of any plausible length lands entirely
 * inside already-queued audio. This used to be a 200ms window plus a 200ms
 * grace, past which a note was skipped outright — so a stall over ~400ms
 * silently dropped every note inside it. A 200-track notation redraw measures
 * 119ms, which made three unlucky frames enough.
 *
 * Timing is the worklet's job now. The pump only keeps the buffer full, which
 * is a job that tolerates being late.
 */
const HORIZON_SECONDS = 4;
/**
 * The most notes handed to the sequencer in one tick.
 *
 * Each is a `postMessage` to the worklet, so without this a dense score's first
 * tick would post thousands at once. Whatever is left waits 50ms, which is
 * nothing against a four-second horizon.
 */
const MAX_EVENTS_PER_REFILL = 512;
const POSITION_TICK_INTERVAL_MS = 1000 / 30;
const MAX_CC = 127;
// `CHANNELS_PER_INSTANCE` is imported from the allocator rather than restated
// here. A second copy of it went stale the moment the allocator moved to 256:
// `pickAuditionChannel` searched only channels 15..0, found every one of them
// taken on a sixteen-track score, and handed auditions a channel a track owned.
/** General MIDI's drum channel, which an audition must not borrow. */
const GM_PERCUSSION_CHANNEL = 9;
/** A pump failing every tick must not also flood the console twenty times a second. */
const MAX_REPORTED_TICK_FAILURES = 3;

/** Percent granularity: finer changes are not worth a store update. */
function roughly(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 100);
}

type TrackState = {
  assignment: ChannelAssignment;
  volume: number;
  muted: boolean;
  solo: boolean;
};

export class SoundfontPlaybackEngine implements PlaybackEngine {
  private readonly queue = new NoteQueue();
  private readonly governor: Governor;
  /** When the pump was last expected to run, for measuring how late it is. */
  private nextPumpDueAt: number | null = null;
  private readonly clock: PlaybackClock;
  private readonly deps: Required<Pick<SoundfontEngineDeps, 'startPump'>> &
    SoundfontEngineDeps;

  private plan: PlaybackPlan | null = null;
  /** Replaced on every `load`. The default is 120 BPM at ppq 480, as before. */
  private tempo: TempoConversion = {
    ticksToSeconds: tick => tick / 960,
    secondsToTicks: seconds => seconds * 960,
  };
  private tracks = new Map<string, TrackState>();
  private observer: PlaybackObserver | null = null;
  private stopPump: (() => void) | null = null;
  private stopSoundingTicker: (() => void) | null = null;
  private readonly sounding = new SoundingSet();
  /**
   * When the last note of the loaded score finishes.
   *
   * The transport used to know the piece was over by the note queue being
   * exhausted *and* no note-offs being outstanding. Releases now happen in the
   * worklet, so there is nothing outstanding to count — this is what stops
   * playback ending on the last note's attack instead of its release.
   */
  private lastNoteEndSeconds = 0;
  private loopRange: ScoreRange | null = null;
  private lastReportedAt = 0;
  private initialized = false;
  /** In-flight bring-up, so concurrent callers share one attempt. */
  private initializing: Promise<void> | null = null;
  private loadState: PlaybackLoadState = { status: 'idle' };
  /** Counted so a pump that fails every tick reports once, not sixty times a second. */
  private tickFailures = 0;
  /**
   * Where playback should begin once the pump actually runs.
   *
   * The clock is *not* started by `play()`. Starting it there loses the opening
   * of the piece: the first pump tick can be seconds late while the main thread
   * finishes worklet and soundfont setup, and by then the clock says the music
   * is already seconds in — so every note before that point is past its grace
   * window and gets skipped. Measured at 2.3s of lost opening on a real load.
   * Anchoring on the first tick instead means the piece starts where it should,
   * however busy the thread was.
   */
  private startAtSeconds: number | null = null;
  private metronomeEnabled = false;
  /** Click positions in ticks, with a cursor, mirroring how notes are drained. */
  private clicks: readonly MetronomeClick[] = [];
  private clickCursor = 0;
  /**
   * Clicks already placed on the audio graph, so the transport can take them
   * back.
   *
   * They are scheduled a whole horizon ahead and do not go through the synth,
   * so `allSoundOff` says nothing to them: pausing used to leave the room
   * ticking for four seconds after the music stopped.
   */
  private pendingClicks: ScheduledClick[] = [];
  /** Audition voices are held on their own channel so they never disturb a track. */
  private auditionHeld = new Map<number, ChannelAssignment>();
  /** How many synths the current score's channel assignment needs. */
  private instanceCount = 1;
  private tempoMultiplier = 1;
  /**
   * The channel auditions borrow — recomputed per score so it is one no track owns.
   *
   * It used to be channel 15 flat. That channel belongs to a track on any score
   * with fifteen pitched parts, so tapping a key selected the audition's program
   * on it and left that part playing the wrong instrument until the next edit
   * reloaded the score.
   */
  private auditionChannel: ChannelAssignment = {
    instance: 0,
    channel: 15,
    needsDrumTypeSwitch: false,
  };

  constructor(deps: SoundfontEngineDeps) {
    this.deps = {
      ...deps,
      startPump:
        deps.startPump ??
        ((tick, ms) => {
          const id = setInterval(tick, ms);
          return () => clearInterval(id);
        }),
    };
    this.clock = new PlaybackClock(() => this.now());
    // The governor's only knob is interpolation order; see governor.ts for why
    // polyphony is not a second rung.
    this.governor = new Governor({
      onChange: order => this.deps.backend.setInterpolation(order),
    });
  }

  private now(): number {
    if (this.deps.now) return this.deps.now();
    return this.deps.backend.now();
  }

  private secondsForTick(tick: number): number {
    return this.tempo.ticksToSeconds(tick);
  }

  /**
   * Brings up the audio context and the synth, once.
   *
   * Resuming comes first, and the guard after it is the whole point. A browser
   * starts an `AudioContext` **suspended** unless it was created during a user
   * gesture, and a suspended context never runs its `AudioWorklet`. The synth's
   * font load round-trips through that worklet, so attempting it on a suspended
   * context does not fail — it simply never returns. That is what happened:
   * `load` ran at load time, long before any click, and left a
   * promise pending for good. Every later `play()` awaited the same promise,
   * so the transport sat at "stopped" with nothing in the console to explain it.
   *
   * So when the context cannot be got running, this does the cheap part and
   * returns. `play()` and `noteOn()` are user gestures and will get it running.
   */
  async initialize(): Promise<void> {
    this.initializing ??= this.bringUp().finally(() => {
      // Cleared either way: a failed or deferred attempt must be retryable from
      // the next gesture rather than cached as the answer forever.
      this.initializing = null;
    });
    return this.initializing;
  }

  private async bringUp(): Promise<void> {
    if (this.initialized) return;
    try {
      const result = await this.deps.backend.prepare({
        instanceCount: this.instanceCount,
        onProgress: state => this.reportLoad(state),
      });
      // Not a failure: the backend could not come up yet and said so, which on
      // the web means a context still waiting for a user gesture. `play()` and
      // `noteOn()` are gestures and will get it running.
      if (result === 'deferred') return;
      this.initialized = true;
      // The score may have arrived while the backend was still deferred; it
      // has not been told about it yet.
      if (this.plan) this.applyPlanToHost(this.plan.tracks);
      this.reportLoad({ status: 'ready' });
    } catch (error) {
      // Reported rather than swallowed: a font that will not load is the
      // difference between silence-with-a-reason and silence.
      this.reportLoad({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Only on change, so a progress stream does not become a store-update stream. */
  private reportLoad(state: PlaybackLoadState): void {
    if (
      state.status === this.loadState.status &&
      (state.status !== 'loading' ||
        this.loadState.status !== 'loading' ||
        roughly(state.fraction) === roughly(this.loadState.fraction))
    ) {
      return;
    }
    this.loadState = state;
    this.observer?.onLoadStateChange?.(state);
  }

  async load(plan: PlaybackPlan): Promise<void> {
    this.plan = plan;
    this.tempo = plan.tempo;
    const notes = plan.notes;
    this.queue.load(notes);
    this.lastNoteEndSeconds = notes.reduce(
      (end, n) => Math.max(end, this.secondsForTick(n.tick + n.durTicks)),
      0
    );
    this.sounding.load(notes, tick => this.secondsForTick(tick));
    this.clicks = plan.clicks;
    this.clickCursor = 0;
    this.seek(0);

    const { assignments, instanceCount } = allocateChannels(
      plan.tracks.map(t => ({ id: t.id, isPercussion: t.isPercussion }))
    );
    this.instanceCount = instanceCount;

    this.tracks = new Map();
    for (const track of plan.tracks) {
      const assignment = assignments.get(track.id);
      if (!assignment) continue;
      this.tracks.set(track.id, {
        assignment,
        volume: track.volume,
        muted: track.muted,
        solo: track.solo,
      });
    }
    this.auditionChannel = this.pickAuditionChannel();

    // Only once there is a synth to tell. Before the fix above this ran inline,
    // which is what dragged the whole synth bring-up into score loading.
    if (this.initialized) {
      // A score can grow past what the open synths can address, and the tracks
      // beyond them are silent until this resolves.
      await this.deps.backend.ensureInstances(this.instanceCount);
      this.applyPlanToHost(plan.tracks);
    } else void this.initialize();
  }

  /**
   * A channel no track owns, searched from the top down because tracks fill
   * from the bottom.
   *
   * Channel 9 is skipped: it is General MIDI's drum channel, so borrowing it
   * would make every audition a drum hit. Percussion auditions get their drum
   * type switched on instead, which is the same route a second drum track takes.
   *
   * Where a score owns every channel of every open instance there is nothing to
   * borrow, and it falls back to sharing the last one — an audition that
   * disturbs one track's program beats a keyboard that makes no sound.
   */
  private pickAuditionChannel(): ChannelAssignment {
    const owned = new Set(
      [...this.tracks.values()].map(
        t => `${t.assignment.instance}:${t.assignment.channel}`
      )
    );
    for (let instance = 0; instance < this.instanceCount; instance += 1) {
      for (
        let channel = CHANNELS_PER_INSTANCE - 1;
        channel >= 0;
        channel -= 1
      ) {
        if (channel === GM_PERCUSSION_CHANNEL) continue;
        if (!owned.has(`${instance}:${channel}`)) {
          return { instance, channel, needsDrumTypeSwitch: false };
        }
      }
    }
    return {
      instance: 0,
      channel: CHANNELS_PER_INSTANCE - 1,
      needsDrumTypeSwitch: false,
    };
  }

  /** Tells the host each track's program, percussion flag, pan and level. */
  private applyPlanToHost(tracks: readonly PlaybackTrack[]): void {
    for (const track of tracks) {
      const assignment = this.tracks.get(track.id)?.assignment;
      if (!assignment) continue;

      if (assignment.needsDrumTypeSwitch || track.isPercussion) {
        // General MIDI selects the drum kit with a program change on the drum
        // channel, so the track's program is its kit — Room, TR-808, Jazz.
        this.deps.backend.setChannelPercussion(
          assignment.instance,
          assignment.channel,
          track.midiProgram
        );
      } else {
        // A soundfont needs only the GM program number. The program-versus-name
        // rule the old engine used existed to choose among hand-built synth
        // voices and has no meaning here.
        this.deps.backend.programSelect(
          assignment.instance,
          assignment.channel,
          track.midiProgram
        );
      }
      this.deps.backend.controlChange(
        assignment.instance,
        assignment.channel,
        CC_PAN,
        panToCc(track.pan)
      );
    }
    this.deps.backend.setTrackCount(tracks.length);
    this.applyTrackLevels();
  }

  /** Volume, mute and solo all resolve to one CC7 value per channel. */
  private applyTrackLevels(): void {
    const anySolo = [...this.tracks.values()].some(t => t.solo);
    for (const state of this.tracks.values()) {
      const audible = anySolo ? state.solo : !state.muted;
      const value = audible ? Math.round(state.volume * MAX_CC) : 0;
      this.deps.backend.controlChange(
        state.assignment.instance,
        state.assignment.channel,
        CC_VOLUME,
        value
      );
    }
  }

  /**
   * Starts the transport — reporting "playing" only once it is true.
   *
   * The first press of Play has to load a 23MB soundfont and hand it to
   * fluidsynth, which takes seconds. This used to report "playing" up front so
   * the button would not look dead through that wait, on the reasoning that it
   * cost nothing in accuracy: the clock does not start until the pump's first
   * tick, so no part of the piece is skipped however long the load takes.
   *
   * It cost something in accuracy elsewhere. The **caret** does not follow the
   * engine's position while playing — it interpolates, dead-reckoning from the
   * last 30Hz report with elapsed real time, because those reports arrive in
   * clumps. During the load there are no reports at all, so the caret projected
   * forward from a standing start and glided silently through several bars,
   * then snapped back when the music finally began at the beginning. Two
   * separately-sound optimisations that could not both be right.
   *
   * So the transport now says what is true, and `PlaybackLoadState` — which the
   * bar renders as "Preparing instruments 45%" — says why the wait is happening.
   * That indicator did not exist when the early report was written; it is what
   * makes honesty affordable here.
   *
   * Only a cold engine waits. Once the synth is up this reports synchronously,
   * which is every press after the first.
   */
  async play(fromTick?: number): Promise<void> {
    if (!this.plan) return;
    if (fromTick !== undefined) this.seek(fromTick);
    this.startAtSeconds = this.clock.positionSeconds;
    this.nextPumpDueAt = null;

    const ready = this.initialized;
    if (ready) this.observer?.onStateChange('playing');

    await this.initialize();
    // Pausing or stopping during the load clears this, and is the user
    // changing their mind: do not start playing underneath them.
    if (!this.initialized || this.startAtSeconds === null) return;
    if (!ready) this.observer?.onStateChange('playing');
    this.startPump();
  }

  pause(): void {
    this.startAtSeconds = null;
    this.clock.pause();
    this.endPump();
    this.seek(this.tickForSeconds(this.clock.positionSeconds));
    this.observer?.onStateChange('paused');
  }

  stop(): void {
    this.startAtSeconds = null;
    this.clock.stop();
    this.endPump();
    this.deps.backend.allSoundOff();
    this.cancelPendingClicks();
    this.clearSounding(0);
    this.queue.seekToTick(0);
    this.clickCursor = 0;
    this.observer?.onPositionTick(0);
    this.observer?.onStateChange('stopped');
  }

  seek(tick: number): void {
    const seconds = this.secondsForTick(tick);
    this.clock.seek(seconds);
    this.queue.seekToTick(tick);
    this.clickCursor = this.clicks.findIndex(c => c.tick >= tick);
    if (this.clickCursor < 0) this.clickCursor = this.clicks.length;
    this.deps.backend.allSoundOff();
    this.cancelPendingClicks();
    this.clearSounding(seconds);

    // Report where we landed. Nothing else writes the store's position —
    // `PlaybackController.seek` only forwards here — so a seek made while
    // stopped (which is what clicking the sheet is) left the caret at
    // whatever tick it was already showing.
    //
    // Clearing the throttle baseline first is not tidiness: `report` gates on
    // the distance from the last reported position, so after a backward seek
    // that distance is negative and every report is suppressed until playback
    // climbs back past the old position. Jumping from bar 60 to bar 1 froze
    // the caret for the whole of those 59 bars.
    this.lastReportedAt = Number.NEGATIVE_INFINITY;
    this.report(seconds);
  }

  /**
   * Changes playback speed, rebuilding what is already queued.
   *
   * Every note in the sequencer carries a delay worked out at the speed that
   * was in force when it was posted, and the horizon is four seconds deep — so
   * on its own a speed change moved the caret at once and left the music at the
   * old tempo for a whole horizon, then jumped. Re-seeking where we stand drops
   * that backlog, and the next tick refills it at the new speed. The gap is one
   * pump interval.
   */
  setTempoMultiplier(multiplier: number): void {
    if (multiplier === this.tempoMultiplier) return;
    this.tempoMultiplier = multiplier;
    // Banks the position first, so the seek below reads where we actually are
    // rather than a position rescaled retroactively.
    this.clock.setRate(multiplier);
    if (this.stopPump)
      this.seek(this.tickForSeconds(this.clock.positionSeconds));
  }

  setLoop(range: ScoreRange | null): void {
    this.loopRange = range;
  }

  setTrackMute(trackId: string, muted: boolean): void {
    const state = this.tracks.get(trackId);
    if (!state) return;
    state.muted = muted;
    this.applyTrackLevels();
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const state = this.tracks.get(trackId);
    if (!state) return;
    state.solo = solo;
    this.applyTrackLevels();
  }

  /**
   * Re-reads the mix off `score` and pushes it, scheduling nothing.
   *
   * `setTrackMute`/`setTrackSolo` covered two of the four mix properties.
   * Volume was read once, in `load`, and pan only in `applyPlanToHost` —
   * so with the playback edit lock in place, where a mix change deliberately
   * does *not* reload, moving a fader mid-playback moved the fader and left the
   * sound where it was.
   *
   * A track the engine does not know is skipped rather than throwing: a mix
   * change cannot add a track (that would be content), so an unknown id means
   * the engine is holding an older plan and the next `load` settles it.
   */
  applyMix(tracks: readonly PlaybackTrack[]): void {
    for (const track of tracks) {
      const state = this.tracks.get(track.id);
      if (!state) continue;
      state.volume = track.volume;
      state.muted = track.muted;
      state.solo = track.solo;
      this.deps.backend.controlChange(
        state.assignment.instance,
        state.assignment.channel,
        CC_PAN,
        panToCc(track.pan)
      );
    }
    this.applyTrackLevels();
  }

  setMetronome(enabled: boolean): void {
    this.metronomeEnabled = enabled;
    // Switching it off has to reach the horizon that is already queued, or the
    // click carries on for four seconds after the user silenced it.
    if (!enabled) this.cancelPendingClicks();
  }

  setMasterVolume(volume: number): void {
    this.deps.backend.setMasterVolume(volume);
  }

  noteOn(midi: number, voice: AuditionVoice): void {
    // Tapping a key is a user gesture, so it is also a chance to get the synth
    // up — otherwise the keyboard stays silent until the first press of Play.
    // The tap that starts the load does not sound; there is nothing to sound on
    // yet, and the alternative is a keyboard that does nothing at all.
    if (!this.initialized) void this.initialize();

    // Auditioning must not disturb the transport, so it borrows a channel no
    // track owns rather than routing through a track's.
    const assignment = this.auditionChannel;
    if (voice.isPercussion) {
      // `voice.program` is the kit, resolved by the caller, so this sounds the
      // kit the track actually plays rather than whatever Standard it had.
      this.deps.backend.setChannelPercussion(
        assignment.instance,
        assignment.channel,
        voice.program
      );
    } else {
      // Switches the channel back off drums first, if the last audition was one.
      this.deps.backend.programSelect(
        assignment.instance,
        assignment.channel,
        voice.program
      );
    }
    this.deps.backend.noteOn(
      assignment.instance,
      assignment.channel,
      midi,
      100
    );
    this.auditionHeld.set(midi, assignment);
  }

  noteOff(midi: number): void {
    const assignment = this.auditionHeld.get(midi);
    if (!assignment) return;
    this.auditionHeld.delete(midi);
    this.deps.backend.noteOff(assignment.instance, assignment.channel, midi);
  }

  setObserver(observer: PlaybackObserver | null): void {
    this.observer = observer;
  }

  dispose(): void {
    this.endPump();
    this.cancelPendingClicks();
    this.deps.backend.dispose();
    this.deps.backend.dispose();
    this.plan = null;
    this.observer = null;
    this.initialized = false;
    this.clearSounding(0);
  }

  // ---- the pump ------------------------------------------------------------

  private startPump(): void {
    if (this.stopPump) return;
    this.stopPump = this.deps.startPump(() => this.tick(), PUMP_INTERVAL_MS);
    this.stopSoundingTicker = this.deps.startPump(
      () => this.tickSounding(),
      SOUNDING_INTERVAL_MS
    );
    this.tick();
  }

  private endPump(): void {
    this.stopPump?.();
    this.stopPump = null;
    this.stopSoundingTicker?.();
    this.stopSoundingTicker = null;
  }

  /**
   * Guarded for the same reason `tick` is, and separately from it: this is its
   * own bare interval callback, so a throw here would kill the key lights
   * silently while audio carried on perfectly.
   */
  private tickSounding(): void {
    try {
      this.reportSounding();
    } catch (error) {
      this.tickFailures += 1;
      if (this.tickFailures <= MAX_REPORTED_TICK_FAILURES) {
        console.error('Playback pump failed', error);
      }
    }
  }

  private tick(): void {
    // Guarded because the pump is a bare interval callback: a throw in here
    // escapes into nothing, the interval keeps firing, and every later tick
    // throws at the same place — playback stops dead with a clean console and
    // a transport still reporting "playing". Whatever else goes wrong, it
    // should not go wrong invisibly.
    try {
      this.dispatchTick();
    } catch (error) {
      this.tickFailures += 1;
      if (this.tickFailures <= MAX_REPORTED_TICK_FAILURES) {
        console.error('Playback pump failed', error);
      }
    }
  }

  private dispatchTick(): void {
    this.measureLateness();
    if (this.startAtSeconds !== null) {
      this.clock.start(this.startAtSeconds);
      this.startAtSeconds = null;
    }
    const position = this.clock.positionSeconds;
    this.applyLoop(position);

    const speed = this.playbackSpeed;
    const untilTick = this.horizonTick(position + HORIZON_SECONDS * speed);
    const due = this.queue.drainUntil(untilTick, MAX_EVENTS_PER_REFILL);

    for (const note of due) {
      const state = this.tracks.get(note.trackId);
      if (!state) continue;
      const { instance, channel } = state.assignment;
      const atSeconds = this.secondsForTick(note.tick);
      const endSeconds = this.secondsForTick(note.tick + note.durTicks);
      this.deps.backend.noteAt(
        instance,
        channel,
        note.midi,
        clampVelocity(note.velocity),
        // Clamped to zero in `noteAt`: a note whose moment passed during a
        // stall sounds at once rather than being dropped, because the sequencer
        // still holds its release.
        (atSeconds - position) / speed,
        (endSeconds - atSeconds) / speed
      );
    }

    this.pumpMetronome(position, untilTick);
    this.report(position);
    // A loop never ends the transport: its range may well run past the last
    // note, and stopping there would end playback mid-loop.
    if (
      !this.loopRange &&
      this.queue.exhausted &&
      this.clock.isRunning &&
      position >= this.lastNoteEndSeconds
    ) {
      this.stop();
    }
  }

  /**
   * The far edge of what this tick may schedule, in ticks.
   *
   * Clamped to just inside a loop, because the wrap only happens on the pump
   * tick *after* the end is reached: without this a note or click a few
   * milliseconds past the loop end was already in the sequencer and sounded
   * before the loop came round, on every pass. The end tick itself belongs to
   * the next pass, where it is the loop's own first beat.
   */
  private horizonTick(untilSeconds: number): number {
    const tick = this.tickForSeconds(untilSeconds);
    if (!this.loopRange) return tick;
    return Math.min(tick, this.loopRange.endTick - 1);
  }

  /**
   * How late this frame ran against when it was due.
   *
   * Measured on the audio clock rather than wall time, because that is the
   * clock the audio is rendered against and the one that matters if the thread
   * is being starved.
   */
  private measureLateness(): void {
    const now = this.now();
    const expected = this.nextPumpDueAt;
    this.nextPumpDueAt = now + PUMP_INTERVAL_MS / 1000;
    if (expected === null) return; // first frame has nothing to be late against
    this.governor.record(Math.max(0, now - expected));
  }

  /**
   * Clicks due in this window, scheduled ahead at their exact moment.
   *
   * Unlike notes, these can be placed precisely: an oscillator started with
   * `start(at)` sounds at that sample however busy the main thread is, so the
   * click stays steady even when the pump runs late.
   */
  private pumpMetronome(position: number, untilTick: number): void {
    const now = this.now();
    // Forget the ones that have finished sounding, so the list tracks what is
    // still cancellable rather than growing for the length of the piece.
    if (this.pendingClicks.length > 0) {
      this.pendingClicks = this.pendingClicks.filter(
        click => click.endsAt > now
      );
    }
    if (!this.metronomeEnabled) return;
    while (this.clickCursor < this.clicks.length) {
      const click = this.clicks[this.clickCursor];
      if (click.tick > untilTick) break;
      const atSeconds = this.secondsForTick(click.tick);
      this.clickCursor += 1;
      if (atSeconds < position) continue; // already gone by; do not stack it up
      this.pendingClicks.push(
        this.deps.backend.scheduleClick(
          now + Math.max(0, (atSeconds - position) / this.playbackSpeed),
          click.accent
        )
      );
    }
  }

  /** Takes back every click still queued — a stop, a seek, or the switch going off. */
  private cancelPendingClicks(): void {
    if (this.pendingClicks.length === 0) return;
    const at = this.now();
    for (const click of this.pendingClicks) click.cancel(at);
    this.pendingClicks = [];
  }

  /** Inverse of `secondsForTick`, for turning the lookahead window back into ticks. */
  private tickForSeconds(seconds: number): number {
    return this.tempo.secondsToTicks(seconds);
  }

  private get playbackSpeed(): number {
    return this.tempoMultiplier > 0 ? this.tempoMultiplier : 1;
  }

  private applyLoop(position: number): void {
    if (!this.loopRange) return;
    if (position < this.secondsForTick(this.loopRange.endTick)) return;
    this.seek(this.loopRange.startTick);
    this.clock.start(this.secondsForTick(this.loopRange.startTick));
  }

  /**
   * Position and active notes, both at 30Hz.
   *
   * The engine this replaces called `onActiveNotes` on every note-on *and*
   * note-off — some 11,500 store updates for a three-minute piece, on the same
   * thread the scheduler runs on. Coalescing is what keeps that work off the
   * pump's back.
   */
  private report(position: number): void {
    this.reportSounding();

    const nowMs = position * 1000;
    /*
      Throttled forwards only. Going *backwards* is always due.

      The baseline is a playback position, not a wall clock, so any jump back
      down the piece makes the distance from it negative — and negative is
      smaller than the interval, so every report is suppressed until playback
      climbs back past where it had previously reached. `seek` knew this and
      cleared the baseline itself, but stopping does not go through `seek`: it
      rewinds the queue directly, so replaying after the transport reached the
      end left the baseline at the end of the piece. Nothing was ever due
      again — the music played, and the caret sat at bar 1 for the whole of it
      with the sheet never following.

      Fixed here rather than by clearing the baseline in `stop` too, because
      that is the version that has now been missed twice. A backward jump is
      the *reason* to report, whoever caused it: a stop, a seek, or a loop
      wrapping to its start.
    */
    const sinceLastReport = nowMs - this.lastReportedAt;
    if (sinceLastReport >= 0 && sinceLastReport < POSITION_TICK_INTERVAL_MS)
      return;
    this.lastReportedAt = nowMs;
    this.observer?.onPositionTick(
      Math.max(0, Math.round(this.tickForSeconds(position)))
    );
  }

  /**
   * Publishes the lit keys, at the position the listener is actually hearing.
   *
   * Separate from `report` because it runs on its own, faster ticker: the keys
   * are a visual and want frame rate, while the position report drives the
   * caret, which interpolates and does not.
   */
  private reportSounding(): void {
    const at =
      this.clock.positionSeconds +
      visualSoundingOffsetSeconds(this.deps.backend.outputLatency());
    const sounding = this.sounding.advanceTo(at);
    if (sounding) this.observer?.onActiveNotes(sounding);
  }

  /** Drops the sounding set and says so, for a seek, stop or teardown. */
  private clearSounding(atSeconds: number): void {
    const had = this.sounding.size > 0;
    this.sounding.reset(atSeconds);
    if (had) this.observer?.onActiveNotes([]);
  }
}

/**
 * A note velocity as MIDI will take it.
 *
 * The floor is 1, not 0: a note-on at velocity zero *is* a note-off, so a value
 * that rounds to nothing is a note that silently does not sound. The offline
 * renderer has always clamped this way, and an export that sounds a note
 * playback drops is the drift `shared/` exists to prevent.
 */
function clampVelocity(velocity: number): number {
  return Math.max(1, Math.min(MAX_CC, Math.round(velocity)));
}

function panToCc(pan: number): number {
  return Math.round(((Math.min(1, Math.max(-1, pan)) + 1) / 2) * MAX_CC);
}
