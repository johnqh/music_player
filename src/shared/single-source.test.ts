/**
 * The bus and `IMusicPosition` cannot disagree.
 *
 * This is the regression the whole interface exists for: the caret, the note
 * highlighting and the piano keyboard each used to derive the playhead their
 * own way, and under load they visibly drifted apart. They now all read one
 * number, and that number is fed by the one write path every caret move goes
 * through.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PlaybackBus } from './bus.js';
import { getMusicPosition, resetMusicPosition } from '@sudobility/music_types';

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
});
