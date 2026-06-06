import { Check, Clock, HelpCircle, X as XIcon } from "lucide-react";
import type {
  PwaAskUserQuestionRequest,
  PwaAskUserQuestionResolved,
} from "@cc-remote/proto";
import { cn } from "../../lib/utils";

export interface ResolvedAskQuestionCardProps {
  resolved: PwaAskUserQuestionResolved;
  /** Original ask request, recovered from `askQuestionRequestHistory`. Null
   *  on cross-device / LRU evicted. */
  request: PwaAskUserQuestionRequest | null;
  /** Local PWA's submitted answers, captured at `outbound_ask_answer`
   *  dispatch time. Null if the resolved frame arrived without a local
   *  submission (cross-device path) — the over-the-wire `*_resolved` frame
   *  does not echo answers, so this is the only way the answer survives
   *  on the device that didn't submit. */
  answers: (string | null)[] | null;
}

type Status = "answered" | "expired" | "no_pwa" | "session_unknown";

const PILL_LABEL: Record<Status, string> = {
  answered: "Answered",
  expired: "Expired",
  no_pwa: "No PWA",
  session_unknown: "Canceled",
};

/**
 * Settled receipt card for an Ask-User-Question. The live `AskQuestionSurface`
 * is modal-only (small-screen wins), so the timeline gets *no* persistent
 * record of what was asked or answered — this card is that record.
 *
 * Body: per-question option list with the chosen option highlighted, mirroring
 * AskQuestionSurface's idiom. Cross-device path shows
 * "(answered on another device)" as a placeholder for the answer.
 */
export function ResolvedAskQuestionCard({
  resolved,
  request,
  answers,
}: ResolvedAskQuestionCardProps) {
  const status: Status = resolved.resolution;
  const isAnswered = status === "answered";
  const isExpired = status === "expired";
  const reqIdShort = resolved.request_id.slice(0, 8);

  return (
    <article
      className={cn(
        "rounded-card flex flex-col gap-2.5 border p-3 text-sm cc-enter",
        isAnswered && "border-success/30 bg-success-subtle",
        !isAnswered && "border-border bg-surface",
      )}
      data-testid="resolved-ask-question-card"
      data-request-id={resolved.request_id}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex h-[20px] items-center rounded-[4px] border px-1.5 text-[10px] font-bold tracking-[0.12em] uppercase",
            isAnswered && "border-success/35 bg-success-subtle text-success",
            !isAnswered && "border-border bg-muted text-muted-foreground",
          )}
        >
          {PILL_LABEL[status]}
        </span>
        {isAnswered ? (
          <Check className="text-success size-4" />
        ) : isExpired ? (
          <Clock className="text-muted-foreground size-4" />
        ) : (
          <XIcon className="text-muted-foreground size-4" />
        )}
        <HelpCircle className="text-muted-foreground size-4" />
        <span className="text-foreground text-[14px] font-semibold">
          Question
        </span>
        <span className="flex-1" />
        <span className="text-tertiary-foreground inline-flex items-baseline gap-1 text-[11px]">
          <span className="uppercase tracking-[0.08em]">req</span>
          <span className="font-mono tracking-tight">{reqIdShort}</span>
        </span>
      </header>

      {request ? (
        <div className="flex flex-col gap-2.5">
          {request.questions.map((q, qIdx) => (
            <section key={qIdx} className="space-y-1.5">
              <p className="text-foreground text-[13px] font-medium">{q.question}</p>
              {q.header && (
                <p className="text-muted-foreground text-[11px]">{q.header}</p>
              )}
              {answers ? (
                <div className="grid gap-1">
                  {q.options.map((opt, oIdx) => {
                    const chosen = answers[qIdx] === opt.label;
                    return (
                      <div
                        key={oIdx}
                        className={cn(
                          "rounded-md border px-2.5 py-1.5 text-[12px]",
                          chosen
                            ? "border-success/40 bg-success-subtle text-foreground"
                            : "border-border bg-muted/30 text-muted-foreground",
                        )}
                      >
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="ml-2 text-[11px] opacity-70">{opt.description}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p
                  className="text-muted-foreground italic text-[11px]"
                  data-testid="resolved-ask-no-answer"
                >
                  (answered on another device)
                </p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <p
          className="text-muted-foreground italic text-xs"
          data-testid="resolved-ask-no-request"
        >
          (question not in history)
        </p>
      )}
    </article>
  );
}
