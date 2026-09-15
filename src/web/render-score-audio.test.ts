/**
 * The web `renderScoreAudio` is forwarding: the soundfont assets to the
 * renderer, the score through `renderEvents`. The failure it can have is an
 * asset silently not arriving — rendering through a different font than the one
 * playback loaded — so that is what is pinned. The renderer itself is covered
 * by `audio/soundfont-render.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderPlan } from '@sudobility/music_types';
import { twinkleScore } from '@sudobility/music_types/test';

const rendered: RenderPlan[] = [];
const assetsSeen: unknown[] = [];

vi.mock('./audio/soundfont-render.js', () => ({
  createSoundfontRenderer: (assets: unknown) => {
    assetsSeen.push(assets);
    return async (plan: RenderPlan) => {
      rendered.push(plan);
      return { samples: new Float32Array([1, 2]), sampleRate: 44100 };
    };
  },
}));

const { renderScoreAudio, renderEvents } = await import('./index.js');

describe('renderScoreAudio (web)', () => {
  it('renders renderEvents(score) through the given soundfont', async () => {
    const soundfont = {
      fluidsynthModuleUrl: '/audio/fluid.js',
      workletModuleUrl: '/audio/worklet.js',
      fontUrl: '/audio/font.sf3',
    };
    const score = twinkleScore();
    const audio = await renderScoreAudio(score, soundfont);

    expect(assetsSeen).toHaveLength(1);
    expect(assetsSeen[0]).toMatchObject({
      fluidsynthModuleUrl: '/audio/fluid.js',
      fontUrl: '/audio/font.sf3',
    });
    expect(rendered).toEqual([renderEvents(score)]);
    expect(audio).toEqual({
      samples: new Float32Array([1, 2]),
      sampleRate: 44100,
    });
  });
});
