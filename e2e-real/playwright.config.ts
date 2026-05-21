import { defineConfig, devices } from "@playwright/test";

const VIEWPORT_PRESETS = {
  // Mobile/tablet override defaultBrowserType from the iPhone/iPad device
  // presets (which default to WebKit). Using chromium across all viewports
  // keeps the browser install single-channel and avoids `pw_run.sh` not
  // installed for webkit. Trade-off: we test responsive layout, not real
  // mobile-Safari rendering.
  mobile:  { ...devices["iPhone 14"], defaultBrowserType: "chromium" as const, viewport: { width: 390, height: 844 } },
  tablet:  { ...devices["iPad Mini"], defaultBrowserType: "chromium" as const, viewport: { width: 768, height: 1024 } },
  desktop: { viewport: { width: 1280, height: 800 } },
};

const requested = (process.env.RUN_VIEWPORTS ?? "desktop").split(",").map((v) => v.trim());
const projects = requested.map((vp) => ({
  name: vp,
  use: VIEWPORT_PRESETS[vp as keyof typeof VIEWPORT_PRESETS] ?? VIEWPORT_PRESETS.desktop,
}));

export default defineConfig({
  testDir: "./tests",
  // Files using `bun:test` can't be loaded by Playwright (ESM loader rejects
  // the `bun:` scheme). Run those separately via `bun test`.
  // - 10-perm-p95.test.ts      — protocol-only WS perf measurement
  // - tests/_helpers/*.test.ts — helper-internal unit tests
  testIgnore: [/10-perm-p95\.test\.ts$/, /\/_helpers\//],
  fullyParallel: false,
  workers: 1,
  // Real-e2e depends on docker compose + tmux + claude + vite preview — any
  // of those can stutter on a fresh boot. One retry locally absorbs the
  // first-test docker race; CI gets two for safety.
  retries: process.env.CI ? 2 : 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:4173", trace: "on", video: "on" },
  projects,
});
