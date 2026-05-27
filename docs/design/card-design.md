可以，下面是一版可以直接放进产品设计文档里的 **Session Timeline UI Design** 章节。它把 Claude Code JSONL、Hooks、PWA protocol events 统一成一套面向用户的时间线 UI，而不是把原始事件名硬铺出来。

---

# Session Timeline UI Design

## 1. Design Goal

Session 页面不是日志查看器，而是一个 **AI coding workflow timeline**。

用户打开 session 时，应该快速理解：

```text
Claude 现在在做什么？
刚刚做了什么？
有没有失败？
有没有需要我批准的权限？
我可以继续发消息吗？
```

因此 timeline 的设计目标是：

1. **聊天感优先**
   用户 prompt 和 assistant text 保持 chat app 的阅读节奏。

2. **工具调用结构化**
   `tool_use` / `tool_result` 不作为普通消息渲染，而是 compact technical cards。

3. **权限请求最高优先级**
   `permission_request` 不应该埋在 transcript 中，而是进入 decision layer。

4. **系统事件低噪声**
   `SessionStart`、`CwdChanged`、`ConfigChange`、`PreCompact` 等事件默认轻量化。

5. **不丢事件**
   unknown event 必须有 fallback raw JSON card，方便兼容 Claude Code 新事件。

---

# 2. Timeline Mental Model

Timeline 分为 5 个视觉层级。

```text
Decision layer
  Permission request / expired / resolved

Chat layer
  User prompt / PWA chat / assistant text

Work layer
  Tool use / tool result / batch / subagent / task

System layer
  Session start / cwd change / config / compact / idle

Error layer
  Tool failure / stop failure / chat error / daemon lost
```

优先级：

```text
Permission > Error > Active work > Chat > System metadata
```

---

# 3. Mobile Session Timeline Layout

Mobile 上 timeline 是 session pane 的主体。

```text
┌──────────────────────────────────────┐
│ ‹ feat_auth          ● Online     ⋯  │
│ work-laptop · claude-3.5-sonnet      │
│ /Users/me/project                    │
│──────────────────────────────────────│
│                                      │
│  Today                               │
│                                      │
│      ┌────────────────────────────┐  │
│      │ You                        │  │
│      │ Fix the failing auth tests │  │
│      └────────────────────────────┘  │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Claude                    10:24  │ │
│ │ I’ll inspect the auth module and │ │
│ │ run the relevant tests.          │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ $ Bash                    10:25  │ │
│ │ pnpm test auth            12s    │ │
│ │ cwd: /Users/me/project          │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ tool_result               ✓ 12s  │ │
│ │ 2 failed, 48 passed              │ │
│ │ [View output]                   │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Claude                    10:26  │ │
│ │ Found the issue. I’m updating    │ │
│ │ the mock setup.                  │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ✎ Edit                    10:27  │ │
│ │ src/auth/login.test.ts           │ │
│ │ +32 lines · -8 lines             │ │
│ │ [View diff]                     │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ── Turn completed · 3 tools · 42s ── │
│                                      │
│──────────────────────────────────────│
│ ┌──────────────────────────────┐  ↗ │
│ │ Message Claude…              │    │
│ └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

## Mobile rules

* Timeline 单列滚动。
* Header sticky。
* Composer sticky bottom。
* `user` bubble 右对齐。
* `assistant` bubble 左对齐。
* Tool cards 左对齐，但宽度接近 full width。
* System notices 居中或 inline。
* Long tool output 默认折叠。
* Permission pending 时 composer 进入 blocked state。

---

# 4. Desktop Timeline Layout

Desktop 上 timeline 应该和 session list / permission panel 并存。

```text
┌──────────────┬────────────────────┬────────────────────────────┬──────────────────┐
│ App Nav      │ Sessions           │ Timeline                   │ Permission       │
│              │                    │                            │ Panel            │
│ Daemons      │ work-laptop        │ feat_auth · Online         │ Permission       │
│ Sessions     │ ┌──────────────┐   │ /Users/me/project          │ Required         │
│ Settings     │ │ feat_auth ⚠  │   │────────────────────────────│                  │
│              │ └──────────────┘   │ user / assistant / tools   │ Bash             │
│              │ ┌──────────────┐   │                            │ rm -rf ...       │
│              │ │ test_api ●   │   │ composer                   │                  │
│              │ └──────────────┘   │                            │ [Deny] [Allow]   │
└──────────────┴────────────────────┴────────────────────────────┴──────────────────┘
```

Desktop rules:

* Transcript 内容最大宽度 `720–840px`。
* Tool cards 可以比 chat bubble 更宽。
* Permission pending 时优先显示右侧 panel，不遮挡 timeline。
* Unknown/debug cards 可以展开更多 metadata。
* Desktop 可显示更多 event metadata，例如 event timestamp、duration、tool id。

---

# 5. Event Normalization Model

不要直接按原始事件渲染。先转换成统一的 `TimelineItem`。

```text
Raw source events
  Claude JSONL
  Claude Hooks
  PWA protocol frames
        ↓
