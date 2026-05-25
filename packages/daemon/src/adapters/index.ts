import type { AGUIEvent } from "@cc-remote/proto";

export interface ConvertContext {
  /** Internal session id (daemon's, not Claude's). */
  sessionId: string;
  /** Byte offset *after* the source row, used for AG-UI event ids. */
  jsonlOffset: number;
}

export interface AgentAdapter {
  /** Map one parsed source-format row to zero or more AG-UI events.
   *  Must NOT emit RUN_STARTED/FINISHED/ERROR — those are FSM-driven. */
  convertRow(row: unknown, ctx: ConvertContext): AGUIEvent[];
}
