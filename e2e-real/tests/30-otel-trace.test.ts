// Scenario 30 — OTel cross-process trace validation.
//
// Goal: a single chat round-trip produces a single trace tree spanning
// PWA → hub → daemon → plugin (and back via the JSONL → daemon → hub →
// PWA event path). The test validates the trace through TWO surfaces:
//
//   1. Jaeger Query API (programmatic) — assert services + operation
//      names + parent linkages.
//   2. Jaeger UI (rendered page) — assert the user-visible UI displays
//      our trace, with a screenshot saved to the test artifacts.
//
// Infrastructure: Jaeger all-in-one runs in a separate compose
// (e2e-real/docker-compose.otel.yml) and the existing hub container is
// brought up with docker-compose.otel-hub.yml so its OTLP exporter
// reaches the host-published Jaeger collector via host.docker.internal.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import {
  upJaeger,
  downJaeger,
  waitForTrace,
  getTraceById,
  spanNamesByService,
  JAEGER_UI,
} from "../helpers/jaeger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaudeBin = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");

const OTEL_HUB_OVERRIDE = resolve(__dirname, "..", "docker-compose.otel-hub.yml");

let preview: PreviewHandle;

test.beforeAll(async () => {
  preflightOrThrow();
  // 1. Jaeger first so the hub container's OTLP exporter has a target
  //    when it's spawned in the next step. Jaeger publishes :4318 on the
  //    host, which the hub reaches via host.docker.internal (added by
  //    docker-compose.otel-hub.yml's extra_hosts entry).
  await upJaeger();
  // 2. App stack with the otel-hub override → hub now has
  //    OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318.
  await upCompose({ extraFiles: [OTEL_HUB_OVERRIDE] });
  // 3. PWA dev preview — VITE_OTEL_ENABLED is read at build time, so it
  //    must be set in process.env BEFORE startPreview() runs the build.
  process.env.VITE_OTEL_ENABLED = "1";
  process.env.VITE_OTEL_COLLECTOR_URL = "http://localhost:4318";
  preview = await startPreview();
});

test.afterAll(async () => {
  await preview?.stop();
  await downCompose({ extraFiles: [OTEL_HUB_OVERRIDE] });
  await downJaeger();
});

test("otel: chat round-trip emits one trace visible via API and Jaeger UI", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const daemon_id = `otel-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-otel-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-otel";
  const sessionId = "mock-otel-session";

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: {
      CLAUDE_PROJECTS_DIR: projectsRoot,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_SERVICE_NAME: "daemon",
    },
  });

  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "30-otel-trace",
    projectName: testInfo.project.name,
  });

  let fakeClaude: ChildProcess | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
        "--auto-reply", "trace-pong",
        "--jsonl-mirror", "true",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CLAUDE_PROJECTS_DIR: projectsRoot,
          // Plugin runs as a child of fake-claude (since fake-claude
          // emulates Claude Code's plugin host); inherit OTel env so its
          // initOtel() picks up the collector URL.
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
          OTEL_SERVICE_NAME: "plugin",
        },
      },
    );

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 30_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    const TOKEN = `OTEL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    await sc.step("chat-sent", async () => {
      await session.page.getByTestId("chat-input").fill(TOKEN);
      await session.page.getByTestId("chat-input").press("Enter");
      await expect(session.page.getByTestId("timeline")).toContainText(TOKEN, { timeout: 10_000 });
    });

    await sc.step("claude-response-rendered", async () => {
      await expect(session.page.getByTestId("timeline")).toContainText("trace-pong", { timeout: 30_000 });
    });

    // Give the OTel batch processors a tick to flush. PWA + daemon both
    // run with scheduledDelayMillis=200 so 1-2s is plenty.
    await new Promise((r) => setTimeout(r, 2_500));

    let trace: Awaited<ReturnType<typeof getTraceById>>;
    await sc.step("api-validation", async () => {
      // Locate the trace by its PWA root span.
      const found = await waitForTrace({
        service: "pwa",
        operation: "pwa.user.sendChat",
        timeoutMs: 60_000,
      });
      // Re-fetch by id to ensure we have the full multi-service trace.
      trace = await getTraceById(found.traceID);

      const byService = spanNamesByService(trace);
      console.log(`[30-otel] trace ${trace.traceID} spans by service:`, JSON.stringify(byService));

      // Required services + their required operations.
      expect(byService["pwa"] ?? []).toContain("pwa.user.sendChat");
      expect(byService["hub"] ?? []).toContain("hub.routeFrame");
      expect(byService["daemon"] ?? []).toContain("daemon.handleChat");
      expect(byService["daemon"] ?? []).toContain("daemon.jsonlEvent");

      // All spans share one trace id.
      for (const span of trace.spans) {
        expect(span.traceID).toBe(trace.traceID);
      }

      // At least one span has a child relationship — i.e. the tree is
      // not a flat collection of orphans.
      const withParent = trace.spans.filter(
        (s) => s.references && s.references.some((r) => r.refType === "CHILD_OF"),
      );
      expect(withParent.length).toBeGreaterThan(0);

      // Specifically: hub.routeFrame's parent should be the pwa span.
      const pwaSpan = trace.spans.find((s) => s.operationName === "pwa.user.sendChat");
      const hubSpan = trace.spans.find((s) => s.operationName === "hub.routeFrame");
      expect(pwaSpan).toBeDefined();
      expect(hubSpan).toBeDefined();
      const hubParent = hubSpan!.references.find((r) => r.refType === "CHILD_OF");
      expect(hubParent?.spanID).toBe(pwaSpan!.spanID);
    });

    await sc.step("ui-validation", async () => {
      // 1. Jaeger search page — service=pwa should list our trace.
      await session.page.goto(`${JAEGER_UI}/search?service=pwa&limit=20&lookback=10m`);
      // The trace id appears as a link on each result row.
      await session.page.waitForSelector(`a[href*='${trace.traceID}']`, { timeout: 30_000 });
      await session.page.screenshot({
        path: join(testInfo.outputDir, "jaeger-search.png"),
        fullPage: true,
      });

      // 2. Click into the trace — the waterfall view must render with
      //    spans from our four expected services.
      await session.page.goto(`${JAEGER_UI}/trace/${trace.traceID}`);
      // The Trace Page header element is stable in current Jaeger UI.
      await session.page.waitForSelector(".TracePageHeader, [data-test-id='trace-page']", {
        timeout: 30_000,
      });
      // Service names appear on each span row.
      const bodyText = await session.page.locator("body").innerText();
      expect(bodyText).toContain("pwa");
      expect(bodyText).toContain("hub");
      expect(bodyText).toContain("daemon");
      await session.page.screenshot({
        path: join(testInfo.outputDir, "jaeger-trace-waterfall.png"),
        fullPage: true,
      });
    });
  } finally {
    if (fakeClaude && fakeClaude.exitCode === null) {
      try { fakeClaude.kill("SIGTERM"); } catch { /* noop */ }
    }
    try { await session.context.close(); } catch { /* noop */ }
    try { await handle.stop(); } catch { /* noop */ }
  }
});
