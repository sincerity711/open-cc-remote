import { Check, Clock, ShieldCheck, X as XIcon } from "lucide-react";
import type {
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import { cn } from "../../lib/utils";
import { tokenizeCommand } from "../primitives/commandTokens";

export interface ResolvedPermissionCardProps {
  resolved: PwaPermissionResolved;
  /** Original request payload, recovered from `permissionRequestHistory`.
   *  Null on cross-device path / LRU eviction — the body falls back to a
   *  "(command not in history)" placeholder. */
  request: PwaPermissionRequest | null;
}

type Status = "allowed" | "denied" | "expired" | "terminal";

function statusFromDecision(d: PwaPermissionResolved["decision"]): Status {
  switch (d) {
    case "allow": return "allowed";
    case "deny":  return "denied";
    case "expired": return "expired";
    case "terminal": return "terminal";
  }
}

const PILL_LABEL: Record<Status, string> = {
  allowed: "Allowed",
  denied: "Denied",
  expired: "Expired",
  terminal: "Terminal",
};

/**
 * Settled receipt card for a permission decision. Renders at the resolution
 * point in the timeline so the user can scroll back and see *what they
 * decided* — distinct from the live `InlinePermissionCard` (warning tone)
 * by using the success/danger/muted "settled" register and ✓/✗/clock icons.
 *
 * Body: tokenized code block via `tokenizeCommand`, mirroring InlinePermissionCard
 * so the historical decision shows the same code rendering as the live prompt.
 * If `request` is null (cross-device PWA never saw the request, or LRU
 * evicted), the body falls back to a muted placeholder.
 */
export function ResolvedPermissionCard({
  resolved,
  request,
}: ResolvedPermissionCardProps) {
  const status = statusFromDecision(resolved.decision);
  const isAllow = status === "allowed";
  const isDeny = status === "denied";
  const reqIdShort = resolved.request_id.slice(0, 8);
  const tokens = request ? tokenizeCommand(request.args_summary) : null;

  return (
    <article
      className={cn(
        "rounded-card flex flex-col gap-2.5 border p-3 text-sm cc-enter",
        isAllow && "border-success/30 bg-success-subtle",
        isDeny && "border-danger/30 bg-danger-subtle",
        !isAllow && !isDeny && "border-border bg-surface",
      )}
      data-testid="resolved-permission-card"
      data-request-id={resolved.request_id}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex h-[20px] items-center rounded-[4px] border px-1.5 text-[10px] font-bold tracking-[0.12em] uppercase",
            isAllow && "border-success/35 bg-success-subtle text-success",
            isDeny && "border-danger/35 bg-danger-subtle text-danger",
            !isAllow && !isDeny && "border-border bg-muted text-muted-foreground",
          )}
        >
          {PILL_LABEL[status]}
        </span>
        {isAllow ? (
          <Check className="text-success size-4" />
        ) : isDeny ? (
          <XIcon className="text-danger size-4" />
        ) : status === "expired" ? (
          <Clock className="text-muted-foreground size-4" />
        ) : (
          <ShieldCheck className="text-muted-foreground size-4" />
        )}
        <span className="text-foreground text-[14px] font-semibold">
          {request?.tool ?? "Permission"}
        </span>
        <span className="flex-1" />
        <span className="text-tertiary-foreground inline-flex items-baseline gap-1 text-[11px]">
          <span className="uppercase tracking-[0.08em]">req</span>
          <span className="font-mono tracking-tight">{reqIdShort}</span>
        </span>
      </header>

      {tokens ? (
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
      ) : (
        <p
          className="text-muted-foreground italic text-xs"
          data-testid="resolved-permission-no-request"
        >
          (command not in history)
        </p>
      )}

      <footer className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]">
        <span>
          {isAllow
            ? "you allowed this"
            : isDeny
              ? "you denied this"
              : status === "expired"
                ? "expired without a decision"
                : "session ended"}
        </span>
        {resolved.decided_via && resolved.decided_via !== "pwa" && (
          <span className="text-muted-foreground">· decided via {resolved.decided_via}</span>
        )}
      </footer>
    </article>
  );
}
