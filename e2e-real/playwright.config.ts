import { defineConfig, devices } from "@playwright/test";

const VIEWPORT_PRESETS = {
  mobile:  { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } },
  tablet:  { ...devices["iPad Mini"], viewport: { width: 768, height: 1024 } },
  desktop: { viewport: { width: 1280, height: 800 } },
};

const requested = (process.env.RUN_VIEWPORTS ?? "desktop").split(",").map((v) => v.trim());
const projects = requested.map((vp) => ({
  name: vp,
  use: VIEWPORT_PRESETS[vp as keyof typeof VIEWPORT_PRESETS] ?? VIEWPORT_PRESETS.desktop,
}));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:4173", trace: "on", video: "on" },
  projects,
});
