// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLatestRequest } from '../useLatestRequest';

describe('useLatestRequest', () => {
  it('treats only the newest request as current', () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(true);
    const second = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it('lets follow-up requests join the current generation without invalidating it', () => {
    const { result } = renderHook(() => useLatestRequest());
    const generation = result.current.begin();
    const followUp = result.current.current();
    expect(followUp).toBe(generation);
    expect(result.current.isCurrent(followUp)).toBe(true);
    result.current.begin();
    expect(result.current.isCurrent(followUp)).toBe(false); // a new generation drops the follow-up too
  });

  it('is stable across renders', () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
