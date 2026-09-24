/**
 * Keeping what you see in step with what you hear.
 *
 * Every visual driven by playback — the lit keys, the note highlighting, and
 * the caret — has to match audio that is already committed to a hardware
 * buffer, and getting that right means holding two delays that point in
 * *opposite* directions:
 *
 * - **Render.** Publishing a sounding set is not painting a pixel. A commit and
 *   a paint follow, about a frame later, so the light appears after the moment
 *   it describes. This makes the keyboard LATE.
 * - **Output latency.** An audio context's `currentTime` is the time the graph
 *   is *scheduling*, not the time the room hears. A sample scheduled at S is
 *   not audible until `currentTime` reaches S + `outputLatency`, so a set
 *   advanced to the raw position describes music the listener has not reached
 *   yet. This makes the keyboard EARLY.
 *
 * So the offset is the *difference*, and the sign is the easy thing to get
 * backwards: correcting for output latency alone pushes the visuals later,
 * which is the direction the original complaint already pointed. On a machine
 * reporting ~20ms the two nearly cancel; where a platform reports no latency
 * at all it reads 0 and the render delay stands alone.
 *
 * Both engines use this, so web and React Native cannot drift apart on it —
 * **and both visuals use it**, which is the part that was missing. It was
 * applied to the sounding set alone, so the caret ran on scheduling time while
 * the lit keys ran on listening time: the caret sat ahead of the sound by the
 * output latency, and ahead of the very notes it was pointing at. Two visuals
 * off the same clock disagreeing with each other is worse than either being
 * wrong, which is why there is one offset rather than one per consumer.
 */

/**
 * How often the lit keys are recomputed — deliberately not how often audio is
 * scheduled.
 *
 * Scheduling works off a lookahead horizon, so its interval decides work per
 * wake rather than whether a note is on time; 50ms is right there and wrong
 * here. Running this often is nearly free: `SoundingSet.advanceTo` is two
 * cursors over sorted arrays and returns `null` when nothing changed, so
 * consumers see exactly as many updates as before — the same note-ons and
 * note-offs, delivered sooner.
 */
export const SOUNDING_INTERVAL_MS = 16;

/**
 * Runs `tick` once per displayed frame, for the lit keys.
 *
 * A `setInterval` at frame rate is a request the main thread grants only when
 * it is idle. With a WebGL view rendering every frame beside the keyboard —
 * the Spatial stage — each frame's `requestAnimationFrame` work, layout and
 * paint run first and the timer fires in whatever is left, so under load the
 * lit keys slipped a frame or more behind the sound while the notes it was
 * sampling had already been played. Measured as "obviously lagging" with the
 * Spatial view open and fine without it.
 *
 * `requestAnimationFrame` *is* the frame: it runs at the start of every one
 * the browser draws, ahead of that frame's paint, so a set advanced here is
 * committed and painted in the same frame — the publish-to-paint the render
 * delay assumes, rather than that plus the wait for the next timer slot.
 * React Native has it too, on the JS thread, and it pauses in a background
 * tab where there is nothing to light anyway; the scheduling pump still calls
 * `reportSounding` on its own 50ms cadence, so the set keeps advancing there
 * and simply publishes less often. Where the platform has no
 * `requestAnimationFrame` at all, the interval stands.
 */
export function startSoundingTicker(tick: () => void): () => void {
  if (
    typeof requestAnimationFrame !== 'function' ||
    typeof cancelAnimationFrame !== 'function'
  ) {
    const id = setInterval(tick, SOUNDING_INTERVAL_MS);
    return () => clearInterval(id);
  }
  let handle = requestAnimationFrame(function frame() {
    // Re-armed before the tick runs, so a tick that throws — guarded by the
    // engines, but the point of the guard is that it should not matter —
    // never ends the loop.
    handle = requestAnimationFrame(frame);
    tick();
  });
  return () => cancelAnimationFrame(handle);
}

/**
 * The engines' default lit-keys ticker: frame-paced, unless the host supplied
 * its own pump timer, in which case that timer at `SOUNDING_INTERVAL_MS` — a
 * host or test that owns the engine's timing owns all of it, and a test that
 * steps the pump by hand must be able to step the lights the same way.
 */
