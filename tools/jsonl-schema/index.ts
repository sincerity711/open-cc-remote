// Hand-rolled validator for Claude Code JSONL session lines.
//
// Why hand-rolled: only one consumer (drift-detector test + fixture lock-in)
// and we want zero new runtime deps. The validator is deliberately strict on
// the shapes the PWA's mergeTimeline relies on (assistant.message.content
// blocks, user.tool_result blocks) and lenient on protocol-internal entries
// it ignores (system/summary/file-history-snapshot/etc.) so future Claude
// Code versions don't break tests when they ship a new envelope type.

export type ValidateResult = { ok: true } | { ok: false; error: string };

/** Top-level Claude JSONL line types we know about. Anything not in this set
 * passes through (forward-compat). */
const PASSTHROUGH_TOP_LEVEL = new Set<string>([
  "system",
  "summary",
  "attachment",
  "queue-operation",
  "file-history-snapshot",
  "mcp_instructions_data",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "pr-link",
]);

const ASSISTANT_BLOCK_TYPES = new Set<string>(["text", "thinking", "tool_use"]);
const USER_BLOCK_TYPES = new Set<string>(["tool_result", "text"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Validate a single content block from `message.content`. */
export function validateContentBlock(block: unknown): ValidateResult {
  if (!isObject(block)) {
    return { ok: false, error: "content block is not an object" };
  }
  const type = block["type"];
  if (!isString(type)) {
    return { ok: false, error: "content block missing string `type`" };
  }
  if (type === "text") {
    if (!isString(block["text"])) {
      return { ok: false, error: "text block missing string `text`" };
    }
    return { ok: true };
  }
  if (type === "thinking") {
    if (!isString(block["thinking"])) {
      return { ok: false, error: "thinking block missing string `thinking`" };
    }
    if (block["signature"] !== undefined && !isString(block["signature"])) {
      return { ok: false, error: "thinking block `signature` must be string when present" };
    }
    return { ok: true };
  }
  if (type === "tool_use") {
    if (!isString(block["id"])) {
      return { ok: false, error: "tool_use block missing string `id`" };
    }
    if (!isString(block["name"])) {
      return { ok: false, error: "tool_use block missing string `name`" };
    }
    if (!isObject(block["input"])) {
      return { ok: false, error: "tool_use block missing object `input`" };
    }
    return { ok: true };
  }
  if (type === "tool_result") {
    if (!isString(block["tool_use_id"])) {
      return { ok: false, error: "tool_result block missing string `tool_use_id`" };
    }
    const content = block["content"];
    if (!isString(content) && !Array.isArray(content)) {
      return { ok: false, error: "tool_result block `content` must be string or array" };
    }
    if (block["is_error"] !== undefined && typeof block["is_error"] !== "boolean") {
      return { ok: false, error: "tool_result block `is_error` must be boolean when present" };
    }
    return { ok: true };
  }
  // Unknown content block type → forward-compat pass.
  return { ok: true };
}

/** Validate one Claude JSONL line. */
export function validateClaudeJsonlLine(obj: unknown): ValidateResult {
  if (!isObject(obj)) {
    return { ok: false, error: "line is not a JSON object" };
  }

  const type = obj["type"];
  if (!isString(type)) {
    return { ok: false, error: "missing top-level string `type`" };
  }

  // Protocol-internal types (system/summary/file-history-snapshot/etc.) pass
  // through without further shape enforcement — they don't carry the
  // uuid/timestamp/sessionId fields that conversation lines do.
  if (PASSTHROUGH_TOP_LEVEL.has(type)) {
    return { ok: true };
  }

  if (!isString(obj["uuid"])) {
    return { ok: false, error: "missing top-level string `uuid`" };
  }
  if (!isString(obj["timestamp"])) {
    return { ok: false, error: "missing top-level string `timestamp`" };
  }
  if (!isString(obj["sessionId"])) {
    return { ok: false, error: "missing top-level string `sessionId`" };
  }

  if (type === "assistant") {
    const message = obj["message"];
    if (!isObject(message)) {
      return { ok: false, error: "assistant line missing object `message`" };
    }
    if (message["role"] !== "assistant") {
      return { ok: false, error: "assistant line `message.role` must be \"assistant\"" };
    }
    const content = message["content"];
    if (!Array.isArray(content)) {
      return { ok: false, error: "assistant line `message.content` must be an array" };
    }
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      const r = validateContentBlock(block);
      if (!r.ok) return { ok: false, error: `assistant block[${i}]: ${r.error}` };
      if (isObject(block)) {
        const bt = block["type"];
        if (isString(bt) && !ASSISTANT_BLOCK_TYPES.has(bt) && bt !== "tool_result") {
          // Unknown is fine for forward-compat, but a tool_result inside an
          // assistant message would be unambiguously wrong.
        }
        if (bt === "tool_result") {
          return { ok: false, error: `assistant block[${i}] cannot be tool_result` };
        }
      }
    }
    return { ok: true };
  }

  if (type === "user") {
    const message = obj["message"];
    if (!isObject(message)) {
      return { ok: false, error: "user line missing object `message`" };
    }
    if (message["role"] !== "user") {
      return { ok: false, error: "user line `message.role` must be \"user\"" };
    }
    const content = message["content"];
    if (isString(content)) {
      return { ok: true };
    }
    if (!Array.isArray(content)) {
      return { ok: false, error: "user line `message.content` must be string or array" };
    }
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      const r = validateContentBlock(block);
      if (!r.ok) return { ok: false, error: `user block[${i}]: ${r.error}` };
      if (isObject(block)) {
        const bt = block["type"];
        if (isString(bt) && !USER_BLOCK_TYPES.has(bt)) {
          // Unknown user block types pass for forward-compat (e.g. images).
        }
      }
    }
    return { ok: true };
  }

  if (PASSTHROUGH_TOP_LEVEL.has(type)) {
    // Already returned above, but kept for type-narrowing exhaustiveness.
    return { ok: true };
  }

  // Forward-compat: unknown top-level types are not an error.
  return { ok: true };
}
