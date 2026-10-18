import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../api/client';

export type PushState = 'idle' | 'checking' | 'granted' | 'denied' | 'unsupported' | 'error';

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/** What the browser already tells us synchronously: no support, or notifications blocked. */
function initialPushState(): PushState {
  if (typeof window === 'undefined') return 'idle';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'idle';
}

export function usePushNotifications(token: string | null) {
  const [state,        setState]       = useState<PushState>(initialPushState);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);

  // On mount, when permission was already granted, check whether this browser is actually subscribed.
  // (Unsupported / denied are known synchronously and set by initialPushState.)
  useEffect(() => {
    if (state !== 'idle' || Notification.permission !== 'granted') return;
    navigator.serviceWorker.getRegistration('/sw.js').then(reg => {
      if (!reg) return;
      reg.pushManager.getSubscription().then(sub => {
        if (sub) { setSubscription(sub); setState('granted'); }
      });
    });
    // Mount-only check: later state changes come from enable()/disable().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = useCallback(async () => {
    if (!token) return;
    setState('checking');
    try {
      // Check server support
      const { publicKey } = await apiGet<{ publicKey: string }>('/api/push/vapid-public-key');

      // Register service worker
      const reg  = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      // Request permission
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState('denied'); return; }

      // Subscribe
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as ArrayBuffer,
      });

      // Send to server
      await apiPost('/api/push/subscribe', sub.toJSON(), token);
      setSubscription(sub);
      setState('granted');
    } catch (err) {
      console.error('Push enable error:', err);
      setState('error');
    }
  }, [token]);

  const disable = useCallback(async () => {
    if (!token) return;
    try {
      // Resolve subscription — may be null if SW check on mount didn't find it
      let sub = subscription;
      if (!sub) {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        sub = reg ? await reg.pushManager.getSubscription() : null;
      }
      if (sub) {
        await apiPost('/api/push/unsubscribe', { endpoint: sub.endpoint }, token);
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error('Push disable error:', err);
    } finally {
      // Always reset local state so the toggle visually disables
      setSubscription(null);
      setState('idle');
    }
  }, [token, subscription]);

  // Sync active jobs to server so it can notify on completion
  const syncJobs = useCallback(async (jobs: Array<{ key: string; productName: string; endDate: string }>) => {
    if (!token || state !== 'granted' || !jobs.length) return;
    try {
      await apiPost('/api/push/sync-jobs', { jobs }, token);
    } catch { /* non-critical */ }
  }, [token, state]);

  return { state, enable, disable, syncJobs };
}
