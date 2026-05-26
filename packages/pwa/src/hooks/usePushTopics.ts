import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource } from "./types";

export interface TopicMeta {
  id: string;
  title: string;
  description: string;
  default_enabled: boolean;
  bypass_dnd: boolean;
}

export interface SubRow {
  topic_id: string;
  daemon_id: string | null;
  enabled: boolean;
}

export interface DndSettings {
  enabled: boolean;
  start_hh_mm: string | null;
  end_hh_mm: string | null;
  timezone: string | null;
}

export interface PushTopicsState {
  topics: TopicMeta[];
  subscriptions: SubRow[];
  dnd: DndSettings;
}

export interface UsePushTopicsResult {
  state: Resource<PushTopicsState>;
  setSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  resetDaemon: (daemon_id: string) => Promise<void>;
  setDnd: (dnd: DndSettings) => Promise<void>;
  lastActionError: string | null;
}

export function resolveSubscription(
  topics: TopicMeta[],
  subs: SubRow[],
  topic_id: string,
  daemon_id: string,
): boolean {
  if (daemon_id !== "") {
    const daemonRow = subs.find((s) => s.topic_id === topic_id && s.daemon_id === daemon_id);
    if (daemonRow) return daemonRow.enabled;
  }
  const defaultRow = subs.find((s) => s.topic_id === topic_id && s.daemon_id === null);
  if (defaultRow) return defaultRow.enabled;
  const topic = topics.find((t) => t.id === topic_id);
  return topic?.default_enabled ?? false;
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

export function usePushTopics(_hubUrl: string, bearer: string | null): UsePushTopicsResult {
  const [state, setState] = useState<Resource<PushTopicsState>>({ status: "loading" });
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const bearerRef = useRef(bearer);
  bearerRef.current = bearer;

  const load = useCallback(() => {
    if (!bearerRef.current) return;
    setState({ status: "loading" });
    jsonFetch<PushTopicsState>("/push/topics", bearerRef.current)
      .then((data) => setState({ status: "ready", data }))
      .catch((e) => setState({ status: "error", error: (e as Error).message, retry: load }));
  }, []);

  useEffect(() => {
    if (!bearer) return;
    load();
  }, [load, bearer]);

  const setSub = useCallback(async (topic_id: string, daemon_id: string | null, enabled: boolean) => {
    if (!bearerRef.current) return;
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const others = prev.data.subscriptions.filter((s) => !(s.topic_id === topic_id && s.daemon_id === daemon_id));
      return { status: "ready", data: { ...prev.data, subscriptions: [...others, { topic_id, daemon_id, enabled }] } };
    });
    try {
      await jsonFetch<void>("/push/topics/subscriptions", bearerRef.current, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic_id, daemon_id, enabled }),
      });
      setLastActionError(null);
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, []);

  const resetDaemon = useCallback(async (daemon_id: string) => {
    if (!bearerRef.current) return;
    let overrides: SubRow[] = [];
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      overrides = prev.data.subscriptions.filter((s) => s.daemon_id === daemon_id);
      return {
        status: "ready",
        data: { ...prev.data, subscriptions: prev.data.subscriptions.filter((s) => s.daemon_id !== daemon_id) },
      };
    });
    try {
      for (const o of overrides) {
        await jsonFetch<void>("/push/topics/subscriptions", bearerRef.current, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic_id: o.topic_id, daemon_id }),
        });
      }
      setLastActionError(null);
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, []);

  const setDnd = useCallback(async (dnd: DndSettings) => {
    if (!bearerRef.current) return;
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      return { status: "ready", data: { ...prev.data, dnd } };
    });
    try {
      await jsonFetch<void>("/push/dnd", bearerRef.current, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dnd),
      });
      setLastActionError(null);
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, []);

  return { state, setSub, resetDaemon, setDnd, lastActionError };
}
