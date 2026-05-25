/**
 * AG-UI event types — re-exports from @ag-ui/core@0.0.53.
 *
 * v1 of the cc-remote protocol uses NO CUSTOM events (decision #10 of
 * docs/superpowers/specs/2026-05-25-ag-ui-design.md). Anything not
 * expressible as a standard AG-UI event falls through to RAW.
 *
 * NOTE: `EventType` is a value (TS enum) that the adapter uses at
 * runtime when constructing events. Importing this module pulls
 * @ag-ui/core's runtime, including its zod peer. The PWA budget
 * controls this via tree-shaking — confirm at bundle time, do not
 * assume "type-only" by reading this file.
 */

export {
  EventType,
  type AGUIEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageChunkEvent,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
  type ReasoningMessageChunkEvent,
  type ActivitySnapshotEvent,
  type ActivityDeltaEvent,
  type StateDeltaEvent,
  type RawEvent,
} from "@ag-ui/core";

import type { AGUIEvent } from "@ag-ui/core";

/** Alias for our internal use — the discriminated union of every AG-UI event. */
export type AgUiEvent = AGUIEvent;
