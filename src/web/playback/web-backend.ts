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
  outputSnapshot?: () => Record<string, unknown>;
  activateAudio?: () => void;
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

const WEB_AUDIO_DEBUG = '[ScoreSmith audio]';

function debugAudio(message: string, details?: Record<string, unknown>): void {
  if (details) console.info(WEB_AUDIO_DEBUG, message, details);
  else console.info(WEB_AUDIO_DEBUG, message);
}

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
  private outputProbeScheduled = false;
  private removeLifecycleListeners: (() => void) | null = null;

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

  activateAudio(): void {
    this.context ??= this.deps.createContext?.() ?? new AudioContext();
    this.installLifecycleListeners();
    this.deps.host.activateAudio?.();
    debugAudio('audio activated from play gesture', this.contextSnapshot());
    void this.resumeContext();
  }

  async prepare({
    instanceCount,
    onProgress,
  }: {
    instanceCount: number;
    onProgress: (state: PlaybackLoadState) => void;
  }): Promise<PrepareResult> {
    this.context ??= this.deps.createContext?.() ?? new AudioContext();
    this.installLifecycleListeners();
    debugAudio('context created', this.contextSnapshot());
    await this.resumeContext();
    debugAudio('context resume attempted', this.contextSnapshot());
    if (!this.contextCanRun()) {
      // Preload the font and worklet graph while Safari keeps the context
      // suspended. The Play handler resumes the already-built graph from the
      // user's gesture, so the first audible note starts immediately.
      debugAudio(
        'context suspended; preloading synth graph',
        this.contextSnapshot()
      );
    }

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
    // Safari can report a running context before the AudioWorklet graph is
    // connected. Resume once more after the destination exists; this is a
    // no-op elsewhere and recovers contexts that remain output-suspended.
    await this.resumeContext();
    debugAudio('synth graph ready', this.contextSnapshot());
    return 'ready';
  }

  /** Best effort: without a user gesture behind it this is allowed to fail. */
  private async resumeContext(): Promise<void> {
    const context = this.context as
      { state?: string; resume?: () => Promise<void> } | undefined;
    if (!context?.resume || context.state === 'running') return;
    debugAudio('resuming context', this.contextSnapshot());
    try {
      await context.resume();
      debugAudio('context resume resolved', this.contextSnapshot());
    } catch (error) {
      debugAudio('context resume rejected', {
        ...this.contextSnapshot(),
        error: error instanceof Error ? error.message : String(error),
      });
      // No gesture yet. `contextCanRun` will see it and defer the rest.
    }
  }

  private contextSnapshot(): Record<string, unknown> {
    const context = this.context as {
      state?: string;
      sampleRate?: number;
      currentTime?: number;
      baseLatency?: number;
      outputLatency?: number;
      destination?: { maxChannelCount?: number; channelCount?: number };
      audioWorklet?: unknown;
    } | null;
    if (!context) return { exists: false };
    return {
      exists: true,
      state: context.state,
      sampleRate: context.sampleRate,
      currentTime: context.currentTime,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
      maxChannelCount: context.destination?.maxChannelCount,
      channelCount: context.destination?.channelCount,
      hasAudioWorklet: Boolean(context.audioWorklet),
    };
  }

  private installLifecycleListeners(): void {
    if (this.removeLifecycleListeners || typeof document === 'undefined')
      return;
    const context = this.context as
      | (AudioContext & { addEventListener?: typeof document.addEventListener })
      | null;
    if (!context) return;
    const resumeIfVisible = (): void => {
      if (document.visibilityState === 'hidden') return;
      debugAudio(
        'page became active; checking context',
        this.contextSnapshot()
      );
      void this.resumeContext();
    };
    const onStateChange = (): void => {
      debugAudio('context state changed', this.contextSnapshot());
      if (context.state !== 'running') void this.resumeContext();
    };
    document.addEventListener('visibilitychange', resumeIfVisible);
    window.addEventListener('pageshow', resumeIfVisible);
    context.addEventListener?.('statechange', onStateChange);
    this.removeLifecycleListeners = () => {
      document.removeEventListener('visibilitychange', resumeIfVisible);
      window.removeEventListener('pageshow', resumeIfVisible);
      context.removeEventListener?.('statechange', onStateChange);
    };
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
    this.scheduleOutputProbe();
  }
  noteOn(i: number, c: number, m: number, v: number): void {
    this.deps.host.noteOn(i, c, m, v);
    this.scheduleOutputProbe();
  }

  private scheduleOutputProbe(): void {
    if (this.outputProbeScheduled || !this.deps.host.outputSnapshot) return;
    this.outputProbeScheduled = true;
    setTimeout(() => {
      debugAudio('output sample probe', this.deps.host.outputSnapshot?.());
      this.outputProbeScheduled = false;
    }, 150);
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
    this.removeLifecycleListeners?.();
    this.removeLifecycleListeners = null;
    this.deps.host.dispose();
    this.context?.close?.();
    this.context = null;
  }
}
