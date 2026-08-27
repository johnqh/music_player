/**
 * The web player: libfluidsynth (WebAssembly) inside an `AudioWorklet`.
 *
 * Resolved by any bundler that is not Metro, through the `default` branch of
 * this package's export condition.
 */
import { SoundfontPlaybackEngine } from '../playback/soundfont-engine.js';
import { WebSynthBackend } from './playback/web-backend.js';
import { SynthHost } from './playback/synth-host.js';
import type { SynthInstance } from './playback/synth-host.js';
import {
  loadSoundfont,
  openSoundfontCache,
} from './playback/soundfont-loader.js';
import { createSoundfontRenderer } from './audio/soundfont-render.js';
import { MusicPlayer } from '../player.js';

export * from '../types.js';
export * from '../singleton.js';
export { MusicPlayer };
export { renderEvents } from '../shared/render-events.js';
export { playbackPlan, playbackTracks, resolveVoice } from '../shared/plan.js';

/**
 * Builds one real `AudioWorkletNodeSynthesizer`.
 *
 * The only place `js-synthesizer` is constructed, and the import is lazy so an
 * app that never plays anything does not pull it in. Async by design: a
 * synchronous factory would need the module loaded first, and a caller
 * forgetting that step would fail at init with no sound and no obvious cause —
 * the failure shape this engine exists to remove.
 */
async function createWorkletSynth(): Promise<SynthInstance> {
  const { AudioWorkletNodeSynthesizer } = await import('js-synthesizer');
  return new AudioWorkletNodeSynthesizer() as unknown as SynthInstance;
}

/**
 * Where the soundfont engine's assets are served from.
 *
 * Passed in rather than resolved here: this is a library and cannot assume how
 * a consuming app serves files out of `node_modules`. The worklet modules in
 * particular must be reachable as URLs, because `addModule` takes a URL.
 *
 * Required, not optional: the soundfont synth is the only engine. There is no
 * silent fallback to be had, and an app that has not hosted the assets should
 * fail loudly at wiring time rather than mysteriously play nothing.
 */
export type SoundfontAssets = {
  /** The `-with-libsndfile` build. The plain one cannot read SF3. */
  fluidsynthModuleUrl: string;
  workletModuleUrl: string;
  fontUrl: string;
};

/** The web player, built fresh. Hand it to `initializeMusicPlayer`. */
export function createMusicPlayer({
  soundfont,
}: {
  soundfont: SoundfontAssets;
}): MusicPlayer {
  return new MusicPlayer(
    new SoundfontPlaybackEngine({
      backend: new WebSynthBackend({
        host: new SynthHost({ createSynth: createWorkletSynth }),
        moduleUrls: {
          fluidsynth: soundfont.fluidsynthModuleUrl,
          worklet: soundfont.workletModuleUrl,
        },
        fontUrl: soundfont.fontUrl,
      }),
    })
  );
}

/**
 * Renders a plan to PCM, faster than realtime.
 *
 * Through the same soundfont as playback, so a file is a recording of what was
 * heard — two voicing paths drift apart the first time one is tuned. The synth
 * *plumbing* differs because it must: playback runs on a realtime
 * `AudioContext` and rendering needs no context at all, and nothing bridges the
 * two. What is shared is the voicing, which is the part that matters.
 *
 * The caller encodes and saves; this package does not touch files.
 */
export function renderSamples(soundfont: SoundfontAssets) {
  return createSoundfontRenderer({
    fluidsynthModuleUrl: soundfont.fluidsynthModuleUrl,
    fontUrl: soundfont.fontUrl,
    loadFont: async url =>
      loadSoundfont(url, { cache: await openSoundfontCache() }),
  });
}
