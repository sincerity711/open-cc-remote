// packages/pwa/public/sw.js
// Receives Web Push events, shows OS notification, opens PWA on click.
// Notification copy is built server-side (see hub push-topics.ts build_payload).

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || "cc-remote";
  const body = data.body || "";
  const tag = data.tag || "cc-remote";
  const requireInteraction = data.require_interaction === true;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data,
      requireInteraction,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    }),
  );
});
