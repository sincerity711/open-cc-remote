import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PwaAskUserQuestionRequest,
  PwaAskUserQuestionResolved,
} from "@cc-remote/proto";
import { ResolvedAskQuestionCard } from "../src/screens/timeline/ResolvedAskQuestionCard";

const baseRequest: PwaAskUserQuestionRequest = {
  type: "ask_user_question_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "ask-abcd1234",
  questions: [
    {
      question: "Where should I put the new file?",
      header: "Location",
      multiSelect: false,
      options: [
        { label: "docs/" },
        { label: "src/" },
        { label: "tests/", description: "test fixtures" },
      ],
    },
  ],
  expires_at: 0,
};

const baseResolved = (
  resolution: PwaAskUserQuestionResolved["resolution"],
): PwaAskUserQuestionResolved => ({
  type: "ask_user_question_resolved",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "ask-abcd1234",
  resolution,
});

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("with request + answers → question visible, chosen option highlighted", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("answered")}
      request={baseRequest}
      answers={["docs/"]}
    />,
  );
  expect(markup).toContain('data-testid="resolved-ask-question-card"');
  const text = visibleText(markup);
  expect(text).toContain("Answered");
  expect(text).toContain("Where should I put the new file?");
  expect(text).toContain("docs/");
  expect(text).toContain("src/");
  // Tone: success-subtle on the article AND on the chosen option.
  expect(markup).toContain("bg-success-subtle");
});

test("with request + null answers → '(answered on another device)' placeholder", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("answered")}
      request={baseRequest}
      answers={null}
    />,
  );
  expect(markup).toContain('data-testid="resolved-ask-no-answer"');
  expect(visibleText(markup)).toContain("(answered on another device)");
});

test("without request → '(question not in history)' placeholder", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("answered")}
      request={null}
      answers={null}
    />,
  );
  expect(markup).toContain('data-testid="resolved-ask-no-request"');
  expect(visibleText(markup)).toContain("(question not in history)");
});

test("expired resolution → EXPIRED pill, muted tone", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("expired")}
      request={baseRequest}
      answers={null}
    />,
  );
  const text = visibleText(markup);
  expect(text).toContain("Expired");
  // No success tone for non-answered.
  expect(markup).not.toContain("bg-success-subtle");
});

test("session_unknown resolution → CANCELED pill", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("session_unknown")}
      request={baseRequest}
      answers={null}
    />,
  );
  expect(visibleText(markup)).toContain("Canceled");
});

test("no_pwa resolution → 'No PWA' pill", () => {
  const markup = renderToStaticMarkup(
    <ResolvedAskQuestionCard
      resolved={baseResolved("no_pwa")}
      request={baseRequest}
      answers={null}
    />,
  );
  expect(visibleText(markup)).toContain("No PWA");
});
