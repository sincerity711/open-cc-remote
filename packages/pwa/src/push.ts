export interface PushResult {
  registered: boolean;
  reason?: string;
}

export async function registerPushSubscription(
  hubBaseUrl: string,
  bearer: string,
  vapidPublicKey: string | null,
): Promise<PushResult> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return { registered: false, reason: "no service worker support" };
  }
  if (!("Notification" in window) || !("PushManager" in window)) {
    return { registered: false, reason: "no push support" };
  }
  if (!vapidPublicKey) {
    return { registered: false, reason: "VITE_VAPID_PUBLIC_KEY not configured" };
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return { registered: false, reason: `notification permission: ${permission}` };
  }

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys) {
    return { registered: false, reason: "subscription missing endpoint/keys" };
  }

  const res = await fetch(`/push/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  });
  if (!res.ok) {
    return { registered: false, reason: `hub returned ${res.status}` };
  }
  return { registered: true };
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const padded = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
