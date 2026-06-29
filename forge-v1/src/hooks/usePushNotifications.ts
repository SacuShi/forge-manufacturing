import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../api/client';

export type PushState = 'idle' | 'checking' | 'granted' | 'denied' | 'unsupported' | 'error';

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export function usePushNotifications(token: string | null) {
  const [state,        setState]       = useState<PushState>('idle');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);

  // Check initial state on mount
  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    if (Notification.permission === 'granted') {
      // Check if actually subscribed
      navigator.serviceWorker.getRegistration('/sw.js').then(reg => {
        if (!reg) return;
        reg.pushManager.getSubscription().then(sub => {
          if (sub) { setSubscription(sub); setState('granted'); }
        });
      });
    }
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
    if (!token || !subscription) return;
    try {
      await apiPost('/api/push/unsubscribe', { endpoint: subscription.endpoint }, token);
      await subscription.unsubscribe();
      setSubscription(null);
      setState('idle');
    } catch (err) {
      console.error('Push disable error:', err);
    }
  }, [token, subscription]);

  // Sync active jobs to server so it can notify on completion
  const syncJobs = useCallback(async (jobs: Array<{ key: string; productName: string; endDate: string }>) => {
    if (!token || state !== 'granted' || !jobs.length) return;
    try {
      await apiPost('/api/push/sync-jobs', { jobs }, token);
    } catch (_) { /* non-critical */ }
  }, [token, state]);

  return { state, enable, disable, syncJobs };
}
