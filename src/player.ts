/**
 * The transport: everything `PlaybackController` did that was not the store.
 *
 * It came from music_lib, where it read Zustand directly for the score, the
 * visible tracks, the selection and the caret. Those four are editing state and
 * stayed behind; what arrives here is score maths and engine driving. The host
 * binds the two together — see music_lib's playback adapter.
 */
import {
  scoreEndTick,
  sourceTickFor,
  performanceTickFor,
} from '@sudobility/music_types';
import type {
  PerformanceTimeline,
  PlaybackLoadState,
  PlaybackPlan,
  PlaybackTrack,
  Score,
  ScoreRange,
  SoundingNote,
  TransportPlaybackState,
} from '@sudobility/music_types';
import type {
  PlaybackEngine,
} from './engine.js';
import { getMusicPositionSource } from '@sudobility/music_types';
import { PlaybackBus } from './shared/bus.js';
import { playbackPlan, playbackTracks, resolveVoice } from './shared/plan.js';
import type { IMusicPlayer, Unsubscribe } from './types.js';

export class MusicPlayer implements IMusicPlayer {
  /**
   * Where position and sounding notes go instead of the host's store.
   *
   * Both arrive far too often to route through React state — see `bus.ts`.
   */
  readonly bus = new PlaybackBus();

  /**
   * How the loaded plan's performance time maps onto the written score.
   *
   * Replaced whenever the plan is — a repeat added or removed changes it. The
   * identity default means a player with nothing loaded translates nothing.
   */
  private timeline: PerformanceTimeline = { segments: [], durationTicks: 0 };

  /** The loaded plan's tempo conversion, so the playhead can be told how fast ticks pass. */
  private tempo: PlaybackPlan['tempo'] | null = null;

  /** The transport's half/double-speed control, kept here since the store no longer holds it for us. */
  private multiplier = 1;

  /** Mirrors the engine, so `load` can tell a mix change from a reload without asking the host. */
  private state: TransportPlaybackState = 'stopped';

  private score: Score | null = null;
  private visibleTrackIds: readonly string[] | null = null;

  private readonly loadStateListeners = new Set<
    (state: PlaybackLoadState) => void
  >();

  constructor(private readonly engine: PlaybackEngine) {
    engine.setObserver({
      /*
        Translated here, and only here.

        The engine reports *performance* time, which differs from written time
        the moment a repeat exists. Converting at this one boundary means the
        caret, the following-scroll, the bar/beat readout and the position
        scrubber all keep receiving a score tick and none of them has to know
        repeats exist. Without repeats the timeline is the identity and this
        costs a single comparison.
      */
      onPositionTick: tick => {
        const scoreTick = sourceTickFor(this.timeline, tick);
        // Refreshed every report rather than once at play, so a fermata or a
        // tempo change mid-piece projects at the speed actually in force.
        getMusicPositionSource().setRate(this.ticksPerSecond(scoreTick));
        this.bus.publishPosition(scoreTick);
      },
      onActiveNotes: notes => this.bus.publishSounding(notes),
      onStateChange: state => {
        this.state = state;
        // Smoothing only applies while the transport advances, and the playhead
        // re-anchors on the transition so a pause does not leave it projecting
        // forward across the time spent stopped.
        getMusicPositionSource().setPlaying(
          state === 'playing',
          this.ticksPerSecond(this.bus.positionTick)
        );
        this.bus.publishTransport(state);
      },
      // Optional on the contract: an engine with nothing to load never calls it.
      onLoadStateChange: state => {
        for (const listener of this.loadStateListeners) listener(state);
      },
    });
  }

  async load(
    score: Score,
    opts: { visibleTrackIds?: readonly string[] } = {}
  ): Promise<void> {
    this.score = score;
    if (opts.visibleTrackIds !== undefined) {
      this.visibleTrackIds = opts.visibleTrackIds;
    }

    if (this.state === 'playing') {
      // Tracks only: rebuilding every note to change a gain would undo the
      // reason this branch exists. The host's edit lock is what makes it safe —
      // while playing, the only score change that can reach here is a mix
      // change, and anything arriving from outside that path must `stop()`
      // first or it will be heard as the old score.
      this.engine.applyMix(playbackTracks(score));
      return;
    }

    const plan = playbackPlan(score);
      // Kept in step with what the engine holds: a repeat added or removed
      // changes the mapping, and a stale one would put the caret in the wrong
      // bar for every frame until the next load.
    this.timeline = plan.timeline;
    this.tempo = plan.tempo;
    await this.engine.load(plan);
    // `load` reseeds every channel's mute from `Track.muted`, so hidden tracks
    // would sound again without this.
    this.applyTrackAudibility();
  }

