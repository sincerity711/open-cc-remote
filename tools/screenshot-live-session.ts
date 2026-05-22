#!/usr/bin/env bun
// Open the live PWA, click into the demo-claude session, take a screenshot.
// Requires the hub to be running locally. Bearer is minted via the admin CLI:
//   bun packages/hub/src/admin.ts mint-bearer <owner_sub>
// Set HUB_OWNER_SUB to override the default owner subject used for minting.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PWA = "http://localhost:15173";
const REPO_ROOT = join(import.meta.dir, "..");
const OWNER_SUB = process.env.HUB_OWNER_SUB ?? "local-admin";

// Mint a bearer directly via the hub admin CLI (no IAS required).
const mintResult = spawnSync(
  "bun",
  ["packages/hub/src/admin.ts", "mint-bearer", OWNER_SUB, "screenshot-live-session"],
  { cwd: REPO_ROOT, encoding: "utf8" },
);
if (mintResult.status !== 0) throw new Error(`admin mint-bearer failed:\n${mintResult.stderr}`);
const bearer = mintResult.stdout.trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 460, height: 1400 } });
const page = await ctx.newPage();
await page.addInitScript((b) => localStorage.setItem("cc_remote_bearer", b), bearer);

// Hook console so we can see PWA-side logs.
page.on("console", (msg) => console.log(`[pwa:${msg.type()}]`, msg.text()));

await page.goto(`${PWA}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Find session row containing "cc-remote-demo" and click it.
const target = page.locator("button, a").filter({ hasText: /cc-remote-demo/ });
console.log("candidates:", await target.count());
await target.first().click();
await page.waitForTimeout(2500);

// Snapshot the timeline area and dump the rendered cards.
await page.screenshot({ path: "/tmp/pwa-shots/06-live-session.png", fullPage: true });
console.log("saved /tmp/pwa-shots/06-live-session.png");

// Dump the timeline cards' visible text so we can see what items exist.
const cards = await page.locator('[data-testid="timeline"] article').allTextContents();
console.log("timeline article count:", cards.length);
cards.forEach((t, i) => console.log(`[${i}]`, t.slice(0, 140).replace(/\s+/g, " ")));

await browser.close();
