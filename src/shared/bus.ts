/**
 * The high-frequency half of playback, kept out of the store.
 *
 * Position arrives ~30 times a second and the sounding set changes on every
 * note boundary. Routing either through Zustand means every subscriber in the
 * app is notified at that rate, which is why the editor grew five separately
 * isolated readout components and a rule in CLAUDE.md reminding everyone not to
 * read those fields at a component's top level. The rule was correct and
 * enforced by memory: one `store((s) => s.positionTick)` in the wrong place
 * silently cost twenty renders a second.
 *
 * Here the fields simply are not in the store, so that subscription cannot be
 * written. What remains in Zustand is the low-frequency state — transport
 * state, loop, tempo, metronome, volume, load progress — which behaves like
 * ordinary React state because it is.
 *
 * Three separate channels rather than one "playback changed" event: a
 * subscriber that cares about position must not wake when a note starts, and
 * the caret and the piano keyboard genuinely care about different things.
 */
import type {
  SoundingNote,
  TransportPlaybackState,
} from '@sudobility/music_types';

export type Unsubscribe = () => void;

import { getMusicPositionSource } from '@sudobility/music_types';

export class PlaybackBus {
  private readonly positionListeners = new Set<(tick: number) => void>();
  private readonly soundingListeners = new Set<
    (notes: readonly SoundingNote[]) => void
  >();
  private readonly transportListeners = new Set<
    (state: TransportPlaybackState) => void
  >();

  /** The last values published, so a subscriber joining mid-playback is not blind until the next event. */
  private lastPosition = 0;
  private lastSounding: readonly SoundingNote[] = [];
  private lastTransport: TransportPlaybackState = 'stopped';

  onPosition(listener: (tick: number) => void): Unsubscribe {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  onSounding(listener: (notes: readonly SoundingNote[]) => void): Unsubscribe {
    this.soundingListeners.add(listener);
    return () => this.soundingListeners.delete(listener);
  }

  onTransport(listener: (state: TransportPlaybackState) => void): Unsubscribe {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  /**
   * Every caret move in the app arrives here — the engine's position reports,
   * a seek, a click on the staff, an arrow key — which is what makes this the
   * one place that has to tell `IMusicPosition` about it. Reporting from the
   * controller's report handler instead would have covered playback only, and
   * left the shared position stale the moment somebody moved the caret by
   * hand.
   *
   * The anchor is stamped **here**, inside the engine's own callback, rather
   * than wherever a React subscriber eventually runs: that is the difference
   * between measuring from the audio clock and measuring from event-loop
   * latency, and it is why the caret used to drift away from the highlights
   * and the keyboard under load.
   */
  publishPosition(tick: number): void {
    this.lastPosition = tick;
    getMusicPositionSource().report(tick);
    for (const listener of this.positionListeners) listener(tick);
  }

  /**
   * The engine already emits only on change (`SoundingSet`), so this does not
   * filter again — doing so would hide a deliberate re-publish after a seek.
   */
  publishSounding(notes: readonly SoundingNote[]): void {
    this.lastSounding = notes;
    for (const listener of this.soundingListeners) listener(notes);
  }

  publishTransport(state: TransportPlaybackState): void {
    this.lastTransport = state;
    for (const listener of this.transportListeners) listener(state);
  }

  /** Where playback last reported it was. Read once on subscribe; do not poll this. */
  get positionTick(): number {
    return this.lastPosition;
  }

  get sounding(): readonly SoundingNote[] {
    return this.lastSounding;
  }

  get transport(): TransportPlaybackState {
    return this.lastTransport;
  }

  /** Drops every listener. For teardown; a live app never calls this. */
  clear(): void {
    this.positionListeners.clear();
    this.soundingListeners.clear();
    this.transportListeners.clear();
  }
}
