import { ShieldAlert, X } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import { Field } from "./primitives/Field";

export interface PermissionSurfaceProps {
  request: PwaPermissionRequest;
  /** Hostname of the daemon that issued the request (resolved by RealApp). */
  daemonHostname: string;
  /** 1-indexed position of the active request in the queue, e.g. 1 of 3. */
  queueIndex: number;
  queueSize: number;
  device: Device;
  onAllow: () => void;
  onDeny: () => void;
  onClose: () => void;
}

export function PermissionSurface(props: PermissionSurfaceProps) {
  const { device } = props;
  const card = <PermissionCard {...props} />;

  if (device === "desktop") {
    return (
      <aside
        className="border-border bg-surface shadow-sheet fixed top-14 right-0 bottom-0 z-50 w-[390px] border-l p-4"
        data-testid="permission-surface"
        data-form="aside"
      >
        {card}
      </aside>
    );
  }

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 flex items-end justify-center md:items-start md:pt-20"
      data-testid="permission-surface"
      data-form={device === "mobile" ? "sheet" : "modal"}
      onClick={props.onClose}
    >
      <div
        className={cn(
          "bg-surface shadow-sheet w-full max-w-[520px]",
          device === "mobile"
            ? "rounded-t-sheet h-[calc(100%-60px)] p-4"
            : "rounded-sheet mx-4 p-5",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {card}
      </div>
    </div>
  );
}

function PermissionCard({
  request,
  daemonHostname,
  queueIndex,
  queueSize,
  onAllow,
  onDeny,
  onClose,
}: PermissionSurfaceProps) {
  return (
    <article className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-warning flex items-center gap-2">
            <ShieldAlert className="size-5" />
            <h2 className="text-foreground text-lg font-semibold">
              Claude requests permission
            </h2>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {request.session_id} · {daemonHostname}
          </p>
        </div>
        <Button aria-label="Close" onClick={onClose} size="icon" variant="ghost">
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-5 grid gap-4">
        <Field label="Tool" value={request.tool} />
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
            Command
          </p>
          <code className="border-border bg-muted mt-2 block rounded-md border p-3 font-mono text-sm whitespace-pre-wrap break-all">
            {request.args_summary}
          </code>
        </div>
        {queueSize > 1 && (
          <p className="text-muted-foreground text-sm" data-testid="permission-queue">
            {queueIndex} of {queueSize} pending
          </p>
        )}
      </div>

      <div className="mt-auto pt-5">
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={onDeny} size="lg" variant="secondary">
            Deny
          </Button>
          <Button onClick={onAllow} size="lg">
            Allow once
          </Button>
        </div>
      </div>
    </article>
  );
}
