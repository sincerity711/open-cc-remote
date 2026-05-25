import type { AGUIEvent } from "@cc-remote/proto";
import { fromClaudeCode } from "@cc-remote/proto";
import type { AgentAdapter, ConvertContext } from "./index";

export class ClaudeCodeAdapter implements AgentAdapter {
  convertRow(row: unknown, ctx: ConvertContext): AGUIEvent[] {
    if (row === null || row === undefined) return [];
    return fromClaudeCode(row, {
      threadId: ctx.sessionId,
      runId: `${ctx.sessionId}:${ctx.jsonlOffset}`,
      offset: ctx.jsonlOffset,
    });
  }
}
