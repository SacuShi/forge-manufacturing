/**
 * FORGE v1.4.0 — CorpPinModal component
 *
 * Shown when the user opens the Corp tab but has no active PIN session.
 * Accepts a 6-digit numeric PIN and delegates verification to the parent.
 *
 * Features:
 *   - 6 individual digit inputs for UX clarity
 *   - Auto-advances to next box on digit entry
 *   - Backspace moves focus to previous box
 *   - Paste a 6-digit string fills all boxes
 *   - Displays verifying spinner + error from server
 */

import { useState, useRef, type FC, type KeyboardEvent, type ClipboardEvent } from 'react';
import type { CorpStatus } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

interface CorpPinModalProps {
  corpStatus:  CorpStatus;
  verifying:   boolean;
  error:       string | null;
  onVerify:    (pin: string) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

const CorpPinModal: FC<CorpPinModalProps> = ({ corpStatus, verifying, error, onVerify }) => {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const refs = useRef<Array<HTMLInputElement | null>>(Array(6).fill(null));

  const handleChange = (index: number, value: string) => {
    // Only accept a single digit
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);

    if (digit && index < 5) {
      refs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits are filled
    if (digit && next.every(Boolean)) {
      onVerify(next.join(''));
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        // Clear current box
        const next = [...digits];
        next[index] = '';
        setDigits(next);
      } else if (index > 0) {
        // Move to previous box
        refs.current[index - 1]?.focus();
      }
    }
    if (e.key === 'Enter') {
      const pin = digits.join('');
      if (pin.length === 6 && /^\d{6}$/.test(pin)) onVerify(pin);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    const next = Array(6).fill('');
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    const focusIdx = Math.min(pasted.length, 5);
    refs.current[focusIdx]?.focus();
    if (pasted.length === 6) onVerify(pasted);
  };

  return (
    <div className="corp-pin-overlay" role="dialog" aria-modal="true" aria-label="Corp data PIN entry">
      <div className="corp-pin-modal">

        {/* Header */}
        <div className="corp-pin-header">
          <span className="corp-pin-icon" aria-hidden="true">🏭</span>
          <h2 className="corp-pin-title">Corp Data Access</h2>
        </div>

        {/* Corp info */}
        <div className="corp-pin-corp-info">
          <span className="corp-pin-corp-name">{corpStatus.corp_name}</span>
          <span className="corp-pin-corp-dir">
            Director: {corpStatus.director_char_name}
          </span>
        </div>

        <p className="corp-pin-desc">
          Enter the 6-digit corp PIN to access corp blueprints, assets, and industry jobs.
          Your session will remain active for 24 hours.
        </p>

        {/* Digit inputs */}
        <div className="corp-pin-inputs" role="group" aria-label="6-digit PIN entry">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={el => { refs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              pattern="\d"
              maxLength={1}
              value={d}
              disabled={verifying}
              className={`corp-pin-digit${error ? ' corp-pin-digit-error' : ''}`}
              aria-label={`PIN digit ${i + 1}`}
              onChange={e => handleChange(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              onPaste={handlePaste}
              onFocus={e => e.target.select()}
              autoFocus={i === 0}
            />
          ))}
        </div>

        {/* Error message */}
        {error && (
          <div className="corp-pin-error" role="alert">
            {error}
          </div>
        )}

        {/* Verifying indicator */}
        {verifying && (
          <div className="corp-pin-verifying" aria-live="polite">
            Verifying…
          </div>
        )}

        {/* Manual submit (fallback for users who don't auto-fill) */}
        <button
          type="button"
          className="btn btn-primary corp-pin-submit"
          disabled={verifying || digits.join('').length < 6}
          onClick={() => onVerify(digits.join(''))}
          aria-label="Submit PIN"
        >
          {verifying ? 'Verifying…' : 'Submit PIN'}
        </button>

        <p className="corp-pin-footer">
          Contact your corp director if you have forgotten the PIN.
        </p>

      </div>
    </div>
  );
};

export default CorpPinModal;
