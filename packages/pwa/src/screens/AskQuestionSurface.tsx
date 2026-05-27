import { useState } from "react";
import { HelpCircle, X } from "lucide-react";
import type { PwaAskUserQuestionRequest } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import type { PendingCommand } from "../hooks/pendingCommands";

export interface AskQuestionSurfaceProps {
  request: PwaAskUserQuestionRequest;
  daemonHostname: string;
  device: Device;
  onAnswer: (answers: (string | null)[]) => void;
  onClose: () => void;
  pendingReply?: PendingCommand;
}

/**
 * Renders the AskUserQuestion relay surface. Input shape matches the local
 * Claude Code TUI prompt — one or more questions, each with N options. Users
 * pick one (or multiple if `multiSelect`) per question; on submit the answers
 * are sent over the websocket as `ask_user_question_answer`. The hook on the
 * daemon side translates that back into a synthesized PreToolUse stdout.
 */
export function AskQuestionSurface(props: AskQuestionSurfaceProps) {
  const { device, request } = props;
  const card = <AskCard {...props} />;

  if (device === "desktop") {
    return (
      <aside
        className="border-border bg-surface shadow-sheet fixed top-14 right-0 bottom-0 z-50 w-[420px] border-l p-4 overflow-y-auto"
        data-testid="ask-question-surface"
        data-form="aside"
        data-request-id={request.request_id}
      >
        {card}
      </aside>
    );
  }

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 flex items-end justify-center md:items-start md:pt-20"
      data-testid="ask-question-surface"
      data-form={device === "mobile" ? "sheet" : "modal"}
      data-request-id={request.request_id}
      onClick={props.onClose}
    >
      <div
        className="bg-surface w-full max-w-lg rounded-t-lg p-4 md:rounded-lg max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {card}
      </div>
    </div>
  );
}

function AskCard({ request, daemonHostname, onAnswer, onClose, pendingReply }: AskQuestionSurfaceProps) {
  const [answers, setAnswers] = useState<(string | null)[]>(() =>
    request.questions.map(() => null),
  );
  const submitting = pendingReply?.status === "pending";
  const replyTimedOut = pendingReply?.status === "timed_out";

  const allAnswered = answers.every((a) => a !== null);

  function setAnswer(qIdx: number, label: string) {
    setAnswers((prev) => {
      const next = [...prev];
      next[qIdx] = label;
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <HelpCircle className="text-primary mt-0.5 size-5 shrink-0" />
          <div>
            <h2 className="text-base font-semibold">Question from Claude</h2>
            <p className="text-muted-foreground text-xs">via {daemonHostname}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {request.questions.map((q, qIdx) => (
        <section key={qIdx} className="space-y-2" data-testid={`ask-question-${qIdx}`}>
          <div>
            <p className="text-foreground text-sm font-medium">{q.question}</p>
            {q.header && (
              <p className="text-muted-foreground mt-0.5 text-xs">{q.header}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            {q.options.map((opt, oIdx) => {
              const selected = answers[qIdx] === opt.label;
              return (
                <button
                  key={oIdx}
                  type="button"
                  data-testid={`ask-option-${qIdx}-${oIdx}`}
                  onClick={() => setAnswer(qIdx, opt.label)}
                  className={cn(
                    "border-border rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "hover:bg-muted/50",
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.description && (
                    <div className="text-muted-foreground text-xs">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {replyTimedOut && (
        <p
          className="text-destructive text-xs"
          data-testid="ask-question-timeout"
        >
          Submit timed out. Try again or close.
        </p>
      )}

      <footer className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="ghost"
          onClick={onClose}
          disabled={submitting}
          data-testid="ask-question-cancel"
        >
          Cancel
        </Button>
        <Button
          onClick={() => onAnswer(answers)}
          disabled={!allAnswered || submitting}
          data-testid="ask-question-submit"
        >
          {submitting ? "Sending…" : "Submit"}
        </Button>
      </footer>
    </div>
  );
}
