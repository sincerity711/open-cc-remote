#!/usr/bin/env bun
// Capture PWA screenshots for visual review of the timeline redesign.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const PWA = "http://localhost:15173";
const HUB = "http://localhost:17745";
const OUT = "/tmp/pwa-shots";

// Acquire a bearer by walking the fake-IAS chain (same as tools/inspect-demo-frames.ts).
const r1 = await fetch(`${HUB}/auth/login`, { redirect: "manual" });
const authorize = r1.headers.get("location")!;
const r2 = await fetch(authorize, { redirect: "manual" });
const callback = r2.headers.get("location")!.replace("fake-ias:7770", "localhost:7770");
const r3 = await fetch(callback, { redirect: "manual" });
const finalLoc = r3.headers.get("location")!;
const bearer = new URL(finalLoc, "http://placeholder/").hash.match(/bearer=([^&]+)/)?.[1] ?? "";
if (!bearer) throw new Error("no bearer");

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
