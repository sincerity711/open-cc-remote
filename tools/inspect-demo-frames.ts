#!/usr/bin/env bun
// Inspect what frames the demo hub broadcasts to a PWA.
// Run while interacting in tmux: `bun tools/inspect-demo-frames.ts`

const HUB = "http://localhost:17745";

async function main() {
  // 1. Walk the IAS chain to get a bearer.
  const r1 = await fetch(`${HUB}/auth/login`, { redirect: "manual" });
  const authorize = r1.headers.get("location")!;
  const r2 = await fetch(authorize, { redirect: "manual" });
  const callback = r2.headers.get("location")!.replace("fake-ias:7770", "localhost:7770");
  const r3 = await fetch(callback, { redirect: "manual" });
  const finalLoc = r3.headers.get("location")!;
  const bearer = new URL(finalLoc, "http://placeholder/").hash.match(/bearer=([^&]+)/)?.[1] ?? "";
  if (!bearer) throw new Error(`no bearer in ${finalLoc}`);

  // 2. Open the WS.
  const ws = new WebSocket(`ws://localhost:17745/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe" }));
  ws.onmessage = (ev) => {
    try {
      const f = JSON.parse(ev.data as string);
      if (f.type === "event") {
        const p = f.payload ?? {};
        const blocks = Array.isArray(p?.message?.content)
          ? p.message.content.map((b: { type?: string }) => b?.type ?? "?").join(",")
          : "—";
        console.log(`event jsonl_offset=${f.jsonl_offset} payload.type=${p.type} blocks=[${blocks}]`);
      } else {
        console.log(`${f.type}`);
      }
    } catch {}
  };
  ws.onerror = (e) => console.error("ws error", e);

  // Stay alive 60s.
  await new Promise((r) => setTimeout(r, 60_000));
  ws.close();
}

main().catch(console.error);
