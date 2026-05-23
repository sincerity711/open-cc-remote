import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource } from "./types";

export interface PushPreferences {
  permission?: boolean;
  offline?: boolean;
  completed?: boolean;
  idle?: boolean;
}

const PREF_DEFAULT_TRUE: ReadonlyArray<keyof PushPreferences> = ["permission"];

export function pushPrefsUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://") + "/push/preferences";
}

export function isPushPrefEnabled(prefs: PushPreferences, key: keyof PushPreferences): boolean {
  if (PREF_DEFAULT_TRUE.includes(key)) return prefs[key] !== false;
  return prefs[key] === true;
}

export function togglePref(prefs: PushPreferences, key: keyof PushPreferences): PushPreferences {
  return { ...prefs, [key]: !isPushPrefEnabled(prefs, key) };
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

export interface UsePushPrefsResult {
  prefs: Resource<PushPreferences>;
  toggle: (key: keyof PushPreferences) => Promise<void>;
  lastActionError: string | null;
}

export function usePushPrefs(hubUrl: string, bearer: string | null): UsePushPrefsResult {
  const [prefs, setPrefs] = useState<Resource<PushPreferences>>({ status: "loading" });
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const bearerRef = useRef(bearer);
  bearerRef.current = bearer;

  const load = useCallback(() => {
    if (!bearerRef.current) return;
    setPrefs({ status: "loading" });
    jsonFetch<PushPreferences>(pushPrefsUrl(hubUrl), bearerRef.current)
      .then((data) => setPrefs({ status: "ready", data }))
      .catch((e) => setPrefs({ status: "error", error: (e as Error).message, retry: load }));
  }, [hubUrl]);

  useEffect(() => {
    if (!bearer) return;
    load();
  }, [load, bearer]);

  const toggle = useCallback(async (key: keyof PushPreferences) => {
    if (!bearerRef.current) return;
    if (prefs.status !== "ready") return;
    const next = togglePref(prefs.data, key);
    setPrefs({ status: "ready", data: next });
    try {
      await jsonFetch<void>(pushPrefsUrl(hubUrl), bearerRef.current, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      setLastActionError(null);
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, prefs]);

  return { prefs, toggle, lastActionError };
}
