import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import { fixtureSession } from "../../proto/src/test-fixtures.ts";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";
import { startSocketServer } from "../src/socket-server.ts";

function tmpSocket() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-sock-"));
  return { dir, path: join(dir, "test.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("plugin register frame triggers handler and ack reply", async () => {
  const t = tmpSocket();
  try {
    const received: PluginToDaemon[] = [];
    let serverSock: Socket | null = null;
    const server = startSocketServer({
      path: t.path,
      onFrame: (frame, sock) => { received.push(frame); serverSock = sock; },
    });
    await server.ready;

    const client = connect(t.path);
    const decoder = new FrameDecoder();
    const acks: DaemonToPlugin[] = [];
    client.on("data", (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) acks.push(f as DaemonToPlugin);
    });
    await new Promise<void>((res) => client.once("connect", () => res()));

    const reg: PluginToDaemon = {
      type: "register",
      session: fixtureSession({ session_id: "s1" }),
    };
    client.write(encodeFrame(reg));

    // Wait for the server to receive the frame so we can reply on its socket.
    const start = Date.now();
    while (!serverSock && Date.now() - start < 1000) {
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(serverSock).not.toBeNull();
    server.replyTo(serverSock!, { type: "ack", ref: "register" });

    await new Promise((res) => setTimeout(res, 50));
    client.end();
    server.close();

    expect(received).toEqual([reg]);
    expect(acks).toEqual([{ type: "ack", ref: "register" }]);
  } finally { t.cleanup(); }
});

test("hook ask_user_question_request frame round-trips through socket-server", async () => {
  const t = tmpSocket();
  try {
    const received: PluginToDaemon[] = [];
    let serverSock: Socket | null = null;
    const server = startSocketServer({
      path: t.path,
      onFrame: (frame, sock) => { received.push(frame); serverSock = sock; },
    });
    await server.ready;

    const client = connect(t.path);
    const decoder = new FrameDecoder();
    const replies: DaemonToPlugin[] = [];
    client.on("data", (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) replies.push(f as DaemonToPlugin);
    });
    await new Promise<void>((res) => client.once("connect", () => res()));

    const ask: PluginToDaemon = {
      type: "ask_user_question_request",
      claude_session_id: "claude-uuid",
      request_id: "ask-1",
      questions: [
        {
          question: "Where to put it?",
          header: "Location",
          multiSelect: false,
          options: [{ label: "docs/" }, { label: "src/" }],
        },
      ],
      expires_at: Date.now() + 5000,
    };
    client.write(encodeFrame(ask));

    const start = Date.now();
    while (!serverSock && Date.now() - start < 1000) {
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(serverSock).not.toBeNull();
    server.replyTo(serverSock!, {
      type: "ask_user_question_answer",
      request_id: "ask-1",
      answers: ["docs/"],
      resolution: "answered",
    });

    await new Promise((res) => setTimeout(res, 50));
    client.end();
    server.close();

    expect(received).toEqual([ask]);
    expect(replies).toEqual([
      {
        type: "ask_user_question_answer",
        request_id: "ask-1",
        answers: ["docs/"],
        resolution: "answered",
      },
    ]);
  } finally { t.cleanup(); }
});
