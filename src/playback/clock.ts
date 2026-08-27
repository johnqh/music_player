/**
 * Playback position, owned here rather than by Tone's Transport.
 *
 * `now` is injected: the engine passes the AudioContext's `currentTime`, so
 * position is measured on the very clock the audio is rendered against, and
 * tests pass a variable they control instead of waiting for real time.
 *
 * Everything works by anchoring — a position and the moment it was true —
 * rather than by accumulating deltas. Accumulation drifts, and drift in the
 * playback clock is what silenced tracks in the engine this replaces.
 */
export class PlaybackClock {
  private running = false;
  private anchorNow = 0;
  private anchorPosition = 0;
  private rate = 1;

  constructor(private readonly now: () => number) {}

  /** Starts, or resumes from wherever it was paused. `fromSeconds` overrides that. */
  start(fromSeconds?: number): void {
    this.anchorPosition = fromSeconds ?? this.positionSeconds;
    this.anchorNow = this.now();
    this.running = true;
  }

  pause(): void {
    if (!this.running) return;
    this.anchorPosition = this.positionSeconds;
    this.running = false;
  }

  stop(): void {
    this.running = false;
    this.anchorPosition = 0;
    this.anchorNow = this.now();
  }

  /** Jumps to `seconds`, keeping whatever running state the clock had. */
  seek(seconds: number): void {
    this.anchorPosition = seconds;
    this.anchorNow = this.now();
  }

  /**
   * Scales elapsed time — the playback-speed control.
   *
   * Banks the current position first, so a speed change applies from here on
   * rather than retroactively rescaling everything already played, which would
   * jump the caret.
   */
  setRate(rate: number): void {
    this.anchorPosition = this.positionSeconds;
    this.anchorNow = this.now();
    this.rate = rate;
  }

  get positionSeconds(): number {
    if (!this.running) return this.anchorPosition;
    return this.anchorPosition + (this.now() - this.anchorNow) * this.rate;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
