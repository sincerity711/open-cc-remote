import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  bearer: string;
  close: () => Promise<void>;
}

/**
 * Launches chromium, signs in via /auth/login → fake-IAS → /auth/callback,
 * waits for the AppShell to render (post-bearer state). Returns the bearer
 * pulled from localStorage so scenarios can also drive WS asserts if needed.
 *
 * The fake-IAS issuer URL (`http://fake-ias:7770`) is host-unresolvable. The
 * browser hits the hub container at localhost:7745, which proxies the
 * authorize request internally — the same trick `pwa-client.ts` uses.
 */
export async function openPwa(opts: {
  baseURL: string;          // e.g. http://localhost:4173
  hub_http: string;         // e.g. http://localhost:7745
  artifactsDir: string;     // for video/trace
}): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: opts.baseURL,
    recordVideo: { dir: opts.artifactsDir },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  // Inject HUB_URL via VITE_HUB_URL — vite preview reads from build-time env, so
  // ensure the build was made with VITE_HUB_URL=ws://localhost:7745. (Task 2
  // step 3 should set this in the build call.)

  // Click sign-in.
  await page.goto("/");
  await page.getByTestId("sign-in-screen").waitFor({ timeout: 10_000 });
  await page.getByRole("link", { name: "Sign in" }).click();

  // The login chain is server-side 302s; once it completes, the PWA's
  // consumeFragment writes the bearer to localStorage and re-renders.
  await page.getByTestId("home-screen").waitFor({ timeout: 30_000 });

  const bearer = await page.evaluate(() => localStorage.getItem("cc_remote_bearer")) ?? "";

  return {
    browser,
    context,
    page,
    bearer,
    async close() {
      await context.tracing.stop({ path: `${opts.artifactsDir}/trace.zip` });
      await context.close();
      await browser.close();
    },
  };
}
