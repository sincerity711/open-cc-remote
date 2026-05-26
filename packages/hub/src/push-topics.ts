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

interface PermissionCtx { daemon_id: string; session_id: string; request_id: string; tool: string; args_summary: string }
interface OfflineCtx    { daemon_id: string; hostname: string; since_ms: number }
interface SessionCtx    { daemon_id: string; session_id: string }

const permissionTopic: PushTopic = {
  id: "permission",
  title: "Permission alerts",
  description: "Claude is asking to run a tool and waiting for your approval.",
  default_enabled: true,
  bypass_dnd: true,
  build_payload(ctx) {
    const c = ctx as PermissionCtx;
    return {
      kind: "permission",
      title: "cc-remote",
      body: `${c.daemon_id} wants to run ${c.tool}\n${c.args_summary}`,
      tag: `permission:${c.request_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
      request_id: c.request_id,
      require_interaction: true,
    };
  },
  build_tag: (p) => p.tag,
};

const offlineTopic: PushTopic = {
  id: "offline",
  title: "Daemon offline",
  description: "A connected daemon has been offline for at least 30 seconds.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as OfflineCtx;
    const seconds = Math.round((c.since_ms ?? 0) / 1000);
    return {
      kind: "offline",
      title: "cc-remote",
      body: `${c.hostname ?? c.daemon_id} has been offline for ${seconds}s`,
      tag: `offline:${c.daemon_id}`,
      daemon_id: c.daemon_id,
    };
  },
  build_tag: (p) => p.tag,
};

const completedTopic: PushTopic = {
  id: "completed",
  title: "Claude finished a turn",
  description: "Claude has finished responding in one of your sessions.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as SessionCtx;
    return {
      kind: "completed",
      title: "cc-remote",
      body: `${c.daemon_id} / ${c.session_id} finished a turn`,
      tag: `completed:${c.daemon_id}:${c.session_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
    };
  },
  build_tag: (p) => p.tag,
};

const idleTopic: PushTopic = {
  id: "idle",
  title: "Claude is idle",
  description: "Claude is idle and waiting for input.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as SessionCtx;
    return {
      kind: "idle",
      title: "cc-remote",
      body: `${c.daemon_id} / ${c.session_id} is idle (waiting for input)`,
      tag: `idle:${c.daemon_id}:${c.session_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
    };
  },
  build_tag: (p) => p.tag,
};

export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  permissionTopic, offlineTopic, completedTopic, idleTopic,
];

const BY_ID = new Map(PUSH_TOPICS.map((t) => [t.id, t] as const));

export function getTopic(id: string): PushTopic {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`unknown topic: ${id}`);
  return t;
}
