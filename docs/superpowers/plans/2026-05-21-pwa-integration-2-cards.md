# PWA Integration P2 — Card Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the prototype's 18 catalog card components and the `SessionTimelineItem` rail shell out of `src/demo/DemoApp.tsx` into `src/screens/timeline/`, so subsequent plans (P3+) can compose them into the live `SessionView`. Cards stay as **static, no-prop** components in P2 — the prototype's catalog uses them verbatim. The data-driven dispatcher (`renderTimelineItem`) is built in P3 against the live `TimelineEvent` type, using the same `CatalogCard` + `CatalogHeader` primitives but with fresh per-event JSX. P2 is a pure file move + visual-regression baseline; the prototype's `/demo` route must look pixel-identical at every step.

**Architecture:** All 18 cards live under `screens/timeline/cards/` as one file each, exporting a no-prop function. Two helper subcomponents (`UserBubbleSurface` and the chat `Reasoning` row) move with their parent. Subagent collapsed + expanded are merged into one `SubagentCard` with an `expanded?: boolean` prop (per spec §1). The live `TimelineEvent` discriminated union moves to `screens/timeline/types.ts` so future plans can dispatch on `kind`. `SessionTimelineItem` (the marker + left rail container) moves to its own file. `PermissionReviewCard` is **not** extracted — it migrates to `screens/PermissionSurface.tsx` in P4 and stays inline in DemoApp until then.

**Tech Stack:** React 18, TypeScript strict, Tailwind 4, lucide-react, shadcn `Button`. No new dependencies.

**Reference:** Source spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §1 (file layout under `screens/timeline/cards/`), §2.2 (kind → marker mapping is built later in P3).

**Prerequisite:** P1 complete (`screens/primitives/`, `screens/timeline/cards/CatalogCard.tsx`, `screens/timeline/cards/CatalogHeader.tsx` all exist and DemoApp uses them).

---

## File structure after P2

```
packages/pwa/src/
└── screens/
    └── timeline/
        ├── SessionTimelineItem.tsx     # NEW
        ├── types.ts                    # NEW (TimelineEvent union)
        └── cards/
            ├── CatalogCard.tsx           # exists (P1)
            ├── CatalogHeader.tsx         # exists (P1)
            ├── UserBubble.tsx            # NEW
            ├── AssistantBubble.tsx       # NEW
            ├── ReasoningCard.tsx         # NEW
            ├── BashToolCard.tsx          # NEW
            ├── FileEditCard.tsx          # NEW
            ├── ReadSearchCard.tsx        # NEW
            ├── ToolResultShortCard.tsx   # NEW
            ├── ToolResultLongCard.tsx    # NEW
            ├── ToolFailureCard.tsx       # NEW
            ├── PermissionInlineCard.tsx  # NEW
            ├── PermissionResolvedCard.tsx # NEW
            ├── BatchSummaryCard.tsx      # NEW
            ├── SubagentCard.tsx          # NEW (collapsed + expanded merged)
            ├── TaskCreatedCard.tsx       # NEW
            ├── TaskCompletedCard.tsx     # NEW
            ├── SystemNoticeCard.tsx      # NEW
            ├── RawJsonCard.tsx           # NEW
            ├── IdleWaitingCard.tsx       # NEW
            └── index.ts                  # MODIFIED — add 18 new exports
```

DemoApp's catalog references update from `<CatalogUserBubble />` → `<UserBubble />` (one-to-one rename). `CatalogPermissionReview` stays inline in DemoApp.

---

## Task 1: Move `TimelineEvent` union to `screens/timeline/types.ts`

**Why:** The discriminated union currently lives at the top of `src/demo/DemoApp.tsx` (lines 60–141). P3 needs to import it for `renderTimelineItem`. Move it to a shared module before any cards are extracted.

**Files:**
- Create: `packages/pwa/src/screens/timeline/types.ts`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Create the shared types file**

Create `packages/pwa/src/screens/timeline/types.ts`:

