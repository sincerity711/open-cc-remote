import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/App";

test("prototype guide includes a dedicated card system section", () => {
  const markup = renderToStaticMarkup(<App />);

  expect(markup).toContain("Cards");
  expect(markup).toContain("Card anatomy, variants, states, and density rules.");
});
