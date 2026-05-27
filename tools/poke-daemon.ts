#!/usr/bin/env bun
// One-shot poke: connect to the daemon socket, send a register, see what happens.
import { connectDaemon } from "../packages/plugin/src/daemon-client.ts";
import { randomUUID } from "node:crypto";

const sock = process.argv[2] ?? "/tmp/cc-remote-demo/daemon.sock";
const client = await connectDaemon(sock, { timeoutMs: 3000 });
const sid = randomUUID();
console.log("connected, sending register", sid);
const ack = await Promise.race([
  client.send({
    type: "register",
    session: {
      session_id: sid,
      claude_session_id: null,
      tmux_session: null,
      tmux_pane: null,
      cwd: "/tmp/cc-remote-demo",
      model: null,
      pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      claude_client_version: "poke",
      plugin_version: "poke",
      state: "idle",
    },
  }),
  new Promise((_, rj) => setTimeout(() => rj(new Error("register ack timeout")), 5000)),
]);
console.log("got ack:", ack);
client.close();