```ts
export type TimelineEvent =
  | {
      id: string;
      kind: "user" | "assistant";
      title: string;
      body: string;
      time: string;
    }
  | {
      id: string;
      kind: "thinking";
      title: string;
      body: string;
      tokens: string;
      time: string;
    }
  | {
      id: string;
      kind: "tool";
      tool: string;
      command: string;
      cwd: string;
      duration: string;
      result: "success" | "failure" | "running";
      summary: string;
      output: string;
      risk?: "warning" | "danger";
    }
  | {
      id: string;
      kind: "permission-inline";
      tool: string;
      command: string;
      risk: string;
    }
  | {
      id: string;
      kind: "permission-resolved";
      decision: "allowed" | "denied" | "expired";
      via: string;
      time: string;
    }
  | {
      id: string;
      kind: "subagent";
      name: string;
      status: "running" | "completed";
      summary: string;
      children: string[];
    }
  | {
      id: string;
      kind: "batch";
      summary: string;
      tools: string[];
      duration: string;
    }
  | {
      id: string;
      kind: "task";
      title: string;
      status: "created" | "completed";
      detail: string;
    }
  | {
      id: string;
      kind: "system" | "compact" | "session-boundary" | "metadata";
      title: string;
      detail: string;
    }
  | {
      id: string;
      kind: "error";
      title: string;
      detail: string;
    }
  | {
      id: string;
      kind: "raw";
      title: string;
      json: string;
    };

export type TimelineEventKind = TimelineEvent["kind"];
```

(Body copied verbatim from `src/demo/DemoApp.tsx` lines 60–141. Added an explicit `TimelineEventKind` alias for downstream dispatch code.)

- [ ] **Step 2: Replace the inline definition in DemoApp**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete the local `type TimelineEvent = | { ... };` block (lines 60–141).
2. Add an import near the other top-of-file imports:

```ts
import type { TimelineEvent } from "../screens/timeline/types";
```

- [ ] **Step 3: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```
Expected: typecheck clean; 1 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/timeline/types.ts packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): hoist TimelineEvent union to screens/timeline/types.ts"
```

---

## Task 2: Extract `SessionTimelineItem`

**Why:** The rail + marker container is shared by both the catalog's `MiniTimelinePreview` and the future live `SessionTimeline`. Extract it once.

**Files:**
- Create: `packages/pwa/src/screens/timeline/SessionTimelineItem.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Create the file**

Create `packages/pwa/src/screens/timeline/SessionTimelineItem.tsx`:

```tsx
import { CheckCircle2, Clock, MessageSquare, Wrench } from "lucide-react";
import type React from "react";
import { cn } from "../../lib/utils";
import { ClaudeCodeMark } from "../primitives/ClaudeCodeMark";

export type TimelineMarker = "claude" | "idle" | "success" | "tool" | "user";