  async play(): Promise<void> {
    await this.engine.play();
  }

  pause(): void {
    this.engine.pause();
  }

  stop(): void {
    this.engine.stop();
  }

  /**
   * Seeks to a *written* position.
   *
   * The engine is given the first performance position of that tick, which is
   * what "play from here" means to somebody reading the page — the first time
   * through, not the repeat. The caret is the host's to move.
   */
  seek(scoreTick: number): void {
    if (!this.score) return;
    this.engine.seek(performanceTickFor(this.timeline, Math.max(0, scoreTick)));
  }

  setLoop(range: ScoreRange | null): void {
    this.engine.setLoop(range);
  }

  /** The whole score, for a host that wants a loop but has no selection to derive one from. */
  wholeScoreRange(): ScoreRange | null {
    if (!this.score) return null;
    return { startTick: 0, endTick: scoreEndTick(this.score), trackIds: [] };
  }

  setTempoMultiplier(multiplier: number): void {
    this.multiplier = multiplier;
    this.engine.setTempoMultiplier(multiplier);
  }

  setMetronome(enabled: boolean): void {
    this.engine.setMetronome(enabled);
  }

  setMasterVolume(volume: number): void {
    this.engine.setMasterVolume(volume);
  }

  applyMix(tracks: readonly PlaybackTrack[]): void {
    this.engine.applyMix([...tracks]);
  }

  setVisibleTracks(visibleTrackIds: readonly string[]): void {
    this.visibleTrackIds = visibleTrackIds;
    this.applyTrackAudibility();
  }

  noteOn(midi: number, program: number, isPercussion = false): void {
    // Resolved here: the engine has no GM tables, and a percussion program
    // addresses a kit rather than an instrument.
    this.engine.noteOn(midi, resolveVoice(program, isPercussion));
  }

  noteOff(midi: number): void {
    this.engine.noteOff(midi);
  }

  onPosition(fn: (scoreTick: number) => void): Unsubscribe {
    return this.bus.onPosition(fn);
  }

  onSounding(fn: (notes: readonly SoundingNote[]) => void): Unsubscribe {
    return this.bus.onSounding(fn);
  }

  onTransport(fn: (state: TransportPlaybackState) => void): Unsubscribe {
    return this.bus.onTransport(fn);
  }

  onLoadState(fn: (state: PlaybackLoadState) => void): Unsubscribe {
    this.loadStateListeners.add(fn);
    return () => this.loadStateListeners.delete(fn);
  }

  dispose(): void {
    this.loadStateListeners.clear();
    this.engine.dispose();
  }

  /**
   * How many score ticks pass per real second at the current position.
   *
   * Read off the plan's own tempo conversion — the same one the engine
   * schedules against, so the playhead's smoothing and the audio agree about
   * how fast the music is going. The multiplier is the transport's half/double
   * speed control: the engine divides logical seconds by it, so one real second
   * is that many logical seconds of music.
   */
  private ticksPerSecond(tick: number): number {
    if (!this.tempo) return 0;
    // A second of music, measured at the playhead: how many ticks fit between
    // now and one second from now, which handles a tempo change mid-piece
    // without needing to know the tempo map's shape.
    const perSecond =
      this.tempo.secondsToTicks(this.tempo.ticksToSeconds(tick) + 1) - tick;
    return Math.max(0, perSecond * this.multiplier);
  }

  /**
   * A track sounds only if it is visible *and* not muted.
   *
   * Visibility used to reach the notation and the print sheet but never the
   * audio, so hiding a track removed it from view while it went on playing.
   * Combining the two axes here rather than writing visibility into the
   * channel's mute means an explicit mute survives being hidden and shown
   * again — the score keeps the user's intent, and this only ever derives from
   * it.
   */
  private applyTrackAudibility(): void {
    const score = this.score;
    if (!score) return;
    const visible = this.visibleTrackIds;
    for (const track of score.tracks) {
      const hidden = visible !== null && !visible.includes(track.id);
      this.engine.setTrackMute(track.id, track.muted || hidden);
    }
  }
}
