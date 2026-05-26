import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource } from "./types";

export interface DaemonItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
  connected: boolean;
}

const POLL_MS = 60_000;

// Returns a same-origin path; the Vite dev server proxies /daemons → hub,
// and the prod build is served from the hub itself (same origin).
export function daemonsUrl(_hubUrl: string): string {
  return "/daemons";
}

function daemonItemUrl(_hubUrl: string, daemon_id: string): string {
  return `/daemons/${encodeURIComponent(daemon_id)}`;
}

export function sortDaemons(list: DaemonItem[]): DaemonItem[] {
  return [...list].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return b.paired_at - a.paired_at;
  });
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

export interface UseDaemonsResult {
  daemons: Resource<DaemonItem[]>;
  rename: (daemon_id: string, display_name: string) => Promise<void>;
  revoke: (daemon_id: string) => Promise<void>;
  refresh: () => void;
  lastActionError: string | null;
}

export function useDaemons(
  hubUrl: string,
  bearer: string | null,
  enabled: boolean = true,
): UseDaemonsResult {
  const [daemons, setDaemons] = useState<Resource<DaemonItem[]>>({ status: "loading" });
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const bearerRef = useRef(bearer);
  bearerRef.current = bearer;

  const load = useCallback(() => {
    if (!bearerRef.current) return;
    setDaemons({ status: "loading" });
    jsonFetch<DaemonItem[]>(daemonsUrl(hubUrl), bearerRef.current)
      .then((data) => setDaemons({ status: "ready", data: sortDaemons(data) }))
      .catch((e) => setDaemons({ status: "error", error: (e as Error).message, retry: load }));
  }, [hubUrl]);

  useEffect(() => {
    if (!enabled || !bearer) return;
    load();
  }, [load, bearer, enabled]);

  useEffect(() => {
    if (!enabled || !bearer) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, bearer, enabled]);

  const rename = useCallback(async (daemon_id: string, display_name: string) => {
    if (!bearerRef.current) return;
    try {
      await jsonFetch<void>(daemonItemUrl(hubUrl, daemon_id), bearerRef.current, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name }),
      });
      setLastActionError(null);
      load();
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, load]);

  const revoke = useCallback(async (daemon_id: string) => {
    if (!bearerRef.current) return;
    try {
      await jsonFetch<void>(daemonItemUrl(hubUrl, daemon_id), bearerRef.current, {
        method: "DELETE",
      });
      setLastActionError(null);
      load();
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, load]);

  return { daemons, rename, revoke, refresh: load, lastActionError };
}
