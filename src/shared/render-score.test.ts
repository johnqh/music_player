import { describe, expect, it } from 'vitest';
import type { RenderPlan, Score } from '@sudobility/music_types';
import { twinkleScore } from '@sudobility/music_types/test';
import { renderEvents } from './render-events.js';
import { renderScoreWith } from './render-score.js';

/** A renderer that records the plan it was given and returns a fixed buffer. */
function recordingRenderer(extra: Record<string, unknown> = {}) {
  const plans: RenderPlan[] = [];
  const samples = new Float32Array([0.25, -0.25]);
  const render = async (plan: RenderPlan) => {
    plans.push(plan);
    return { samples, sampleRate: 48000, ...extra };
  };
  return { plans, samples, render };
}

describe('renderScoreWith', () => {
  it('renders the plan renderEvents builds, humanized as live playback is', async () => {
    const score = twinkleScore();
    const { plans, render } = recordingRenderer();
    await renderScoreWith(score, render);
    // Humanizing is deterministic (hashed from note ids), so the plan an
    // export renders is exactly the default renderEvents plan — the one both
    // apps built by hand before this existed.
    expect(plans).toEqual([renderEvents(score)]);
    expect(plans[0]).not.toEqual(renderEvents(score, { humanize: false }));
  });

  it('respects mute and solo, because renderEvents decides what sounds', async () => {
    const base = twinkleScore();
    const score: Score = {
      ...base,
      tracks: base.tracks.map(t => ({ ...t, muted: true })),
    };
    const { plans, render } = recordingRenderer();
    await renderScoreWith(score, render);
    expect(plans[0].events).toEqual([]);
    expect(plans[0].tracks).toHaveLength(score.tracks.length);
  });

  it('returns PCM and its rate, and nothing else', async () => {
    const { samples, render } = recordingRenderer({ channels: 2 });
    const audio = await renderScoreWith(twinkleScore(), render);
    expect(audio).toEqual({ samples, sampleRate: 48000 });
    expect(audio.samples).toBe(samples);
  });

  it('rejects when the renderer does, so the host can report it', async () => {
    const failing = async () => {
      throw new Error('no synth');
    };
    await expect(renderScoreWith(twinkleScore(), failing)).rejects.toThrow(
      'no synth'
    );
  });
});
