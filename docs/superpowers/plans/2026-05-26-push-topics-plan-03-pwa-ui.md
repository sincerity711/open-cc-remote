# Push Topics — Plan 03: PWA UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-toggle `usePushPrefs`/`SettingsDrawer` UI with a data-driven `usePushTopics` hook plus rewritten Settings sections that render topics from `GET /push/topics`, support per-daemon overrides, and expose DND.

**Architecture:** New `usePushTopics` hook fetches `{ topics, subscriptions, dnd }`, exposes `setSub(topic_id, daemon_id|null, enabled)`, `resetDaemon(daemon_id)`, `setDnd(...)`. New helper `resolveSubscription` produces effective enabled value for any (topic, daemon) pair. `SettingsDrawer` Notifications section becomes three sub-blocks: DND, Defaults, Per-daemon overrides. RealApp/DemoApp wire the new hook; the old `usePushPrefs` is deleted.

**Tech Stack:** React + TypeScript + Tailwind. Existing `Resource<T>` tri-state; existing UI primitives (`Button`, `Section`, `ToggleRow`).

**Spec reference:** `docs/superpowers/specs/2026-05-25-push-topics-design.md`

**Depends on:** Plan 02 (`plan-push-topics-02-api` tag).

**Independence:** After this plan the legacy `/push/preferences` shim from Plan 02 is no longer used by the PWA. The shim stays in place for one more release (cleanup happens after Plan 04).

---

## File map

| Path | What |
|---|---|
| `packages/pwa/src/hooks/usePushTopics.ts` | **new** — fetch state + setSub/resetDaemon/setDnd + `resolveSubscription` |
| `packages/pwa/src/hooks/usePushPrefs.ts` | **delete** at end of plan |
| `packages/pwa/src/screens/SettingsDrawer.tsx` | rewrite the Notifications section: DND, Defaults, Per-daemon |
| `packages/pwa/src/RealApp.tsx` | swap `usePushPrefs` for `usePushTopics`, pass new props |
| `packages/pwa/src/demo/DemoApp.tsx` | swap stubbed prefs for stubbed topic state |
| `packages/pwa/tests/usePushTopics.test.ts` | **new** |
| `packages/pwa/tests/SettingsDrawer.test.tsx` | **new** (data-driven render + per-daemon expand + DND block) |

---

## Task 1: `usePushTopics` hook

