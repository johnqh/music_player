/**
 * The slice of `react-native-audio-api` this engine uses.
 *
 * Declared structurally rather than imported so the engine can be constructed
 * and driven in a test with a fake, and so this package's own dev tree does not
 * need React Native — the library requires it at import time and cannot run
 * outside a device anyway.
 *
 * Deliberately narrow. Widening it to the library's full surface would invite
 * use of nodes that have not been thought about on this side of the boundary,
 * which is the same reason `rn/types.d.ts` stays minimal.
 */

export type RNAudioBuffer = {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
};

export type RNAudioParam = {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
};

export type RNAudioNode = {
  connect(destination: RNAudioNode): unknown;
  disconnect(): unknown;
};

export type RNGainNode = RNAudioNode & { readonly gain: RNAudioParam };

export type RNBufferSource = RNAudioNode & {
  buffer: RNAudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: RNAudioParam;
  readonly detune: RNAudioParam;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  onEnded?: (() => void) | null;
};

export type RNOscillator = RNAudioNode & {
  readonly frequency: RNAudioParam;
  type: string;
  start(when?: number): void;
  stop(when?: number): void;
};

export type RNStereoPanner = RNAudioNode & { readonly pan: RNAudioParam };

export type RNBiquadFilter = RNAudioNode & {
  type: string;
  readonly frequency: RNAudioParam;
  readonly Q: RNAudioParam;
};

/** The offline context, for export. Same node factories, plus `startRendering`. */
export type RNOfflineAudioContext = {
  readonly destination: RNAudioNode;
  readonly sampleRate: number;
  createGain(): RNGainNode;
  createBufferSource(): RNBufferSource;
  createStereoPanner(): RNStereoPanner;
  createBiquadFilter(): RNBiquadFilter;
  startRendering(): Promise<RNAudioBuffer>;
};

export type RNAudioContext = {
  readonly currentTime: number;
  readonly destination: RNAudioNode;
  readonly sampleRate: number;
  createGain(): RNGainNode;
  createBufferSource(): RNBufferSource;
  createOscillator(): RNOscillator;
  createStereoPanner(): RNStereoPanner;
  createBiquadFilter(): RNBiquadFilter;
  resume(): Promise<void>;
  close(): Promise<void> | void;
};

/** What `rn/playback/sample-engine.ts` needs from the module, and nothing else. */
export type AudioApi = {
  AudioContext: new () => RNAudioContext;
  decodeAudioData(input: ArrayBuffer, sampleRate?: number): Promise<RNAudioBuffer>;
  /** Absent before 0.13; `createRNSoundfontRenderer` says so rather than failing obscurely. */
  OfflineAudioContext?: new (options: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
  }) => RNOfflineAudioContext;
};

/** Loads the real module. Lazy, so importing this package without it present does not throw. */
export async function loadAudioApi(): Promise<AudioApi> {
  const mod = (await import('react-native-audio-api')) as unknown as Partial<AudioApi> & {
    default?: Partial<AudioApi>;
  };
  const AudioContext = mod.AudioContext ?? mod.default?.AudioContext;
  const decodeAudioData = mod.decodeAudioData ?? mod.default?.decodeAudioData;
  const OfflineAudioContext = mod.OfflineAudioContext ?? mod.default?.OfflineAudioContext;
  if (!AudioContext || !decodeAudioData) {
    throw new Error(
      'react-native-audio-api is missing AudioContext or decodeAudioData; playback needs >=0.13.',
    );
  }
  return { AudioContext, decodeAudioData, OfflineAudioContext } as AudioApi;
}
