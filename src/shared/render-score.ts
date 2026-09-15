/**
 * A score rendered to PCM: the two halves of an audio export, joined once.
 *
 * Both apps used to write `renderSamples(soundfont)(renderEvents(score))` at
 * their own export call site. Two copies of a two-line composition look too
 * small to share, and they are exactly where the drift this package exists to
 * prevent starts: one side passes `{ humanize: false }` to make a test pass,
 * or reaches for `playbackPlan` instead, and its exported file stops being a
 * recording of what was heard while every build stays green.
 *
 * Platform-free on purpose. The renderer is handed in, so this half is
 * testable without a synth and each platform entry supplies its own
 * (`renderScoreAudio` in `web/` and `rn/`).
 *
 * **What is exported is decided before this is called.** The score passed in is
 * already the export's target — hidden tracks dropped or kept by music_lib's
 * `exportTargetScore` — so there is no scope parameter here; mute and solo, by
 * contrast, are part of how the score sounds and `renderEvents` applies them.
 *
 * It returns PCM and stops. Encoding and writing the file is `music_io`'s
 * (`io.saveAudio`), and neither platform package depends on the other.
 */
import type { DecodedAudio, RenderPlan, Score } from '@sudobility/music_types';
import { renderEvents } from './render-events.js';

/** Anything that turns a render plan into PCM — each platform's `renderSamples`. */
export type PlanRenderer = (plan: RenderPlan) => Promise<DecodedAudio>;

export async function renderScoreWith(
  score: Score,
  render: PlanRenderer
): Promise<DecodedAudio> {
  const audio = await render(renderEvents(score));
  // Only the contract's two fields: a renderer may carry more on its result,
  // and a caller handing this straight to `saveAudio` should not see it.
  return { samples: audio.samples, sampleRate: audio.sampleRate };
}