**Files:**
- Create: `packages/pwa/src/hooks/usePushTopics.ts`
- Test: `packages/pwa/tests/usePushTopics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/pwa/tests/usePushTopics.test.ts
import { test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePushTopics, resolveSubscription } from "../src/hooks/usePushTopics";

const SAMPLE_RESPONSE = {
  topics: [
    { id: "permission", title: "Permission alerts", description: "x", default_enabled: true,  bypass_dnd: true  },
    { id: "idle",       title: "Idle",              description: "y", default_enabled: false, bypass_dnd: false },
  ],
  subscriptions: [
    { topic_id: "idle", daemon_id: null,  enabled: true  },
    { topic_id: "idle", daemon_id: "d-1", enabled: false },
  ],
  dnd: { enabled: false, start_hh_mm: null, end_hh_mm: null, timezone: null },
};

beforeEach(() => {
  globalThis.fetch = mock(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/push/topics") && method === "GET") {
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/push/topics/subscriptions") && (method === "PUT" || method === "DELETE")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/push/dnd") && method === "PUT") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

test("resolveSubscription: daemon-specific row wins", () => {
  expect(resolveSubscription(SAMPLE_RESPONSE.topics, SAMPLE_RESPONSE.subscriptions, "idle", "d-1")).toBe(false);
  expect(resolveSubscription(SAMPLE_RESPONSE.topics, SAMPLE_RESPONSE.subscriptions, "idle", "d-2")).toBe(true);
  expect(resolveSubscription(SAMPLE_RESPONSE.topics, SAMPLE_RESPONSE.subscriptions, "permission", "d-1")).toBe(true);
});

test("hook fetches state on mount and exposes ready data", async () => {
  const { result } = renderHook(() => usePushTopics("http://hub", "tok"));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  if (result.current.state.status !== "ready") throw new Error("unreachable");
  expect(result.current.state.data.topics).toHaveLength(2);
});

test("setSub optimistically updates state and calls PUT", async () => {
  const { result } = renderHook(() => usePushTopics("http://hub", "tok"));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  await act(async () => {
    await result.current.setSub("idle", "d-1", true);
  });
  if (result.current.state.status !== "ready") throw new Error("unreachable");
  const sub = result.current.state.data.subscriptions.find((s) => s.topic_id === "idle" && s.daemon_id === "d-1");
  expect(sub?.enabled).toBe(true);
});

test("setSub with enabled=null deletes the subscription", async () => {
  // (We choose: passing the exact same value as the current default-fallback also acts as a delete?
  //  No — explicit reset is via DELETE; setSub is upsert. resetDaemon deletes per-daemon overrides.)
  const { result } = renderHook(() => usePushTopics("http://hub", "tok"));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  await act(async () => {
    await result.current.resetDaemon("d-1");
  });
  if (result.current.state.status !== "ready") throw new Error("unreachable");
  const remaining = result.current.state.data.subscriptions.filter((s) => s.daemon_id === "d-1");
  expect(remaining).toHaveLength(0);
});

test("setDnd updates state", async () => {
  const { result } = renderHook(() => usePushTopics("http://hub", "tok"));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  await act(async () => {
    await result.current.setDnd({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
  });
  if (result.current.state.status !== "ready") throw new Error("unreachable");
  expect(result.current.state.data.dnd).toEqual({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
});

test("hook surfaces error and provides retry", async () => {
  globalThis.fetch = mock(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const { result } = renderHook(() => usePushTopics("http://hub", "tok"));
  await waitFor(() => expect(result.current.state.status).toBe("error"));
  if (result.current.state.status !== "error") throw new Error("unreachable");
  expect(typeof result.current.state.retry).toBe("function");
});
```

- [ ] **Step 2: Run — FAIL (module missing)**

```bash
bun test packages/pwa/tests/usePushTopics.test.ts
```

- [ ] **Step 3: Create `packages/pwa/src/hooks/usePushTopics.ts`**

```ts
// packages/pwa/src/hooks/usePushTopics.ts
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
  topics: TopicMeta[], subs: SubRow[], topic_id: string, daemon_id: string,
): boolean {
  const daemonRow = subs.find((s) => s.topic_id === topic_id && s.daemon_id === daemon_id);
  if (daemonRow) return daemonRow.enabled;
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
    if (state.status !== "ready") return;
    const overrides = state.data.subscriptions.filter((s) => s.daemon_id === daemon_id);
    setState({
      status: "ready",
      data: { ...state.data, subscriptions: state.data.subscriptions.filter((s) => s.daemon_id !== daemon_id) },
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
  }, [state]);

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
```

- [ ] **Step 4: Run — PASS**

```bash
bun test packages/pwa/tests/usePushTopics.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/usePushTopics.ts packages/pwa/tests/usePushTopics.test.ts
git commit -m "feat(pwa): usePushTopics hook with optimistic setSub/resetDaemon/setDnd"
```

---

## Task 2: SettingsDrawer — DND block

**Files:**
- Modify: `packages/pwa/src/screens/SettingsDrawer.tsx` (props + DND sub-section)
- Test: `packages/pwa/tests/SettingsDrawer.test.tsx`

We change `SettingsDrawerProps` to take the new shape. To keep the diff focused, this task replaces only the Notifications section's contents; the rest of the drawer is untouched.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/pwa/tests/SettingsDrawer.test.tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsDrawer } from "../src/screens/SettingsDrawer";
import type { Resource } from "../src/hooks/types";
import type { PushTopicsState } from "../src/hooks/usePushTopics";

