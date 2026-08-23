import { describe, expect, it } from 'vitest';
import { MIN_VOICE_SECONDS, RELEASE_SECONDS, planVoice } from './voice-plan.js';

const choice = { midi: 60, uri: 'data:audio/mp3;base64,AAAA', detuneCents: 200 };

describe('planVoice', () => {
  it('holds the note for its written duration, then releases', () => {
    const plan = planVoice({ atSeconds: 2, durationSeconds: 1.5, velocity: 127, trackGain: 1, choice });

    expect(plan.startAt).toBe(2);
    expect(plan.releaseAt).toBe(3.5);
    expect(plan.endAt).toBeCloseTo(3.5 + RELEASE_SECONDS, 6);
  });

  it('carries the sample choice through, so the engine never re-derives pitch', () => {
    const plan = planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 100, trackGain: 1, choice });

    expect(plan.uri).toBe(choice.uri);
    expect(plan.detuneCents).toBe(200);
  });

  it('scales gain by velocity and the track trim together', () => {
    // SF2's concave velocity curve — (v/127)^2, not v/127 — halved by the
    // track's own level. The linear form this replaced was 12dB too loud here.
    const plan = planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 64, trackGain: 0.5, choice });
    expect(plan.gain).toBeCloseTo((64 / 127) ** 2 * 0.5, 6);
  });

  it('clamps an out-of-range velocity instead of producing gain over unity', () => {
    expect(planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 999, trackGain: 1, choice }).gain).toBe(1);
    expect(planVoice({ atSeconds: 0, durationSeconds: 1, velocity: -5, trackGain: 1, choice }).gain).toBe(0);
  });

  it('gives a zero-duration note an audible floor rather than a silent voice', () => {
    // A grace note quantized to nothing still has to be heard; scheduling
    // stop() at the same instant as start() plays nothing at all.
    const plan = planVoice({ atSeconds: 1, durationSeconds: 0, velocity: 80, trackGain: 1, choice });
    expect(plan.releaseAt).toBeCloseTo(1 + MIN_VOICE_SECONDS, 6);
  });

  it('gives a note the instrument\'s own release, not the flat constant', () => {
    // Grand Piano measured 0.52s. Every instrument used to get 80ms, which
    // chopped a released chord instead of letting it ring.
    const plan = planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 100, trackGain: 1, choice, program: 0 });
    expect(plan.endAt - plan.releaseAt).toBeCloseTo(0.52, 2);
    expect(plan.endAt - plan.releaseAt).toBeGreaterThan(RELEASE_SECONDS * 5);
  });

  it('applies the instrument\'s velocity-to-brightness, and none without a program', () => {
    const withProgram = planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 40, trackGain: 1, choice, program: 0 });
    const without = planVoice({ atSeconds: 0, durationSeconds: 1, velocity: 40, trackGain: 1, choice });
    expect(withProgram.cutoffHz).toBeGreaterThan(0);
    // The metronome and auditions pass no program and must stay unfiltered.
    expect(without.cutoffHz).toBeNull();
  });

  it('never schedules in the past, which a source node rejects', () => {
    // planDispatch already drops notes past the grace window; this covers the
    // rounding case where atSeconds lands a hair behind the context clock.
    const plan = planVoice({ atSeconds: -0.01, durationSeconds: 1, velocity: 80, trackGain: 1, choice });
    expect(plan.startAt).toBe(0);
    expect(plan.releaseAt).toBeGreaterThan(0);
  });
});