export function SessionTimelineItem({
  children,
  meta,
  marker,
  title,
}: {
  children: React.ReactNode;
  marker: TimelineMarker;
  meta?: string;
  title?: string;
}) {
  return (
    <div className="relative mb-4">
      <span
        className={cn(
          "absolute -left-8 top-0 z-10 flex size-7 items-center justify-center rounded-full border",
          marker === "claude" && "border-orange-200 bg-orange-50",
          marker === "idle" && "border-border bg-muted",
          marker === "success" && "border-primary/25 bg-primary text-primary-foreground",
          marker === "tool" && "border-border bg-muted",
          marker === "user" && "border-primary/25 bg-primary-subtle",
        )}
      >
        {marker === "claude" ? (
          <ClaudeCodeMark className="rounded-full" size="sm" />
        ) : marker === "user" ? (
          <MessageSquare className="text-primary size-3.5" />
        ) : marker === "success" ? (
          <CheckCircle2 className="size-3.5" />
        ) : marker === "idle" ? (
          <Clock className="text-muted-foreground size-3.5" />
        ) : (
          <Wrench className="text-muted-foreground size-3.5" />
        )}
      </span>
      <div className="min-w-0">
        {title && (
          <div className="mb-2 flex items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
          </div>
        )}
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}
```

(Body copied verbatim from `src/demo/DemoApp.tsx` lines 1077–1123. Marker union hoisted to a named export. Imports rerouted: `cn` and `ClaudeCodeMark` come from the new locations established in P1.)

- [ ] **Step 2: Replace the inline copy in DemoApp**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete the local `function SessionTimelineItem(...)` block.
2. Add an import:

```ts
import { SessionTimelineItem } from "../screens/timeline/SessionTimelineItem";
```

- [ ] **Step 3: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```
Expected: clean.

In a browser visit `http://localhost:5173/demo` → **Cards** step and confirm the `MiniTimelinePreview` rail renders identically.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/timeline/SessionTimelineItem.tsx packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract SessionTimelineItem"
```

---

## Task 3: Extract chat cards — `UserBubble`, `AssistantBubble`, `ReasoningCard`

**Why:** Three small, similar-shape cards. Group them in one task so a single visual diff covers all three.

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/UserBubble.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/ReasoningCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `UserBubble.tsx`**

Create `packages/pwa/src/screens/timeline/cards/UserBubble.tsx`:

```tsx
import { CatalogCard } from "./CatalogCard";

export function UserBubble() {
  return (
    <CatalogCard>
      <UserBubbleSurface />
    </CatalogCard>
  );
}

export function UserBubbleSurface() {
  return (
    <div className="bg-primary-subtle border-primary/20 ml-auto max-w-[92%] rounded-md border p-3">
      <p>Please add password reset flow using email tokens.</p>
      <p className="text-muted-foreground mt-2 text-right text-xs">10:24 AM</p>
    </div>
  );
}
```

(Bodies copied from `src/demo/DemoApp.tsx` lines 1411–1426. `UserBubbleSurface` is exported alongside because P3's `renderTimelineItem` may need the bubble shape outside a CatalogCard wrapper for the live `user` event variant.)

- [ ] **Step 2: Create `AssistantBubble.tsx`**

Create `packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx`:

```tsx
import { Terminal } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function AssistantBubble() {
  return (
    <CatalogCard>
      <CatalogHeader icon={Terminal} title="Claude" meta="10:24 AM" />
      <p className="mt-2 leading-5">
        I'll plan the implementation and create the necessary endpoints.
      </p>
    </CatalogCard>
  );
}
```

(Body from lines 1428–1437.)

- [ ] **Step 3: Create `ReasoningCard.tsx`**

Create `packages/pwa/src/screens/timeline/cards/ReasoningCard.tsx`:

```tsx
import { ChevronRight, Sparkles } from "lucide-react";
import { CatalogCard } from "./CatalogCard";

export function ReasoningCard() {
  return (
    <CatalogCard>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Sparkles className="text-primary size-4" />
          Reasoning (5 steps)
        </p>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
      <p className="text-muted-foreground mt-4 text-center text-xs">
        Click to expand
      </p>
    </CatalogCard>
  );
}
```

(Body from lines 1439–1453.)

- [ ] **Step 4: Update the cards barrel**

Edit `packages/pwa/src/screens/timeline/cards/index.ts`:

```ts
export { CatalogCard, type CatalogCardTone } from "./CatalogCard";
export { CatalogHeader, type CatalogHeaderTone } from "./CatalogHeader";
export { AssistantBubble } from "./AssistantBubble";
export { ReasoningCard } from "./ReasoningCard";
export { UserBubble, UserBubbleSurface } from "./UserBubble";
```

- [ ] **Step 5: Replace inline copies in DemoApp**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete `function CatalogUserBubble()`, `function UserBubbleSurface()`, `function CatalogAssistantBubble()`, `function CatalogReasoning()`.
2. Add imports near the other card imports:

```ts
import {
  AssistantBubble,
  ReasoningCard,
  UserBubble,
  UserBubbleSurface,
} from "../screens/timeline/cards";
```

3. Find and replace usage in the catalog and the mini preview:
   - `<CatalogUserBubble />` → `<UserBubble />`
   - `<CatalogAssistantBubble />` → `<AssistantBubble />`
   - `<CatalogReasoning />` → `<ReasoningCard />`
   - `<UserBubbleSurface />` (already that name) — unchanged.

- [ ] **Step 6: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```
Expected: clean. Browser-visit `/demo` → Cards step → tiles 1, 2, 3 unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/UserBubble.tsx \
        packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx \
        packages/pwa/src/screens/timeline/cards/ReasoningCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract chat cards (UserBubble, AssistantBubble, ReasoningCard)"
```

---

## Task 4: Extract tool-execution cards — `BashToolCard`, `FileEditCard`, `ReadSearchCard`

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/BashToolCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/FileEditCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/ReadSearchCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `BashToolCard.tsx`**

Create `packages/pwa/src/screens/timeline/cards/BashToolCard.tsx`:

```tsx
import { Terminal } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function BashToolCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={Terminal}
        title="Bash"
        meta="10:25 AM"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <code className="mt-3 block font-mono text-xs">pnpm test auth</code>
      <p className="text-muted-foreground mt-2 truncate font-mono text-xs">
        cwd ~/awesome-project
      </p>
      <div className="border-border mt-3 border-t pt-2">
        <span className="text-warning text-xs font-semibold">2 warnings</span>
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1456–1474.)

