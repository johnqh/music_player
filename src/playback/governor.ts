/**
 * Adaptive quality — currently measuring, not acting.
 *
 * This used to step interpolation order down after ten consecutive pump frames
 * more than 100ms late, on the reasoning that a starved pump meant a starved
 * synth. `setInterpolation(0)` renders the same passage in 53% of the time, so
 * the knob is real, and timbre is the right thing to shed first.
 *
 * The scheduling horizon killed the reasoning. The pump no longer delivers
 * notes on time — it tops up a four-second buffer in the worklet, and the
 * synth renders from that buffer on the audio thread. The main thread can now
 * stall for a second with nothing audible happening at all, so lateness here
 * says only that the main thread is busy. Degrading timbre for every listener
 * because a notation redraw took 119ms is a cost with no benefit.
 *
 * So the count is kept and nothing acts on it. It is free, and it is the shape
 * a real audio-thread load signal would take. `AudioWorkletNode` exposes no
 * such signal today, and `AudioContext` offers only latency figures that do not
 * move under voice pressure; when one exists, it plugs in here.
 *
 * Polyphony was to be the other rung. `js-synthesizer` has no runtime setter
 * for it — `ISynthesizer` has `setInterpolation` and `setGain` and nothing else
 * — so the ceiling is chosen once at init in `synth-host.ts` and fluidsynth's
 * own overflow priority does the stealing above it.
 */
export type GovernorOptions = {
  onChange?: (interpolationOrder: number) => void;
};

/** fluidsynth's interpolation orders, best first. */
const LADDER = [7, 4, 1, 0];
/** How late a pump frame must be to count against the budget. */
const LATE_THRESHOLD_SECONDS = 0.1;

export class Governor {
  private lateFrames = 0;

  constructor(private readonly options: GovernorOptions = {}) {}

  get interpolation(): number {
    return LADDER[0];
  }

  /** Consecutive frames measured late. Diagnostic; nothing acts on it. */
  get stalledFrames(): number {
    return this.lateFrames;
  }

  /**
   * One pump frame's lateness, in seconds.
   *
   * Counted, never acted on — see this module's doc for why. `options.onChange`
   * is therefore never invoked; it is kept so the caller's wiring survives
   * whatever replaces this signal.
   */
  record(lateBySeconds: number): void {
    if (lateBySeconds > LATE_THRESHOLD_SECONDS) {
      this.lateFrames += 1;
      return;
    }
    this.lateFrames = 0;
  }
}
