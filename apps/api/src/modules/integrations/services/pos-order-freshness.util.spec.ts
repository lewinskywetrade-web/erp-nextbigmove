import { describe, expect, it } from '@jest/globals';
import { incomingPancakeSourceVersion, normalizePancakeSourceVersion, savedPancakeSourceVersion } from './pos-order-freshness.util';

describe('Pancake source version ordering', () => {
  it('preserves microseconds and treats provider timestamps without a zone as UTC', () => {
    expect(normalizePancakeSourceVersion('2026-10-22T06:57:03.850999')).toBe('2026-10-22T06:57:03.850999000Z');
    expect(normalizePancakeSourceVersion('2026-10-22T06:57:03.850999Z')! <
      normalizePancakeSourceVersion('2026-10-22T06:57:03.851001Z')!).toBe(true);
    expect(normalizePancakeSourceVersion('2026-10-22T06:57:03.850998Z')! <
      normalizePancakeSourceVersion('2026-10-22T06:57:03.850999Z')!).toBe(true);
  });

  it.each(['2026-10-22T14:57:03.850999+08:00', '2026-10-22T01:57:03.850999-05:00'])('normalizes offsets: %s', value => {
    expect(normalizePancakeSourceVersion(value)).toBe('2026-10-22T06:57:03.850999000Z');
  });

  it('handles UTC day rollover and nanosecond precision', () => {
    expect(normalizePancakeSourceVersion('2026-01-01T01:00:00.000000001+02:00')).toBe('2025-12-31T23:00:00.000000001Z');
  });

  it.each([undefined, null, 1792652223850, '', 'yesterday', '2026-10-22', '2026-02-29T01:00:00Z',
    '2026-02-30T01:00:00Z', '2026-10-22T24:00:00Z', '2026-10-22T06:60:00Z',
    '2026-10-22T06:57:60Z', '2026-10-22T06:57:03.1234567890Z', '2026-10-22T06:57:03+24:00',
    '2026-10-22T06:57:03+08:60'])('rejects invalid or ambiguous timestamps: %p', value => {
    expect(normalizePancakeSourceVersion(value)).toBeNull();
  });

  it('uses latest valid legacy status history as a floor', () => {
    expect(savedPancakeSourceVersion(null, [
      { updated_at: '2026-10-22T06:57:03.850999' },
      { updated_at: 'bad' }, { updated_at: '2026-10-20T06:57:03' },
    ])).toBe('2026-10-22T06:57:03.850999000Z');
    expect(savedPancakeSourceVersion({ _pancakeUpdatedAt: '2026-10-23T00:00:00Z' }, [
      { updated_at: '2026-10-22T00:00:00Z' },
    ])).toBe('2026-10-23T00:00:00.000000000Z');
  });

  it('never disguises a malformed explicit version with valid history', () => {
    expect(incomingPancakeSourceVersion({ updated_at: 'bad', status_history: [{ updated_at: '2026-10-22T00:00:00Z' }] }))
      .toEqual({ version: null, invalid: true });
  });

  it('does not substitute historical status time for a missing snapshot version', () => {
    expect(incomingPancakeSourceVersion({ status_history: [{ updated_at: '2026-10-22T00:00:00Z' }] }))
      .toEqual({ version: null, invalid: false });
  });
});
