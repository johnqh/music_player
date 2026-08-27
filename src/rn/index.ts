/**
 * The React Native player: a sample-based FluidR3 engine.
 *
 * Playback is samples rather than the web's libfluidsynth-in-an-AudioWorklet —
 * React Native has neither WebAssembly nor `addModule`, so that engine cannot
 * be ported, only replaced. It is replaced with the *same font*, pre-rendered
 * per note, so a phone plays the recordings a browser plays. See
 * `playback/sample-engine.ts`.
 */
import { RNSamplePlaybackEngine } from './playback/sample-engine.js';
import { createRNSoundfontRenderer } from './audio/offline-render.js';
import { MusicPlayer } from '../player.js';

export * from '../types.js';
export * from '../singleton.js';
export { MusicPlayer, RNSamplePlaybackEngine, createRNSoundfontRenderer };
/**
 * The native soundfont path: a `SynthBackend` over a platform synth, driven by
 * the same scheduler the browser uses. Beside the sample engine rather than
 * replacing it — that one needs no native module at all, which is what makes
 * it the right default on a phone.
 */
export { NativeSynthBackend } from './playback/native-backend.js';
export type {
  NativeSynth,
  NativeSynthApi,
  NativeSynthSettings,
} from './playback/native-synth-api.js';
export { SoundfontPlaybackEngine } from '../playback/soundfont-engine.js';
export type {
  SynthBackend,
  ScheduledClick,
  PrepareResult,
} from '../playback/synth-backend.js';
export { renderEvents } from '../shared/render-events.js';
export { playbackPlan, playbackTracks, resolveVoice } from '../shared/plan.js';
/**
 * `expression-table` is deliberately *not* re-exported here: the app that owns
 * the soundfont needs `MEASURED_FROM_SHA256` to check the two still agree, and
 * reaching it through this entry drags in the RN optional peers, which a web
 * app does not install. It has its own dependency-free subpath,
 * `@sudobility/music_player/rn/expression-table`.
 */

export type RNMusicPlayerOptions = {
  /**
   * Where the instrument packs are served from. An app that would rather not
   * depend on a third party at runtime can copy them and point this at its own
   * CDN — they are CC-BY 3.0, so that is allowed, and it is the recommended
   * setup for anything shipping to a store.
   */
  packBase?: string;
  /**
   * Reads a pack body, given the URL `packBase`/`percussionBase` produced.
   *
   * The reason this is a function rather than only a base URL: a shipped native
   * app should carry its instruments *inside* the bundle, and a bundled file is
   * not something `fetch` can read — React Native's `fetch` does not handle
   * `file://` on either platform. An app that copies the packs into its own
   * bundle supplies this and reads them off disk, and then pressing play needs
   * no network at all: no third-party host to be down, nothing to tell that
   * host who is playing what, and no wait on a first note.
   *
   * Defaults to `fetch`, which is what a web-ish build or a self-hosted CDN
   * wants. The URL is still built by `packBase`/`percussionBase`, so a loader
   * only has to map a URL to bytes however its platform likes.
   */
  fetchPack?: (url: string) => Promise<string>;
  /**
   * Where the drum-kit packs are served from. **Required for percussion**;
   * there is no default because nobody publishes usably-licensed GM percussion.
   */
  percussionBase?: string;
};

/** The React Native player, built fresh. Hand it to `initializeMusicPlayer`. */
export function createMusicPlayer(
  options: RNMusicPlayerOptions = {}
): MusicPlayer {
  return new MusicPlayer(
    new RNSamplePlaybackEngine({
      packBase: options.packBase,
      percussionBase: options.percussionBase,
      ...(options.fetchPack ? { fetchPack: options.fetchPack } : {}),
    })
  );
}

/**
 * Renders a plan to PCM, faster than realtime.
 *
 * Scheduled up front against an `OfflineAudioContext` rather than in real time.
 * Sharing `PackLibrary` and `planVoice` with the engine is what keeps the file
 * a recording of what was heard. The caller encodes and saves; this package
 * does not touch files.
 */
export function renderSamples(options: RNMusicPlayerOptions = {}) {
  return createRNSoundfontRenderer({
    packBase: options.packBase,
    percussionBase: options.percussionBase,
    // The same loader as live playback, for the same reason the bases are
    // shared: an exported file has to be a recording of what was heard, and a
    // renderer reading different bytes is a different instrument.
    ...(options.fetchPack ? { fetchPack: options.fetchPack } : {}),
  }).render;
}