- [ ] **Step 2: Create `FileEditCard.tsx`**

Create `packages/pwa/src/screens/timeline/cards/FileEditCard.tsx`:

```tsx
import { Pencil } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function FileEditCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={Pencil}
        title="Edit"
        meta="10:27 AM"
        tone="success"
        status={
          <span className="shrink-0 text-xs font-semibold">
            <span className="text-success">+24</span>{" "}
            <span className="text-danger">-6</span>
          </span>
        }
      />
      <p className="mt-3 truncate font-mono text-xs">src/routes/auth/reset.ts</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Lines 45-68</span>
        <span className="text-primary text-xs font-semibold">View diff</span>
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1476–1498.)

- [ ] **Step 3: Create `ReadSearchCard.tsx`**

Create `packages/pwa/src/screens/timeline/cards/ReadSearchCard.tsx`:

```tsx
import { ChevronRight, FileSearch } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ReadSearchCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={FileSearch} title="Read" meta="10:27 AM" tone="primary" />
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="truncate font-mono text-xs">src/lib/token.ts</p>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </div>
      <p className="text-muted-foreground mt-2 text-xs">(128 lines)</p>
    </CatalogCard>
  );
}
```

(Body from lines 1500–1511.)

- [ ] **Step 4: Update the barrel**

Append to `packages/pwa/src/screens/timeline/cards/index.ts`:

```ts
export { BashToolCard } from "./BashToolCard";
export { FileEditCard } from "./FileEditCard";
export { ReadSearchCard } from "./ReadSearchCard";
```

- [ ] **Step 5: Replace inline copies in DemoApp**

1. Delete `function CatalogBashTool()`, `function CatalogFileEdit()`, `function CatalogReadSearch()`.
2. Extend the existing `from "../screens/timeline/cards"` import:

```ts
import {
  AssistantBubble,
  BashToolCard,
  FileEditCard,
  ReadSearchCard,
  ReasoningCard,
  UserBubble,
  UserBubbleSurface,
} from "../screens/timeline/cards";
```

3. Replace catalog references:
   - `<CatalogBashTool />` → `<BashToolCard />`
   - `<CatalogFileEdit />` → `<FileEditCard />`
   - `<CatalogReadSearch />` → `<ReadSearchCard />`

- [ ] **Step 6: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```

Browser-visit `/demo` → Cards → tiles 4, 5, 6 unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/BashToolCard.tsx \
        packages/pwa/src/screens/timeline/cards/FileEditCard.tsx \
        packages/pwa/src/screens/timeline/cards/ReadSearchCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract tool-execution cards (Bash, FileEdit, ReadSearch)"
