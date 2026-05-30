import { siClaude } from "simple-icons";
import { cn } from "../../lib/utils";

/**
 * Brand-mark avatar for AI assistants in the timeline / chat surfaces.
 *
 * Uses the official Claude brand SVG from simple-icons (which tracks
 * Anthropic's published mark + brand color #D97757) so the assistant is
 * unambiguously identified rather than approximated with a generic
 * sparkle. We deliberately don't conflate this with the cc-remote
 * product mark (`>_`) — that mark stays for the product itself.
 *
 * The component is structured to make it cheap to add other assistants
 * later (Codex / Gemini / GPT / generic). Add a new entry to `BRANDS`,
 * pass `brand="codex"` from the call site, and the chrome (wash + size +
 * positioning) stays consistent.
 *
 * Visual contract:
 *   - Glyph rides on a soft tinted wash so it reads on both light and dark
 *     surfaces without changing color.
 *   - Two sizes: `sm` (timeline rail glyph), `md` (inline avatar where the
 *     row gets a touch more weight, e.g. the "Claude is thinking" beat).
 */

export type AssistantBrand = "claude";

interface BrandSpec {
  title: string;
  hex: string;
  /** raw SVG path, no surrounding tag — pulled from simple-icons. */
  path: string;
}

const BRANDS: Record<AssistantBrand, BrandSpec> = {
  claude: { title: siClaude.title, hex: `#${siClaude.hex}`, path: siClaude.path },
};

export function ClaudeAvatar({
  brand = "claude",
  className,
  size = "sm",
}: {
  brand?: AssistantBrand;
  className?: string;
  size?: "sm" | "md";
}) {
  const spec = BRANDS[brand];
  const px = size === "sm" ? 11 : 14;

  return (
    <span
      aria-label={spec.title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full cc-transition-state",
        // Soft warm wash so the brand mark reads on both light & dark
        // surfaces. The mark itself carries identity; the wash is a
        // unobtrusive container.
        "bg-[color-mix(in_oklab,var(--cc-brand)_14%,transparent)]",
        size === "sm" && "size-5",
        size === "md" && "size-7",
        className,
      )}
      style={{ ["--cc-brand" as string]: spec.hex }}
    >
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        fill={spec.hex}
        aria-hidden
      >
        <path d={spec.path} />
      </svg>
    </span>
  );
}
