// FORGE Service Worker — push notification handler

self.addEventListener('push', e => {
  if (!e.data) return;
  let payload = { title: 'FORGE', body: 'Update available', tag: 'forge' };
  try { payload = e.data.json(); } catch (_) { payload.body = e.data.text(); }

  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body:               payload.body,
      icon:               '/favicon.svg',
      badge:              '/favicon.svg',
      tag:                payload.tag || 'forge',
      requireInteraction: false,
      vibrate:            [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const forge = list.find(c => c.url.includes(self.location.origin));
      if (forge) return forge.focus();
      return clients.openWindow('/');
    })
  );
});
