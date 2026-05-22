import type {
  EventFrameForPwa,
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import type { TimelineEvent } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: EventFrameForPwa[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  /** Unix milliseconds — the sole ordering key for the merged timeline. */
  tsMs: number;
  /** Tiebreaker for stable ordering when timestamps collide (e.g. chat and event in the same ms). */
  rank: number;
  item: TimelineEvent;
}

/**
 * Protocol-internal JSONL payload types that should never appear in the user
 * timeline. `user` and `assistant` are now inspected in detail (see below) —
 * their text content is dropped (covered by chat broadcast) but tool_use,
 * tool_result, and thinking blocks become live cards.
 *
 * The remaining types are session-control noise (attachments, summaries,
 * queue ops, MCP instructions, AI title metadata, file-history snapshots,
 * last-prompt, permission-mode, pr-link, raw `system` JSONL frames) that
 * previously fell through to the raw-JSON card and dominated the panel.
 */
const HIDDEN_PAYLOAD_TYPES = new Set<string>([
  "attachment",
  "summary",
  "queue-operation",
  "mcp_instructions_data",
  "ai-title",
  "system",
  "file-history-snapshot",
  "last-prompt",
  "permission-mode",
  "pr-link",
]);

/**
 * MCP tools whose tool_use blocks should NOT surface as timeline cards.
 * Two classes:
 *   - `mcp__cc-remote__`: cc-remote-plugin-internal tools used by the
 *     channel-permission protocol; chat broadcast already shows the result.
 *   - `ToolSearch`: Claude's built-in deferred-tool-resolver — it shows up
 *     when claude introspects its own toolbox, never represents user work.
 */
const HIDDEN_TOOL_NAME_PREFIXES = ["mcp__cc-remote__"];
const HIDDEN_TOOL_NAMES = new Set(["ToolSearch"]);

function isHiddenToolName(name: string): boolean {
  if (HIDDEN_TOOL_NAMES.has(name)) return true;
  return HIDDEN_TOOL_NAME_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Pure derivation of the visible timeline. JSONL is the source of truth for
 * rendering — chat broadcasts are notification-layer only (badge counts,
 * push, daemon-offline error banner) and are NOT included here. The args
 * still carry `chat` for API compat but the field is ignored.
 *
 * Timestamps: JSONL events arrive with `ts > 0` for live (daemon watcher)
 * and `ts === 0` for history-replayed lines. Sorting is by tsMs then
 * jsonl_offset for stable ordering.
 */
export function mergeTimeline(args: MergeTimelineArgs): TimelineEvent[] {
  const buf: TimedItem[] = [];
  // Map tool_use.id → the TimelineEvent we emitted for it, so a later
  // user/tool_result frame can mutate the same object in place.
  const toolById = new Map<string, TimelineEvent>();

  for (const e of args.events) {
    const tsMs = e.ts > 0 ? e.ts : 0;
    const payloadType = extractPayloadType(e.payload);

    if (payloadType === "assistant") {
      const blocks = extractContentBlocks(e.payload);
      blocks.forEach((block, idx) => {
        if (!isObject(block)) return;
        const type = (block as { type?: unknown }).type;
        if (type === "text") {
          const text = stringField(block, "text");
          if (!text) return;
          buf.push({
            tsMs,
            rank: e.jsonl_offset * 100 + idx,
            item: {
              id: `event:${e.jsonl_offset}:${idx}`,
              kind: "assistant",
              title: "Claude",
              body: text,
              time: formatClockTime(tsMs),
            },
          });
          return;
        }
        if (type === "thinking") {
          const thinkingText = stringField(block, "thinking");
          if (!thinkingText.trim()) return;
          buf.push({
            tsMs,
            rank: e.jsonl_offset * 100 + idx,
            item: {
              id: `event:${e.jsonl_offset}:${idx}`,
              kind: "thinking",
              title: "Reasoning",
              body: thinkingText,
              tokens: "",
              time: formatClockTime(tsMs),
            },
          });
          return;
        }
        if (type === "tool_use") {
          const id = stringField(block, "id");
          const name = stringField(block, "name");
          // The cc-remote `reply` tool carries Claude's actual chat
          // response — render it as a normal assistant bubble instead of
          // hiding (its companion tool_result is just "delivered" plumbing).
          if (name === "mcp__cc-remote__reply") {
            const input = (block as { input?: unknown }).input;
            const replyText = isObject(input) ? stringField(input, "text") : "";
            if (replyText) {
              buf.push({
                tsMs,
                rank: e.jsonl_offset * 100 + idx,
                item: {
                  id: `event:${e.jsonl_offset}:${idx}:reply`,
                  kind: "assistant",
                  title: "Claude",
                  body: replyText,
                  time: formatClockTime(tsMs),
                },
              });
            }
            // Drop the matching tool_use card entirely — already rendered as text.
            return;
          }
          if (isHiddenToolName(name)) return;
          const input = (block as { input?: unknown }).input;
          const tool: TimelineEvent = {
            id: `tool:${id}`,
            kind: "tool",
            tool: name,
            command: derivedToolCommand(name, input),
            cwd: "",
            duration: "",
            result: "running",
            summary: "",
            output: "",
          };
          buf.push({
            tsMs,
            rank: e.jsonl_offset * 100 + idx,
            item: tool,
          });
          if (id) toolById.set(id, tool);
          return;
        }
        // forward-compat: unknown content block types are silently skipped.
      });
      continue;
    }

    // Inspect user content blocks: tool_result mutates the matching tool.
    // Regular user prose (string content OR text-block content) renders as
    // a user bubble — channel-injected (PWA chat) messages get their
    // <channel ...>...</channel> envelope stripped first.
    if (payloadType === "user") {
      let userProse: string | null = null;
      const messageContent = (e.payload as { message?: { content?: unknown } } | null)
        ?.message?.content;
      if (typeof messageContent === "string") {
        userProse = messageContent;
      }

      const blocks = extractContentBlocks(e.payload);
      let hasToolResult = false;
      for (const block of blocks) {
        if (!isObject(block)) continue;
        const type = (block as { type?: unknown }).type;
        if (type === "tool_result") {
          hasToolResult = true;
          const toolUseId = stringField(block, "tool_use_id");
          const target = toolUseId ? toolById.get(toolUseId) : undefined;
          if (!target || target.kind !== "tool") continue;
          const isError = (block as { is_error?: unknown }).is_error === true;
          const output = stringifyToolOutput((block as { content?: unknown }).content);
          target.result = isError ? "failure" : "success";
          target.output = output;
          target.summary = firstLine(output, 80);
        } else if (type === "text") {
          // text blocks inside user content carry prose (less common — happens
          // when CC injects synthesized user messages alongside tool results).
          const text = stringField(block, "text");
          if (text && !userProse) userProse = text;
        }
      }

      // tool_result-only user payloads carry no prose — already mutated the
      // tool card above, nothing else to render.
      if (hasToolResult && !userProse) continue;

      if (userProse) {
        const origin = (e.payload as { origin?: { kind?: unknown } } | null)?.origin;
        const isChannel = isObject(origin) && (origin as { kind?: unknown }).kind === "channel";
        const isMetaProtocol =
          !isChannel &&
          ((e.payload as { isMeta?: unknown } | null)?.isMeta === true ||
            /^<(local-command|command-(name|message|args)|system-reminder)/.test(userProse.trim()));
        if (!isMetaProtocol) {
          const body = isChannel ? stripChannelEnvelope(userProse) : userProse;
          if (body) {
            buf.push({
              tsMs,
              rank: e.jsonl_offset,
              item: {
                id: `event:${e.jsonl_offset}:user`,
                kind: "user",
                title: "You",
                body,
                time: formatClockTime(tsMs),
              },
            });
          }
        }
      }
      continue;
    }

    // Filter remaining protocol-internal payload types.
    if (HIDDEN_PAYLOAD_TYPES.has(payloadType)) continue;

    buf.push({
      tsMs,
      rank: e.jsonl_offset,
      item: {
        id: `event:${e.jsonl_offset}`,
        kind: "raw",
        title: payloadType,
        json: safeStringify(e.payload),
      },
    });
  }

  // Pending permission requests → permission-inline.
  // expires_at is unix seconds (per @cc-remote/proto).
  for (const p of args.pending) {
    const tsMs = p.expires_at * 1000;
    buf.push({
      tsMs,
      rank: 0,
      item: {
        id: `perm:${p.request_id}`,
        kind: "permission-inline",
        tool: p.tool,
        command: p.args_summary,
        risk: "warning",
      },
    });
  }

  // Resolved permissions → permission-resolved. The protocol carries no ts
  // on the resolved frame, so we sort them after pending requests via a high
  // rank — the live UI will mostly receive these one at a time anyway.
  for (const r of args.resolved) {
    buf.push({
      tsMs: 0,
      rank: Number.MAX_SAFE_INTEGER,
      item: {
        id: `perm-res:${r.request_id}`,
        kind: "permission-resolved",
        decision: mapDecision(r.decision),
        via: r.decided_via,
        time: "",
      },
    });
  }

  buf.sort((a, b) => (a.tsMs - b.tsMs) || (a.rank - b.rank));
  return buf.map((b) => b.item);
}

function extractPayloadType(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "type" in payload &&
    typeof (payload as { type: unknown }).type === "string"
  ) {
    return (payload as { type: string }).type;
  }
  return "event";
}

/**
 * For an `assistant` or `user` JSONL frame, return the array at
 * `payload.message.content` if it is an array. Returns [] if the field is
 * missing or a string (regular text-only message — covered by chat broadcast).
 */
function extractContentBlocks(payload: unknown): unknown[] {
  if (!isObject(payload)) return [];
  const message = (payload as { message?: unknown }).message;
  if (!isObject(message)) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/**
 * Strip the `<channel source="..." ...>BODY</channel>` envelope that Claude
 * Code wraps cc-remote channel-injected user messages in. We split this out
 * so PWA-sent chat messages render as plain user prose after a refresh
 * (chat broadcasts aren't persisted; JSONL is the only source).
 */
export function stripChannelEnvelope(content: string): string {
  const m = content.match(/^<channel\b[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/);
  return (m && m[1] ? m[1] : content).trim();
}

function stringField(obj: unknown, key: string): string {
  if (!isObject(obj)) return "";
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/**
 * Compact one-line representation of a tool_use.input, picked per tool.
 * Fallback truncates a JSON dump.
 */
export function derivedToolCommand(toolName: string, input: unknown): string {
  if (!isObject(input)) {
    return safeStringify(input).slice(0, 120);
  }
  switch (toolName) {
    case "Bash": {
      const cmd = stringField(input, "command");
      if (cmd) return cmd;
      return JSON.stringify(input).slice(0, 200);
    }
    case "Read":
    case "Write":
    case "Edit": {
      const path = stringField(input, "file_path");
      if (path) return path;
      break;
    }
    case "Grep": {
      return stringField(input, "pattern") || stringField(input, "query");
    }
    case "Glob":
      return stringField(input, "pattern");
    default:
      break;
  }
  return JSON.stringify(input).slice(0, 120);
}

/**
 * Normalize a tool_result.content (string | text-block array | other) to a
 * plain string suitable for inline display.
 */
export function stringifyToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isObject(block) && (block as { type?: unknown }).type === "text") {
        const t = stringField(block, "text");
        if (t) parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(content).slice(0, 4000);
  } catch {
    return "";
  }
}

function firstLine(s: string, max: number): string {
  if (!s) return "";
  const nl = s.indexOf("\n");
  const line = (nl === -1 ? s : s.slice(0, nl)).trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function mapDecision(
  d: PwaPermissionResolved["decision"],
): "allowed" | "denied" | "expired" {
  if (d === "allow") return "allowed";
  if (d === "deny") return "denied";
  return "expired";
}

function formatClockTime(tsMs: number): string {
  if (tsMs <= 0) return "";
  const date = new Date(tsMs);
  const h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, "0");
  const period = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${m} ${period}`;
}
