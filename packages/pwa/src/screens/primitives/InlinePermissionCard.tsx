import { ShieldAlert } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../../components/ui/button";
import type { PendingCommand } from "../../hooks/pendingCommands";

export interface InlinePermissionCardProps {
  request: PwaPermissionRequest;
  /** When set, the card is in an "awaiting daemon ack" state — buttons disabled, status text shown. */
  pendingReply?: PendingCommand;
  onDecide(decision: "allow" | "deny"): void;
}

/**
 * Inline session-bound permission prompt. Replaces the deleted full-screen
 * `<PermissionSurface>` modal. Mounted by `SessionView` at the top of the
 * chat-log region (sibling to the timeline scroller, NOT inside it) so it
 * stays pinned and always visible until the user decides — only renders
 * when the SELECTED session has a pending permission request.
 *
 * Visual contract (variant B per the design spec):
 *   - Container with warning-tinted border + subtle shadow
 *   - Header: small uppercase pill + tool name + truncated request_id
 *   - Black-on-light code block with the verbatim args_summary
 *   - Right-aligned action row: Deny (secondary) + Allow once (default)
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
}: InlinePermissionCardProps) {
  const submitting = pendingReply?.status === "pending";
  const replyTimedOut = pendingReply?.status === "timed_out";
  const reqIdShort = request.request_id.slice(0, 8);

  return (
    <article
      className="rounded-card border-warning/35 bg-surface flex flex-col gap-3 border p-4 shadow-card"
      data-testid="inline-permission-card"
      data-request-id={request.request_id}
    >
      <div className="flex items-center gap-2">
        <span className="bg-warning-subtle text-warning inline-flex h-[22px] items-center rounded-full px-2 text-[11px] font-bold tracking-wider uppercase">
          Permission
        </span>
        <ShieldAlert className="text-warning size-4" />
        <span className="text-foreground font-semibold">{request.tool}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground font-mono text-xs">
          request {reqIdShort}
        </span>
      </div>

      <code className="bg-code text-code-foreground block rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        $ {request.args_summary}
      </code>

      {submitting && (
        <p
          className="text-muted-foreground text-sm"
          data-testid="inline-permission-submitting"
        >
          Sending decision…
        </p>
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
          onClick={() => onDecide("deny")}
          size="md"
          variant="secondary"
          disabled={submitting}
        >
          Deny
        </Button>
        <Button
          onClick={() => onDecide("allow")}
          size="md"
          disabled={submitting}
        >
          Allow once
        </Button>
      </div>
    </article>
  );
}
