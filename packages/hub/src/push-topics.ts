// packages/hub/src/push-topics.ts
export interface PushPayload {
  kind: string;
  title: string;
  body: string;
  tag: string;
  daemon_id: string;
  session_id?: string;
  request_id?: string;
  require_interaction?: boolean;
  [k: string]: unknown;
}

export interface PushTopic {
  id: string;
  title: string;
  description: string;
  default_enabled: boolean;
  bypass_dnd: boolean;
  /** Builds the full notification payload (title/body/etc.) from a trigger context. */
  build_payload: (ctx: unknown) => PushPayload;
  /** Tag string used by the OS to collapse duplicate notifications. */
  build_tag: (payload: PushPayload) => string;
}

// Plan 02 replaces these stubs with real copy + tags.
const stubBuild = (id: string) => (ctx: unknown): PushPayload => {
  const c = (ctx ?? {}) as Record<string, unknown>;
  return {
    kind: id,
    title: "cc-remote",
    body: "",
    tag: id,
    daemon_id: String(c.daemon_id ?? ""),
    ...(typeof c.session_id === "string" ? { session_id: c.session_id } : {}),
    ...(typeof c.request_id === "string" ? { request_id: c.request_id } : {}),
  };
};
const stubTag = (p: PushPayload) => p.tag;

export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  {
    id: "permission",
    title: "Permission alerts",
    description: "Claude is asking to run a tool and waiting for your approval.",
    default_enabled: true,
    bypass_dnd: true,
    build_payload: stubBuild("permission"),
    build_tag: stubTag,
  },
  {
    id: "offline",
    title: "Daemon offline",
    description: "A connected daemon has been offline for at least 30 seconds.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("offline"),
    build_tag: stubTag,
  },
  {
    id: "completed",
    title: "Claude finished a turn",
    description: "Claude has finished responding in one of your sessions.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("completed"),
    build_tag: stubTag,
  },
  {
    id: "idle",
    title: "Claude is idle",
    description: "Claude is idle and waiting for input.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("idle"),
    build_tag: stubTag,
  },
];

const BY_ID = new Map(PUSH_TOPICS.map((t) => [t.id, t] as const));

export function getTopic(id: string): PushTopic {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`unknown topic: ${id}`);
  return t;
}