Normalize
        ↓
TimelineItem
        ↓
Renderer component
```

## 5.1 TimelineItem categories

```text
chat.user
chat.assistant
chat.reasoning

tool.use
tool.result
tool.failure
tool.batch

permission.request
permission.resolved
permission.expired

task.created
task.completed

subagent.start
subagent.stop
subagent.group

system.notice
system.boundary
system.metadata

error.session
error.chat

debug.raw
```

## 5.2 Normalized item shape

Conceptually:

```text
TimelineItem
  id
  category
  source
  timestamp
  sessionId
  daemonId
  title
  summary
  body
  metadata
  severity
  status
  expandable
  defaultExpanded
  actions
```

Important fields:

| Field             | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `category`        | Selects renderer                               |
| `severity`        | neutral / info / warning / danger              |
| `status`          | pending / running / success / failed / expired |
| `expandable`      | Whether item can expand                        |
| `defaultExpanded` | Initial rendering state                        |
| `actions`         | Copy, view output, approve, retry, etc.        |

---

# 6. Event Rendering Map

| Input event                   | Timeline item         | UI renderer            | Default    |
| ----------------------------- | --------------------- | ---------------------- | ---------- |
| `user` prompt                 | `chat.user`           | User bubble            | Expanded   |
| PWA `chat` from user          | `chat.user`           | User bubble            | Expanded   |
| `assistant` text              | `chat.assistant`      | Assistant bubble       | Expanded   |
| `thinking` block              | `chat.reasoning`      | Reasoning accordion    | Collapsed  |
| `tool_use` Bash               | `tool.use`            | Bash tool card         | Expanded   |
| `tool_use` Edit / Write       | `tool.use`            | File operation card    | Expanded   |
| `tool_use` Read / Grep / Glob | `tool.use`            | Search/read card       | Collapsed  |
| `tool_result` short success   | `tool.result`         | Result card            | Expanded   |
| `tool_result` long success    | `tool.result`         | Result card            | Collapsed  |
| `PostToolUseFailure`          | `tool.failure`        | Error result card      | Expanded   |
| `PostToolBatch`               | `tool.batch`          | Batch summary row      | Collapsed  |
| `PermissionRequest`           | `permission.request`  | Permission sheet/panel | Expanded   |
| PWA `permission_request`      | `permission.request`  | Permission sheet/panel | Expanded   |
| `permission_resolved`         | `permission.resolved` | Inline system notice   | Expanded   |
| expired permission            | `permission.expired`  | Expired notice/card    | Expanded   |
| `TaskCreated`                 | `task.created`        | Task chip row          | Expanded   |
| `TaskCompleted`               | `task.completed`      | Completion marker      | Expanded   |
| PWA `task_completed`          | `task.completed`      | Completion marker      | Expanded   |
| `SubagentStart`               | `subagent.start`      | Subagent group header  | Expanded   |
| `SubagentStop`                | `subagent.stop`       | Subagent summary       | Expanded   |
| `SessionStart`                | `system.boundary`     | Timeline boundary      | Expanded   |
| `Stop`                        | `system.boundary`     | Quiet end marker       | Collapsed  |
| `StopFailure`                 | `error.session`       | Session error card     | Expanded   |
| `idle`                        | `system.notice`       | Idle notice            | Expanded   |
| `TeammateIdle`                | `system.notice`       | Idle notice            | Expanded   |
| `Notification`                | `system.notice`       | Notification notice    | Contextual |
| `PreCompact` / `PostCompact`  | `system.metadata`     | Compact boundary       | Collapsed  |
| `ConfigChange`                | `system.metadata`     | Metadata pill          | Collapsed  |
| `CwdChanged`                  | `system.metadata`     | Metadata pill          | Collapsed  |
| `FileChanged`                 | `system.metadata`     | File metadata pill     | Collapsed  |
| `InstructionsLoaded`          | `system.metadata`     | Metadata pill          | Collapsed  |
| unknown event                 | `debug.raw`           | Raw JSON card          | Collapsed  |

---

# 6.1 Prototype Card Section

The prototype should include a standalone **Cards** section, separate from
Home, Session, Permission, and Settings.

Purpose:

* Explain card grammar directly, instead of forcing users to infer it from the
  session transcript.
* Show how the same card structure adapts across chat, tool, permission,
  system, and error events.
* Make mobile density and desktop density comparable in one place.

The section should cover four topics:

```text
Card anatomy
  identity / primary content / metadata / actions

