/**
 * FORGE v1.0 — useAuth hook
 *
 * Manages the complete EVE Online OAuth2 authentication lifecycle:
 *
 *   1. On mount: check sessionStorage for a previously saved token.
 *      If found, resume the session without re-authenticating.
 *
 *   2. OAuth callback: if the URL contains ?code=xxx, exchange it for an
 *      access token via POST /api/eve-token, then load character data.
 *
 *   3. Login: redirect the browser to the EVE SSO URL with the correct
 *      scopes. A CSRF state token is stored in sessionStorage and verified
 *      on callback.
 *
 *   4. Data loading: after a successful token exchange, load assets,
 *      blueprints, wallet, and jobs from ESI, then cache the session on
 *      the FORGE server (required for AI chat to work).
 *
 *   5. Logout: clear the token and all character data from state and storage.
 *
 * The token is stored in sessionStorage (survives page refresh within the
 * same tab; cleared when the tab/window closes — good security tradeoff
 * for a browser-based EVE tool).
 *
 * Security:
 *   - CSRF state token verified on every OAuth callback.
 *   - Token never stored in localStorage or query strings.
 *   - Authorization headers used for all authenticated calls.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  CharacterInfo,
  ActiveJob,
  EsiBlueprint,
  EsiAsset,
  EsiJob,
  EsiCharacter,
} from '../types';
import { esiFetchAll, esiGet, apiPost } from '../api/client';

// ── EVE OAuth constants (must match EVE Developer Portal registration) ────────

const EVE_CLIENT_ID = '5be8a3b3444a4413b7f82b45c2c54a26';
const SCOPES =
  'esi-assets.read_assets.v1 esi-characters.read_blueprints.v1 ' +
  'esi-wallet.read_character_wallet.v1 esi-industry.read_character_jobs.v1 ' +
  'esi-markets.structure_markets.v1';

const SESSION_TOKEN_KEY = 'forge_token';
const SESSION_STATE_KEY = 'forge_oauth_state';

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthStatus = 'idle' | 'exchanging' | 'loading' | 'authed' | 'error';

export interface LoadStep {
  label: string;
  status: 'ok' | 'warn' | 'err' | 'pending';
  detail?: string;
}

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  character: CharacterInfo | null;
  /** Raw ESI blueprint list — needed for ownership checks and AI chat */
  blueprints: EsiBlueprint[];
  /** Raw ESI asset list — needed for AI chat */
  assets: EsiAsset[];
  error: string | null;
  /** Current loading step label (shown on LoadingScreen) */
  loadStep: string;
  /** Log of all loading steps (shown on LoadingScreen) */
  dataLog: LoadStep[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Decode a JWT payload without verifying the signature (verification happens server-side) */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = '=='.slice(0, (4 - (part.length % 4)) % 4);
  return JSON.parse(atob(part + pad)) as Record<string, unknown>;
}

/** Extract numeric characterId from EVE JWT sub claim ("CHARACTER:EVE:12345678") */
function characterIdFromJwt(token: string): number {
  const payload = decodeJwtPayload(token);
  const sub = payload.sub as string;
  return parseInt(sub.replace('CHARACTER:EVE:', ''), 10);
}

