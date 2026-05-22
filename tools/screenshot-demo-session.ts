#!/usr/bin/env bun
// Capture the /demo Session step (step 3) timeline.
import { chromium } from "playwright";

const PWA = "http://localhost:15173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 460, height: 1400 } });
const page = await ctx.newPage();

await page.goto(`${PWA}/demo`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Click step 3 — match the step list specifically (it's in a list of 6 numbered buttons).
const stepButtons = await page.locator('button').filter({ hasText: /^\d+\s*$/ }).all();
console.log(`step-numbered buttons: ${stepButtons.length}`);

// Fallback: click any button whose text begins with "Session\n".
const sessionBtn = page.locator('button:has-text("Session"):has-text("Claude Code execution")');
console.log("session btn count:", await sessionBtn.count());
await sessionBtn.first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/pwa-shots/04-demo-session.png", fullPage: true });
console.log("04-demo-session.png");

// And step 4 (Cards) — shows all card variants.
const cardsBtn = page.locator('button:has-text("Cards"):has-text("Card anatomy")');
await cardsBtn.first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/pwa-shots/05-demo-cards.png", fullPage: true });
console.log("05-demo-cards.png");

await browser.close();
