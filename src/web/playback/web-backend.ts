/**
 * A `SynthBackend` over the browser: an `AudioContext`, js-synthesizer behind
 * `SynthHost`, the cached soundfont fetch, and the oscillator click.
 *
 * All four used to live inside the scheduler, which is what made the scheduler
 * web-only despite being almost entirely about ticks and tempo. They are here
 * now, so the same scheduler runs against a native synth unchanged.
 *
 * The context lifecycle is the part with a rule worth keeping in one place. A
 * browser starts an `AudioContext` **suspended** unless it was created during
 * a user gesture, and a suspended context never runs its `AudioWorklet` — so
 * the font load round-trips into a promise that never settles rather than
 * failing. That is why `prepare` answers `deferred` instead of throwing: the
 * caller does the cheap part and tries again from the next gesture.
 */
import type {
  PrepareResult,
  ScheduledClick,
  SynthBackend,
} from '../../playback/synth-backend.js';
import type { PlaybackLoadState } from '@sudobility/music_types';
import { scheduleClick } from './click.js';
import { loadSoundfont, openSoundfontCache } from './soundfont-loader.js';
import type { LoadProgress } from './soundfont-loader.js';

/** The slice of `SynthHost` this backend drives, so tests can pass a stub. */
export type SynthHostLike = {
  init(
    context: BaseAudioContext,
    options: {
      fluidsynthModuleUrl: string;
      workletModuleUrl: string;
      soundfont: ArrayBuffer;
      instanceCount: number;
    }
  ): Promise<void>;
  ensureInstances(count: number): Promise<void>;
  setChannelPercussion(instance: number, channel: number, kit?: number): void;
  programSelect(instance: number, channel: number, program: number): void;
  noteOn(
    instance: number,
    channel: number,
    midi: number,
    velocity: number
  ): void;
  noteAt(
    instance: number,
    channel: number,
    midi: number,
    velocity: number,
    delaySeconds: number,
    durationSeconds: number
  ): void;
  noteOff(instance: number, channel: number, midi: number): void;
  controlChange(
    instance: number,
    channel: number,
    control: number,
    value: number
  ): void;
  allSoundOff(): void;
  setInterpolation(order: number): void;
  setMasterVolume(volume: number): void;
  setTrackCount(count: number): void;
  dispose(): void;
};

export type WebBackendDeps = {
  host: SynthHostLike;
  moduleUrls: { fluidsynth: string; worklet: string };
  fontUrl: string;
  loadFont?: (
    url: string,
    onProgress?: (progress: LoadProgress) => void
  ) => Promise<ArrayBuffer>;
  createContext?: () => AudioContext;
};

/**
 * Fetching is the measurable half of the load; handing the bytes to fluidsynth
 * takes seconds more and reports nothing. So the bar is held below halfway
 * until the fetch is done, rather than sitting at "done" through the decode.
 */
const FETCH_SHARE = 0.5;

export class WebSynthBackend implements SynthBackend {
  private readonly deps: Required<
    Pick<WebBackendDeps, 'host' | 'moduleUrls' | 'fontUrl' | 'loadFont'>
  > &
    WebBackendDeps;
  private context: AudioContext | null = null;

  constructor(deps: WebBackendDeps) {
    this.deps = {
      ...deps,
      loadFont:
        deps.loadFont ??
        (async (url, onProgress) =>
          loadSoundfont(url, {
            cache: await openSoundfontCache(),
            onProgress,
          })),
    };
  }

  async prepare({
    instanceCount,
    onProgress,
  }: {
    instanceCount: number;
    onProgress: (state: PlaybackLoadState) => void;
  }): Promise<PrepareResult> {
    this.context ??= this.deps.createContext?.() ?? new AudioContext();
    await this.resumeContext();
    if (!this.contextCanRun()) return 'deferred';

    onProgress({ status: 'loading', fraction: 0 });
    const soundfont = await this.deps.loadFont(
      this.deps.fontUrl,
      ({ loaded, total }) => {
        onProgress({
          status: 'loading',
          fraction: total > 0 ? (loaded / total) * FETCH_SHARE : null,
        });
      }
    );
    // Busy, no idea how long — which is the honest answer for the decode.
    onProgress({ status: 'loading', fraction: null });
    await this.deps.host.init(this.context, {
      fluidsynthModuleUrl: this.deps.moduleUrls.fluidsynth,
      workletModuleUrl: this.deps.moduleUrls.worklet,
      soundfont,
      instanceCount,
    });
    return 'ready';
  }

  /** Best effort: without a user gesture behind it this is allowed to fail. */
  private async resumeContext(): Promise<void> {
    const context = this.context as
      { state?: string; resume?: () => Promise<void> } | undefined;
    if (!context?.resume || context.state === 'running') return;
    try {
      await context.resume();
    } catch {
      // No gesture yet. `contextCanRun` will see it and defer the rest.
    }
  }

  /** A stub context in a test has no `state`; only a real suspended one blocks. */
  private contextCanRun(): boolean {
    const state = (this.context as { state?: string } | undefined)?.state;
    return state === undefined || state === 'running';
  }

  now(): number {
    return this.context?.currentTime ?? 0;
  }

  outputLatency(): number | undefined {
    return this.context?.outputLatency;
  }

  scheduleClick(atSeconds: number, accent: boolean): ScheduledClick {
    if (!this.context) return { endsAt: atSeconds, cancel: () => undefined };
    return scheduleClick(
      this.context,
      this.context.destination,
      atSeconds,
      accent
    );
  }

  ensureInstances(count: number): Promise<void> {
    return this.deps.host.ensureInstances(count);
  }
  noteAt(
    i: number,
    c: number,
    m: number,
    v: number,
    delay: number,
    dur: number
  ): void {
    this.deps.host.noteAt(i, c, m, v, delay, dur);
  }
  noteOn(i: number, c: number, m: number, v: number): void {
    this.deps.host.noteOn(i, c, m, v);
  }
  noteOff(i: number, c: number, m: number): void {
    this.deps.host.noteOff(i, c, m);
  }
  programSelect(i: number, c: number, program: number): void {
    this.deps.host.programSelect(i, c, program);
  }
  setChannelPercussion(i: number, c: number, kit?: number): void {
    this.deps.host.setChannelPercussion(i, c, kit);
  }
  controlChange(i: number, c: number, control: number, value: number): void {
    this.deps.host.controlChange(i, c, control, value);
  }
  allSoundOff(): void {
    this.deps.host.allSoundOff();
  }
  setInterpolation(order: number): void {
    this.deps.host.setInterpolation(order);
  }
  setMasterVolume(volume: number): void {
    this.deps.host.setMasterVolume(volume);
  }
  setTrackCount(count: number): void {
    this.deps.host.setTrackCount(count);
  }

  dispose(): void {
    this.deps.host.dispose();
    this.context?.close?.();
    this.context = null;
  }
}
