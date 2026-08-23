import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStubNotice, seedMainThreadQuietModule } from './quiet-stub-notices.js';

afterEach(() => {
  delete (globalThis as unknown as { Module?: unknown }).Module;
  vi.restoreAllMocks();
});

describe('isStubNotice', () => {
  it('matches the notices the WASM build emits on every soundfont load', () => {
    expect(isStubNotice('fluidsynth: error: function fluid_stat is a stub, always returning -1')).toBe(true);
    expect(isStubNotice('fluidsynth: error: function fluid_file_test is a stub, always returning true')).toBe(
      true,
    );
  });

  it('does not match a real fluidsynth failure', () => {
    // The reason this filters by pattern instead of silencing the channel: a
    // genuine error must still reach the console.
    expect(isStubNotice('fluidsynth: error: Unable to open file "missing.sf2"')).toBe(false);
    expect(isStubNotice('fluidsynth: error: Failed to allocate voice')).toBe(false);
  });
});

describe('seedMainThreadQuietModule', () => {
  it('installs a printErr that drops stub notices and passes everything else', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedMainThreadQuietModule();
    const printErr = (globalThis as unknown as { Module: { printErr: (t: unknown) => void } }).Module.printErr;

    printErr('fluidsynth: error: function fluid_stat is a stub, always returning -1');
    expect(spy).not.toHaveBeenCalled();

    printErr('fluidsynth: error: something genuinely wrong');
    expect(spy).toHaveBeenCalledWith('fluidsynth: error: something genuinely wrong');
  });

  it('keeps any Module fields an app had already set', () => {
    (globalThis as unknown as { Module?: Record<string, unknown> }).Module = { locateFile: 'keep me' };
    seedMainThreadQuietModule();
    const mod = (globalThis as unknown as { Module: Record<string, unknown> }).Module;
    expect(mod.locateFile).toBe('keep me');
    expect(typeof mod.printErr).toBe('function');
  });
});
