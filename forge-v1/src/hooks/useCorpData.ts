/**
 * FORGE v1.4.0 — useCorpData hook
 *
 * Manages corp feature state:
 *   - Checks whether the corp has been configured (GET /api/corp/status)
 *   - Checks whether the current character has corp data access
 *     (admin whitelist or valid PIN session)
 *   - Provides PIN verification (POST /api/corp/verify-pin)
 *   - Exposes access state so the Corp tab can show the PIN modal or data
 *
 * Call this hook once in App.tsx and pass results down as props.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  CorpStatus,
  CorpAccessStatus,
} from '../types';
import { apiGet, apiPost } from '../api/client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseCorpDataReturn {
  /** Whether the corp has been set up on the server */
  corpStatus:       CorpStatus | null;
  /** Whether the current character has active corp data access */
  accessStatus:     CorpAccessStatus | null;
  /** True while loading corpStatus or accessStatus */
  loading:          boolean;
  /** True while a PIN verification request is in-flight */
  verifying:        boolean;
  /** Error from the most recent PIN verification attempt */
  pinError:         string | null;
  /** Verify the PIN entered by the user.  Returns true on success. */
  verifyPin:        (pin: string) => Promise<boolean>;
  /** Re-check access status (e.g. after PIN verify succeeds) */
  refreshAccess:    () => Promise<void>;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useCorpData(
  token:     string | null,
  /** The corp tab must be active and the user logged in before we fire requests */
  isActive:  boolean,
): UseCorpDataReturn {
  const [corpStatus,   setCorpStatus]   = useState<CorpStatus | null>(null);
  const [accessStatus, setAccessStatus] = useState<CorpAccessStatus | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [verifying,    setVerifying]    = useState(false);
  const [pinError,     setPinError]     = useState<string | null>(null);

  // ── Load corp status + access status when the Corp tab first becomes active ──
  useEffect(() => {
    if (!isActive || !token) return;

    let cancelled = false;
    setLoading(true);

    Promise.all([
      apiGet<CorpStatus>('/api/corp/status'),
      apiGet<CorpAccessStatus>('/api/corp/access-status', token),
    ])
      .then(([status, access]) => {
        if (cancelled) return;
        setCorpStatus(status);
        setAccessStatus(access);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        console.warn('Corp status check failed:', err.message);
        // Non-fatal — leave states as null so the UI shows "not configured"
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // Deliberately not including token/isActive changes mid-session — only fires once per activation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, !!token]);

  // ── Re-check access status (called after successful PIN verify) ─────────────
  const refreshAccess = useCallback(async () => {
    if (!token) return;
    try {
      const access = await apiGet<CorpAccessStatus>('/api/corp/access-status', token);
      setAccessStatus(access);
    } catch {
      // non-fatal
    }
  }, [token]);

  // ── PIN verification ────────────────────────────────────────────────────────
  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!token) return false;
    setPinError(null);
    setVerifying(true);
    try {
      await apiPost('/api/corp/verify-pin', { pin }, token);
      // Immediately refresh access status so the Corp tab unlocks
      await refreshAccess();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'PIN verification failed';
      // Surface "Incorrect PIN" cleanly; other errors are shown as-is
      setPinError(msg.includes('Incorrect') ? 'Incorrect PIN — please try again.' : msg);
      return false;
    } finally {
      setVerifying(false);
    }
  }, [token, refreshAccess]);

  return { corpStatus, accessStatus, loading, verifying, pinError, verifyPin, refreshAccess };
}
