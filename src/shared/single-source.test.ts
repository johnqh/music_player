/**
 * The bus and `IMusicPosition` cannot disagree.
 *
 * This is the regression the whole interface exists for: the caret, the note
 * highlighting and the piano keyboard each used to derive the playhead their
 * own way, and under load they visibly drifted apart. They now all read one
 * number, and that number is fed by the one write path every caret move goes
 * through.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { PlaybackBus } from './bus.js';
import {
  getMusicPosition,
  getMusicPositionSource,
  resetMusicPosition,
} from '@sudobility/music_types';

beforeEach(() => resetMusicPosition());

describe('the bus feeds the shared position', () => {
  it('a published position is immediately readable through the interface', () => {
    const bus = new PlaybackBus();
    bus.publishPosition(1920);
    expect(getMusicPosition().tick).toBe(1920);
  });

  it('a seek while paused moves it too, not just a playback report', () => {
    // Editing is the other half of "playback and editing both use the
    // interface" — clicking the staff publishes a position with the transport
    // stopped, and the shared value has to follow it.
    const bus = new PlaybackBus();
    bus.publishPosition(480);
    expect(getMusicPosition().tick).toBe(480);
    bus.publishPosition(0);
    expect(getMusicPosition().tick).toBe(0);
  });

  it('agrees with the bus itself after every publish', () => {
    const bus = new PlaybackBus();
    for (const tick of [0, 240, 480, 960, 1440]) {
      bus.publishPosition(tick);
      expect(getMusicPosition().tick).toBe(bus.positionTick);
    }
  });

  /*
    Agreement has to survive the transport moving, not just a publish.

    The bus used to keep its own copy of the reported tick. Banking a position
    on a state change moved the playhead's and left the copy behind, so the two
    described different moments — which is the whole thing the interface says
    cannot happen.
  */
  it('still agrees after the transport banks a position on a state change', () => {
    const bus = new PlaybackBus();
    const source = getMusicPositionSource();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now * 1000);

    source.setPlaying(true, 960);
    bus.publishPosition(0);
    now = 0.25;
    source.setPlaying(false);

    expect(bus.positionTick).toBe(getMusicPosition().tick);
    expect(bus.positionTick).toBeCloseTo(240, 0);
  });

  /*
    And it has to survive the producer going quiet.

    Smoothing projects between reports; with none arriving it projected without
    limit, so the caret glided the length of the score while everything reading
    the reported tick sat at bar one. Bounded, the two stay within one
    projection window of each other however long the silence lasts.
  */
  it('cannot drift without limit when nothing is reported', () => {
    const bus = new PlaybackBus();
    const source = getMusicPositionSource();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now * 1000);

    source.setPlaying(true, 960); // 960 ticks per second
    bus.publishPosition(0);

    now = 60; // a minute of silence from the engine
    expect(getMusicPosition().tick - bus.positionTick).toBeLessThanOrEqual(480);
  });
});
