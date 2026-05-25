import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssistantBubble,
  BashToolCard,
  BatchSummaryCard,
  FileEditCard,
  PermissionInlineCard,
  PermissionResolvedCard,
  RawJsonCard,
  ReadSearchCard,
  ReasoningCard,
  SubagentCard,
  SystemNoticeCard,
  ToolFailureCard,
  ToolResultLongCard,
  ToolResultShortCard,
  UserBubble,
} from "../src/screens/timeline/cards";

const cases: Array<[string, JSX.Element, string]> = [
  ["UserBubble", <UserBubble />, "Please add password reset flow"],
  ["AssistantBubble", <AssistantBubble />, "plan the implementation"],
  ["ReasoningCard", <ReasoningCard />, "Reasoning (5 steps)"],
  ["BashToolCard", <BashToolCard />, "pnpm test auth"],
  ["FileEditCard", <FileEditCard />, "src/routes/auth/reset.ts"],
  ["ReadSearchCard", <ReadSearchCard />, "src/lib/token.ts"],
  ["ToolResultShortCard", <ToolResultShortCard />, "All 42 tests passed"],
  ["ToolResultLongCard", <ToolResultLongCard />, "View output (24 lines)"],
  ["ToolFailureCard", <ToolFailureCard />, "Permission denied: node_modules"],
  ["PermissionInlineCard", <PermissionInlineCard />, "Permission required"],
  ["PermissionResolvedCard", <PermissionResolvedCard />, "Permission granted"],
  ["BatchSummaryCard", <BatchSummaryCard />, "Batch complete"],
  ["SubagentCard collapsed", <SubagentCard />, "Click to expand"],
  ["SubagentCard expanded", <SubagentCard expanded />, "Run integration tests"],
  ["SystemNoticeCard", <SystemNoticeCard />, "Claude Sonnet 3.5"],
  ["RawJsonCard", <RawJsonCard />, "event_unknown"],
];

for (const [name, element, signature] of cases) {
  test(`card renders: ${name}`, () => {
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain(signature);
  });
}