export function soundingTickerFrom(
  startPump: ((tick: () => void, intervalMs: number) => () => void) | undefined
): (tick: () => void) => () => void {
  if (!startPump) return startSoundingTicker;
  return tick => startPump(tick, SOUNDING_INTERVAL_MS);
}

/** Publish-to-paint: a React commit and a browser paint, about one frame. */
export const RENDER_DELAY_SECONDS = 0.016;

/**
 * Half the lit-keys cadence: the mean age of a note boundary when the ticker
 * first sees it.
 *
 * The ticker samples; it does not wake on a boundary. A note starting between
 * two samples is noticed anywhere from 0 to one interval late, uniformly, so
 * leading by half of it centres that error on zero instead of leaving the
 * whole of it on the late side. The render delay cannot absorb this because
 * the host measures that from publish to paint, and the sampling delay is
 * spent before the publish.
 */
export const SOUNDING_SAMPLING_LEAD_SECONDS = SOUNDING_INTERVAL_MS / 2 / 1000;

/**
 * What to add to the scheduling position to get the position to *show*, in
 * the position's own units — playback seconds.
 *
 * Applies to every playback-driven visual: which notes are sounding, and where
 * the caret is.
 *
 * Both delays are real time — a frame is a frame and a hardware buffer is a
 * hardware buffer however fast the piece is played — but the position they
 * correct runs at the transport's speed, so the correction is scaled by it
 * before it is added. This used to be skipped as a "known simplification,
 * ~8ms at 2x", an estimate made as if output latency were zero: with a real
 * one the error is `(render - latency) * (1 - 1/speed)` in real time, which
 * on Bluetooth headphones (~150ms) at half-speed practice is ~130ms LATE —
 * the keyboard visibly behind the sound in exactly the mode a musician slows
 * down to watch it.
 */
export function visualOffsetSeconds(
  outputLatency?: number,
  /**
   * Publish-to-paint for the visual this position is for. Defaults to one
   * frame; the lit notes use what the host measured (see
   * `soundingRenderDelayOrDefault`).
   */
  renderDelaySeconds: number = RENDER_DELAY_SECONDS,
  /** The transport's tempo multiplier; playback seconds per real second. */
  speed: number = 1
): number {
  const latency =
    typeof outputLatency === 'number' &&
    Number.isFinite(outputLatency) &&
    outputLatency >= 0
      ? outputLatency
      : 0;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return (renderDelaySeconds - latency) * rate;
}

/**
 * `visualOffsetSeconds` for the lit notes specifically: the same two delays,
 * plus the half-interval the sounding ticker takes on average to notice a
 * boundary. The caret does not take this term — it dead-reckons between
 * reports rather than waiting to be told, so it has no sampling delay to
 * centre.
 */
export function soundingOffsetSeconds(
  outputLatency: number | undefined,
  renderDelaySeconds: number,
  speed: number = 1
): number {
  return visualOffsetSeconds(
    outputLatency,
    renderDelaySeconds + SOUNDING_SAMPLING_LEAD_SECONDS,
    speed
  );
}

/**
 * The longest publish-to-paint a host may claim.
 *
 * A measurement is only ever a few frames; anything past this is a stall being
 * mistaken for the pipeline, and leading the lights by it would light notes
 * that are nowhere near sounding.
 */
export const MAX_SOUNDING_RENDER_DELAY_SECONDS = 0.25;

/**
 * How far ahead the lit notes are published: what the host measured drawing
 * them takes, or one frame when it has said nothing believable.
 *
 * The lit notes, not the caret, because the two are drawn by different
 * pipelines. On the web both are cheap. In the native app a change of lit
 * notes re-records the notation as a Skia picture and waits a React commit —
 * measured at 45–70ms on a dense score — while the caret is moved by a native
 * view with no JavaScript in the frame. One shared figure would put one of them
 * out of step with the sound.
 */
export function soundingRenderDelayOrDefault(seconds: number): number {
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds, MAX_SOUNDING_RENDER_DELAY_SECONDS)
    : RENDER_DELAY_SECONDS;
}

/**
 * The previous name, kept as an alias.
 *
 * It named the one consumer it had rather than the correction it performs,
 * which is how the caret came to be left out of it.
 */
export const visualSoundingOffsetSeconds = visualOffsetSeconds;
