import { describe, expect, it, vi } from 'vitest';
import { NativeSynthBackend } from './native-backend.js';
import type { NativeSynth, NativeSynthApi } from './native-synth-api.js';
import { PERCUSSION_CHANNEL } from '@sudobility/music_types';
import { headroomTrimFor } from '../../shared/mix.js';

type NoteAtCall = {
  instance: number;
  channel: number;
  midi: number;
  delay: number;
  duration: number;
};

function fakeApi(supported = true) {
  const noteAt: NoteAtCall[] = [];
  const cancelled: number[] = [];
  const percussion: Array<{ instance: number; channel: number }> = [];
  let instances = 0;
  const synth: NativeSynth = {
    initialize: vi.fn(async ({ instanceCount, onProgress }) => {
      instances = instanceCount;
      onProgress?.(0.5);
    }),
    ensureInstances: vi.fn(async (count: number) => {
      instances = count;
    }),
    currentTime: () => 10,
    outputLatency: () => 0.02,
    noteAt: (instance, channel, midi, _v, delay, duration) => {
      noteAt.push({ instance, channel, midi, delay, duration });
    },
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    programSelect: vi.fn(),
    setChannelPercussion: vi.fn((instance: number, channel: number) => {
      percussion.push({ instance, channel });
    }),
    controlChange: vi.fn(),
    cancelScheduledOn: vi.fn((instance: number) => cancelled.push(instance)),
    allSoundOff: vi.fn(),
    setInterpolation: vi.fn(),
    setMasterVolume: vi.fn(),
    dispose: vi.fn(),
  };
  const api: NativeSynthApi = {
    createSynth: () => synth,
    isSupported: () => supported,
  };
  return {
    api,
    synth,
    noteAt,
    cancelled,
    percussion,
    instanceCount: () => instances,
  };
}

async function prepared(instanceCount = 2) {
  const f = fakeApi();
  const backend = new NativeSynthBackend({
    api: f.api,
    soundfontUri: 'file:///font.sf3',
  });
  await backend.prepare({ instanceCount, onProgress: vi.fn() });
  return { ...f, backend };
}

