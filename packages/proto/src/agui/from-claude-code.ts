/**
 * Claude Code JSONL → AG-UI event adapter (spike).
 *
 * Input shape: a parsed JSONL row from `~/.claude/projects/<...>/<sid>.jsonl`,
 * i.e. EventFrame.payload from packages/proto/src/frames.ts. Output: 0..N
 * AG-UI events that, when fed through to-timeline.ts, reproduce the
 * TimelineEvent stream that packages/pwa/src/lib/timeline.ts:mergeTimeline()
 * produces today.
 *
 * Design notes:
 *  - We emit *_CHUNK variants rather than start/content/end triples. AG-UI's
 *    spec says clients automatically expand chunks, which keeps the adapter
 *    simple (1 JSONL row → 1 AG-UI event for the common case).
 *  - We DO NOT track turn boundaries here. RUN_STARTED / RUN_FINISHED would
 *    come from the daemon's session-FSM (working/idle transitions), not from
 *    JSONL parsing — synthesising them per-row would double-emit.
 *  - Filtering of HIDDEN_PAYLOAD_TYPES / HIDDEN_TOOL_NAMES preserves the
 *    same noise reduction the PWA does today; otherwise round-trip would
 *    drown in mcp__cc-remote__/system/etc.
 */

import type { AgUiEvent } from "./events.ts";
import { EventType } from "./events.ts";

export interface FromClaudeCodeContext {
  /** Reserved for future use — the daemon's ClaudeCodeAdapter passes
   *  these for symmetry with run-lifecycle event ids. fromClaudeCode
   *  itself does NOT consume them. */
  threadId?: string;
  /** Reserved for future use — see threadId. */
  runId?: string;
  /** Required when present in the source frame. The adapter uses it
   *  to seed unique synthetic ids for blocks within one row. */
  offset?: number;
  /** Reserved for future state-doc reconstruction. */
  prevState?: unknown;
}

const HIDDEN_PAYLOAD_TYPES = new Set<string>([
  // NB: "attachment" is handled explicitly above (queued_command surfaces
  // as a user TEXT_MESSAGE_CHUNK; other subtypes emit nothing).
  "queue-operation",
  "mcp_instructions_data",
  "ai-title",
  "system",
  "file-history-snapshot",
  "last-prompt",
  "permission-mode",
  "pr-link",
  // NB: "summary" is NOT hidden — we surface it as a RAW event.
]);

const HIDDEN_TOOL_NAME_PREFIXES = ["mcp__cc-remote__"];
const HIDDEN_TOOL_NAMES = new Set(["ToolSearch"]);

