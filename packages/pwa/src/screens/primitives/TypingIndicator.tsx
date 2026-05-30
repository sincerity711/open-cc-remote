import { cn } from "../../lib/utils";

/**
 * Three-dot typing indicator. Used wherever the UI is waiting on a
 * streamed response and we want to convey "alive, generating" without
 * a spinner shouting for attention.
 *
 * The dots stagger via animation-delay on each child. Bob is 4px so
 * the row height is stable regardless of where this is mounted.
 */
export function TypingIndicator({
  label,
  className,
}: {
  /** Optional sr-only label. Defaults to "Generating response". */
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-1", className)}
    >
      <span className="sr-only">{label ?? "Generating response"}</span>
      <span
        aria-hidden
        className="cc-typing-dot bg-current size-1.5 rounded-full"
        style={{ animationDelay: "0ms" }}
      />
      <span
        aria-hidden
        className="cc-typing-dot bg-current size-1.5 rounded-full"
        style={{ animationDelay: "180ms" }}
      />
      <span
        aria-hidden
        className="cc-typing-dot bg-current size-1.5 rounded-full"
        style={{ animationDelay: "360ms" }}
      />
    </span>
  );
}

/**
 * Compact circular spinner. Sized via parent font/sizing so it sits
 * inline with text or icon buttons. The border-t-transparent trick
 * gives the rotating gap.
 */
export function Spinner({
  className,
  size = "sm",
}: {
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "cc-spin inline-block rounded-full border-2 border-current border-t-transparent",
        size === "sm" && "size-3",
        size === "md" && "size-4",
        className,
      )}
    />
  );
}