Card variants
  chat / tool / permission / failure

Card states
  running / succeeded / needs approval / failed

Card density
  mobile full-width / desktop tool width / desktop chat width
```

Rules:

* This section is a design reference board, not a product settings screen.
* It should use realistic examples from the session timeline.
* It should not introduce a second card language; examples must reuse the same
  tokens, radius, borders, status chips, and action buttons as the working
  prototype.
* On mobile, the section scrolls as one column.
* On desktop, the section can use a two-column reference layout.

---

# 7. Timeline Components

## 7.1 User Bubble

Used for:

```text
user prompt
PWA chat from user
manual follow-up
```

Wireframe:

```text
          ┌──────────────────────────┐
          │ You                 10:24│
          │ Fix the failing tests    │
          └──────────────────────────┘
```

Visual:

* Right aligned.
* Primary subtle background.
* No heavy metadata.
* Supports failed send state.

States:

```text
sending
sent
failed
```

Failed state:

```text
          ┌──────────────────────────┐
          │ You                 failed│
          │ Fix the failing tests    │
          │ [Retry]                  │
          └──────────────────────────┘
```

---

## 7.2 Assistant Bubble

Used for:

```text
assistant.message.content text
```

Wireframe:

```text
┌──────────────────────────────────┐
│ Claude                    10:26  │
│ Found the issue. I’m updating    │
│ the test mock setup.             │
└──────────────────────────────────┘
```

Visual:

* Left aligned.
* Surface card.
* Assistant avatar or small Claude mark optional.
* Metadata hidden behind details if not needed.

Rules:

* Multiple assistant text blocks close together may be merged.
* Assistant text should not show raw JSON metadata by default.
* If assistant text is empty but tool calls exist, skip bubble and show tool cards directly.

---

## 7.3 Reasoning Accordion

Used for:

```text
thinking block
```

Default collapsed.

```text
┌──────────────────────────────────┐
│ ▸ Reasoning · 1.2k tokens · 8s   │
└──────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────┐
│ ▾ Reasoning · 1.2k tokens · 8s   │
│ Claude analyzed failing auth     │
│ tests and compared mock setup…   │
└──────────────────────────────────┘
```

Rules:

* Never dominate the timeline.
* Do not auto-expand on mobile.
* If thinking is not available or not displayable, omit it.

---

## 7.4 Bash Tool Card

Used for:

```text
tool_use Bash
```

Wireframe:

```text
┌──────────────────────────────────┐
│ $ Bash                    10:25  │
│ pnpm test auth                  │
│ cwd: /Users/me/project          │
│ status: running                 │
└──────────────────────────────────┘
```

Completed:

```text
┌──────────────────────────────────┐
│ $ Bash                    ✓ 12s  │
│ pnpm test auth                  │
│ cwd: /Users/me/project          │
│ [Copy] [View result]            │
└──────────────────────────────────┘
```

Dangerous command:

```text
┌──────────────────────────────────┐
│ ⚠ Bash                    pending│
│ rm -rf node_modules             │
│ cwd: /Users/me/project          │
│                                  │
│ Risk: deletes files recursively  │
│ [Review permission]             │
└──────────────────────────────────┘
```

Risk heuristics:

```text
rm -rf
sudo
chmod -R
chown -R
curl | sh
wget | sh
git reset --hard
docker system prune
```

Visual treatment:

* Bash command uses monospace.
* CWD uses muted mono.
* Risk line uses warning color.
* Failed Bash uses error card style.

---

## 7.5 File Operation Card

Used for:

```text
Edit
Write
MultiEdit
NotebookEdit
```

Wireframe:

```text
┌──────────────────────────────────┐
│ ✎ Edit                    10:27  │
│ src/auth/login.test.ts           │
│ +32 lines · -8 lines             │
│ [View diff]                      │
└──────────────────────────────────┘
```

For Write:

```text
┌──────────────────────────────────┐
│ ＋ Write                   10:28  │
│ src/auth/session.ts              │
│ created · 84 lines               │
│ [View file]                      │
└──────────────────────────────────┘
```

Rules:

* Edit/Write default expanded.
* Show file path prominently.
* Show line delta if available.
* Do not show full diff inline by default on mobile.
* Desktop can show inline diff preview up to a small threshold.

---

## 7.6 Read / Search Tool Card

Used for:

```text
Read
Grep
Glob
LS
```

Default collapsed.

```text
┌──────────────────────────────────┐
│ ▸ Read                    10:25  │
│ src/auth/login.ts               │
│ 128 lines                       │
└──────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────┐
│ ▾ Grep                    10:25  │
│ pattern: "login"                │
│ path: src/auth                  │
│ 6 matches in 3 files            │
└──────────────────────────────────┘
```

Rules:

* Read/Grep/Glob can be numerous, so keep quiet.
* Default collapsed unless result is important or failed.
* Show summary first, raw output behind expansion.

---

## 7.7 Tool Result Card

Short success:

```text
┌──────────────────────────────────┐
│ tool_result               ✓ 12s  │
│ 2 failed, 48 passed              │
└──────────────────────────────────┘
```

Long output collapsed:

```text
┌──────────────────────────────────┐
│ tool_result               ✓ 12s  │
│ 240 lines output                 │
│ [View output]                    │
└──────────────────────────────────┘
```

Expanded output:

```text
┌──────────────────────────────────┐
│ tool_result               ✓ 12s  │
│──────────────────────────────────│
│ FAIL src/auth/login.test.ts      │
│ Expected 200, received 401       │
│ ...                              │
│ [Collapse] [Copy output]         │
└──────────────────────────────────┘
```

Collapse threshold:

```text
> 8 lines
or
> 480px rendered height
or
> 4KB text
```

---

## 7.8 Tool Failure Card

Used for:

```text
failed tool_result
PostToolUseFailure
```

```text
┌──────────────────────────────────┐
│ ! Bash failed              10:25 │
│ pnpm test auth                  │
│                                  │
│ Exit code: 1                    │
│ 2 tests failed                  │
│                                  │
│ [View output] [Copy]            │
└──────────────────────────────────┘
```

Rules:

* Error color only used for actual failure.
* Show exit code if available.
* If failure blocks the session, add recovery hint.
* Do not visually equate test failure with app/system failure; use softer error unless session itself broke.

---

## 7.9 Permission Request Card / Sheet

Permission is not a normal timeline item. It has two renderings:

1. Inline placeholder inside timeline.
2. Focused decision UI as sheet / panel.

Inline placeholder:

```text
┌──────────────────────────────────┐
│ ⚠ Permission required            │
│ Bash · rm -rf node_modules       │
│ Claude is waiting for approval.  │
│ [Review permission]              │
└──────────────────────────────────┘
```

Mobile focused sheet:

```text
┌──────────────────────────────────────┐
│ Permission required              1/2 │
│ work-laptop · feat_auth              │
│                                      │
│ Tool                                 │
│ Bash                                 │
│                                      │
│ Command                              │
│ ┌──────────────────────────────────┐ │
│ │ rm -rf node_modules              │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Working directory                    │
│ /Users/me/project                    │
│                                      │
│ ⚠ This will permanently delete files │
│ and cannot be undone.                │
│                                      │
│ [Deny]              [Allow once]     │
│        Allow always…                 │
└──────────────────────────────────────┘
```

Desktop focused panel:

```text
┌──────────────────────────────┐
│ Permission required      1/2 │
│ work-laptop · feat_auth      │
│                              │
│ Bash                         │
│ rm -rf node_modules          │
│ /Users/me/project            │
│                              │
│ ⚠ Deletes files recursively  │
│                              │
│ [Deny]                       │
│ [Allow once]                 │
│ [Allow always…]              │
│                              │
│ [View details]               │
└──────────────────────────────┘
```

Rules:

* `Allow once` is primary.
* `Deny` is secondary.
* `Allow always` is tertiary and requires confirmation.
* Dangerous commands should visually de-emphasize `Allow always`.
* Composer is blocked while permission is pending.
* Tapping notification deep-links directly to this review UI.

---

## 7.10 Permission Resolved Notice

Allowed:

```text
── Permission allowed once · Bash · 10:26 ──
```

Denied:

```text
── Permission denied · Bash · 10:26 ──
```

Expired:

```text
── Permission expired · no action taken ──
```

Rules:

* Keep compact.
* Do not use a large card unless resolution failed.
* If denied, show enough context for transcript continuity.

---

## 7.11 Batch Summary Row

Used for:

```text
PostToolBatch
```

Collapsed:

```text
┌──────────────────────────────────┐
│ ▸ Tool batch completed           │
│ 3 tools · 1 failed · 12s         │
└──────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────┐
│ ▾ Tool batch completed           │
│ ✓ Read src/auth/login.ts         │
│ ✓ Grep "session"                 │
│ ! Bash pnpm test auth            │
└──────────────────────────────────┘
```

Rules:

* Default collapsed.
* Expand if any child failed.
* Child events remain accessible but not noisy.

---

## 7.12 Subagent Group

Used for:

```text
SubagentStart
SubagentStop
subagent transcript
```

Collapsed group:

```text
┌──────────────────────────────────┐
│ ▸ Subagent: review auth flow     │
│ 6 events · 2 tools · 18s         │
└──────────────────────────────────┘
```

Expanded group:

```text
┌──────────────────────────────────┐
│ ▾ Subagent: review auth flow     │
│──────────────────────────────────│
│ Claude: Checking login flow…     │
│ Read src/auth/login.ts           │
│ Grep "session"                   │
│ Result: issue found in mock      │
└──────────────────────────────────┘
```

Rules:

* Subagent events should not be dumped into the main stream ungrouped.
* Show summary in main timeline.
* Expand on demand.
* If subagent fails, group card gets warning/error state.

---

## 7.13 Task Created / Completed

Task created:

```text
── Task created · update auth tests ──
```

Task completed:

```text
── Turn completed · 3 tools · 42s ──
```

Richer completion:

```text
┌──────────────────────────────────┐
│ ✓ Task completed                 │
│ Updated auth tests and fixed     │
│ login mock setup.                │
│ 3 tools · 42s                    │
└──────────────────────────────────┘
```

Rules:

* Use marker for common completion.
* Use card if completion includes useful summary.
* Completed-task count in Home should update from this event.

---

## 7.14 System Metadata Pills

Used for:

```text
CwdChanged
ConfigChange
FileChanged
InstructionsLoaded
PreCompact
PostCompact
WorktreeCreate
WorktreeRemove
```

Inline format:

```text
── cwd changed to /Users/me/project ──
```

Compact pill format:

```text
[Config changed] [View]
```

Compaction:

```text
┌──────────────────────────────────┐
│ ▸ Context compacted              │
│ Previous transcript summarized   │
│ to preserve context window.      │
└──────────────────────────────────┘
```

Rules:

* Default collapsed.
* Never interrupt user reading flow.
* Worktree events can be larger cards because they affect workspace context.

---

## 7.15 Unknown / Raw Event Card

Fallback renderer:

```text
┌──────────────────────────────────┐
│ ▸ Unknown event                  │
│ type: NewFutureClaudeEvent       │
│ source: hook                     │
│ [View raw JSON]                  │
└──────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────┐
│ ▾ Unknown event                  │
│ {                                │
│   "type": "...",                 │
│   "payload": { ... }             │
│ }                                │
│ [Copy JSON]                      │
└──────────────────────────────────┘
```

Rules:

* Never drop unknown events.
* Default collapsed.
* Useful for debugging protocol drift.

---

# 8. Timeline Grouping Rules

## 8.1 Merge assistant text blocks

If multiple assistant text chunks arrive close together, render as one assistant bubble.

```text
assistant text chunk
assistant text chunk
assistant text chunk
→ one assistant bubble
```

## 8.2 Pair tool_use with tool_result

Prefer visual pairing:

```text
tool_use Bash
  ↳ tool_result