```

---

## Task 5: Extract tool-result cards — `ToolResultShortCard`, `ToolResultLongCard`, `ToolFailureCard`

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/ToolResultShortCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/ToolResultLongCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/ToolFailureCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `ToolResultShortCard.tsx`**

```tsx
import { CheckCircle2 } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolResultShortCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={CheckCircle2}
        title="Tests"
        tone="success"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <p className="mt-3">All 42 tests passed</p>
      <p className="text-muted-foreground mt-2 text-xs">Duration 1.8s</p>
    </CatalogCard>
  );
}
```

(Body from lines 1513–1526.)

- [ ] **Step 2: Create `ToolResultLongCard.tsx`**

```tsx
import { ChevronRight, FileText } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolResultLongCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={FileText}
        title="Build"
        meta="10:26 AM"
        tone="primary"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <p className="mt-3">Build completed with warnings</p>
      <button className="bg-muted mt-3 flex h-9 w-full items-center justify-between rounded-md px-3 text-xs font-semibold">
        View output (24 lines)
        <ChevronRight className="size-4" />
      </button>
    </CatalogCard>
  );
}
```

(Body from lines 1528–1545.)

- [ ] **Step 3: Create `ToolFailureCard.tsx`**

```tsx
import { Terminal } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolFailureCard() {
  return (
    <CatalogCard tone="danger">
      <CatalogHeader
        icon={Terminal}
        title="Bash"
        meta="10:25 AM"
        tone="danger"
        status={<span className="text-danger text-xs font-semibold">Failed</span>}
      />
      <code className="mt-3 block font-mono text-xs">rm -rf node_modules</code>
      <p className="text-muted-foreground mt-2 text-xs">
        Exit code <span className="text-danger font-semibold">1</span>
      </p>
      <pre className="bg-danger-subtle text-danger mt-3 rounded-md font-mono text-xs leading-5">
Permission denied: node_modules
Operation not permitted
      </pre>
    </CatalogCard>
  );
}
```

(Body from lines 1547–1567. Per spec §1 invariant 6 this same card is used for the `error` kind in P3.)

- [ ] **Step 4: Update the barrel**

Append to `packages/pwa/src/screens/timeline/cards/index.ts`:

```ts
export { ToolResultShortCard } from "./ToolResultShortCard";
export { ToolResultLongCard } from "./ToolResultLongCard";
export { ToolFailureCard } from "./ToolFailureCard";
```

- [ ] **Step 5: Replace inline copies in DemoApp**

1. Delete `function CatalogToolResultShort()`, `function CatalogToolResultLong()`, `function CatalogToolFailure()`.
2. Extend the cards import to include `ToolResultShortCard, ToolResultLongCard, ToolFailureCard`.
3. Replace catalog references:
   - `<CatalogToolResultShort />` → `<ToolResultShortCard />`
   - `<CatalogToolResultLong />` → `<ToolResultLongCard />`
   - `<CatalogToolFailure />` → `<ToolFailureCard />`

- [ ] **Step 6: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```

Browser-visit `/demo` → Cards → tiles 7, 8, 9 unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/ToolResultShortCard.tsx \
        packages/pwa/src/screens/timeline/cards/ToolResultLongCard.tsx \
        packages/pwa/src/screens/timeline/cards/ToolFailureCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract tool-result cards (Short, Long, Failure)"
```

---

## Task 6: Extract permission cards — `PermissionInlineCard`, `PermissionResolvedCard`

**Why:** Two cards. Note: `CatalogPermissionReview` (catalog tile #11) is **not** extracted in P2 — it migrates to `screens/PermissionSurface.tsx` in P4 and stays inline in DemoApp until then.

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/PermissionInlineCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/PermissionResolvedCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `PermissionInlineCard.tsx`**

```tsx
import { ShieldAlert } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function PermissionInlineCard() {
  return (
    <CatalogCard tone="warning">
      <CatalogHeader icon={ShieldAlert} title="Permission required" meta="10:26 AM" tone="warning" />
      <div className="mt-3 grid gap-1 text-xs">
        <p>Tool <span className="ml-6 font-mono">Bash</span></p>
        <p>Command <span className="font-mono">rm -rf node_modules</span></p>
      </div>
      <Button className="mt-3 w-full" size="sm" variant="secondary">
        Review
      </Button>
    </CatalogCard>
  );
}
```

(Body from lines 1569–1582. Imports `Button` from the shared shadcn primitive.)

- [ ] **Step 2: Create `PermissionResolvedCard.tsx`**

```tsx
import { ShieldCheck } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function PermissionResolvedCard() {
  return (
    <CatalogCard tone="success">
      <CatalogHeader icon={ShieldCheck} title="Permission granted" meta="10:27 AM" tone="success" />
      <code className="mt-3 block font-mono text-xs">rm -rf node_modules</code>
    </CatalogCard>
  );
}
```

(Body from lines 1603–1610.)

- [ ] **Step 3: Update the barrel**

Append:

```ts
export { PermissionInlineCard } from "./PermissionInlineCard";
export { PermissionResolvedCard } from "./PermissionResolvedCard";
```

- [ ] **Step 4: Replace inline copies in DemoApp**

1. Delete `function CatalogPermissionInline()` and `function CatalogPermissionResolved()`.
   - Do **not** delete `function CatalogPermissionReview()` — it stays.
2. Extend the cards import to include `PermissionInlineCard, PermissionResolvedCard`.
3. Replace catalog references:
   - `<CatalogPermissionInline />` → `<PermissionInlineCard />`
   - `<CatalogPermissionResolved />` → `<PermissionResolvedCard />`
   - `<CatalogPermissionReview />` — unchanged.

- [ ] **Step 5: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```

