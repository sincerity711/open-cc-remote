#!/usr/bin/env bun
// Capture PWA screenshots for visual review of the timeline redesign.
// Requires the hub to be running locally. Bearer is minted via the admin CLI:
//   bun packages/hub/src/admin.ts mint-bearer <owner_sub>
// Set HUB_OWNER_SUB to override the default owner subject used for minting.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PWA = "http://localhost:15173";
const HUB = "http://localhost:17745";
const OUT = "/tmp/pwa-shots";
const REPO_ROOT = join(import.meta.dir, "..");
const OWNER_SUB = process.env.HUB_OWNER_SUB ?? "local-admin";

// Mint a bearer directly via the hub admin CLI (no IAS required).
const mintResult = spawnSync(
  "bun",
  ["packages/hub/src/admin.ts", "mint-bearer", OWNER_SUB, "screenshot-pwa"],
  { cwd: REPO_ROOT, encoding: "utf8" },
);
if (mintResult.status !== 0) throw new Error(`admin mint-bearer failed:\n${mintResult.stderr}`);
const bearer = mintResult.stdout.trim();
if (!bearer) throw new Error("admin mint-bearer returned empty bearer");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();

// Pre-seed bearer in localStorage (same key the PWA reads).
await page.addInitScript((b) => {
  localStorage.setItem("cc_remote_bearer", b);
}, bearer);

await page.goto(`${PWA}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

await page.screenshot({ path: `${OUT}/01-home.png`, fullPage: true });
console.log("01-home.png");

// Click into the first session (test-spawn or demo-claude).
const sessions = await page.locator('[data-testid^="session-row"], button:has-text("session")').all();
console.log(`found ${sessions.length} session candidates`);

// Try to find a session and click it.
const links = await page.locator("button, a").filter({ hasText: /tmp|cc-remote|test-spawn/i }).all();
console.log(`found ${links.length} session-like links`);
if (links.length > 0) {
  await links[0].click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/02-session.png`, fullPage: true });
  console.log("02-session.png");
}

// Also visit /demo if it exists.
await page.goto(`${PWA}/demo`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/03-demo.png`, fullPage: true });
console.log("03-demo.png");

await browser.close();
console.log("done");
