/**
 * A player that records what it was asked to do and makes no sound.
 *
 * Shipped from this package rather than rewritten in each consumer, so
 * music_lib's and music_app's tests exercise the same double this package's own
 * suite does.
 */
import type {
  PlaybackLoadState,
  PlaybackTrack,
  Score,
  ScoreRange,
  SoundingNote,
  TransportPlaybackState,
} from '@sudobility/music_types';
import { PlaybackBus } from '../shared/bus.js';
import type { IMusicPlayer, Unsubscribe } from '../types.js';

export class MockMusicPlayer implements IMusicPlayer {
  readonly calls: string[] = [];
  /** The score it was last handed, for tests to assert on. */
  loadedScore: Score | null = null;

  private readonly position = new Set<(t: number) => void>();
  private readonly soundingListeners = new Set<
    (n: readonly SoundingNote[]) => void
  >();
  private readonly transport = new Set<(s: TransportPlaybackState) => void>();
  private readonly loadState = new Set<(s: PlaybackLoadState) => void>();

  /** A real bus, so a consumer's tests can publish into it exactly as the engine would. */
  readonly bus = new PlaybackBus();

  async load(
    score: Score,
    opts: { visibleTrackIds?: readonly string[] } = {}
  ): Promise<void> {
    this.loadedScore = score;
    this.calls.push(
      opts.visibleTrackIds
        ? `load(visible:${opts.visibleTrackIds.length})`
        : 'load'
    );
  }

  async play(): Promise<void> {
    this.calls.push('play');
  }
  pause(): void {
    this.calls.push('pause');
  }
  stop(): void {
    this.calls.push('stop');
  }
  seek(tick: number): void {
    this.calls.push(`seek(${tick})`);
  }
  setLoop(range: ScoreRange | null): void {
    this.calls.push(
      range ? `setLoop(${range.startTick},${range.endTick})` : 'clearLoop'
    );
  }
  setTempoMultiplier(m: number): void {
    this.calls.push(`setTempoMultiplier(${m})`);
  }
  setMetronome(on: boolean): void {
    this.calls.push(`setMetronome(${on})`);
  }
  setMasterVolume(v: number): void {
    this.calls.push(`setMasterVolume(${v})`);
  }
  applyMix(tracks: readonly PlaybackTrack[]): void {
    this.calls.push(`applyMix(${tracks.length})`);
  }
  setVisibleTracks(ids: readonly string[]): void {
    this.calls.push(`setVisibleTracks(${ids.length})`);
  }
  noteOn(midi: number, program: number, isPercussion = false): void {
    this.calls.push(`noteOn(${midi},${program},${isPercussion})`);
  }
  noteOff(midi: number): void {
    this.calls.push(`noteOff(${midi})`);
  }

  onPosition(fn: (t: number) => void): Unsubscribe {
    this.position.add(fn);
    return () => this.position.delete(fn);
  }
  onSounding(fn: (n: readonly SoundingNote[]) => void): Unsubscribe {
    this.soundingListeners.add(fn);
    return () => this.soundingListeners.delete(fn);
  }
  onTransport(fn: (s: TransportPlaybackState) => void): Unsubscribe {
    this.transport.add(fn);
    return () => this.transport.delete(fn);
  }
  onLoadState(fn: (s: PlaybackLoadState) => void): Unsubscribe {
    this.loadState.add(fn);
    return () => this.loadState.delete(fn);
  }

  dispose(): void {
    this.calls.push('dispose');
  }

  // ---- test drivers: let a suite push events the way a real engine would ----
  emitPosition(tick: number): void {
    this.bus.publishPosition(tick);
    for (const fn of this.position) fn(tick);
  }
  emitSounding(notes: readonly SoundingNote[]): void {
    this.bus.publishSounding(notes);
    for (const fn of this.soundingListeners) fn(notes);
  }
  emitTransport(state: TransportPlaybackState): void {
    for (const fn of this.transport) fn(state);
  }
  emitLoadState(state: PlaybackLoadState): void {
    for (const fn of this.loadState) fn(state);
  }
}
