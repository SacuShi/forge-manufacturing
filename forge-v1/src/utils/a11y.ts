import type { KeyboardEvent } from 'react';

/**
 * onKeyDown handler that makes a non-<button> element activate on Enter and Space, as a real button does.
 * Use it only where a <button> is not allowed (table rows, rows that contain other buttons); everywhere
 * else use <button type="button" className="btn-reset">. Keys pressed inside a nested control are left
 * alone, so typing in an input or pressing a child button doesn't also activate the row.
 */
export function onActivateKey(activate: (e: KeyboardEvent<HTMLElement>) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); // Space would otherwise scroll the page
    activate(e);
  };
}
