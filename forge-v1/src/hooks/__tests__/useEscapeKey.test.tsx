// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, fireEvent } from '@testing-library/react';
import { useEscapeKey } from '../useEscapeKey';

const press = (key: string, target: Document | Element = document) => fireEvent.keyDown(target, { key });

describe('useEscapeKey', () => {
  it('calls the handler on Escape and ignores other keys', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));
    press('Enter');
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled, and stops listening on unmount', () => {
    const onEscape = vi.fn();
    const { rerender, unmount } = renderHook(({ on }) => useEscapeKey(onEscape, on), { initialProps: { on: false } });
    press('Escape');
    expect(onEscape).not.toHaveBeenCalled();
    rerender({ on: true });
    press('Escape');
    unmount();
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('uses the latest handler without re-subscribing', () => {
    const first = vi.fn(), second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useEscapeKey(fn), { initialProps: { fn: first } });
    rerender({ fn: second });
    press('Escape');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape that an inner field claimed with preventDefault (e.g. closing an autocomplete list)', () => {
    const onEscape = vi.fn();
    function Modal() {
      useEscapeKey(onEscape);
      return <input aria-label="field" onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }} />;
    }
    const { getByLabelText } = render(<Modal />);
    press('Escape', getByLabelText('field'));
    expect(onEscape).not.toHaveBeenCalled();
    press('Escape', document.body);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
