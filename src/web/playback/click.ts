/**
 * The metronome click, in plain Web Audio.
 *
 * Not routed through the synth, and not through the mixer. A click is a
 * monitoring aid rather than part of the music, so the master headroom trim and
 * the per-track balance have no business changing how loud it is — and it
 * should not consume one of the sixteen MIDI channels a score might need.
 *
 * Unlike notes, clicks are scheduled *ahead* at an exact time: an oscillator
 * started with `start(at)` sounds at that sample whatever the main thread is
 * doing. So the click stays steady even when the pump runs late, which makes it
 * a usable reference rather than a second thing to distrust.
 *
 * Which is also why scheduling one hands back a way to take it back. The
 * engine keeps a whole horizon of them queued, and `allSoundOff` does not
 * reach any of it — that speaks to the synth, and a click deliberately does
 * not go through the synth. So pausing left the room ticking for as long as
 * the horizon was deep.
 */
const ACCENT_HZ = 1500;
const BEAT_HZ = 1000;
const CLICK_SECONDS = 0.03;
/** Quiet enough to sit under the music, loud enough to hear over it. */
const CLICK_PEAK = 0.25;

/** A click already on the audio graph, and the two things a caller can do with it. */
export type ScheduledClick = {
  /** When it has finished sounding, so a caller knows when to forget it. */
  readonly endsAt: number;
  /** Silences it from `atSeconds`, whether or not it has begun. */
  cancel(atSeconds: number): void;
};

export function scheduleClick(
  context: BaseAudioContext,
  destination: AudioNode,
  atSeconds: number,
  accent: boolean,
): ScheduledClick {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = accent ? ACCENT_HZ : BEAT_HZ;
  oscillator.connect(gain);
  gain.connect(destination);

  // A short decay rather than a hard stop: a square-edged gate on a sine is an
  // audible tick of its own.
  const end = atSeconds + CLICK_SECONDS;
  gain.gain.setValueAtTime(CLICK_PEAK, atSeconds);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.start(atSeconds);
  oscillator.stop(end);
  let released = false;
  oscillator.onended = () => {
    released = true;
    oscillator.disconnect();
    gain.disconnect();
  };

  return {
    endsAt: end,
    cancel(from: number) {
      // Nothing to take back once it has run its course. `onended` is the
      // reliable signal but it arrives on a later task, so the time is checked
      // too — a click that finished microseconds ago is still finished.
      if (released || from >= end) return;
      // Drops the peak scheduled above when `from` precedes it, so a click
      // cancelled before it begins never gets a level at all.
      gain.gain.cancelScheduledValues(from);
      gain.gain.setValueAtTime(0, from);
      // A stop at or before the start means it simply never plays.
      oscillator.stop(from);
    },
  };
}
