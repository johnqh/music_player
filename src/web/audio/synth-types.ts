/**
 * The slice of `js-synthesizer`'s non-worklet `Synthesizer` offline rendering
 * uses, declared here so the renderer can be tested against a stub.
 *
 * Signatures follow the library's own `ISynthesizer`. Note `midiSetChannelType`
 * takes a **boolean**, not a numeric channel-type constant — a mismatch that
 * happens to work by truthiness and is therefore worth stating plainly.
 */
export type SynthesizerLike = {
  init(sampleRate: number, settings?: { midiChannelCount?: number; polyphony?: number }): void;
  loadSFont(bin: ArrayBuffer): Promise<number>;
  render(outBuffer: Float32Array[]): void;
  midiNoteOn(chan: number, key: number, vel: number): void;
  midiNoteOff(chan: number, key: number): void;
  midiControl(chan: number, ctrl: number, val: number): void;
  midiProgramSelect(chan: number, sfontId: number, bank: number, presetNum: number): void;
  midiSetChannelType(chan: number, isDrum: boolean): void;
  midiAllSoundsOff(chan?: number): void;
  close(): void;
};
