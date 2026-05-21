# PWA Integration P1 — Skeleton & Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock in the directory layout — route `/demo` to the prototype and `/` to the existing live UI — and extract 6 reusable primitive components from the prototype so subsequent card / screen plans can consume them without duplicating code.

**Architecture:** `App.tsx` becomes a tiny path-based router (no `react-router`). The 2592-line prototype moves to `src/demo/DemoApp.tsx` unchanged. The existing 194-line live UI in `src/RealApp.tsx` keeps its behavior; only its export name changes. After P1 the live `/` route renders exactly as it does today; `/demo` renders the prototype's full guided demo.

**Tech Stack:** React 18, Vite 5, TypeScript strict, Tailwind 4, shadcn primitives, lucide-react icons. No new dependencies introduced in P1.

**Reference:** Source spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §1 architecture, §4 milestones M1 + M2.

---

## File structure after P1

```
packages/pwa/src/
├── components/
│   └── ui/
│       └── button.tsx           # unchanged
├── demo/
│   └── DemoApp.tsx              # NEW — was App.tsx (prototype, exports DemoApp)
├── screens/
│   ├── primitives/
│   │   ├── ClaudeCodeMark.tsx   # NEW
│   │   ├── Field.tsx            # NEW
│   │   ├── StatusChip.tsx       # NEW (also exports SessionState type)
│   │   ├── StatusIcon.tsx       # NEW
│   │   └── index.ts             # NEW barrel
│   └── timeline/
│       └── cards/
│           ├── CatalogCard.tsx     # NEW
│           ├── CatalogHeader.tsx   # NEW
│           └── index.ts            # NEW barrel
├── lib/
│   └── utils.ts                 # unchanged
├── App.tsx                      # REWRITTEN — path router (/, /demo)
├── RealApp.tsx                  # MODIFIED — export App → RealApp
├── api.ts                       # unchanged
├── auth.ts                      # unchanged
├── main.tsx                     # unchanged
├── PermissionBanner.tsx         # unchanged (still used by RealApp)
├── push.ts                      # unchanged
├── SessionPane.tsx              # unchanged (still used by RealApp)
├── Settings.tsx                 # unchanged (still used by RealApp)
├── styles.css                   # unchanged
└── ws.ts                        # unchanged
```

`packages/pwa/tests/App.test.tsx` is updated to import `DemoApp` from its new location.

---

## Task 1: Move prototype to `demo/DemoApp.tsx`

**Why:** The prototype (currently at `src/App.tsx`) must move out of the entry-point slot so `App.tsx` can become a router. We keep the prototype's body verbatim — only the file location and the exported function name change.

**Files:**
- Create: `packages/pwa/src/demo/DemoApp.tsx`
- Modify: `packages/pwa/tests/App.test.tsx`

- [ ] **Step 1: Create the new directory and copy the prototype file**

```bash
mkdir -p packages/pwa/src/demo
cp packages/pwa/src/App.tsx packages/pwa/src/demo/DemoApp.tsx
```

- [ ] **Step 2: Fix imports in the copied file**

The original imports `Button` from `./components/ui/button` and `cn` from `./lib/utils`. After moving one level deeper they must reference `../components/ui/button` and `../lib/utils`.

Edit `packages/pwa/src/demo/DemoApp.tsx`:

```diff
-import { Button } from "./components/ui/button";
-import { cn } from "./lib/utils";
+import { Button } from "../components/ui/button";
+import { cn } from "../lib/utils";
```

- [ ] **Step 3: Rename the exported function**

In `packages/pwa/src/demo/DemoApp.tsx` change the export from `App` to `DemoApp`:

```diff
-export function App() {
+export function DemoApp() {
```

(Single line change near line 366. The function body is unchanged.)

- [ ] **Step 4: Update the existing prototype test to import from the new location**

Edit `packages/pwa/tests/App.test.tsx`:

```ts
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoApp } from "../src/demo/DemoApp";

test("prototype guide includes a dedicated card system section", () => {
  const markup = renderToStaticMarkup(<DemoApp />);

  expect(markup).toContain("Cards");
  expect(markup).toContain("Card anatomy, variants, states, and density rules.");
});
```

- [ ] **Step 5: Verify the test still passes against the moved file**

Run: `cd packages/pwa && bun test tests/App.test.tsx`
Expected: `1 pass, 0 fail`