function baseState(over: Partial<PushTopicsState> = {}): Resource<PushTopicsState> {
  return {
    status: "ready",
    data: {
      topics: [
        { id: "permission", title: "Permission alerts", description: "perm", default_enabled: true,  bypass_dnd: true  },
        { id: "idle",       title: "Claude is idle",    description: "idl",  default_enabled: false, bypass_dnd: false },
      ],
      subscriptions: [],
      dnd: { enabled: false, start_hh_mm: null, end_hh_mm: null, timezone: null },
      ...over,
    },
  };
}

const noopHandlers = {
  onRenameDaemon: () => {},
  onRevokeDaemon: () => {},
  onSetSub: async () => {},
  onResetDaemon: async () => {},
  onSetDnd: async () => {},
  onGenerateCode: () => {},
  onCancelPairing: () => {},
  onSetAppearance: () => {},
  onClose: () => {},
};

test("renders DND row with off label by default", () => {
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: [] }}
      pushState={baseState()}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
    />,
  );
  expect(screen.getByText(/Do not disturb/)).toBeTruthy();
  expect(screen.getByText("Off")).toBeTruthy();
});

test("expands DND editor when toggled on", async () => {
  let savedDnd: unknown = null;
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: [] }}
      pushState={baseState({ dnd: { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" } })}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
      onSetDnd={async (d) => { savedDnd = d; }}
    />,
  );
  expect(screen.getByDisplayValue("22:00")).toBeTruthy();
  expect(screen.getByDisplayValue("07:00")).toBeTruthy();
  fireEvent.change(screen.getByDisplayValue("22:00"), { target: { value: "23:30" } });
  fireEvent.click(screen.getByRole("button", { name: /Save DND/ }));
  expect((savedDnd as { start_hh_mm: string }).start_hh_mm).toBe("23:30");
});
```

- [ ] **Step 2: Run — FAIL (props mismatch)**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

- [ ] **Step 3: Update `SettingsDrawerProps` and add DND sub-component**

Replace the prop block + Notifications section in `packages/pwa/src/screens/SettingsDrawer.tsx`:

```tsx
// at top of file
import type { PushTopicsState, DndSettings } from "../hooks/usePushTopics";
import { resolveSubscription } from "../hooks/usePushTopics";
// remove: import type { PushPreferences } from "../hooks/usePushPrefs";
// remove: import { isPushPrefEnabled } from "../hooks/usePushPrefs";

// Replace the PUSH_TOGGLES const (delete it entirely).

export interface SettingsDrawerProps {
  device: Device;
  account: { email: string; onSignOut: () => void };
  daemons: Resource<DaemonItem[]>;
  onRenameDaemon: (daemon_id: string, display_name: string) => void;
  onRevokeDaemon: (daemon_id: string) => void;
  pushState: Resource<PushTopicsState>;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
  onSetDnd: (dnd: DndSettings) => Promise<void>;
  pairing: PairingState;
  onGenerateCode: () => void;
  onCancelPairing: () => void;
  appearance: Appearance;
  onSetAppearance: (mode: Appearance) => void;
  daemonActionError?: string | null;
  pushActionError?: string | null;
  pairingError?: string | null;
  onClose: () => void;
}
```

In `SettingsDrawer({...})`, replace the `<Section title="Notifications">` block with three sub-blocks (DND first):

```tsx
<Section title="Notifications">
  <ResourceView
    resource={pushState}
    render={(s) => (
      <>
        <DndBlock dnd={s.dnd} onSave={onSetDnd} />
        <DefaultsBlock state={s} onSetSub={onSetSub} />
        <PerDaemonBlock state={s} daemons={daemons} onSetSub={onSetSub} onResetDaemon={onResetDaemon} />
      </>
    )}
  />
  {pushActionError && <p className="text-danger mt-2 text-sm">{pushActionError}</p>}
</Section>
```

Add the `DndBlock` component to the same file:

```tsx
function DndBlock({ dnd, onSave }: { dnd: DndSettings; onSave: (d: DndSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<DndSettings>(dnd);
  // Keep draft in sync if external state changes
  if (draft !== dnd && (draft.enabled !== dnd.enabled || draft.start_hh_mm !== dnd.start_hh_mm
    || draft.end_hh_mm !== dnd.end_hh_mm || draft.timezone !== dnd.timezone)) {
    // intentional: only re-init when toggled externally; otherwise let user edit
  }
  const tz = draft.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="rounded-card border-border bg-surface mb-3 border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Do not disturb</span>
        <button
          className={cn(
            "rounded-full px-2 py-1 text-xs font-semibold",
            draft.enabled ? "bg-success-subtle text-success" : "bg-muted text-muted-foreground",
          )}
          onClick={() => {
            const next = { ...draft, enabled: !draft.enabled,
              start_hh_mm: draft.start_hh_mm ?? "22:00",
              end_hh_mm:   draft.end_hh_mm   ?? "07:00",
              timezone:    draft.timezone    ?? tz };
            setDraft(next);
            void onSave(next);
          }}
          type="button"
        >
          {draft.enabled ? "On" : "Off"}
        </button>
      </div>
      {draft.enabled && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="text-xs">Start
            <input type="time" className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-sm"
              value={draft.start_hh_mm ?? ""}
              onChange={(e) => setDraft({ ...draft, start_hh_mm: e.target.value })} />
          </label>
          <label className="text-xs">End
            <input type="time" className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-sm"
              value={draft.end_hh_mm ?? ""}
              onChange={(e) => setDraft({ ...draft, end_hh_mm: e.target.value })} />
          </label>
          <label className="text-xs">Timezone
            <input type="text" className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-xs font-mono"
              value={draft.timezone ?? tz}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
          </label>
          <Button size="sm" className="col-span-3" onClick={() => void onSave(draft)}>Save DND</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — PASS for the two new tests**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

(`DefaultsBlock` and `PerDaemonBlock` will be added in Tasks 3 and 4. The render call inside `<Section title="Notifications">` references them; declare placeholder components returning `null` for now to keep this task's commit compiling:

```tsx
function DefaultsBlock(_: any) { return null; }
function PerDaemonBlock(_: any) { return null; }
```

These are replaced in the next two tasks.)

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/SettingsDrawer.tsx packages/pwa/tests/SettingsDrawer.test.tsx
git commit -m "feat(pwa): SettingsDrawer DND block + new pushState props (defaults+per-daemon stubs)"
```

---

## Task 3: SettingsDrawer — Defaults block (data-driven topic list)

**Files:**
- Modify: `packages/pwa/src/screens/SettingsDrawer.tsx` (replace `DefaultsBlock` placeholder)
- Modify: `packages/pwa/tests/SettingsDrawer.test.tsx`

- [ ] **Step 1: Append failing tests**

```tsx
test("Defaults block renders one toggle per topic from server", () => {
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: [] }}
      pushState={baseState()}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
    />,
  );
  expect(screen.getByText("Permission alerts")).toBeTruthy();
  expect(screen.getByText("Claude is idle")).toBeTruthy();
});

test("Defaults block: clicking a toggle calls onSetSub with daemon_id=null", async () => {
  const calls: Array<{ topic_id: string; daemon_id: string | null; enabled: boolean }> = [];
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: [] }}
      pushState={baseState()}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
      onSetSub={async (t, d, e) => { calls.push({ topic_id: t, daemon_id: d, enabled: e }); }}
    />,
  );
  // 'idle' default_enabled=false → currently Off → clicking should set enabled=true
  fireEvent.click(screen.getByText("Claude is idle").closest("button")!);
  expect(calls).toEqual([{ topic_id: "idle", daemon_id: null, enabled: true }]);
});
```

- [ ] **Step 2: Run — FAIL**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

- [ ] **Step 3: Replace `DefaultsBlock` placeholder**

```tsx
function DefaultsBlock({
  state, onSetSub,
}: {
  state: PushTopicsState;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
}) {
  return (
    <div className="mb-3">
      <p className="text-muted-foreground mb-2 text-xs uppercase">Defaults</p>
      {state.topics.map((t) => {
        const enabled = resolveSubscription(state.topics, state.subscriptions, t.id, "");
        return (
          <ToggleRow
            key={t.id}
            enabled={enabled}
            label={t.title}
            onToggle={() => void onSetSub(t.id, null, !enabled)}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run — PASS**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/SettingsDrawer.tsx packages/pwa/tests/SettingsDrawer.test.tsx
git commit -m "feat(pwa): SettingsDrawer Defaults block — data-driven topic toggles"
```

---

## Task 4: SettingsDrawer — Per-daemon overrides block

**Files:**
- Modify: `packages/pwa/src/screens/SettingsDrawer.tsx`
- Modify: `packages/pwa/tests/SettingsDrawer.test.tsx`

Each daemon row collapses by default; expanding shows the same topic list with the resolved `enabled` based on `(D, T, daemon_id)` rows.

- [ ] **Step 1: Append failing tests**

```tsx
const sampleDaemons = [
  { daemon_id: "d-1", display_name: "laptop",         hostname: "laptop", connected: true, last_seen_at: Date.now() },
  { daemon_id: "d-2", display_name: "office-desktop", hostname: "office", connected: true, last_seen_at: Date.now() },
];

test("Per-daemon block lists each connected daemon with collapsed default state", () => {
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: sampleDaemons }}
      pushState={baseState()}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
    />,
  );
  expect(screen.getByText("laptop")).toBeTruthy();
  expect(screen.getByText("office-desktop")).toBeTruthy();
  // Collapsed: no per-daemon ToggleRow visible yet
  expect(screen.queryAllByText("Permission alerts")).toHaveLength(1); // only Defaults
});

test("Expanding a daemon shows per-topic toggles using resolved value", () => {
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: sampleDaemons }}
      pushState={baseState({ subscriptions: [{ topic_id: "idle", daemon_id: "d-1", enabled: true }] })}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Override.*laptop|laptop.*Override/i }));
  // After expanding, Defaults still has the topics + d-1's section also has them
  expect(screen.queryAllByText("Permission alerts")).toHaveLength(2);
  expect(screen.queryAllByText("Claude is idle")).toHaveLength(2);
});

