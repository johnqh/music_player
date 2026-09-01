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

/** Publish-to-paint: a React commit and a browser paint, about one frame. */
export const RENDER_DELAY_SECONDS = 0.016;

/**
 * What to add to the scheduling position to get the position to *show*.
 *
 * Applies to every playback-driven visual: which notes are sounding, and where
 * the caret is.
 *
 * Known simplification: the offset is applied in playback seconds without
 * scaling by the transport's speed, so at 2x it is out by about 8ms. Both
 * engines share the simplification deliberately — being more correct in one
 * than the other is worse than being consistent, and 8ms at double speed is
 * below what the eye resolves against a moving caret.
 */
export function visualOffsetSeconds(outputLatency?: number): number {
  const latency =
    typeof outputLatency === 'number' &&
    Number.isFinite(outputLatency) &&
    outputLatency >= 0
      ? outputLatency
      : 0;
  return RENDER_DELAY_SECONDS - latency;
}

/**
 * The previous name, kept as an alias.
 *
 * It named the one consumer it had rather than the correction it performs,
 * which is how the caret came to be left out of it.
 */
export const visualSoundingOffsetSeconds = visualOffsetSeconds;