```

Rendered as adjacent cards:

```text
┌ Bash ───────────────┐
└─────────────────────┘
┌ result ─────────────┐
└─────────────────────┘
```

Do not interleave unrelated events between paired tool events unless timestamps force it.

## 8.3 Collapse noisy read/search events

Read/Grep/Glob can flood the timeline.

Default behavior:

```text
1–2 read/search events:
  show compact cards

3+ consecutive read/search events:
  group into batch card
```

Example:

```text
┌──────────────────────────────────┐
│ ▸ Read/search activity           │
│ 5 reads · 2 greps · 9s           │
└──────────────────────────────────┘
```

## 8.4 Turn boundary

A “turn” starts with user input and ends with one of:

```text
TaskCompleted
Stop
StopFailure
idle
permission_request
```

Render completion marker at turn end:

```text
── Turn completed · 5 tools · 1m 12s ──
```

If blocked by permission:

```text
── Turn paused · permission required ──
```

## 8.5 Date boundary

For long sessions:

```text
Today
Yesterday
May 20
```

Use quiet sticky date labels or inline boundaries.

---

# 9. Composer States in Timeline Context

## Normal

```text
┌──────────────────────────────┐ ↗
│ Message Claude…              │
└──────────────────────────────┘
```

## Sending

```text
┌──────────────────────────────┐ …
│ Sending…                     │
└──────────────────────────────┘
```

## Offline

```text
┌──────────────────────────────────────┐
│ Daemon offline. Reconnect to send.   │
└──────────────────────────────────────┘
```

## Blocked by permission

```text
┌──────────────────────────────────────┐
│ Claude is waiting for permission.    │
│ [Review permission]                  │
└──────────────────────────────────────┘
```

## Session completed / idle

Composer remains enabled:

```text
Message Claude…
```

---

# 10. Timeline Empty / Loading / Error States

## No events yet

```text
┌──────────────────────────────────────┐
│                                      │
│          No events yet               │
│                                      │
│  Send a message to start working     │
│  with Claude Code in this directory. │
│                                      │
└──────────────────────────────────────┘
```

## Loading history

```text
↑ Loading earlier events…
```

Skeleton:

```text
┌──────────────────────────────────┐
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒                   │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒               │
└──────────────────────────────────┘
```

## History load failed

```text
┌──────────────────────────────────┐
│ Couldn’t load earlier events     │
│ Network or hub connection failed │
│ [Retry]                          │
└──────────────────────────────────┘
```

## Session disconnected

```text
┌──────────────────────────────────┐
│ ◇ Session disconnected           │
│ The daemon is offline. Transcript│
│ may be stale.                    │
└──────────────────────────────────┘
```

## Chat send error

```text
          ┌──────────────────────────┐
          │ You                 failed│
          │ Run the auth tests       │
          │ [Retry] [Discard]        │
          └──────────────────────────┘