function isHiddenToolName(name: string): boolean {
  if (HIDDEN_TOOL_NAMES.has(name)) return true;
  return HIDDEN_TOOL_NAME_PREFIXES.some((p) => name.startsWith(p));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function stringField(obj: unknown, key: string): string {
  if (!isObject(obj)) return "";
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function extractPayloadType(payload: unknown): string {
  if (isObject(payload) && typeof payload["type"] === "string") {
    return payload["type"];
  }
  return "event";
}

function extractContentBlocks(payload: unknown): unknown[] {
  if (!isObject(payload)) return [];
  const message = payload["message"];
  if (!isObject(message)) return [];
  const content = message["content"];
  return Array.isArray(content) ? content : [];
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isObject(block) && block["type"] === "text") {
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

function parseTimestampMs(payload: unknown): number | undefined {
  if (!isObject(payload)) return undefined;
  const ts = payload["timestamp"];
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * Strip the `<channel ...>BODY</channel>` envelope that wraps PWA-injected
 * user prose. Mirrors packages/pwa/src/lib/timeline.ts:stripChannelEnvelope.
 */
function stripChannelEnvelope(content: string): string {
  const m = content.match(/^<channel\b[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/);
  return (m && m[1] ? m[1] : content).trim();
}

/** True when a user prose looks like CC's protocol meta (dropped by PWA). */
function isMetaProse(prose: string): boolean {
  return /^<(local-command|command-(name|message|args)|system-reminder)/.test(
    prose.trim(),
  );
}

/**
 * Map one parsed Claude Code JSONL row to zero or more AG-UI events.
 *
 * INPUT
 * - `jsonlRow`: an `unknown` (parsed `JSON.parse(line)`); null/non-object
 *   rows are emitted as a single RAW event.
 * - `ctx`: see {@link FromClaudeCodeContext}. `threadId`/`runId` are
 *   reserved-for-future-use and not consumed by this function.
 *
 * EMISSIONS — guaranteed by spec contracts in
 * `docs/superpowers/specs/2026-05-25-ag-ui-design.md`:
 * - decision #5: NEVER emits RUN_STARTED / RUN_FINISHED / RUN_ERROR
 *   (those are FSM-driven in the daemon).
 * - decision #7: every TOOL_CALL_RESULT carries
 *   `rawEvent.is_error: boolean` (Claude's tool_result.is_error).
 * - decision #8: thinking blocks become REASONING_MESSAGE_CHUNK; the
 *   deprecated THINKING_* family is never emitted.
 * - decision #10: emits zero CUSTOM events. Anything that doesn't fit
 *   a standard AG-UI event falls through to RAW.
 */
export function fromClaudeCode(
  jsonlRow: unknown,
  ctx: FromClaudeCodeContext,
): AgUiEvent[] {
  const out: AgUiEvent[] = [];
  const offset = ctx.offset ?? 0;
  const ts = parseTimestampMs(jsonlRow);
  const payloadType = extractPayloadType(jsonlRow);

  // ── assistant message ───────────────────────────────────────────────
  if (payloadType === "assistant") {
    const blocks = extractContentBlocks(jsonlRow);
    blocks.forEach((block, idx) => {
      if (!isObject(block)) return;
      const blockType = block["type"];

      if (blockType === "text") {
        const text = stringField(block, "text");
        if (!text) return;
        out.push({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: `event:${offset}:${idx}`,
          role: "assistant",
          delta: text,
          ...(ts !== undefined ? { timestamp: ts } : {}),
          rawEvent: jsonlRow,
        } as AgUiEvent);
        return;
      }

      if (blockType === "thinking") {
        const thinking = stringField(block, "thinking");
        if (!thinking.trim()) return;
        out.push({
          type: EventType.REASONING_MESSAGE_CHUNK,
          messageId: `event:${offset}:${idx}`,
          delta: thinking,
          ...(ts !== undefined ? { timestamp: ts } : {}),
          rawEvent: jsonlRow,
        } as AgUiEvent);
        return;
      }

      if (blockType === "tool_use") {
        const id = stringField(block, "id");
        const name = stringField(block, "name");

        // Special-case: cc-remote `reply` tool carries Claude's chat text.
        if (name === "mcp__cc-remote__reply") {
          const input = block["input"];
          const replyText = isObject(input) ? stringField(input, "text") : "";
          if (replyText) {
            out.push({
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: `event:${offset}:${idx}:reply`,
              role: "assistant",
              delta: replyText,
              ...(ts !== undefined ? { timestamp: ts } : {}),
              rawEvent: jsonlRow,
            } as AgUiEvent);
          }
          return;
        }

        if (isHiddenToolName(name)) return;

        const input = block["input"];
        out.push({
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: id || `tool:${offset}:${idx}`,
          toolCallName: name,
          parentMessageId: `event:${offset}:${idx}`,
          delta: JSON.stringify(input ?? {}),
          ...(ts !== undefined ? { timestamp: ts } : {}),
          rawEvent: jsonlRow,
        } as AgUiEvent);
        return;
      }
      // unknown block types silently dropped (forward-compat).
    });
    return out;
  }

  // ── user message ────────────────────────────────────────────────────
  if (payloadType === "user") {
    const messageContent = (jsonlRow as { message?: { content?: unknown } } | null)
      ?.message?.content;
    let userProse: string | null =
      typeof messageContent === "string" ? messageContent : null;

    const blocks = extractContentBlocks(jsonlRow);
    let hasToolResult = false;
    for (const block of blocks) {
      if (!isObject(block)) continue;
      const t = block["type"];
      if (t === "tool_result") {
        hasToolResult = true;
        const toolUseId = stringField(block, "tool_use_id");
        const isError = block["is_error"] === true;
        const output = stringifyToolOutput(block["content"]);
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `event:${offset}:result:${toolUseId}`,
          toolCallId: toolUseId,
          content: output,
          role: "tool",
          ...(ts !== undefined ? { timestamp: ts } : {}),
          // Stash the is_error flag inside rawEvent (decision #7 of
          // docs/superpowers/specs/2026-05-25-ag-ui-design.md). AG-UI's
          // TOOL_CALL_RESULT has no first-class success flag.
          rawEvent: { is_error: isError, source: "claude-code-jsonl", row: jsonlRow },
        } as AgUiEvent);
      } else if (t === "text" && !userProse) {
        userProse = stringField(block, "text");
      }
    }

    // tool_result-only frames have no prose to emit.
    if (hasToolResult && !userProse) return out;

    if (userProse) {
      const origin = (jsonlRow as { origin?: { kind?: unknown } } | null)?.origin;
      const isChannel = isObject(origin) && origin["kind"] === "channel";
      const isMeta =
        !isChannel &&
        ((jsonlRow as { isMeta?: unknown } | null)?.isMeta === true ||
          isMetaProse(userProse));
      if (!isMeta) {
        const body = isChannel ? stripChannelEnvelope(userProse) : userProse;
        if (body) {
          out.push({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: `event:${offset}:user`,
            role: "user",
            delta: body,
            ...(ts !== undefined ? { timestamp: ts } : {}),
            rawEvent: jsonlRow,
          } as AgUiEvent);
        }
      }
    }
    return out;
  }

  // ── attachment ──────────────────────────────────────────────────────
  // Claude Code drops `attachment` rows into the JSONL for queued commands
  // (channel injections that arrive mid-tool-call) and for file/image
  // attachments. We only surface queued_command attachments — everything
  // else is intentionally silent (the PWA filters payloadType==="attachment"
  // as RAW, so the fallback would never be visible anyway).
  if (payloadType === "attachment") {
    const attachment = isObject(jsonlRow) ? jsonlRow["attachment"] : undefined;
    const subtype = stringField(attachment, "type");
    if (subtype === "queued_command") {
      const prompt = stringField(attachment, "prompt");
      // queued_command always wraps the user's prose in a <channel> envelope
      // when it originated from cc-remote. Strip the envelope unconditionally;
      // stripChannelEnvelope is a no-op when the envelope is absent.
      const body = stripChannelEnvelope(prompt);
      // Note: the row carries `isMeta:true`, but that flag is Claude's marker
      // for "system inject" prose — for channel queued_command it's misleading,
      // so we ignore it here (unlike the regular user-message branch).
      if (body) {
        out.push({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: `event:${offset}:queued_user`,
          role: "user",
          delta: body,
          ...(ts !== undefined ? { timestamp: ts } : {}),
          rawEvent: jsonlRow,
        } as AgUiEvent);
      }
    }
    // Other attachment subtypes (image, file, …) emit nothing.
    return out;
  }

  // ── compact / summary marker ────────────────────────────────────────
  if (payloadType === "summary") {
    out.push({
      type: EventType.RAW,
      source: "claude-code-jsonl",
      event: jsonlRow,
      ...(ts !== undefined ? { timestamp: ts } : {}),
    } as AgUiEvent);
    return out;
  }

  // ── filter remaining protocol-internal types ────────────────────────
  if (HIDDEN_PAYLOAD_TYPES.has(payloadType)) return out;

  // ── unknown JSONL row → RAW ─────────────────────────────────────────
  out.push({
    type: EventType.RAW,
    event: jsonlRow,
    source: "claude-code-jsonl",
    ...(ts !== undefined ? { timestamp: ts } : {}),
    rawEvent: jsonlRow,
  } as AgUiEvent);
  return out;
}
