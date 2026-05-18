#!/usr/bin/env bun
// Admin helper. Until the PWA "Add daemon" UI lands (Plan 5),
// human administrators issue pairing codes from the CLI.

import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { issueCode } from "./repos/pairing-codes.ts";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "issue-pairing-code") {
  const issuer_sub = args[1];
  const daemon_id = args[2];
  if (!issuer_sub) {
    process.stderr.write(
      "usage: bun packages/hub/src/admin.ts issue-pairing-code <issuer_sub> [daemon_id]\n",
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  const db = openDb(cfg.db_path);
  try {
    const code = issueCode(
      db, "daemon", issuer_sub,
      daemon_id ? { daemon_id } : null,
      90_000,
    );
    process.stdout.write(`${code}\n`);
  } finally {
    db.close();
  }
} else {
  process.stderr.write("commands: issue-pairing-code\n");
  process.exit(1);
}
