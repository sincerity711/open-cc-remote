import { test, expect } from "bun:test";
import { handle } from "../src/routes.ts";

test("GET /healthz returns 200 ok", async () => {
  const res = await handle(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("unknown path returns 404", async () => {
  const res = await handle(new Request("http://localhost/nope"));
  expect(res.status).toBe(404);
});
