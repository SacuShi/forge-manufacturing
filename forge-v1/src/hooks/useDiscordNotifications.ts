import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../api/client';

/** What the server reports about this character's Discord job notifications. Never includes the webhook URL. */
export interface DiscordStatus {
  available: boolean;
  connected: boolean;
  active: boolean;
  lastOkAt: string | null;
  lastError: string | null;
}

const NONE: DiscordStatus = { available: false, connected: false, active: false, lastOkAt: null, lastError: null };

/** Same rule as the server (lib/discord.js), so an obvious mistake is caught before sending. */
export function isDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[\w-]{20,200}$/
    .test(url.trim());
}

/** The server's own message from an apiGet/apiPost error ("API 400 /path: {"error":"…"}"). */
export function apiErrorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const m = /^API \d+ [^:]+: ([\s\S]*)$/.exec(text);
  if (!m) return text;
  try {
    const body = JSON.parse(m[1]) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : m[1];
  } catch {
    return m[1];
  }
}

export function useDiscordNotifications(token: string | null) {
  // Keyed by the token it was loaded for, so a character switch never shows the previous character's setting.
  const [loaded, setLoaded] = useState<{ token: string; status: DiscordStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let ignore = false;
    apiGet<DiscordStatus>('/api/notify/discord', token)
      .then((status) => { if (!ignore) setLoaded({ token, status }); })
      .catch(() => { /* older server or signed out: the Discord option just stays hidden */ });
    return () => { ignore = true; };
  }, [token]);

  const status = loaded && loaded.token === token ? loaded.status : NONE;

  /** Resolves true when the server accepted the change. */
  const send = useCallback(async (path: string, body: unknown, okNotice: string): Promise<boolean> => {
    if (!token) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await apiPost<DiscordStatus>(path, body, token);
      setLoaded({ token, status: next });
      setNotice(okNotice);
      return true;
    } catch (e) {
      setError(apiErrorMessage(e));
      // A failed test also changes the stored status (e.g. the webhook was deleted): show the current one.
      apiGet<DiscordStatus>('/api/notify/discord', token)
        .then((s) => setLoaded({ token, status: s }))
        .catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }, [token]);

  const connect = useCallback((url: string) =>
    send('/api/notify/discord', { url: url.trim() }, 'Connected. FORGE posted a confirmation message in that channel.'), [send]);
  const test = useCallback(() =>
    send('/api/notify/discord/test', {}, 'Test message sent. Check your Discord channel.'), [send]);
  const disconnect = useCallback(() =>
    send('/api/notify/discord/disconnect', {}, 'Discord notifications turned off.'), [send]);
  const clearMessages = useCallback(() => { setError(null); setNotice(null); }, []);

  return {
    status,
    available: status.available,
    enabled: status.connected && status.active,
    busy, error, notice,
    connect, test, disconnect, clearMessages,
  };
}

export type DiscordNotifications = ReturnType<typeof useDiscordNotifications>;
