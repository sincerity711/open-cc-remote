import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaAskUserQuestionRequest } from "@cc-remote/proto";
import { AskQuestionSurface } from "../src/screens/AskQuestionSurface";

const request: PwaAskUserQuestionRequest = {
  type: "ask_user_question_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "ask-1",
  questions: [
    {
      question: "Where should the file go?",
      header: "Location",
      multiSelect: false,
      options: [
        { label: "docs/", description: "next to other docs" },
        { label: "src/", description: "alongside source" },
      ],
    },
    {
      question: "What format?",
      header: "Format",
      multiSelect: false,
      options: [{ label: "markdown" }, { label: "plain text" }],
    },
  ],
  expires_at: 0,
};

test.each(["mobile", "tablet", "desktop"] as const)(
  "AskQuestionSurface renders on %s with all questions and options",
  (device) => {
    const markup = renderToStaticMarkup(
      <AskQuestionSurface
        request={request}
        daemonHostname="mbp.local"
        device={device}
        onAnswer={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain("Question from Claude");
    expect(markup).toContain("via mbp.local");
    expect(markup).toContain("Where should the file go?");
    expect(markup).toContain("docs/");
    expect(markup).toContain("next to other docs");
    expect(markup).toContain("What format?");
    expect(markup).toContain("markdown");
    expect(markup).toContain('data-testid="ask-question-surface"');
    expect(markup).toContain('data-request-id="ask-1"');
    expect(markup).toContain('data-testid="ask-question-submit"');
  },
);

test("AskQuestionSurface submit is disabled until all answered", () => {
  const markup = renderToStaticMarkup(
    <AskQuestionSurface
      request={request}
      daemonHostname="mbp.local"
      device="desktop"
      onAnswer={() => {}}
      onClose={() => {}}
    />,
  );
  // Submit button rendered with disabled attribute when no answers picked.
  // SSR can't drive useState so initial state is "no answers" → disabled.
  expect(markup).toMatch(/<button[^>]*disabled[^>]*data-testid="ask-question-submit"/);
});

test("AskQuestionSurface shows timeout message when reply timed_out", () => {
  const markup = renderToStaticMarkup(
    <AskQuestionSurface
      request={request}
      daemonHostname="mbp.local"
      device="desktop"
      onAnswer={() => {}}
      onClose={() => {}}
      pendingReply={{
        id: "ask-1",
        kind: "ask_answer",
        daemon_id: "d1",
        session_id: "s1",
        started_at: 0,
        status: "timed_out",
      }}
    />,
  );
  expect(markup).toContain('data-testid="ask-question-timeout"');
  expect(markup).toContain("Submit timed out");
});
