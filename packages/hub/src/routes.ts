export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz" && req.method === "GET") {
    return new Response("ok", { status: 200 });
  }
  return new Response("not found", { status: 404 });
}