```

---

# 11. Visual Style Rules

## Spacing

```text
Timeline horizontal padding:
mobile: 16px
tablet: 20px
desktop: 24px

Gap between timeline items:
8–12px

Gap between grouped tool cards:
6px

Date / turn boundary margin:
20px top, 12px bottom
```

## Width

```text
Mobile:
user bubble max-width: 86%
assistant bubble max-width: 92%
tool card width: 100%

Desktop:
chat bubble max-width: 680px
tool card max-width: 760px
timeline content max-width: 840px
```

## Typography

```text
Chat body:
15px / 22px

Tool command:
14px / 22px monospace

Metadata:
12px / 16px

Card title:
13–15px semibold
```

---

# 12. Color Usage

Use semantic theme tokens from the main design system.

## Chat layer

```text
User bubble:
bg = color.action.primarySubtle
text = color.text.primary

Assistant bubble:
bg = color.bg.surface
border = color.border.default
```

## Work layer

```text
Tool card:
bg = color.bg.surfaceSubtle
border = color.border.default

Tool header:
text = color.text.primary

Tool metadata:
text = color.text.secondary
```

## Decision layer

```text
Permission:
bg = color.status.warningSubtle
border = color.status.waiting
icon = color.status.waiting
```

## Error layer

```text
Failure:
bg = color.status.errorSubtle
border = color.status.error
icon = color.status.error
```

## System layer

```text
System notice:
text = color.text.tertiary
border = color.border.subtle
```

---

# 13. Interaction Details

## Expand / collapse

Cards that can expand:

```text
reasoning
long tool result
read/search tools
batch summaries
subagent groups
raw JSON
compaction metadata
```

Interaction:

```text
tap card header
or
tap explicit View output / Collapse
```

Mobile should prefer explicit buttons for clarity.

## Copy actions

Support copy on:

```text
Bash command
cwd
tool output
raw JSON
file path
```

Copy action should show toast:

```text
Copied command
Copied output
Copied path
```

## Scroll behavior

New event arrival:

```text
If user is at bottom:
  auto-scroll to latest

