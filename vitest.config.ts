import { defineConfig } from 'vitest/config';

/**
 * Node, not jsdom. Nothing here needs a DOM: the web engine's `AudioWorklet`
 * and `AudioContext` are stubbed per suite, because jsdom does not implement
 * Web Audio and pretending otherwise only hides which calls are being faked.
 */
export default defineConfig({
  test: { environment: 'node', globals: false },
});
