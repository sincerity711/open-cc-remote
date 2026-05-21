import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoApp } from "../src/demo/DemoApp";

test("prototype guide includes a dedicated card system section", () => {
  const markup = renderToStaticMarkup(<DemoApp />);

  expect(markup).toContain("Cards");
  expect(markup).toContain("Card anatomy, variants, states, and density rules.");
});