Browser-visit `/demo` → Cards → tiles 10 and 12 unchanged. Tile 11 (Permission Review) still rendered by the inline `CatalogPermissionReview` — also unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/PermissionInlineCard.tsx \
        packages/pwa/src/screens/timeline/cards/PermissionResolvedCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract permission cards (Inline, Resolved)"
```

---

## Task 7: Extract workflow cards — `BatchSummaryCard`, `SubagentCard`, `TaskCreatedCard`, `TaskCompletedCard`

**Why:** Four cards. `SubagentCard` merges the prototype's collapsed and expanded variants into a single component with an `expanded?: boolean` prop, matching spec §1.

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/BatchSummaryCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/SubagentCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/TaskCreatedCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/TaskCompletedCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `BatchSummaryCard.tsx`**

```tsx
import { ChevronRight, PackageCheck } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function BatchSummaryCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={PackageCheck} title="Batch complete" meta="10:28 AM" tone="primary" />
      <p className="text-muted-foreground mt-2 text-xs">4 tools - 1m 12s</p>
      <p className="text-muted-foreground mt-1 text-xs">3 succeeded, 1 failed</p>
      <div className="border-border mt-3 flex items-center justify-between border-t pt-2">
        <span className="text-primary text-xs font-semibold">View details</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1612–1624.)

- [ ] **Step 2: Create `SubagentCard.tsx` (collapsed + expanded merged)**

```tsx
import { CheckCircle2, ChevronRight, Users } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

const expandedRows = [
  "Install deps",
  "Run unit tests",
  "Run integration tests",
  "Collect coverage",
];

export function SubagentCard({ expanded = false }: { expanded?: boolean }) {
  if (expanded) {
    return (
      <CatalogCard>
        <CatalogHeader
          icon={Users}
          title="Subagent: test-runner"
          tone="primary"
          status={<span className="text-success text-xs font-semibold">Completed</span>}
        />
        <div className="mt-3 grid gap-1">
          {expandedRows.map((row, index) => (
            <div className="flex items-center justify-between gap-2 text-xs" key={row}>
              <span className="flex items-center gap-2">
                <CheckCircle2 className="text-success size-3.5" />
                {row}
              </span>
              <span className="text-muted-foreground">{12 + index * 8}.4s</span>
            </div>
          ))}
        </div>
      </CatalogCard>
    );
  }

  return (
    <CatalogCard>
      <CatalogHeader icon={Users} title="Subagent: test-runner" tone="primary" />
      <p className="text-muted-foreground mt-2 text-xs">4 steps - 1m 12s</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Click to expand</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
```

(Bodies merged from lines 1626–1662.)

- [ ] **Step 3: Create `TaskCreatedCard.tsx`**

```tsx
import { Plus } from "lucide-react";
import { CatalogCard } from "./CatalogCard";

const taskChips = ["api-reset", "email-token", "rate-limit"];

export function TaskCreatedCard() {
  return (
    <CatalogCard>
      <div className="flex flex-wrap gap-2">
        {taskChips.map((task) => (
          <span
            className="border-primary/25 bg-primary-subtle text-primary rounded-md border px-2 py-1 text-xs font-semibold"
            key={task}
          >
            {task}
          </span>
        ))}
      </div>
      <button className="text-muted-foreground mt-4 flex items-center gap-1 text-xs">
        <Plus className="size-3.5" />
        Add task
      </button>
    </CatalogCard>
  );
}
```

(Body from lines 1664–1683.)

- [ ] **Step 4: Create `TaskCompletedCard.tsx`**

```tsx
import { CheckCircle2, ExternalLink } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function TaskCompletedCard() {
  return (
    <CatalogCard tone="purple">
      <CatalogHeader icon={CheckCircle2} title="Task completed" meta="10:31 AM" tone="primary" />
      <p className="mt-2 font-semibold">feat: add password reset flow</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Commit a1b2c3d</span>
        <ExternalLink className="text-primary size-3.5" />
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1685–1696.)

- [ ] **Step 5: Update the barrel**

Append:

```ts
export { BatchSummaryCard } from "./BatchSummaryCard";
export { SubagentCard } from "./SubagentCard";
export { TaskCreatedCard } from "./TaskCreatedCard";
export { TaskCompletedCard } from "./TaskCompletedCard";
```

- [ ] **Step 6: Replace inline copies in DemoApp**

1. Delete `function CatalogBatchSummary()`, `function CatalogSubagentCollapsed()`, `function CatalogSubagentExpanded()`, `function CatalogTaskCreated()`, `function CatalogTaskCompleted()`.
2. Extend the cards import to include `BatchSummaryCard, SubagentCard, TaskCreatedCard, TaskCompletedCard`.
3. Replace catalog references:
   - `<CatalogBatchSummary />` → `<BatchSummaryCard />`
   - `<CatalogSubagentCollapsed />` → `<SubagentCard />`
   - `<CatalogSubagentExpanded />` → `<SubagentCard expanded />`
   - `<CatalogTaskCreated />` → `<TaskCreatedCard />`
   - `<CatalogTaskCompleted />` → `<TaskCompletedCard />`

- [ ] **Step 7: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```

