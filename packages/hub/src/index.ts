import { makeServer } from "./routes.ts";

const PORT = Number(process.env.HUB_PORT ?? 7745);
const { fetch, websocket } = makeServer();

const server = Bun.serve({ port: PORT, fetch, websocket });
console.log(`hub listening on http://localhost:${server.port}`);
