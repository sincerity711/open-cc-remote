import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { fromClaudeCode } from "../../src/agui/from-claude-code";

const TAPES_DIR = join(import.meta.dir, "../../../../e2e-real/fixtures/jsonl-tapes");
const TAPES = [
  "bash-failure.jsonl",
  "bash-success.jsonl",
  "channel-injection.jsonl",
  "long-output.jsonl",
  "read-then-edit.jsonl",
  "thinking-then-tool.jsonl",
];

function parseTape(name: string): unknown[] {
  const text = readFileSync(join(TAPES_DIR, name), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ctx = { threadId: "t1", runId: "r1" };

describe("fromClaudeCode contract", () => {
  test("never emits CUSTOM events (decision #10)", () => {
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(ev.type).not.toBe(EventType.CUSTOM);
        }
      }
    }
  });

  test("never emits THINKING_* events (decision #8)", () => {
    const banned = new Set([
      EventType.THINKING_START,
      EventType.THINKING_END,
      EventType.THINKING_TEXT_MESSAGE_START,
      EventType.THINKING_TEXT_MESSAGE_CONTENT,
      EventType.THINKING_TEXT_MESSAGE_END,
    ]);
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(banned.has(ev.type)).toBe(false);
        }
      }
    }
  });

  test("never emits RUN_STARTED/FINISHED/ERROR (decision #5 — daemon FSM does that)", () => {
    const banned = new Set([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR]);
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(banned.has(ev.type)).toBe(false);
        }
      }
    }
  });

  test("TOOL_CALL_RESULT carries rawEvent.is_error (decision #7)", () => {
    // bash-failure.jsonl includes a tool_result with is_error=true.
    const events = parseTape("bash-failure.jsonl").flatMap((row) => fromClaudeCode(row, ctx));
    const results = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results.length).toBeGreaterThan(0);
    for (const ev of results) {
      const raw = (ev as { rawEvent?: { is_error?: unknown } }).rawEvent;
      expect(raw).toBeDefined();
      expect(typeof raw?.is_error).toBe("boolean");
    }
    expect(results.some((e) => (e as { rawEvent: { is_error: boolean } }).rawEvent.is_error === true)).toBe(true);
  });

  test("multi-block rows produce N events sharing the row's logical offset", () => {
    // thinking-then-tool.jsonl has rows with reasoning + tool_use in a single line.
    const rows = parseTape("thinking-then-tool.jsonl");
    const multiBlockRow = rows.find((row) => {
      const blocks = (row as { message?: { content?: unknown[] } }).message?.content;
      return Array.isArray(blocks) && blocks.length >= 2;
    });
    expect(multiBlockRow).toBeDefined();
    const events = fromClaudeCode(multiBlockRow, ctx);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test("bash-success tape emits TOOL_CALL_CHUNK then TOOL_CALL_RESULT", () => {
    const events = parseTape("bash-success.jsonl").flatMap((row) => fromClaudeCode(row, ctx));
    const types = events.map((e) => e.type);
    // Must contain at least one chunk and one result, in chunk-before-result order.
    const chunkIdx = types.indexOf(EventType.TOOL_CALL_CHUNK);
    const resultIdx = types.indexOf(EventType.TOOL_CALL_RESULT);
    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(chunkIdx);
  });

  test("channel-injection tape produces TEXT_MESSAGE_CHUNK with envelope stripped", () => {
    const events = parseTape("channel-injection.jsonl").flatMap((row) => fromClaudeCode(row, ctx));
    const userText = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK && (e as { role?: string }).role === "user",
    ) as { delta?: string } | undefined;
    expect(userText).toBeDefined();
    // Delta should be human prose, NOT contain the channel envelope tags.
    expect(userText?.delta).toBeDefined();
    expect(userText?.delta).not.toMatch(/<channel|origin\b|kind\s*:/);
  });

  test("mcp__cc-remote__reply tool_use is promoted to TEXT_MESSAGE_CHUNK", () => {
    // Inline fixture — none of the tapes contain this path.
    const row = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_reply_1",
            name: "mcp__cc-remote__reply",
            input: { text: "Done — see you tomorrow." },
          },
        ],
      },
    };
    const events = fromClaudeCode(row, ctx);
    const text = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK && (e as { role?: string }).role === "assistant",
    ) as { delta?: string } | undefined;
    expect(text).toBeDefined();
    expect(text?.delta).toBe("Done — see you tomorrow.");
  });

  test("AskUserQuestion tool_use is hidden (relayed via channel, not the timeline)", () => {
    // The hook intercepts AskUserQuestion and renders the picker via the
    // ask_user_question_request frame. The model's tool_use call is denied
    // and never executes, so emitting a tool-call card in the timeline is
    // misleading — hide it. The deny reason still surfaces as a tool_result.
    const row = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_auq_1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Pick one", options: [] }] },
          },
        ],
      },
    };
    const events = fromClaudeCode(row, ctx);
    const toolCall = events.find((e) => e.type === EventType.TOOL_CALL_CHUNK);
    expect(toolCall).toBeUndefined();
  });

  test("attachment.queued_command emits a user TEXT_MESSAGE_CHUNK with envelope stripped", () => {
    // Claude Code spools mid-tool-call channel injections into JSONL as
    // `attachment` rows with subtype `queued_command`. The prompt body is
    // wrapped in our <channel> envelope and the row also carries isMeta:true,
    // which we deliberately ignore for this subtype.
    const row = {
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt:
          '<channel source="cc-remote" chat_id="pwa" message_id="01KSE" user="alice" ts="2026-05-25T07:09:42.531Z">\n这三篇 doc 是关于sap ai metering的帮我入库\n</channel>',
        commandMode: "prompt",
        origin: { kind: "channel", server: "cc-remote" },
        isMeta: true,
      },
      timestamp: "2026-05-25T07:09:42.531Z",
    };
    const events = fromClaudeCode(row, { ...ctx, offset: 42 });
    expect(events).toHaveLength(1);
    const ev = events[0] as {
      type: EventType;
      role?: string;
      delta?: string;
      messageId?: string;
    };
    expect(ev.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(ev.role).toBe("user");
    expect(ev.delta).toBe("这三篇 doc 是关于sap ai metering的帮我入库");
    expect(ev.delta).not.toMatch(/<channel|<\/channel>/);
    expect(ev.messageId).toBe("event:42:queued_user");
  });

  test("attachment with non-queued_command subtype emits zero events", () => {
    for (const subtype of ["image", "file", "something_else"]) {
      const row = {
        type: "attachment",
        attachment: {
          type: subtype,
          path: "/tmp/foo.png",
        },
        timestamp: "2026-05-25T07:09:42.531Z",
      };
      const events = fromClaudeCode(row, ctx);
      expect(events).toHaveLength(0);
    }
  });
});
