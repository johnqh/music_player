/**
 * Fetching, decoding and caching sample packs — shared by live playback and
 * offline rendering, so an exported file cannot be voiced differently from what
 * was heard.
 *
 * Holds the two rules that decide *which* sample sounds:
 *
 * - a pitched note takes the nearest sample and bends it (normally by nothing,
 *   since the FluidR3 packs cover every key);
 * - a drum takes its exact slot or nothing, because a note number in a kit
 *   names an instrument rather than a pitch.
 */
import { exactSample, nearestSample, parseSamplePack, sampleUrlFor } from './sample-pack.js';
import type { SampleChoice, SamplePack } from './sample-pack.js';
import type { RNAudioBuffer } from './audio-api.js';
import { base64ToBytes } from '@sudobility/music_types';

export type PackLibraryDeps = {
  fetchPack: (url: string) => Promise<string>;
  decodeAudioData: (bytes: ArrayBuffer) => Promise<RNAudioBuffer>;
  /** Melodic packs. Defaults to the pre-rendered FluidR3 collection's own host. */
  packBase?: string;
  /** Drum kits. No default: these are app-hosted, since no CDN publishes usably-licensed GM percussion. */
  percussionBase?: string;
};

export type Voicing = { choice: SampleChoice; buffer: RNAudioBuffer };

export class PackLibrary {
  private readonly packs = new Map<string, SamplePack>();
  private readonly buffers = new Map<string, Map<number, RNAudioBuffer>>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: PackLibraryDeps) {}

  /** True once `name` is decoded and ready to voice notes from. */
  has(name: string): boolean {
    return this.buffers.has(name);
  }

  /** Where a pack lives. Kits and instruments come from different places. */
  urlFor(name: string): string {
    if (!name.startsWith('percussion_')) return sampleUrlFor(name, this.deps.packBase);
    if (!this.deps.percussionBase) {
      throw new Error(
        'Percussion needs `percussionBase`: drum kits are app-hosted, since no CDN publishes ' +
          'usably-licensed GM percussion. Build them with music_io/scripts/build-percussion-packs.mjs.',
      );
    }
    return sampleUrlFor(name, this.deps.percussionBase);
  }

  /**
   * Fetches, parses and decodes one pack, at most once.
   *
   * De-duplicated by name *and* in flight: a score with two violin parts, or a
   * play racing an audition of the same instrument, must not each start their
   * own download of the same 2.7MB.
   */
  ensure(name: string): Promise<void> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;

    const work = (async () => {
      const pack = parseSamplePack(await this.deps.fetchPack(this.urlFor(name)));
      const decoded = new Map<number, RNAudioBuffer>();
      for (const [midi, uri] of pack.samples) {
        decoded.set(midi, await this.deps.decodeAudioData(dataUriToBytes(uri)));
      }
      this.packs.set(name, pack);
      this.buffers.set(name, decoded);
    })();

    this.inFlight.set(name, work);
    return work;
  }

  /** The sample and buffer that sound `midi` from `name`, or null if nothing does. */
  voice(name: string, midi: number, isPercussion: boolean): Voicing | null {
    const pack = this.packs.get(name);
    const decoded = this.buffers.get(name);
    if (!pack || !decoded) return null;

    const choice = isPercussion ? exactSample(pack, midi) : nearestSample(pack, midi);
    if (!choice) return null;
    const buffer = decoded.get(choice.midi);
    return buffer ? { choice, buffer } : null;
  }
}

/**
 * `data:audio/mp3;base64,...` -> bytes, without `atob` or `Buffer`.
 *
 * Hermes has neither reliably, and the decoder needs an ArrayBuffer regardless.
 */
export function dataUriToBytes(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URI in sample pack.');
  return base64ToBytes(uri.slice(comma + 1));
}

export { base64ToBytes };
