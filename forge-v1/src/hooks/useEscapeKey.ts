import { useEffect, useRef } from 'react';

/**
 * Calls `onEscape` when Escape is pressed anywhere on the page while `enabled` is true — the keyboard
 * equivalent of clicking a modal's backdrop. A key handler inside the page can claim Escape for itself
 * (e.g. cancelling an inline rename) by calling `e.preventDefault()`; React handlers run before this
 * document listener, so a claimed Escape is ignored here.
 */
export function useEscapeKey(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  useEffect(() => { handler.current = onEscape; });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      handler.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
