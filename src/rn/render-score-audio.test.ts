/**
 * The React Native `renderScoreAudio` is forwarding, like `createMusicPlayer`
 * beside it (see `index.test.ts` for why that is worth pinning): a dropped
 * `fetchPack` renders an export from a third party's host instead of the packs
 * bundled with the app, and nothing throws. The renderer itself is covered by
 * `audio/offline-render.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderPlan } from '@sudobility/music_types';
import { twinkleScore } from '@sudobility/music_types/test';

const rendered: RenderPlan[] = [];
const depsSeen: Array<Record<string, unknown>> = [];

vi.mock('./audio/offline-render.js', () => ({
  createRNSoundfontRenderer: (deps: Record<string, unknown>) => {
    depsSeen.push(deps);
    return {
      render: async (plan: RenderPlan) => {
        rendered.push(plan);
        return { samples: new Float32Array([3]), sampleRate: 22050 };
      },
    };
  },
}));

const { renderScoreAudio, renderEvents } = await import('./index.js');

describe('renderScoreAudio (React Native)', () => {
  it('renders renderEvents(score) through the same packs playback uses', async () => {
    const fetchPack = async () => 'MIDI.Soundfont.x = {}';
    const score = twinkleScore();
    const audio = await renderScoreAudio(score, {
      packBase: 'https://example.test/packs/',
      percussionBase: 'https://example.test/drums/',
      fetchPack,
    });

    expect(depsSeen).toEqual([
      {
        packBase: 'https://example.test/packs/',
        percussionBase: 'https://example.test/drums/',
        fetchPack,
      },
    ]);
    expect(rendered).toEqual([renderEvents(score)]);
    expect(audio).toEqual({
      samples: new Float32Array([3]),
      sampleRate: 22050,
    });
  });
});