/** Generate a cryptographically random state string for CSRF protection */
function generateState(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert ESI end_date (ISO 8601) to a human-readable remaining time string.
 * Returns "Done" if the date is in the past.
 */
function formatTimeRemaining(endDate: string): { label: string; done: boolean } {
  const diff = new Date(endDate).getTime() - Date.now();
  if (diff <= 0) return { label: 'Done', done: true };

  const totalMinutes = Math.floor(diff / 60_000);
  const hours        = Math.floor(totalMinutes / 60);
  const minutes      = totalMinutes % 60;

  if (hours === 0) return { label: `${minutes}m`, done: false };
  return { label: `${hours}h ${String(minutes).padStart(2, '0')}m`, done: false };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthState & {
  login:  () => void;
  logout: () => void;
} {
  const [status,     setStatus]     = useState<AuthStatus>('idle');
  const [token,      setToken]      = useState<string | null>(null);
  const [character,  setCharacter]  = useState<CharacterInfo | null>(null);
  const [blueprints, setBlueprints] = useState<EsiBlueprint[]>([]);
  const [assets,     setAssets]     = useState<EsiAsset[]>([]);
  const [error,      setError]      = useState<string | null>(null);
  const [loadStep,   setLoadStep]   = useState('');
  const [dataLog,    setDataLog]    = useState<LoadStep[]>([]);

  // ── loadCharacterData ──────────────────────────────────────────────────────

  const loadCharacterData = useCallback(async (acc: string) => {
    setToken(acc);
    setStatus('loading');

    const log: LoadStep[] = [];
    const addLog = (label: string, st: LoadStep['status'], detail?: string) => {
      log.push({ label, status: st, detail });
      setDataLog([...log]);
    };

    try {
      // ── 1. Decode JWT → characterId ──────────────────────────────────────
      const cid = characterIdFromJwt(acc);

      // ── 2. Character info ─────────────────────────────────────────────────
      setLoadStep('Loading character…');
      const charInfo = await esiGet<EsiCharacter>(`/characters/${cid}/`, acc);
      addLog('Character', 'ok', charInfo.name);

      // ── 3. Assets ─────────────────────────────────────────────────────────
      setLoadStep('Scanning asset hold…');
      let aData: EsiAsset[] = [];
      try {
        aData = await esiFetchAll<EsiAsset>(`/characters/${cid}/assets/`, acc);
        setAssets(aData);
        addLog('Assets', aData.length > 0 ? 'ok' : 'warn',
          `${aData.length} stacks${aData.length === 0 ? ' — check scopes or corp hangar' : ''}`);
      } catch (e) {
        addLog('Assets', 'err', (e as Error).message);
      }

      // ── 4. Blueprints ─────────────────────────────────────────────────────
      setLoadStep('Cataloguing blueprints…');
      let bData: EsiBlueprint[] = [];
      try {
        bData = await esiFetchAll<EsiBlueprint>(`/characters/${cid}/blueprints/`, acc);
        setBlueprints(bData);
        addLog('Blueprints', bData.length > 0 ? 'ok' : 'warn',
          `${bData.length} blueprints${bData.length === 0 ? ' — check scopes or corp hangar' : ''}`);
      } catch (e) {
        addLog('Blueprints', 'err', (e as Error).message);
      }

      // ── 5. Wallet ─────────────────────────────────────────────────────────
      setLoadStep('Reading wallet…');
      let wallet = 0;
      try {
        wallet = await esiGet<number>(`/characters/${cid}/wallet/`, acc);
        addLog('Wallet', 'ok', `${(wallet / 1e9).toFixed(2)}B ISK`);
      } catch (e) {
        addLog('Wallet', 'err', (e as Error).message);
      }

      // ── 6. Industry jobs ──────────────────────────────────────────────────
      setLoadStep('Checking industry jobs…');
      let activeJobs: ActiveJob[] = [];
      try {
        const allJobs = await esiGet<EsiJob[]>(
          `/characters/${cid}/industry/jobs/?include_completed=false`,
          acc
        );
        const mfgJobs = allJobs.filter(
          (j) => j.status === 'active' && j.activity_id === 1
        );

        // Resolve product names for each active job
        const namePromises = mfgJobs.map(async (job) => {
          try {
            const typeInfo = await esiGet<{ name: string }>(
              `/universe/types/${job.product_type_id}/`
            );
            return typeInfo.name;
          } catch {
            return `Item #${job.product_type_id}`;
          }
        });

        const names = await Promise.all(namePromises);

        activeJobs = mfgJobs.map((job, i) => {
          const { label, done } = formatTimeRemaining(job.end_date);
          return {
            name:      names[i],
            quantity:  job.runs,
            remaining: label,
            done,
          };
        });

        addLog('Industry Jobs', 'ok', `${activeJobs.length} active`);
      } catch (e) {
        addLog('Industry Jobs', 'err', (e as Error).message);
      }

      // ── 7. Count BPOs vs BPCs ──────────────────────────────────────────────
      const bpoCount = bData.filter((bp) => bp.quantity === -1).length;

      // ── 8. Build CharacterInfo ─────────────────────────────────────────────
      const charInfoResult: CharacterInfo = {
        characterId:    cid,
        name:           charInfo.name,
        walletISK:      wallet,
        activeJobCount: activeJobs.length,
        blueprintCount: bData.length,
        bpoCount,
        activeJobs,
      };
      setCharacter(charInfoResult);

      // ── 9. Cache session on FORGE server (required for AI chat) ────────────
      setLoadStep('Caching session data…');
      try {
        await apiPost('/api/session-data', {
          assets:    aData,
          blueprints: bData,
          prices:    {},
          wallet,
          jobs:      activeJobs,
        }, acc);
        addLog('Session', 'ok', 'Cached on server (2hr expiry)');
      } catch (e) {
        // Non-fatal: user can still use the market table, just not AI chat
        addLog('Session', 'warn', `Cache failed — AI chat may not work: ${(e as Error).message}`);
        console.warn('Session cache failed:', e);
      }

      // ── Done ──────────────────────────────────────────────────────────────
      sessionStorage.setItem(SESSION_TOKEN_KEY, acc);
      setStatus('authed');

    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      setStatus('error');
    }
  }, []);

  // ── OAuth callback + saved-token check on mount ───────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');

    if (code && state) {
      // ── Handle OAuth callback ──────────────────────────────────────────────
      window.history.replaceState({}, '', window.location.pathname);

      const savedState = sessionStorage.getItem(SESSION_STATE_KEY);
      sessionStorage.removeItem(SESSION_STATE_KEY);

      if (!savedState || state !== savedState) {
        setError('OAuth state mismatch — possible CSRF. Please try logging in again.');
        setStatus('error');
        return;
      }

      setStatus('exchanging');
      setLoadStep('Verifying login with EVE…');

      const redirectUri = window.location.origin + window.location.pathname;
      apiPost<{ access_token: string; error_description?: string }>(
        '/api/eve-token',
        { code, redirect_uri: redirectUri }
      )
        .then((data) => {
          if (!data.access_token) {
            throw new Error(data.error_description ?? 'Token exchange returned no token');
          }
          return loadCharacterData(data.access_token);
        })
        .catch((e: Error) => {
          setError(e.message);
          setStatus('error');
        });

      return;
    }

    // ── Resume saved session ───────────────────────────────────────────────
    const saved = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (saved) {
      loadCharacterData(saved).catch((e: Error) => {
        // Saved token may be expired — fall back to login screen
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        setError(`Session expired: ${e.message}`);
        setStatus('idle');
      });
    }
  }, [loadCharacterData]);

  // ── login ─────────────────────────────────────────────────────────────────

  const login = useCallback(() => {
    const state       = generateState();
    const redirectUri = window.location.origin + window.location.pathname;

    sessionStorage.setItem(SESSION_STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     EVE_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         SCOPES,
      state,
    });

    window.location.href = `https://login.eveonline.com/v2/oauth/authorize?${params}`;
  }, []);

  // ── logout ────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken(null);
    setCharacter(null);
    setBlueprints([]);
    setAssets([]);
    setError(null);
    setDataLog([]);
    setStatus('idle');
  }, []);

  return {
    status,
    token,
    character,
    blueprints,
    assets,
    error,
    loadStep,
    dataLog,
    login,
    logout,
  };
}
