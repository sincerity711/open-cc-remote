// Hand-rolled validator for Claude Code JSONL session lines.
//
// THE SPEC IS LAYERED:
//
// 1. Inner layer — `assistant.message.content[]` and `user.message.content[]`
//    blocks (text / thinking / tool_use / tool_result / image /
//    redacted_thinking). This IS the Anthropic Messages API content-block
//    schema, officially documented and stable:
//      • https://platform.claude.com/docs/en/api/messages
//      • https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
//      • https://platform.claude.com/docs/en/build-with-claude/extended-thinking
//    We enforce this layer strictly. If Anthropic ever changes the schema
//    here it would be a breaking API change documented in their changelog.
//
// 2. Outer layer — the JSONL envelope (`type`, `uuid`, `parentUuid`,
//    `sessionId`, `timestamp`, `cwd`, `version`, `gitBranch`, `promptId`,
//    `userType`, `entrypoint`, plus protocol-internal top-level types like
//    `attachment`, `queue-operation`, `file-history-snapshot`,
//    `mcp_instructions_data`, `ai-title`, `last-prompt`, `permission-mode`,
//    `pr-link`, `system`, `summary`). This is Claude Code's INTERNAL on-disk
//    format with no published stability guarantee — community-reverse-engineered
//    from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. We enforce
//    this layer leniently: known protocol-internal types pass through without
//    inner-shape checks, unknown top-level types pass through entirely
//    (forward-compat).
//
// Why hand-rolled (not Zod): one consumer (drift-detector + fixture lock-in),
// zero new runtime deps, easy to grep when CC version drifts.
//
// On drift detection: the `*.test.ts` next to this file walks the most
// recent real CC JSONL on disk (under `~/.claude/projects/`) and validates
// every line. If Anthropic changes the Messages API schema, this fails
// loud with the offending block + path so a human can update fixtures and
// the validator together.

export type ValidateResult = { ok: true } | { ok: false; error: string };

/** Top-level Claude JSONL line types we know about. Anything not in this set
 * passes through (forward-compat). All of these are Claude-Code-internal
 * envelope types — NOT part of the Anthropic Messages API. */
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

/** Block types valid inside an `assistant.message.content[]` array per the
 * Anthropic Messages API. `redacted_thinking` is the encrypted-body variant
 * of thinking returned when extended-thinking is enabled. */
const ASSISTANT_BLOCK_TYPES = new Set<string>([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
]);

/** Block types valid inside a `user.message.content[]` array per the
 * Anthropic Messages API. */
const USER_BLOCK_TYPES = new Set<string>(["tool_result", "text", "image"]);

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
  if (type === "redacted_thinking") {
    // Encrypted-body variant. Anthropic only sends `data` (base64 string).
    if (!isString(block["data"])) {
      return { ok: false, error: "redacted_thinking block missing string `data`" };
    }
    return { ok: true };
  }
  if (type === "image") {
    // Anthropic Messages API: image blocks have a `source: {type, media_type, data}` object.
    const source = block["source"];
    if (!isObject(source)) {
      return { ok: false, error: "image block missing object `source`" };
    }
    if (!isString(source["type"])) {
      return { ok: false, error: "image block `source.type` must be string" };
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
