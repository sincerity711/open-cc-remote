import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoApp } from "../src/demo/DemoApp";

/**
 * The demo was reshaped from a 6-step "guided rail" walkthrough into a
 * live, tap-driven app prototype. The old "Cards" guided step (a static
 * catalog of every timeline card) is no longer there because the demo
 * itself now drives those cards through real interactions. We instead
 * verify the demo renders its toolbar + an actual app shell.
 */
test("demo renders a real app shell, not a guided walkthrough", () => {
  const markup = renderToStaticMarkup(<DemoApp />);

  // Toolbar identity — the prototype label and live-interaction subtitle.
  expect(markup).toContain("cc-remote");
  expect(markup).toContain("Live interaction");

  // Device switcher exists (mobile/tablet/desktop).
  expect(markup).toContain("Mobile");
  expect(markup).toContain("Tablet");
  expect(markup).toContain("Desktop");

  // The shell carries the real app's surfaces — Home with Machines and a
  // session view ready to drive.
  expect(markup).toContain("Machines");
});
