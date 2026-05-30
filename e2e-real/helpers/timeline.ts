import type { Page } from "@playwright/test";

/**
 * Expand the first ToolGroup in the timeline if it isn't open already.
 *
 * Post-polish, consecutive tool calls fold into a `tool-group` whose
 * inner per-tool cards are hidden until expanded — a deliberate
 * design call (group header reads "Ran 4 commands · 23s" by default;
 * users expand to inspect). When a test asserts on per-tool article
 * chrome (Bash/Edit/Read articles, Success/Failed pills, View output
 * button), it must expand the group first — that's what the user
 * would do.
 *
 * Idempotent: if the group is already expanded, or no group exists,
 * the call is a no-op. Caller's downstream assertions will fail with
 * their own meaningful timeout if no group ever shows up.
 *
 * Used by scenarios 02, 18, 19 — anywhere a JSONL tape replay or a
 * permission-allow flow lands tool cards we then drill into.
 */
export async function expandFirstToolGroup(page: Page, timeoutMs = 15_000) {
  const group = page.getByTestId("timeline").getByTestId("tool-group").first();
  if (await group.isVisible({ timeout: timeoutMs }).catch(() => false)) {
    if ((await group.getAttribute("data-expanded")) !== "true") {
      await group.locator("button[aria-expanded]").first().click();
    }
  }
}
