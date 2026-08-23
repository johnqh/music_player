import type { PlaybackBus } from './shared/bus.js';
import type {
  PlaybackLoadState,
  PlaybackTrack,
  Score,
  ScoreRange,
  SoundingNote,
  TransportPlaybackState,
} from '@sudobility/music_types';

export type Unsubscribe = () => void;

/**
 * The transport.
 *
 * Takes a `Score`, not a plan: this package owns `playbackPlan`, so making the
 * caller build one first would be a two-step dance whose second step is here.
 * The *engine* underneath still takes a `PlaybackPlan` and does no score maths,
 * which is where music_io's "handed a plan, never a score" rule was always
 * actually about.
 *
 * Deliberately has no caret, and no `togglePlay`, `seekToMeasure`,
 * `previousMeasure`, `nextMeasure` or loop-from-selection. Those read and write
 * the caret or the selection, both of which are editing state; a copy of either
 * here is a second thing that can disagree with the first. See `MusicPosition`
 * in music_types for what that cost last time. They live in music_lib's
 * playback adapter and compose the primitives below.
 */
export interface IMusicPlayer {
  /**
   * Adopts a score.
   *
   * **While playing, this is a mix change and nothing else** — the note queue is
   * kept. The edit lock is what makes that safe: while the transport runs, the
   * only score change that can reach here is a mix change. A score arriving
   * from outside that path (a generation result, an opened snapshot) must be
   * preceded by `stop()`, or it will be heard as the old score.
   */
  /**
   * Rejects on failure rather than swallowing. The host translates: the message
   * a user sees is a localized string, and this package carries no copy.
   */
  load(score: Score, opts?: { visibleTrackIds?: readonly string[] }): Promise<void>;

  play(): Promise<void>;
  pause(): void;
  stop(): void;

  /** Seeks to a *written* tick; the first performance of it, if repeats make several. */
  seek(scoreTick: number): void;

  setLoop(range: ScoreRange | null): void;
  setTempoMultiplier(multiplier: number): void;
  setMetronome(enabled: boolean): void;
  setMasterVolume(volume: number): void;

  /** Live, without rebuilding the note queue: mixing is not editing. */
  applyMix(tracks: readonly PlaybackTrack[]): void;

  /** A track sounds only if it is visible *and* not muted. */
  setVisibleTracks(visibleTrackIds: readonly string[]): void;

  /**
   * Sounds a pitch for as long as it is held — auditioning a key while editing.
   *
   * Touches no transport state on purpose: no caret move, no play/pause change,
   * and no appearance in the active-note highlighting that follows the score.
   *
   * `isPercussion` must be passed for a percussion-clef track, or the tap sounds
   * a pitched instrument while the same note plays back as a drum. The program
   * is resolved to a voice here rather than by the caller, because a percussion
   * program addresses a kit and only this package's tables know which.
   */
  noteOn(midi: number, program: number, isPercussion?: boolean): void;
  noteOff(midi: number): void;

  /**
   * The three high-frequency channels, as one object.
   *
   * Exposed rather than wrapped so a host binds React to the same bus the
   * engine publishes into — two would be two answers to "what is sounding".
   * `positionTick` and `sounding` hang off it for a subscriber joining
   * mid-playback, which is why they are held at all.
   */
  readonly bus: PlaybackBus;

  onPosition(fn: (scoreTick: number) => void): Unsubscribe;
  onSounding(fn: (notes: readonly SoundingNote[]) => void): Unsubscribe;
  onTransport(fn: (state: TransportPlaybackState) => void): Unsubscribe;
  /**
   * Synth load progress. Not one of the bus's three high-frequency channels —
   * it reports per percent and behaves like ordinary React state, so the host
   * puts it in its store. It is here because the host has no other way to hear
   * about it.
   */
  onLoadState(fn: (state: PlaybackLoadState) => void): Unsubscribe;

  dispose(): void;
}
