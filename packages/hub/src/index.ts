import { handle } from "./routes.ts";

const PORT = Number(process.env.HUB_PORT ?? 7745);

const server = Bun.serve({
  port: PORT,
  fetch: (req) => handle(req),
});

console.log(`hub listening on http://localhost:${server.port}`);
