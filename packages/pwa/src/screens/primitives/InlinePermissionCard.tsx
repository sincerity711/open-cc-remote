import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { PendingCommand } from "../../hooks/pendingCommands";
import { detectRisks, tokenizeCommand } from "./commandTokens";

export interface InlinePermissionCardProps {
  request: PwaPermissionRequest;
  /** When set, the card is in an "awaiting daemon ack" state — buttons disabled, status text shown. */
  pendingReply?: PendingCommand;
  onDecide(decision: "allow" | "deny"): void;
  /** Optional queue context: position (1-indexed) of `request` in the pending queue and total count. */
  queue?: { position: number; total: number };
}

/**
 * Inline session-bound permission prompt. Replaces the deleted full-screen
 * `<PermissionSurface>` modal. Mounted by `SessionView` at the top of the
 * chat-log region (sibling to the timeline scroller, NOT inside it) so it
 * stays pinned and always visible until the user decides — only renders
 * when the SELECTED session has a pending permission request.
 *
 * Visual contract (variant B per the design spec):
 *   - Container with warning-tinted border + soft warning-subtle backdrop
 *     so the card reads "decision required", distinct from neutral cards.
 *   - Header: small uppercase pill + tool name + queue chip ("1 of 3")
 *     when more requests are pending. Truncated request id on the right.
 *   - Tokenized code block — destructive verbs (rm/sudo/…) rendered red,
 *     flags muted, paths default. Risk labels surfaced below if any match.
 *   - Right-aligned action row: Deny (secondary) + Allow once (default).
 *     While submitting, the clicked button shows a spinner in place rather
 *     than swapping to a separate status row, so the click feedback lives
 *     where the click landed.
 *
 * The component is purely presentational: hub access, sendPermissionReply,
 * and pendingPermissions reducer state all live above. When the request is
 * resolved (locally or cross-device), `pendingPermissions[request_id]`
 * disappears from the reducer and the parent unmounts this card naturally —
 * no internal "handled by another device" logic.
 */
export function InlinePermissionCard({
  request,
  pendingReply,
  onDecide,
  queue,
}: InlinePermissionCardProps) {
  // Track which button the user pressed locally so the spinner can render
  // in the correct slot. The reducer state above doesn't know which
  // decision is in flight — only that *some* permission_reply is pending.
  const [lastDecision, setLastDecision] = useState<"allow" | "deny" | null>(
    null,
  );
  const submitting = pendingReply?.status === "pending";
  const replyTimedOut = pendingReply?.status === "timed_out";
  const reqIdShort = request.request_id.slice(0, 8);

  const tokens = tokenizeCommand(request.args_summary);
  const risks = detectRisks(request.args_summary);
  const hasRisk = risks.length > 0;

  const handleDecide = (decision: "allow" | "deny") => {
    setLastDecision(decision);
    onDecide(decision);
  };

  return (
    <article
      className={cn(
        "rounded-card flex flex-col gap-3 border p-4 cc-permission-enter",
        "bg-warning-subtle/50 border-warning/45",
        // Slightly stronger elevation than a regular card so the eye lands
        // on it before the surrounding chat surfaces.
        "shadow-[0_2px_8px_rgba(217,119,6,0.08)]",
      )}
      data-testid="inline-permission-card"
      data-request-id={request.request_id}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* PERMISSION pill — softened from solid amber fill to a subtle
            outline form. The tool name should lead the eye; the pill is
            a secondary semantic label, not a banner. */}
        <span className="border-warning/45 bg-warning-subtle text-warning inline-flex h-[20px] items-center rounded-[4px] border px-1.5 text-[10px] font-bold tracking-[0.12em] uppercase">
          Permission
        </span>
        <ShieldAlert className="text-warning size-4" />
        <span className="text-foreground text-[15px] font-semibold">
          {request.tool}
        </span>
        {queue && queue.total > 1 && (
          <span
            className="border-warning/45 bg-surface text-warning inline-flex h-[22px] items-center rounded-full border px-2 text-[11px] font-semibold"
            data-testid="inline-permission-queue"
          >
            {queue.position} of {queue.total}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-tertiary-foreground inline-flex items-baseline gap-1 text-[11px]">
          <span className="uppercase tracking-[0.08em]">req</span>
          <span className="font-mono tracking-tight">{reqIdShort}</span>
        </span>
      </div>

      <code className="bg-code text-code-foreground block rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        <span className="text-muted-foreground select-none">$ </span>
        {tokens.map((tok, i) => (
          <span
            key={i}
            className={cn(
              tok.kind === "danger" && "text-danger font-semibold",
              tok.kind === "flag" && "text-muted-foreground",
              tok.kind === "path" && "text-code-foreground",
            )}
          >
            {tok.text}
          </span>
        ))}
      </code>

      {hasRisk && (
        <div
          className="text-warning flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
          data-testid="inline-permission-risk"
        >
          <span className="font-semibold uppercase tracking-wide">Risk</span>
          {risks.map((r) => (
            <span key={r} className="text-foreground/80">
              · {r}
            </span>
          ))}
        </div>
      )}

      {replyTimedOut && (
        <p
          className="text-danger text-sm"
          role="alert"
          data-testid="inline-permission-timeout"
        >
          Decision not confirmed. Try again.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => handleDecide("deny")}
          size="md"
          variant="secondary"
          disabled={submitting}
          data-testid="inline-permission-deny"
        >
          {submitting && lastDecision === "deny" ? (
            <SpinnerWithLabel label="Denying…" />
          ) : (
            "Deny"
          )}
        </Button>
        <Button
          onClick={() => handleDecide("allow")}
          size="md"
          disabled={submitting}
          data-testid="inline-permission-allow"
        >
          {submitting && lastDecision === "allow" ? (
            <SpinnerWithLabel label="Allowing…" />
          ) : (
            "Allow once"
          )}
        </Button>
      </div>
    </article>
  );
}

/**
 * Compact spinner + label used inside Allow / Deny buttons while the
 * decision is in flight. Renders inside the existing button so the click
 * target does not collapse — feedback overlays the original action.
 */
function SpinnerWithLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="cc-spin inline-block size-3 rounded-full border-2 border-current border-t-transparent"
      />
      <span>{label}</span>
    </span>
  );
}