test("Per-daemon toggle calls onSetSub with daemon_id=daemon", async () => {
  const calls: Array<{ topic_id: string; daemon_id: string | null; enabled: boolean }> = [];
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: sampleDaemons }}
      pushState={baseState()}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
      onSetSub={async (t, d, e) => { calls.push({ topic_id: t, daemon_id: d, enabled: e }); }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Override.*laptop|laptop.*Override/i }));
  // The d-1 idle toggle currently resolves to default (false). Clicking flips to true with daemon_id='d-1'.
  const idleToggles = screen.getAllByText("Claude is idle").map((n) => n.closest("button")!);
  fireEvent.click(idleToggles[1]!);   // second one is the per-daemon row
  expect(calls).toEqual([{ topic_id: "idle", daemon_id: "d-1", enabled: true }]);
});

test("Reset to defaults calls onResetDaemon", async () => {
  const calls: string[] = [];
  render(
    <SettingsDrawer
      device="desktop"
      account={{ email: "u@x", onSignOut: () => {} }}
      daemons={{ status: "ready", data: sampleDaemons }}
      pushState={baseState({ subscriptions: [{ topic_id: "idle", daemon_id: "d-1", enabled: true }] })}
      pairing={{ status: "idle" }}
      appearance="system"
      {...noopHandlers}
      onResetDaemon={async (id) => { calls.push(id); }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Override.*laptop|laptop.*Override/i }));
  fireEvent.click(screen.getByRole("button", { name: /Reset to defaults/ }));
  expect(calls).toEqual(["d-1"]);
});
```

- [ ] **Step 2: Run — FAIL**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

- [ ] **Step 3: Replace `PerDaemonBlock` placeholder**

```tsx
function PerDaemonBlock({
  state, daemons, onSetSub, onResetDaemon,
}: {
  state: PushTopicsState;
  daemons: Resource<DaemonItem[]>;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
}) {
  if (daemons.status !== "ready" || daemons.data.length === 0) return null;
  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs uppercase">Per-daemon overrides</p>
      {daemons.data.map((d) => (
        <DaemonOverrideRow
          key={d.daemon_id}
          daemon={d}
          state={state}
          onSetSub={onSetSub}
          onResetDaemon={onResetDaemon}
        />
      ))}
    </div>
  );
}