Browser-visit `/demo` → Cards → tiles 13, 14, 15, 16, 17 unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/BatchSummaryCard.tsx \
        packages/pwa/src/screens/timeline/cards/SubagentCard.tsx \
        packages/pwa/src/screens/timeline/cards/TaskCreatedCard.tsx \
        packages/pwa/src/screens/timeline/cards/TaskCompletedCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract workflow cards (Batch, Subagent, TaskCreated, TaskCompleted)"
```

---

## Task 8: Extract system / fallback cards — `SystemNoticeCard`, `RawJsonCard`, `IdleWaitingCard`

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/SystemNoticeCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/RawJsonCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/IdleWaitingCard.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `SystemNoticeCard.tsx`**

```tsx
import { Info } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function SystemNoticeCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={Info} title="System" meta="10:22 AM" />
      <div className="text-muted-foreground mt-3 grid gap-1 text-xs">
        <p>Session started</p>
        <p>Claude Sonnet 3.5</p>
        <p>Context window 128k</p>
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1698–1709. Per spec §1 invariant 2 this card also handles `compact`, `session-boundary`, and `metadata` kinds in P3 — same shell, different content built in `renderTimelineItem`.)

- [ ] **Step 2: Create `RawJsonCard.tsx`**

```tsx
import { ChevronRight, Code2 } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function RawJsonCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={Code2} title="Unknown message" meta="10:22 AM" />
      <pre className="bg-muted mt-3 overflow-hidden rounded-md p-2 font-mono text-xs leading-5">
{`{
  "type": "event_unknown",
  "payload": { "foo": "bar" }
}`}
      </pre>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-primary text-xs font-semibold">View raw</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1711–1727. Be careful preserving the literal whitespace inside the `<pre>` block — the leading newlines and indentation are part of the rendered output.)

- [ ] **Step 3: Create `IdleWaitingCard.tsx`**

```tsx
import { Clock, PlayCircle } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function IdleWaitingCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={Clock} title="Waiting for input" meta="10:31 AM" />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm leading-5">
          How would you like to proceed?
        </p>
        <span className="border-border bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-full border">
          <PlayCircle className="text-muted-foreground size-5" />
        </span>
      </div>
    </CatalogCard>
  );
}
```

(Body from lines 1729–1743.)

- [ ] **Step 4: Update the barrel**

Append:

```ts
export { SystemNoticeCard } from "./SystemNoticeCard";
export { RawJsonCard } from "./RawJsonCard";
export { IdleWaitingCard } from "./IdleWaitingCard";
```

- [ ] **Step 5: Replace inline copies in DemoApp**

1. Delete `function CatalogSystemNotice()`, `function CatalogRawJson()`, `function CatalogIdleWaiting()`.
2. Extend the cards import to include `SystemNoticeCard, RawJsonCard, IdleWaitingCard`.
3. Replace catalog references:
   - `<CatalogSystemNotice />` → `<SystemNoticeCard />`
   - `<CatalogRawJson />` → `<RawJsonCard />`
   - `<CatalogIdleWaiting />` → `<IdleWaitingCard />`

- [ ] **Step 6: Verify**

```bash
cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx
```

Browser-visit `/demo` → Cards → tiles 18, 19, 20 unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/SystemNoticeCard.tsx \
        packages/pwa/src/screens/timeline/cards/RawJsonCard.tsx \
        packages/pwa/src/screens/timeline/cards/IdleWaitingCard.tsx \
        packages/pwa/src/screens/timeline/cards/index.ts \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract system/fallback cards (SystemNotice, RawJson, IdleWaiting)"
```

---

