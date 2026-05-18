export interface DeviceItem {
  device_id: string;
  display_name: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

function httpHub(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://");
}

async function jsonFetch<T>(url: string, bearer: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export async function listDevices(hubUrl: string, bearer: string): Promise<DeviceItem[]> {
  return jsonFetch<DeviceItem[]>(`${httpHub(hubUrl)}/devices`, bearer);
}

export async function renameDevice(hubUrl: string, bearer: string, device_id: string, display_name: string): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/devices/${encodeURIComponent(device_id)}`, bearer, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name }),
  });
}

export async function revokeDevice(hubUrl: string, bearer: string, device_id: string): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/devices/${encodeURIComponent(device_id)}`, bearer, {
    method: "DELETE",
  });
}

export interface PushPreferences {
  permission?: boolean;
  offline?: boolean;
}

export async function getPushPreferences(hubUrl: string, bearer: string): Promise<PushPreferences> {
  return jsonFetch<PushPreferences>(`${httpHub(hubUrl)}/push/preferences`, bearer);
}

export async function setPushPreferences(hubUrl: string, bearer: string, prefs: PushPreferences): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/push/preferences`, bearer, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
}
