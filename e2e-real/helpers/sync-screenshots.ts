// Sync passing-test screenshots into a stable visual-regression baseline.
//
// Per scenario, when the test status is "passed" at afterEach time, copy all
// PNGs Playwright wrote into testInfo.outputDir (which is also where our
// `step()` helper writes its named frames) over to
// e2e-real/screenshots/<scenarioSlug>/. Failed runs DO NOT write — they
// would otherwise poison the baseline with broken UI.
//
// Diff workflow: `git diff e2e-real/screenshots/` before merging. Any byte
// change is either a deliberate visual update (commit it) or an unintended
// regression (fix it).

import { mkdir, readdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestInfo } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const screenshotsRoot = resolve(repoRoot, "e2e-real", "screenshots");

export async function syncIfPassed(testInfo: TestInfo, scenarioSlug: string): Promise<void> {
  if (testInfo.status !== "passed") return;
  const dest = resolve(screenshotsRoot, scenarioSlug);
  await mkdir(dest, { recursive: true });
  let files: string[];
  try {
    files = await readdir(testInfo.outputDir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".png")) continue;
    await copyFile(resolve(testInfo.outputDir, f), resolve(dest, f));
  }
}