If the test fails with a module-resolution error, re-check the relative imports in `src/demo/DemoApp.tsx` — the file moved one level deeper than `App.tsx`.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/demo/DemoApp.tsx packages/pwa/tests/App.test.tsx
git commit -m "refactor(pwa): move prototype to src/demo/DemoApp.tsx"
```

---

## Task 2: Rename `RealApp.tsx` export from `App` to `RealApp`

**Why:** Both `App.tsx` and `RealApp.tsx` currently export a function named `App`, which would collide once `App.tsx` becomes the router that imports both. Rename the live UI's export to match the file name.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Rename the function declaration**

Edit `packages/pwa/src/RealApp.tsx` line 13:

```diff
-export function App() {
+export function RealApp() {
```

(No callers exist yet — `main.tsx` still imports from `./App.tsx`, which currently aliases the prototype. The router task below introduces the first import of `RealApp`.)

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/pwa && bun run typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/RealApp.tsx
git commit -m "refactor(pwa): rename RealApp export App → RealApp"
```

---

## Task 3: Replace `App.tsx` with a path-based router

**Why:** `main.tsx` mounts `App` from `./App.tsx`. After this task `App` is a 12-line component that picks `DemoApp` or `RealApp` based on `location.pathname`. Per the spec (§1 invariant 5) we explicitly do **not** add `react-router` — pathname matching is enough.

**Files:**
- Modify: `packages/pwa/src/App.tsx` (full rewrite — file currently holds the prototype, which has been copied to `demo/DemoApp.tsx` in Task 1)

- [ ] **Step 1: Overwrite `App.tsx` with the router**

Replace the entire contents of `packages/pwa/src/App.tsx` with:

```tsx
import { DemoApp } from "./demo/DemoApp";
import { RealApp } from "./RealApp";

export function App() {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/demo")) {
    return <DemoApp />;
  }
  return <RealApp />;
}
```

- [ ] **Step 2: Verify typecheck across the workspace**

Run: `bun run typecheck`
Expected: zero errors. (If the prototype test fails to compile, re-check Task 1 Step 4.)

- [ ] **Step 3: Verify in-process e2e is still green**

Run: `bun test e2e/`
Expected: all 12 e2e tests pass. The router is invisible to protocol-level e2e (which uses `helpers/pwa-client.ts`, not a browser), so behavior must be identical.

- [ ] **Step 4: Smoke-test both routes in a real browser**

Start: `cd packages/pwa && bun run dev`

Verify in a browser tab:
- `http://localhost:5173/` → renders `RealApp` (header "cc-remote", inline-styled "You're not signed in." sign-in button — same as before this plan).
- `http://localhost:5173/demo` → renders `DemoApp` (the shadcn prototype with three-end guided demo).
- `http://localhost:5173/demo/anything` → also renders `DemoApp` (prefix match).

Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/App.tsx
git commit -m "feat(pwa): App.tsx routes / → RealApp, /demo → DemoApp"
```

---

## Task 4: Extract `ClaudeCodeMark` primitive

**Why:** The brand mark is referenced from `AppHeader` (in DemoApp), the future `SignInScreen`, and the live `RealApp` once it switches to the new shell (P4). Extracting it now avoids duplicating the gradient + sizing classes in three places.

**Files:**
- Create: `packages/pwa/src/screens/primitives/ClaudeCodeMark.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Create the primitive file**

Create `packages/pwa/src/screens/primitives/ClaudeCodeMark.tsx`:

```tsx
import { cn } from "../../lib/utils";

export function ClaudeCodeMark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <span
      className={cn(
        "shadow-card inline-flex shrink-0 items-center justify-center rounded-xl border border-slate-950/10 bg-gradient-to-br from-slate-900 to-slate-950 font-mono font-bold text-white",
        size === "sm" && "size-7 text-sm",
        size === "md" && "size-9 text-lg",
        size === "lg" && "size-12 text-2xl",
        size === "xl" && "size-20 text-[38px]",
        className,
      )}
      aria-label="Claude Code"
    >
      <span className="-mt-1 tracking-[-0.12em]">&gt;_</span>
    </span>
  );
}
```

(Body copied verbatim from `DemoApp.tsx` lines 607–629; only the import path for `cn` changed.)

- [ ] **Step 2: Delete the inline copy in DemoApp and import from the new module**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete the local `function ClaudeCodeMark(...) { ... }` block (lines 607–629 in the moved file — search for `function ClaudeCodeMark`).
2. Add a top-level import alongside the other imports near the top of the file:

```ts
import { ClaudeCodeMark } from "../screens/primitives/ClaudeCodeMark";
```

- [ ] **Step 3: Verify markup is unchanged**

Run: `cd packages/pwa && bun test tests/App.test.tsx`
Expected: `1 pass`.

Then in a browser confirm `http://localhost:5173/demo` looks pixel-identical (the brand mark in the top-left of the workbench frame).

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/primitives/ClaudeCodeMark.tsx packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract ClaudeCodeMark primitive"
```

---

## Task 5: Extract `StatusChip`, `StatusIcon`, `Field` primitives

**Why:** All three are pure presentational components used by `AppHeader`, `DaemonCard`, `SessionRow`, and the future `SessionView`. Group them in one task to keep commits coherent.

**Files:**
- Create: `packages/pwa/src/screens/primitives/StatusChip.tsx`
- Create: `packages/pwa/src/screens/primitives/StatusIcon.tsx`
- Create: `packages/pwa/src/screens/primitives/Field.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Create `StatusChip.tsx` (also defines the shared `SessionState` type)**

Create `packages/pwa/src/screens/primitives/StatusChip.tsx`:

```tsx
import { cn } from "../../lib/utils";

export type SessionState = "waiting" | "working" | "idle" | "offline";

export type StatusChipTone =
  | "error"
  | "idle"
  | "offline"
  | "online"
  | "waiting"
  | "working";

export function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: StatusChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs font-semibold",
        tone === "online" && "border-success/30 bg-success-subtle text-success",
        tone === "waiting" &&
          "border-warning/30 bg-warning-subtle text-warning",
        tone === "working" &&
          "border-primary/30 bg-primary-subtle text-primary",
        tone === "idle" && "border-border bg-muted text-muted-foreground",
        tone === "offline" && "border-border bg-muted text-offline",
        tone === "error" && "border-danger/30 bg-danger-subtle text-danger",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
```

(Body copied from DemoApp lines 2547–2579. We tighten the union: the original accepted `StatusChipTone | SessionState`, but every member of `SessionState` is already in `StatusChipTone`, so a single `StatusChipTone` is equivalent and clearer.)

- [ ] **Step 2: Create `StatusIcon.tsx`**

Create `packages/pwa/src/screens/primitives/StatusIcon.tsx`:

```tsx
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
```

(Body copied from DemoApp lines 2534–2545. The `SessionState` type now lives in `StatusChip.tsx` and is imported here.)

- [ ] **Step 3: Create `Field.tsx`**

Create `packages/pwa/src/screens/primitives/Field.tsx`:

```tsx
import { cn } from "../../lib/utils";

export function Field({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
        {label}
      </p>
      <p className={cn("mt-1 text-sm", mono && "font-mono")}>{value}</p>
    </div>
  );
}
```

(Body copied from DemoApp lines 2402–2419.)

- [ ] **Step 4: Replace inline copies in DemoApp**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete the local `function StatusIcon(...)`, `function StatusChip(...)`, and `function Field(...)` blocks (search for each `function ` declaration).
2. Delete the local `type SessionState = "waiting" | "working" | "idle" | "offline";` near line 59 (now imported from StatusChip).
3. Add imports at the top of the file:

```ts
import { Field } from "../screens/primitives/Field";
import { StatusChip, type SessionState } from "../screens/primitives/StatusChip";
import { StatusIcon } from "../screens/primitives/StatusIcon";
```

- [ ] **Step 5: Verify**

Run: `cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx`
Expected: typecheck clean; 1 pass.

In a browser confirm `http://localhost:5173/demo` is unchanged (status pills in the header, status icons in `SessionRow`, label/value pairs in `SessionPane`'s metadata).

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/primitives/StatusChip.tsx \
        packages/pwa/src/screens/primitives/StatusIcon.tsx \
        packages/pwa/src/screens/primitives/Field.tsx \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract StatusChip, StatusIcon, Field primitives"
```

---

## Task 6: Extract `CatalogCard` and `CatalogHeader` shells

**Why:** Every one of the 20 timeline cards (extracted in P2) wraps its content in `CatalogCard` and uses `CatalogHeader` for the icon + title + meta row. Extracting both shells now means P2 can drop in 20 small files that each just import these two.

**Files:**
- Create: `packages/pwa/src/screens/timeline/cards/CatalogCard.tsx`
- Create: `packages/pwa/src/screens/timeline/cards/CatalogHeader.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`

- [ ] **Step 1: Create `CatalogCard.tsx`**

Create `packages/pwa/src/screens/timeline/cards/CatalogCard.tsx`:

```tsx
import type React from "react";
import { cn } from "../../../lib/utils";

export type CatalogCardTone =
  | "default"
  | "danger"
  | "success"
  | "warning"
  | "purple";

export function CatalogCard({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: CatalogCardTone;
}) {
  return (
    <article
      className={cn(
        "rounded-card shadow-card min-h-[92px] border p-3 text-sm",
        tone === "default" && "border-border bg-surface",
        tone === "danger" && "border-danger/30 bg-danger-subtle",
        tone === "success" && "border-success/30 bg-success-subtle",
        tone === "warning" && "border-warning/35 bg-warning-subtle",
        tone === "purple" && "border-primary/25 bg-primary-subtle",
      )}
    >
      {children}
    </article>
  );
}
```

(Body copied from DemoApp lines 1344–1365. Tone literal hoisted to a named export.)

- [ ] **Step 2: Create `CatalogHeader.tsx`**

Create `packages/pwa/src/screens/timeline/cards/CatalogHeader.tsx`:

```tsx
import type { LucideIcon } from "lucide-react";
import type React from "react";
import { cn } from "../../../lib/utils";

export type CatalogHeaderTone =
  | "danger"
  | "default"
  | "primary"
  | "success"
  | "warning";

export function CatalogHeader({
  icon: Icon,
  meta,
  status,
  title,
  tone = "default",
}: {
  icon: LucideIcon;
  meta?: string;
  status?: React.ReactNode;
  title: string;
  tone?: CatalogHeaderTone;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="flex min-w-0 items-center gap-2 font-semibold">
        <span
          className={cn(
            "border-border bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-md border",
            tone === "primary" && "border-primary/25 bg-primary-subtle",
            tone === "success" && "border-success/25 bg-success-subtle",
            tone === "warning" && "border-warning/30 bg-warning-subtle",
            tone === "danger" && "border-danger/30 bg-danger-subtle",
          )}
        >
          <Icon
            className={cn(
              "size-3.5",
              tone === "primary" && "text-primary",
              tone === "success" && "text-success",
              tone === "warning" && "text-warning",
              tone === "danger" && "text-danger",
            )}
          />
        </span>
        <span className="truncate">{title}</span>
      </p>
      {status ?? (
        <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>
      )}
    </div>
  );
}
```

(Body copied from DemoApp lines 1367–1409. Icon prop type tightened from `typeof Terminal` to `LucideIcon` — the proper type from `lucide-react` for any icon component.)

- [ ] **Step 3: Replace inline copies in DemoApp**

In `packages/pwa/src/demo/DemoApp.tsx`:
1. Delete the local `function CatalogCard(...)` block (search for `function CatalogCard`, around line 1344).
2. Delete the local `function CatalogHeader(...)` block (around line 1367).
3. Add imports at the top of the file:

```ts
import { CatalogCard } from "../screens/timeline/cards/CatalogCard";
import { CatalogHeader } from "../screens/timeline/cards/CatalogHeader";
```

- [ ] **Step 4: Verify**

Run: `cd packages/pwa && bun run typecheck && bun test tests/App.test.tsx`
Expected: typecheck clean; 1 pass.

In a browser visit `http://localhost:5173/demo` and click through to the **Cards** step — every catalog tile renders the same shell as before.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/CatalogCard.tsx \
        packages/pwa/src/screens/timeline/cards/CatalogHeader.tsx \
        packages/pwa/src/demo/DemoApp.tsx
git commit -m "refactor(pwa): extract CatalogCard and CatalogHeader shells"
```

---

## Task 7: Add barrel files

**Why:** Subsequent plans will import from `screens/primitives` and `screens/timeline/cards` repeatedly. A barrel keeps each importer to one line.

**Files:**
- Create: `packages/pwa/src/screens/primitives/index.ts`
- Create: `packages/pwa/src/screens/timeline/cards/index.ts`

- [ ] **Step 1: Create `screens/primitives/index.ts`**

```ts
export { ClaudeCodeMark } from "./ClaudeCodeMark";
export { Field } from "./Field";
export { StatusChip, type SessionState, type StatusChipTone } from "./StatusChip";
export { StatusIcon } from "./StatusIcon";
```

- [ ] **Step 2: Create `screens/timeline/cards/index.ts`**

```ts
export { CatalogCard, type CatalogCardTone } from "./CatalogCard";
export { CatalogHeader, type CatalogHeaderTone } from "./CatalogHeader";
```

(P2 will add the 20 timeline-card exports here as each card is extracted.)

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/pwa && bun run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/primitives/index.ts \
        packages/pwa/src/screens/timeline/cards/index.ts
git commit -m "refactor(pwa): add barrel files for primitives and cards"
```

---

## Task 8: Final P1 verification

**Why:** Confirm the workspace is clean and every test layer agrees before handing off to P2.

- [ ] **Step 1: Workspace-wide typecheck**

Run: `bun run typecheck`
Expected: every package green.

- [ ] **Step 2: Workspace-wide unit tests**

Run: `bun test packages/`
Expected: all tests pass (existing 169 + the 1 prototype-markup test = 170).

- [ ] **Step 3: In-process e2e**

Run: `bun test e2e/`
Expected: all 12 in-process scenarios pass.

- [ ] **Step 4: Manual three-route smoke**

Start `cd packages/pwa && bun run dev` and verify in a browser:
- `/` → live `RealApp` (sign-in → daemon list → SessionPane round trip works as before P1).
- `/demo` → prototype boots on the **Home** step.
- `/demo/whatever` → prototype boots (prefix match).

Stop the dev server.

- [ ] **Step 5: Tag the milestone (no separate commit needed — verification only)**

Confirm `git status` shows a clean tree. P1 is done. Hand off to P2 (Card Catalog).
