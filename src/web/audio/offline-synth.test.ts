import { describe, expect, it, vi } from 'vitest';
import { getOfflineSynth, releaseOfflineSynth } from './offline-synth.js';
import type { SynthesizerLike } from './synth-types.js';

/** A synth that records its init and hands back a known soundfont id. */
function stubSynth() {
  const init = vi.fn();
  const synth = { init, loadSFont: vi.fn(async () => 7) } as unknown as SynthesizerLike;
  return { synth, init };
}

describe('getOfflineSynth', () => {
  it('opens with the same 256 channels the allocator hands out', async () => {
    // Export shares `allocateChannels` with playback. On a 16-channel synth it
    // would address channels that do not exist and silently lose every track
    // past the sixteenth.
    releaseOfflineSynth();
    const { synth, init } = stubSynth();
    const loaded = await getOfflineSynth({
      fluidsynthModuleUrl: 'fluid.js',
      fontUrl: 'font.sf3',
      sampleRate: 44100,
      loadFont: async () => new Uint8Array(4).buffer,
      createSynth: () => synth,
    });
    expect(loaded.sfontId).toBe(7);
    expect(init).toHaveBeenCalledWith(44100, { midiChannelCount: 256, polyphony: 2048 });
  });

  it('builds the synth once and reuses it for the same font and rate', async () => {
    releaseOfflineSynth();
    const { synth, init } = stubSynth();
    const request = {
      fluidsynthModuleUrl: 'fluid.js',
      fontUrl: 'font.sf3',
      sampleRate: 44100,
      loadFont: async () => new Uint8Array(4).buffer,
      createSynth: () => synth,
    };
    await getOfflineSynth(request);
    await getOfflineSynth(request);
    expect(init).toHaveBeenCalledTimes(1);
    releaseOfflineSynth();
  });
});
