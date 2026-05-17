/**
 * FORGE v1.0 — LoadingScreen component
 *
 * Shown while character data is being loaded from ESI after login.
 * Displays the current step label and a running log of completed steps
 * with ok / warn / err status indicators — mirrors the old frontend's
 * data load sequence so users know what's happening.
 */

import type { FC } from 'react';
import type { LoadStep } from '../hooks/useAuth';

interface LoadingScreenProps {
  step: string;
  log: LoadStep[];
}

const STATUS_ICON: Record<LoadStep['status'], string> = {
  ok:      '✓',
  warn:    '⚠',
  err:     '✗',
  pending: '…',
};

const STATUS_COLOUR: Record<LoadStep['status'], string> = {
  ok:      'var(--color-success)',
  warn:    'var(--color-warning)',
  err:     'var(--color-danger)',
  pending: 'var(--color-text-tertiary)',
};

const LoadingScreen: FC<LoadingScreenProps> = ({ step, log }) => (
  <div className="login-screen">
    {/* Spinner */}
    <div className="loading-spinner" aria-hidden="true" />

    <h2 className="login-title" style={{ fontSize: 18, marginTop: 16 }}>
      {step || 'Connecting to EVE…'}
    </h2>

    {/* Step log */}
    {log.length > 0 && (
      <ul
        className="load-log"
        role="status"
        aria-live="polite"
        aria-label="Data loading progress"
      >
        {log.map((entry, i) => (
          <li key={i} className="load-log-row">
            <span
              className="load-log-icon"
              style={{ color: STATUS_COLOUR[entry.status] }}
              aria-hidden="true"
            >
              {STATUS_ICON[entry.status]}
            </span>
            <span className="load-log-label">{entry.label}</span>
            {entry.detail && (
              <span className="load-log-detail">{entry.detail}</span>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
);

export default LoadingScreen;
