import { describe, expect, it, vi } from 'vitest';
import { WebSynthBackend } from './web-backend.js';
import type { SynthHostLike } from './web-backend.js';

function backendWith(context: AudioContext) {
  const host = {
    init: vi.fn(async () => {}),
  } as unknown as SynthHostLike;
  const backend = new WebSynthBackend({
    host,
    moduleUrls: { fluidsynth: 'synth.js', worklet: 'worklet.js' },
    fontUrl: 'font.sf3',
    loadFont: async () => new ArrayBuffer(1),
    createContext: () => context,
  });
  return { backend, host };
}

describe('browser audio output', () => {
  it('routes a selection made before context creation and switches the live context', async () => {
    const setSinkId = vi.fn(async (_id: string) => {});
    const context = { setSinkId, currentTime: 0 } as unknown as AudioContext;
    const { backend } = backendWith(context);

    await backend.setAudioOutputDevice('speakers');
    expect(setSinkId).not.toHaveBeenCalled();
    await backend.prepare({ instanceCount: 1, onProgress: () => {} });
    expect(setSinkId).toHaveBeenCalledWith('speakers');

    await backend.setAudioOutputDevice('headphones');
    expect(setSinkId).toHaveBeenLastCalledWith('headphones');
    expect(backend.getAudioOutputDeviceId()).toBe('headphones');
  });

  it('keeps the old selection when the browser rejects a route change', async () => {
    const setSinkId = vi.fn(async (id: string) => {
      if (id === 'missing') throw new Error('device gone');
    });
    const { backend } = backendWith({ setSinkId } as unknown as AudioContext);
    await backend.prepare({ instanceCount: 1, onProgress: () => {} });
    await backend.setAudioOutputDevice('speakers');

    await expect(backend.setAudioOutputDevice('missing')).rejects.toThrow(
      'device gone'
    );
    expect(backend.getAudioOutputDeviceId()).toBe('speakers');
  });

  it('falls back to the system output when a selected device vanishes before playback', async () => {
    const setSinkId = vi.fn(async () => {
      throw new Error('device gone');
    });
    const { backend } = backendWith({ setSinkId } as unknown as AudioContext);
    await backend.setAudioOutputDevice('missing');

    await expect(
      backend.prepare({ instanceCount: 1, onProgress: () => {} })
    ).resolves.toBe('ready');
    expect(backend.getAudioOutputDeviceId()).toBe('');
  });
});
