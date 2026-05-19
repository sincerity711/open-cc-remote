# @cc-remote/plugin

Channel plugin for Claude Code 2.1.143+. Loaded via `--plugin-dir`:

```bash
claude --plugin-dir packages/plugin -p "your prompt"
```

Required runtime: a running cc-remote daemon at `~/.cc-remote/daemon.sock` (or `$CC_REMOTE_SOCKET`).

## Architecture

This plugin is an MCP stdio server. It speaks two protocols simultaneously:

1. **MCP stdio (to Claude Code):** `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }`. Inbound `notifications/claude/channel/permission_request`; outbound `notifications/claude/channel/permission` and `notifications/claude/channel`. Exposes one tool: `reply`.

2. **Unix socket (to daemon):** Existing `register` / `bye` / `permission_request` / `permission_reply` frames, plus new `chat_in` / `chat_out` frames.

## Validation

```bash
claude plugin validate packages/plugin
```

Should pass with at most an "author" warning.
