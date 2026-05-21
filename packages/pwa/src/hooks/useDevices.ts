import { useCallback, useEffect, useState } from "react";

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
  completed?: boolean;
  idle?: boolean;
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

export interface UseDevicesResult {
  devices: DeviceItem[] | null;
  pushPrefs: PushPreferences | null;
  error: string | null;
  refresh: () => void;
  rename: (device_id: string, display_name: string) => Promise<void>;
  revoke: (device_id: string) => Promise<void>;
  togglePushPref: (key: keyof PushPreferences) => Promise<void>;
}

const PREF_DEFAULT_TRUE: ReadonlyArray<keyof PushPreferences> = ["permission"];

function isEnabled(prefs: PushPreferences, key: keyof PushPreferences): boolean {
  if (PREF_DEFAULT_TRUE.includes(key)) return prefs[key] !== false;
  return prefs[key] === true;
}

/**
 * Wraps the existing fetch helpers in a hook so screens stay presentational.
 * Treats network errors the same as the legacy Settings.tsx — exposes the message
 * via `error`; doesn't retry. SettingsDrawer surfaces it inline.
 */
export function useDevices(hubUrl: string, bearer: string | null): UseDevicesResult {
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [pushPrefs, setPushPrefs] = useState<PushPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!bearer) return;
    listDevices(hubUrl, bearer).then(setDevices).catch((e) => setError((e as Error).message));
  }, [hubUrl, bearer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bearer) return;
    getPushPreferences(hubUrl, bearer)
      .then(setPushPrefs)
      .catch((e) => setError((e as Error).message));
  }, [hubUrl, bearer]);

  const rename = useCallback(
    async (device_id: string, display_name: string) => {
      if (!bearer) return;
      try {
        await renameDevice(hubUrl, bearer, device_id, display_name);
        refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, refresh],
  );

  const revoke = useCallback(
    async (device_id: string) => {
      if (!bearer) return;
      try {
        await revokeDevice(hubUrl, bearer, device_id);
        refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, refresh],
  );

  const togglePushPref = useCallback(
    async (key: keyof PushPreferences) => {
      if (!bearer || !pushPrefs) return;
      const next: PushPreferences = { ...pushPrefs, [key]: !isEnabled(pushPrefs, key) };
      setPushPrefs(next);
      try {
        await setPushPreferences(hubUrl, bearer, next);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, pushPrefs],
  );

  return { devices, pushPrefs, error, refresh, rename, revoke, togglePushPref };
}

export { isEnabled as isPushPrefEnabled };
