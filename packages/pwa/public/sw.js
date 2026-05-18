// Service worker for cc-remote.
// Receives Web Push events, shows OS notification, opens PWA on click.

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = "cc-remote";
  let body = "";
  if (data.kind === "permission") {
    body = `${data.daemon_id || "daemon"} wants to run ${data.tool || "?"}\n${data.args_summary || ""}`;
  } else if (data.kind === "idle") {
    body = `${data.daemon_id || "daemon"} / ${data.session_id || "?"} is idle (waiting for input)`;
  } else if (data.kind === "completed") {
    body = `${data.daemon_id || "daemon"} / ${data.session_id || "?"} finished a turn`;
  } else if (data.kind === "offline") {
    const seconds = Math.round((data.since_ms || 0) / 1000);
    body = `${data.hostname || data.daemon_id} has been offline for ${seconds}s`;
  } else {
    body = JSON.stringify(data);
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.request_id || "cc-remote",
      data,
      requireInteraction: data.kind === "permission",
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
