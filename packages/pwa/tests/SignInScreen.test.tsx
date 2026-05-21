import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInScreen } from "../src/screens/SignInScreen";

test("SignInScreen renders brand, CTA href, and optional notice", () => {
  const markup = renderToStaticMarkup(
    <SignInScreen loginHref="https://hub.example/auth/login" notice="Session expired" />,
  );
  expect(markup).toContain("cc-remote");
  expect(markup).toContain('href="https://hub.example/auth/login"');
  expect(markup).toContain("Session expired");
  expect(markup).toContain('data-testid="sign-in-screen"');
});

test("SignInScreen omits notice block when absent", () => {
  const markup = renderToStaticMarkup(
    <SignInScreen loginHref="https://hub.example/auth/login" />,
  );
  expect(markup).not.toContain('role="status"');
});