If user has scrolled up:
  do not yank scroll
  show "New events" floating pill
```

Floating pill:

```text
┌──────────────┐
│ 3 new events │
└──────────────┘
```

## Permission arrival while viewing old history

If user is scrolled up and permission arrives:

```text
show sticky high-priority banner:
Permission required · Review
```

Do not rely only on bottom auto-scroll.

---

# 14. Accessibility

Minimum requirements:

```text
Tap target >= 44px
All statuses have icon + label
No color-only meaning
Expandable cards expose aria-expanded
Permission sheet traps focus
Keyboard navigation works on desktop
Reduced motion respected
```

Screen reader examples:

Assistant bubble:

```text
Claude, 10:26 AM. Found the issue. I’m updating the test mock setup.
```

Tool card:

```text
Tool use. Bash. Command pnpm test auth. Working directory Users me project. Status completed in 12 seconds.
```

Permission:

```text
Permission required. Claude wants to use Bash in session feat_auth on work-laptop. Command rm dash rf node_modules. This may delete files. Actions: deny, allow once, configure allow always.
```

---

# 15. Recommended Implementation Order

I would build timeline rendering in this order:

```text
1. Normalized TimelineItem model
2. Basic user / assistant bubbles
3. Bash tool_use + tool_result cards
4. Permission request sheet/panel
5. Error cards
6. Read/Edit/Write specialized cards
7. Batch grouping
8. Subagent grouping
9. System metadata pills
10. Unknown raw JSON fallback
```

This keeps the high-value path working first: chat, tools, permission, failure.

---

# 16. Key Product Decision

The timeline should not expose raw Claude Code internals as the primary UI.

Raw events are implementation detail. The product UI should translate them into:

```text
User asked something
Claude reasoned
Claude used tools
Tool returned result
Claude needs permission
Task paused/completed/failed
```

That is the difference between a useful mobile coding control surface and a noisy event log.