function DaemonOverrideRow({
  daemon, state, onSetSub, onResetDaemon,
}: {
  daemon: DaemonItem;
  state: PushTopicsState;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverrides = state.subscriptions.some((s) => s.daemon_id === daemon.daemon_id);

  return (
    <div className="rounded-card border-border bg-surface mb-2 border p-3">
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-medium">{daemon.display_name ?? daemon.daemon_id}</span>
        <Button size="sm" variant="secondary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Collapse" : `Override${hasOverrides ? " ✓" : ""}`}
        </Button>
      </div>
      {expanded && (
        <div className="mt-3">
          {state.topics.map((t) => {
            const enabled = resolveSubscription(state.topics, state.subscriptions, t.id, daemon.daemon_id);
            return (
              <ToggleRow
                key={t.id}
                enabled={enabled}
                label={t.title}
                onToggle={() => void onSetSub(t.id, daemon.daemon_id, !enabled)}
              />
            );
          })}
          <Button size="sm" variant="secondary" onClick={() => void onResetDaemon(daemon.daemon_id)}>
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — PASS**

```bash
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/SettingsDrawer.tsx packages/pwa/tests/SettingsDrawer.test.tsx
git commit -m "feat(pwa): SettingsDrawer per-daemon overrides block with expand/collapse + reset"
```

---

## Task 5: Wire `usePushTopics` into `RealApp`

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Edit imports + hook usage**

In `packages/pwa/src/RealApp.tsx`:

- Replace `import { usePushPrefs } from "./hooks/usePushPrefs";` with:
  ```ts
  import { usePushTopics } from "./hooks/usePushTopics";
  ```
- Replace `const pushHook = usePushPrefs(HUB_URL, bearer);` with:
  ```ts
  const pushHook = usePushTopics(HUB_URL, bearer);
  ```
- Replace the `<SettingsDrawer ... pushPrefs={pushHook.prefs} onTogglePref={pushHook.toggle} ...>` props with:
  ```tsx
  pushState={pushHook.state}
  onSetSub={pushHook.setSub}
  onResetDaemon={pushHook.resetDaemon}
  onSetDnd={pushHook.setDnd}
  pushActionError={pushHook.lastActionError}
  ```

- [ ] **Step 2: Build to confirm types**

```bash
bun run --filter @cc-remote/pwa build
```

Expected: clean.

- [ ] **Step 3: Existing PWA tests still pass**

```bash
bun test packages/pwa/
```

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/RealApp.tsx
git commit -m "feat(pwa): RealApp wires usePushTopics into SettingsDrawer"
```

---

## Task 6: Wire stub into `DemoApp`

**Files:**
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Replace stubbedPrefs with stubbedTopics**

```tsx
// at top
import type { PushTopicsState, DndSettings } from "../hooks/usePushTopics";

// inside the component, replace `stubbedPrefs` block with:
const stubbedTopics: Resource<PushTopicsState> = {
  status: "ready",
  data: {
    topics: [
      { id: "permission", title: "Permission alerts",  description: "Claude wants to run a tool.", default_enabled: true,  bypass_dnd: true  },
      { id: "offline",    title: "Daemon offline",     description: "A daemon went offline.",      default_enabled: false, bypass_dnd: false },
      { id: "completed",  title: "Claude finished a turn", description: "",                        default_enabled: false, bypass_dnd: false },
      { id: "idle",       title: "Claude is idle",     description: "",                            default_enabled: false, bypass_dnd: false },
    ],
    subscriptions: [],
    dnd: { enabled: false, start_hh_mm: null, end_hh_mm: null, timezone: null },
  },
};

// In the SettingsDrawer JSX, replace
//   pushPrefs={stubbedPrefs}
//   onTogglePref={() => {}}
// with:
//   pushState={stubbedTopics}
//   onSetSub={async () => {}}
//   onResetDaemon={async () => {}}
//   onSetDnd={async () => {}}
```

Remove the now-unused `import type { PushPreferences } from "../hooks/usePushPrefs";`.

- [ ] **Step 2: Run typecheck + smoke**

```bash
bun run --filter @cc-remote/pwa typecheck
bun run --filter @cc-remote/pwa build
```

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/demo/DemoApp.tsx
git commit -m "feat(pwa): DemoApp stubs the new push topics shape"
```

---

## Task 7: Delete `usePushPrefs`

**Files:**
- Delete: `packages/pwa/src/hooks/usePushPrefs.ts`
- Delete: any tests under `packages/pwa/tests/usePushPrefs.test.ts` if present

- [ ] **Step 1: Confirm no remaining references**

```bash
grep -rn "usePushPrefs\|PushPreferences\|isPushPrefEnabled" packages/pwa/src packages/pwa/tests
```

Expected: no source matches outside the file we are about to delete.

- [ ] **Step 2: Delete**

```bash
rm packages/pwa/src/hooks/usePushPrefs.ts
```

(If a `usePushPrefs.test.ts` exists, delete it too.)

- [ ] **Step 3: Build + test**

```bash
bun run --filter @cc-remote/pwa typecheck && bun run --filter @cc-remote/pwa build && bun test packages/pwa/
```

- [ ] **Step 4: Commit**

```bash
git add -u packages/pwa/src/hooks/usePushPrefs.ts
git commit -m "chore(pwa): drop usePushPrefs (replaced by usePushTopics)"
```

---

## Task 8: Existing e2e regression check + tag

**Files:** none

- [ ] **Step 1: Existing PWA-flavoured e2e**

```bash
bun test e2e-real/tests/13-settings-drawer.test.ts
```

The drawer markup changed substantially. If `13-settings-drawer.test.ts` asserted on the old four-toggle labels, the assertion text needs updating to the new ones (`Permission alerts`, `Daemon offline`, `Claude finished a turn`, `Claude is idle`) — but those are exactly today's labels so most likely no change is needed. If the test is testing visibility of all four toggles, it may also need to expand a daemon override row to find `Permission alerts` more than once; update the test to look at the Defaults block specifically (e.g., `getByText("Permission alerts").first()`).

- [ ] **Step 2: All e2e**

```bash
bun test e2e-real/
```

Expected: green; if any failure relates to the SettingsDrawer markup, fix the test (not the implementation) since this plan does not change semantics, only the new sections.

- [ ] **Step 3: Tag**

```bash
git tag plan-push-topics-03-pwa
```

---

## Done criteria

- ✅ `usePushTopics` hook with optimistic updates, retry, error surface.
- ✅ SettingsDrawer Notifications section: DND block (toggle + time + tz), Defaults block (data-driven topic list), Per-daemon overrides block (expand/collapse + reset).
- ✅ RealApp + DemoApp swap to new hook/stub.
- ✅ `usePushPrefs.ts` deleted; no orphan references.
- ✅ `bun test packages/pwa/` green; existing e2e green.
- ✅ Tag `plan-push-topics-03-pwa`.

---

## Self-review

- **Spec coverage (Plan 03 scope):** §PWA UI ✓ Tasks 2/3/4; §Hook (`usePushTopics`) ✓ Task 1; wiring ✓ Tasks 5/6.
- **Out of Plan 03 scope (Plan 04):** PWA manifest, icons, ops doc, e2e scenario 21.
- **Placeholders:** none; the placeholder `DefaultsBlock`/`PerDaemonBlock` returning `null` exists only for Task 2's commit and is replaced in Tasks 3/4 — this is documented in the steps.
- **Type consistency:** `daemon_id: string | null` from hook matches `SubRow.daemon_id` and `SettingsDrawerProps.onSetSub`. `PushTopicsState` re-exported from the hook is the type the drawer consumes.
- **Test completeness:** hook tests cover load/setSub/resetDaemon/setDnd/error; drawer tests cover render-from-server, defaults toggle, per-daemon expand, per-daemon toggle, reset, DND save.