describe('NativeSynthBackend', () => {
  it('reserves one synth past the score for the metronome alone', async () => {
    const { instanceCount, percussion } = await prepared(2);
    // Two for the score, one for the click.
    expect(instanceCount()).toBe(3);
    // The click's own instance is put on the drum channel, so a percussion
    // track that selected another kit cannot change what the click sounds like.
    expect(percussion).toContainEqual({
      instance: 2,
      channel: PERCUSSION_CHANNEL,
    });
  });

  it('plays the click as percussion, and tells accent from beat', async () => {
    const { backend, noteAt } = await prepared(2);
    backend.scheduleClick(11, true);
    backend.scheduleClick(11.5, false);
    expect(noteAt).toHaveLength(2);
    expect(noteAt[0].instance).toBe(2);
    expect(noteAt[0].channel).toBe(PERCUSSION_CHANNEL);
    expect(noteAt[0].midi).not.toBe(noteAt[1].midi);
    // Delay is measured from the synth's own clock, which reads 10.
    expect(noteAt[0].delay).toBeCloseTo(1);
    expect(noteAt[1].delay).toBeCloseTo(1.5);
  });

  it('never schedules a click in the past', async () => {
    const { backend, noteAt } = await prepared(1);
    backend.scheduleClick(5, false); // already gone by; clock reads 10
    expect(noteAt[0].delay).toBe(0);
  });

  it('takes back clicks without silencing the music', async () => {
    const { backend, cancelled, synth } = await prepared(2);
    backend.scheduleClick(11, true).cancel(10.5);
    // The click's instance only, never `allSoundOff` — switching the metronome
    // off must not stop the notes.
    expect(cancelled).toEqual([2]);
    expect(synth.allSoundOff).not.toHaveBeenCalled();
  });

  it('keeps the metronome past the end as the score grows', async () => {
    const { backend, instanceCount, percussion } = await prepared(2);
    await backend.ensureInstances(5);
    expect(instanceCount()).toBe(6);
    expect(percussion.at(-1)).toEqual({
      instance: 5,
      channel: PERCUSSION_CHANNEL,
    });
  });

  it('reports the synth clock and latency, and 0 before it exists', async () => {
    const backend = new NativeSynthBackend({
      api: fakeApi().api,
      soundfontUri: 'f',
    });
    expect(backend.now()).toBe(0);
    expect(backend.outputLatency()).toBeUndefined();
    await backend.prepare({ instanceCount: 1, onProgress: vi.fn() });
    expect(backend.now()).toBe(10);
    expect(backend.outputLatency()).toBeCloseTo(0.02);
  });

  it('crosses to native for the clock a few times a second, not on every read', async () => {
    const f = fakeApi();
    let audio = 10;
    let wall = 100;
    const currentTime = vi.fn(() => audio);
    const outputLatency = vi.fn(() => 0.02);
    f.synth.currentTime = currentTime;
    f.synth.outputLatency = outputLatency;
    const backend = new NativeSynthBackend({
      api: f.api,
      soundfontUri: 'f',
      wallClock: () => wall,
    });
    await backend.prepare({ instanceCount: 1, onProgress: vi.fn() });
    currentTime.mockClear();
    outputLatency.mockClear();

    expect(backend.now()).toBe(10);
    // Between reads it extrapolates at wall-clock speed.
    wall += 0.05;
    audio += 0.05;
    expect(backend.now()).toBeCloseTo(10.05);
    wall += 0.05;
    audio += 0.05;
    expect(backend.now()).toBeCloseTo(10.1);
    expect(currentTime).toHaveBeenCalledTimes(1);

    // And re-anchors once the extrapolation is old enough to have drifted.
    wall += 0.5;
    audio += 0.5;
    expect(backend.now()).toBeCloseTo(10.6);
    expect(currentTime).toHaveBeenCalledTimes(2);

    // Latency is a property of the open driver, read once.
    backend.outputLatency();
    backend.outputLatency();
    expect(outputLatency).toHaveBeenCalledTimes(1);
  });

  it('never reads the clock backwards across a re-anchor', async () => {
    const f = fakeApi();
    let wall = 100;
    let audio = 10;
    f.synth.currentTime = () => audio;
    const backend = new NativeSynthBackend({
      api: f.api,
      soundfontUri: 'f',
      wallClock: () => wall,
    });
    await backend.prepare({ instanceCount: 1, onProgress: vi.fn() });
    backend.now();
    wall += 0.4;
    const projected = backend.now();
    // The audio clock advances in render blocks, so a fresh read can land a
    // little behind the projection.
    audio += 0.39;
    wall += 0.3;
    expect(backend.now()).toBeGreaterThanOrEqual(projected);
  });

  it('says so rather than failing obscurely with no native synth', async () => {
    const backend = new NativeSynthBackend({
      api: fakeApi(false).api,
      soundfontUri: 'f',
    });
    await expect(
      backend.prepare({ instanceCount: 1, onProgress: vi.fn() })
    ).rejects.toThrow(/native synth/i);
  });

  it('forwards the load through PlaybackLoadState, which the transport shows', async () => {
    const f = fakeApi();
    const onProgress = vi.fn();
    const backend = new NativeSynthBackend({
      api: f.api,
      soundfontUri: 'f',
    });
    await backend.prepare({ instanceCount: 1, onProgress });
    expect(onProgress).toHaveBeenCalledWith({ status: 'loading', fraction: 0 });
    expect(onProgress).toHaveBeenCalledWith({
      status: 'loading',
      fraction: 0.5,
    });
  });

  /**
   * `setTrackCount` used to be a no-op here — this is the gap that let a
   * busy score sum into `synth.gain` at full, untrimmed level while the web
   * engine trimmed its own master bus for the same score. Both calls must
   * fold together into one `synth.setMasterVolume`, whichever arrives last,
   * since a score can change track count after the transport's own volume
   * was already set.
   */
  it('folds the multi-track headroom trim into the native master gain', async () => {
    const { synth, backend } = await prepared();

    backend.setMasterVolume(0.8);
    backend.setTrackCount(4);

    expect(synth.setMasterVolume).toHaveBeenLastCalledWith(
      0.8 * headroomTrimFor(4)
    );
  });

  it('re-derives the native master gain when track count changes after volume was set', async () => {
    const { synth, backend } = await prepared();

    backend.setTrackCount(9);
    backend.setMasterVolume(1);

    expect(synth.setMasterVolume).toHaveBeenLastCalledWith(
      1 * headroomTrimFor(9)
    );
  });

  it('applies no trim for a single track, matching the web engine', async () => {
    const { synth, backend } = await prepared();

    backend.setTrackCount(1);
    backend.setMasterVolume(0.5);

    expect(synth.setMasterVolume).toHaveBeenLastCalledWith(0.5);
  });
});
