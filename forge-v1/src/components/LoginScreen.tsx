/**
 * FORGE v1.0 — LoginScreen component
 *
 * Shown when the user is not authenticated.
 * Renders the FORGE branding and an "Login with EVE Online" button that
 * kicks off the EVE OAuth2 flow via the useAuth hook.
 *
 * The EVE SSO button uses CCP's official branding asset from
 * images.evetech.net so it's always up to date.
 */

import type { FC } from 'react';
import forgeLogo from '../assets/forge-logo.png';

interface LoginScreenProps {
  onLogin: () => void;
  error?: string | null;
  sessionExpired?: boolean;
}

const LoginScreen: FC<LoginScreenProps> = ({ onLogin, error, sessionExpired }) => (
  <div className="login-screen">
    {/* ── Branding ──────────────────────────────────────────────────────────── */}
    <div className="login-logo">
      <img src={forgeLogo} alt="" aria-hidden="true" width={128} height={128} />
    </div>

    <h1 className="login-title">FORGE</h1>
    <p className="login-subtitle">
      <span className="backronym-letter">F</span>abrication,{' '}
      <span className="backronym-letter">O</span>perations,{' '}
      <span className="backronym-letter">R</span>esource &amp;{' '}
      <span className="backronym-letter">G</span>uidance{' '}
      <span className="backronym-letter">E</span>ngine
    </p>

    <p className="login-description">
      AI-powered EVE Online manufacturing intelligence.
      Connect your character to see live profit analysis.
    </p>

    {/* ── Session expiry message ────────────────────────────────────────────── */}
    {sessionExpired && (
      <div className="session-expired-message" role="alert">
        Your session has expired. Please log in again.
      </div>
    )}

    {/* ── Error state ───────────────────────────────────────────────────────── */}
    {error && (
      <div className="login-error" role="alert">
        {error}
      </div>
    )}

    {/* ── EVE SSO button ────────────────────────────────────────────────────── */}
    <button
      type="button"
      className="eve-login-btn"
      onClick={onLogin}
      aria-label="Login with EVE Online — opens EVE SSO in this tab"
    >
      <img
        src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-small.png"
        alt="Login with EVE Online"
        width={195}
        height={40}
        onError={(e) => {
          /* Fallback text if CCP CDN is unavailable */
          (e.currentTarget as HTMLImageElement).style.display = 'none';
          (e.currentTarget.nextSibling as HTMLElement | null)?.removeAttribute('hidden');
        }}
      />
      <span hidden style={{ color: 'var(--color-bg-primary)', fontWeight: 500 }}>
        Login with EVE Online
      </span>
    </button>

    <p className="login-note">
      Requires EVE Online account · Read-only scopes · No in-game actions
    </p>
  </div>
);

export default LoginScreen;
