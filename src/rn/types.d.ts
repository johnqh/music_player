/**
 * Type stubs for the React Native native modules this entry uses.
 *
 * Declared here rather than installed, following the same convention as
 * `@sudobility/di`'s `src/rn/types.d.ts`: pulling in `react-native-fs` and
 * `react-native-share` for their types would drag `react-native` itself into
 * this package's dev tree for no benefit, since neither can run outside a
 * device anyway. They are optional peers; a React Native app supplies the real
 * ones.
 *
 * Only the members `file.rn.ts` actually calls are declared. Widening these to
 * the libraries' full APIs would invite use of members that have not been
 * thought about on this side of the boundary.
 */
declare module 'react-native-audio-api' {
  /**
   * The shape `decodeAudioData` resolves with: `AudioBuffer`-compatible, which
   * is what lets `shared/audio/mp3.ts`'s mixdown take it and the browser's
   * `AudioBuffer` alike.
   */
  export interface AudioBuffer {
    readonly length: number;
    readonly numberOfChannels: number;
    readonly sampleRate: number;
    readonly duration: number;
    getChannelData(channel: number): Float32Array;
  }

  /**
   * Hands the bytes to the OS decoder — AVFoundation on iOS, MediaCodec on
   * Android — so it reads wav, mp3 and `.mpa` without this package bundling a
   * decoder, exactly as `AudioContext.decodeAudioData` does on the web.
   *
   * Added in 0.13; the peer range says so, and `rn/audio-codec.ts` reports a
   * missing export as a version problem rather than a mysterious undefined.
   */
  export function decodeAudioData(
    input: ArrayBuffer,
    sampleRate?: number
  ): Promise<AudioBuffer>;

  /**
   * The nodes `playback/sample-engine.ts` builds a voice out of.
   *
   * Still only what is actually touched. The engine talks to the module through
   * `playback/audio-api.ts`'s structural types, so this declaration exists to
   * let the lazy `import('react-native-audio-api')` typecheck, not to describe
   * the library.
   */
  export class AudioContext {
    readonly currentTime: number;
    readonly destination: unknown;
    readonly sampleRate: number;
    createGain(): unknown;
    createBufferSource(): unknown;
    createOscillator(): unknown;
    resume(): Promise<void>;
    close(): Promise<void>;
  }
}

declare module 'react-native-fs' {
  export type ReadDirItem = {
    name: string;
    path: string;
    mtime?: Date | null;
  };
  export const CachesDirectoryPath: string;
  export function mkdir(path: string): Promise<void>;
  export function readDir(path: string): Promise<ReadDirItem[]>;
  export function unlink(path: string): Promise<void>;
  export function writeFile(
    path: string,
    contents: string,
    encoding: string
  ): Promise<void>;
  const RNFS: {
    CachesDirectoryPath: string;
    mkdir: typeof mkdir;
    readDir: typeof readDir;
    unlink: typeof unlink;
    writeFile: typeof writeFile;
  };
  export default RNFS;
}

declare module 'react-native-share' {
  export type ShareOpenOptions = {
    url?: string;
    type?: string;
    failOnCancel?: boolean;
  };
  const Share: { open(options: ShareOpenOptions): Promise<unknown> };
  export default Share;
}
