import { describe, it, expect } from 'vitest';
import { jobQuantity } from '../jobQuantity';

// EVE rounds once per job (not per run) and never goes below one unit per run.
describe('jobQuantity', () => {
  it('applies the multiplier to the whole job before rounding', () => {
    expect(jobQuantity(1000, 1, 0.9)).toBe(900);
    expect(jobQuantity(100, 10, 0.9)).toBe(900);
  });
  it('rounds the job total up to a whole unit', () => {
    expect(jobQuantity(3, 1, 0.9)).toBe(3); // 2.7 -> 3
    expect(jobQuantity(7, 3, 0.9)).toBe(19); // 18.9 -> 19
  });
  it('never asks for fewer than one unit per run', () => {
    expect(jobQuantity(1, 5, 0.5)).toBe(5);
    expect(jobQuantity(1, 1, 0.01)).toBe(1);
  });
  it('treats missing or fractional runs as whole runs of at least one', () => {
    expect(jobQuantity(100, 0, 1)).toBe(100);
    expect(jobQuantity(100, 2.7, 1)).toBe(200);
  });
});
