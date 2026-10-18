// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

import { usePushNotifications } from '../usePushNotifications';

afterEach(() => { vi.unstubAllGlobals(); delete (navigator as unknown as Record<string, unknown>).serviceWorker; });

/** Makes the browser look as though it supports push, with the given permission and registration. */
function supportPush(permission: NotificationPermission, subscription: unknown = null, registered = true) {
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registered ? { pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } } : undefined) },
  });
}

describe('usePushNotifications initial state', () => {
  it('is unsupported in a browser without push', () => {
    const { result } = renderHook(() => usePushNotifications('tok'));
    expect(result.current.state).toBe('unsupported');
  });

  it('is denied when the pilot blocked notifications', () => {
    supportPush('denied');
    const { result } = renderHook(() => usePushNotifications('tok'));
    expect(result.current.state).toBe('denied');
  });

  it('is idle when permission has not been decided', () => {
    supportPush('default');
    const { result } = renderHook(() => usePushNotifications('tok'));
    expect(result.current.state).toBe('idle');
  });

  it('becomes granted once an existing subscription is found', async () => {
    const sub = { endpoint: 'https://push.example/1' };
    supportPush('granted', sub);
    const { result } = renderHook(() => usePushNotifications('tok'));
    await waitFor(() => expect(result.current.state).toBe('granted'));
  });

  it('stays idle when permission is granted but nothing is subscribed', async () => {
    supportPush('granted', null);
    const { result } = renderHook(() => usePushNotifications('tok'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.state).toBe('idle');
  });
});
