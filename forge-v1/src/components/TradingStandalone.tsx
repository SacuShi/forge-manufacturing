/**
 * FORGE — Station Trading standalone shell (v1.27.0)
 *
 * Opened via window.open('/trading?standalone=1') from TradingTab.
 * Reads auth token from localStorage['forge_trading_token'] written by App.tsx.
 * Shows a full-width version of TradingTab — no sidebar, no nav.
 */

import { useState, useEffect, type FC } from 'react';
import TradingTab from './TradingTab';

const TOKEN_KEY = 'forge_trading_token';

const TradingStandalone: FC = () => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [tokenAge, setTokenAge] = useState<string>('');

  // Re-check token every 30s (it can expire after ~20 min).
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    setToken(stored);

    const interval = setInterval(() => {
      const t = localStorage.getItem(TOKEN_KEY);
      setToken(t);
      if (t) {
        try {
          const payload = JSON.parse(atob(t.split('.')[1]));
          const expiresIn = Math.round((payload.exp * 1000 - Date.now()) / 60000);
          setTokenAge(expiresIn > 0 ? `token expires in ${expiresIn}m` : 'token expired — please re-login in the main window');
        } catch {
          setTokenAge('');
        }
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="standalone-shell">
      <div className="standalone-topbar">
        <span className="standalone-logo">⟳ FORGE · Station Trading</span>
        {token && tokenAge && (
          <span className="standalone-token-age">{tokenAge}</span>
        )}
        {!token && (
          <span className="standalone-no-auth">
            Not logged in — open this link from the main FORGE window while logged in.
          </span>
        )}
      </div>
      <div className="standalone-body">
        <TradingTab token={token} />
      </div>
    </div>
  );
};

export default TradingStandalone;
