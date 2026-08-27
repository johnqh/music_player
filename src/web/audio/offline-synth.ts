/**
 * A long-lived synth for offline rendering, loaded once per page.
 *
 * Export cannot share playback's synth: Web Audio nodes belong to the context
 * that created them, playback runs on a realtime `AudioContext`, and rendering
 * faster than realtime needs an `OfflineAudioContext`. Nothing bridges the two.
 * Worse, an `OfflineAudioContext` renders exactly once, so the previous design
 * built a fresh worklet and reloaded the 23MB soundfont on *every export* —
 * about five seconds each time, with libfluidsynth's build-stub notices along
 * for the ride.
 *
 * `Synthesizer.render()` avoids all of it by needing no audio context at all:
 * it fills buffers straight from the WASM synth. So one synth is built, the
 * font is loaded into it once, and every export after the first is immediate.
 *
 * This one runs on the main thread rather than in a worklet, which is fine
 * precisely because it is offline — there is no audio callback to starve.
 */
import { CHANNELS_PER_INSTANCE } from '../../playback/channel-allocator.js';
import { seedMainThreadQuietModule } from '../playback/quiet-stub-notices.js';
import type { SynthesizerLike } from './synth-types.js';

/** Matches playback's ceiling, so an export sounds like what was heard. */
const OFFLINE_POLYPHONY = 2048;

/** Resolves once `libfluidsynth-*.js` has been loaded and its WASM is ready. */
let fluidsynthReady: Promise<void> | null = null;
/** The loaded synth, keyed so a changed font or rate rebuilds rather than lying. */
let cached: { key: string; synth: Promise<LoadedOfflineSynth> } | null = null;

export type LoadedOfflineSynth = {
  synth: SynthesizerLike;
  sfontId: number;
  sampleRate: number;
};

/**
 * Loads libfluidsynth into the *main thread*.
 *
 * A script tag rather than `addModule`: the non-worklet synth reads the module
 * from the global scope, where `addModule` would put it inside the worklet
 * instead. Memoised, since loading it twice would replace the global mid-flight.
 */
async function ensureFluidsynth(moduleUrl: string): Promise<void> {
  fluidsynthReady ??= (async () => {
    if (typeof document === 'undefined') {
      throw new Error('Offline rendering needs a document to load libfluidsynth');
    }
    // Before the script runs: emscripten reads the global Module on load.
    seedMainThreadQuietModule();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = moduleUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${moduleUrl}`));
      document.head.appendChild(script);
    });
    const jsSynth = await import('js-synthesizer');
    await jsSynth.waitForReady();
  })();
  return fluidsynthReady;
}

export type OfflineSynthRequest = {
  fluidsynthModuleUrl: string;
  fontUrl: string;
  loadFont: (url: string) => Promise<ArrayBuffer>;
  sampleRate: number;
  /**
   * Builds the synth. Injected only by tests — the real path first loads
   * libfluidsynth into the page through a script tag, which a unit test has no
   * way to satisfy. Supplying this skips that bring-up, the same seam
   * `SynthHost` exposes for the same reason.
   */
  createSynth?: () => SynthesizerLike;
};

/** The shared offline synth, building it on first use. */
export async function getOfflineSynth(request: OfflineSynthRequest): Promise<LoadedOfflineSynth> {
  const key = `${request.fluidsynthModuleUrl}|${request.fontUrl}|${request.sampleRate}`;
  if (cached?.key === key) return await cached.synth;

  const building = (async (): Promise<LoadedOfflineSynth> => {
    let synth: SynthesizerLike;
    if (request.createSynth) {
      synth = request.createSynth();
    } else {
      await ensureFluidsynth(request.fluidsynthModuleUrl);
      const jsSynth = await import('js-synthesizer');
      synth = new jsSynth.Synthesizer() as unknown as SynthesizerLike;
    }
    // The same channel count playback uses, because both share
    // `allocateChannels`: on a 16-channel synth an export would address
    // channels that do not exist and silently lose every track past the
    // sixteenth. Polyphony matches too, so an export sounds like what was heard.
    synth.init(request.sampleRate, {
      midiChannelCount: CHANNELS_PER_INSTANCE,
      polyphony: OFFLINE_POLYPHONY,
    });
    const sfontId = await synth.loadSFont(await request.loadFont(request.fontUrl));
    return { synth, sfontId, sampleRate: request.sampleRate };
  })();

  cached = { key, synth: building };
  try {
    return await building;
  } catch (error) {
    cached = null; // a failed build must not be handed to the next caller
    throw error;
  }
}

/** Drops the shared synth. Exposed for tests and teardown, not used in normal flow. */
export function releaseOfflineSynth(): void {
  cached = null;
}
