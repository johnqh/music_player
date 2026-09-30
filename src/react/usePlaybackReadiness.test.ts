/**
 * The engine comes up because a Play button is on screen, and the button
 * shows that it is.
 */
import { describe, expect, it } from 'vitest';
import { readinessOf } from '../types.js';

describe('readiness from the load state', () => {
  it('is preparing while loading and ready after', () => {
    expect(readinessOf({ status: 'loading', fraction: 0.2 })).toBe('preparing');
    expect(readinessOf({ status: 'loading', fraction: null })).toBe(
      'preparing'
    );
    expect(readinessOf({ status: 'ready' })).toBe('ready');
  });

  it('is not ready before anything asked', () => {
    expect(readinessOf({ status: 'idle' })).toBe('notReady');
  });

  it('leaves a failed engine to Play, which retries, rather than to a spinner that never ends', () => {
    expect(readinessOf({ status: 'failed', message: 'no font' })).toBe('ready');
  });
});