## Task 9: Add a static-markup smoke test for every extracted card

**Why:** P3+ will mutate `renderTimelineItem` and downstream files. A small unit test that mounts each card via `renderToStaticMarkup` and asserts a unique signature string per card protects every extraction in this plan from silent regression.

**Files:**
- Create: `packages/pwa/tests/cards.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/pwa/tests/cards.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssistantBubble,
  BashToolCard,
  BatchSummaryCard,
  FileEditCard,
  IdleWaitingCard,
  PermissionInlineCard,
  PermissionResolvedCard,
  RawJsonCard,
  ReadSearchCard,
  ReasoningCard,
  SubagentCard,
  SystemNoticeCard,
  TaskCompletedCard,
  TaskCreatedCard,
  ToolFailureCard,
  ToolResultLongCard,
  ToolResultShortCard,
  UserBubble,
} from "../src/screens/timeline/cards";

const cases: Array<[string, JSX.Element, string]> = [
  ["UserBubble", <UserBubble />, "Please add password reset flow"],
  ["AssistantBubble", <AssistantBubble />, "I'll plan the implementation"],
  ["ReasoningCard", <ReasoningCard />, "Reasoning (5 steps)"],
  ["BashToolCard", <BashToolCard />, "pnpm test auth"],
  ["FileEditCard", <FileEditCard />, "src/routes/auth/reset.ts"],
  ["ReadSearchCard", <ReadSearchCard />, "src/lib/token.ts"],
  ["ToolResultShortCard", <ToolResultShortCard />, "All 42 tests passed"],
  ["ToolResultLongCard", <ToolResultLongCard />, "View output (24 lines)"],
  ["ToolFailureCard", <ToolFailureCard />, "Permission denied: node_modules"],
  ["PermissionInlineCard", <PermissionInlineCard />, "Permission required"],
  ["PermissionResolvedCard", <PermissionResolvedCard />, "Permission granted"],
  ["BatchSummaryCard", <BatchSummaryCard />, "Batch complete"],
  ["SubagentCard collapsed", <SubagentCard />, "Click to expand"],
  ["SubagentCard expanded", <SubagentCard expanded />, "Run integration tests"],
  ["TaskCreatedCard", <TaskCreatedCard />, "email-token"],
  ["TaskCompletedCard", <TaskCompletedCard />, "feat: add password reset flow"],
  ["SystemNoticeCard", <SystemNoticeCard />, "Claude Sonnet 3.5"],
  ["RawJsonCard", <RawJsonCard />, "event_unknown"],
  ["IdleWaitingCard", <IdleWaitingCard />, "How would you like to proceed?"],
];

for (const [name, element, signature] of cases) {
  test(`card renders: ${name}`, () => {
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain(signature);
  });
}
```

- [ ] **Step 2: Run the test to confirm it passes**

```bash
cd packages/pwa && bun test tests/cards.test.tsx
```
Expected: 19 pass, 0 fail.

(If a test fails, the corresponding card body diverged from its source-of-truth literals during extraction — re-check that task.)

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/tests/cards.test.tsx
git commit -m "test(pwa): static-markup smoke tests for 18 timeline cards"
```

---

## Task 10: Final P2 verification

- [ ] **Step 1: Workspace-wide typecheck**

```bash
bun run typecheck
```
Expected: every package green.

- [ ] **Step 2: Workspace-wide unit tests**

```bash
bun test packages/
```
Expected: prior 170 + 19 new card tests = 189 passing (or whatever the baseline plus 19 was).

- [ ] **Step 3: In-process e2e**

```bash
bun test e2e/
```
Expected: all 12 in-process scenarios still pass. (P2 didn't touch hub/auth/api/RealApp paths — anything red here is unrelated to this plan; investigate separately.)

- [ ] **Step 4: Manual visual regression on `/demo`**

Run `cd packages/pwa && bun run dev` and visit `http://localhost:5173/demo`:
- Walk through every step of the guided tour (Sign in → Home → Session → Cards → Permission → Settings) on each device width (Mobile / Tablet / Desktop).
- The **Cards** step is the critical one — confirm tiles 1–20 render visually identical to before P2. Any tile mismatch = a card extraction body diverged from its source.

Stop the dev server.

- [ ] **Step 5: Confirm clean tree**

```bash
git status
```
Expected: working tree clean. P2 done. Hand off to P3 (Session Live Wiring).
