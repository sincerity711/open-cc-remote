import { CheckCircle2, Circle, Radio, ShieldAlert } from "lucide-react";
import type { SessionState } from "./StatusChip";

export function StatusIcon({ state }: { state: SessionState }) {
  if (state === "waiting") {
    return <ShieldAlert className="text-warning mt-1 size-5 shrink-0" />;
  }
  if (state === "working") {
    return <Radio className="text-primary mt-1 size-5 shrink-0" />;
  }
  if (state === "offline") {
    return <Circle className="text-offline mt-1 size-5 shrink-0" />;
  }
  return <CheckCircle2 className="text-success mt-1 size-5 shrink-0" />;
}
