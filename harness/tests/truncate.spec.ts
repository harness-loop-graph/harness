import { describe, it, expect } from 'vitest';
import { truncateMiddle } from '../src/components/truncate.js';

describe('truncateMiddle', () => {
  it('returns text within the limit unchanged', () => {
    expect(truncateMiddle('hello', 5)).toBe('hello');
    expect(truncateMiddle('', 10)).toBe('');
  });

  it('keeps the start and the end of over-limit text with a marker', () => {
    const text = 'START-' + 'x'.repeat(10_000) + '-END';
    const out = truncateMiddle(text, 500);
    expect(out.startsWith('START-')).toBe(true);
    expect(out.endsWith('-END')).toBe(true);
    expect(out).toMatch(/\[truncated \d+ chars\]/);
  });

  it('respects the max length', () => {
    for (const max of [60, 100, 500, 8000]) {
      const out = truncateMiddle('a'.repeat(20_000), max);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it('weights the tail at least as much as the head', () => {
    const text = 'H'.repeat(5000) + 'T'.repeat(5000);
    const out = truncateMiddle(text, 1000);
    expect((out.match(/T/g) ?? []).length).toBeGreaterThanOrEqual((out.match(/H/g) ?? []).length);
  });

  it('reports the number of removed chars in the marker', () => {
    const text = 'a'.repeat(2000);
    const out = truncateMiddle(text, 300);
    const removed = Number(/\[truncated (\d+) chars\]/.exec(out)![1]);
    expect(out.length - out.match(/\n…\[truncated \d+ chars\]…\n/)![0].length + removed).toBe(2000);
  });
});
