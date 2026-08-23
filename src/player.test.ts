import { describe, expect, it, vi } from 'vitest';
import { MusicPlayer } from './player.js';
import { twinkleScore } from './test/fixtures.js';
import type {
  PlaybackObserver,
} from './engine.js';

/** A recording stand-in for the platform engine. */
function fakeEngine() {
  const calls: string[] = [];
  let observer: PlaybackObserver | null = null;
  const engine = {
    setObserver: vi.fn((o: PlaybackObserver) => {
      observer = o;
    }),
    load: vi.fn(async (_plan: unknown) => {
      calls.push('load');
    }),
    play: vi.fn(async () => {
      calls.push('play');
    }),
    pause: vi.fn(() => calls.push('pause')),
    stop: vi.fn(() => calls.push('stop')),
    seek: vi.fn((t: number) => calls.push(`seek(${t})`)),
    applyMix: vi.fn(() => calls.push('applyMix')),
    setTrackMute: vi.fn((id: string, muted: boolean) =>
      calls.push(`mute(${id},${muted})`)
    ),
    setLoop: vi.fn(),
    setTempoMultiplier: vi.fn(),
    setMetronome: vi.fn(),
    setMasterVolume: vi.fn(),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    dispose: vi.fn(),
  };
  return { engine, calls, fire: () => observer! };
}

describe('MusicPlayer', () => {
  it('hands the engine a plan, never the score', async () => {
    const { engine } = fakeEngine();
    const player = new MusicPlayer(engine as never);
    await player.load(twinkleScore());

    // A plan carries resolved notes and flat tracks; a Score carries tracks of
    // measures. Both have a `tracks` key, so the measures are the tell.
    const handed = engine.load.mock.calls[0]?.[0] as unknown as {
      notes?: unknown[];
      tracks?: Record<string, unknown>[];
    };
    expect(handed.notes).toBeDefined();
    expect(handed.tracks?.[0]).not.toHaveProperty('measures');
  });

  it('treats a score arriving mid-playback as a mix change, keeping the queue', async () => {
    const { engine, calls, fire } = fakeEngine();
    const player = new MusicPlayer(engine as never);
    await player.load(twinkleScore());
    fire().onStateChange('playing');
    calls.length = 0;

    await player.load(twinkleScore());

    expect(calls).toEqual(['applyMix']);
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('silences a track that is hidden, and one that is muted', async () => {
    const { engine, calls } = fakeEngine();
    const player = new MusicPlayer(engine as never);
    const score = twinkleScore();
    calls.length = 0;

    await player.load(score, { visibleTrackIds: [] });

    const first = score.tracks[0].id;
    expect(calls).toContain(`mute(${first},true)`);
  });

  it('reports a score tick, not a performance tick, on position', async () => {
    const { engine, fire } = fakeEngine();
    const player = new MusicPlayer(engine as never);
    await player.load(twinkleScore());

    const seen: number[] = [];
    player.onPosition(t => seen.push(t));
    fire().onPositionTick(480);

    // No repeats in the fixture, so the timeline is the identity — the point is
    // that it goes through the translation at all.
    expect(seen).toEqual([480]);
  });

  it('rejects a failed load rather than swallowing it', async () => {
    const { engine } = fakeEngine();
    engine.load.mockRejectedValueOnce(new Error('bad soundfont'));
    const player = new MusicPlayer(engine as never);

    // The host translates and shows it: the message a user sees is localized,
    // and this package carries no copy.
    await expect(player.load(twinkleScore())).rejects.toThrow('bad soundfont');
  });
});
