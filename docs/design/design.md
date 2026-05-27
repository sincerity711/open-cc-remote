---

# 0. Product design principles

## Core principles

1. **Permission first**

   * 任何 pending permission 都应该压过普通聊天和 session 浏览。
   * 用户打开通知后，不应该先进 Home 再找 session，而是直接进入 permission review。

2. **Dense, but not cramped**

   * Home 要承载多 daemon、多 session。
   * Session row 用 compact card，而不是大号聊天列表。

3. **Chat-like transcript, structured tool cards**

   * Assistant / user 走 chat rhythm。
   * tool_use / tool_result 走 compact technical card。
   * 不要做成纯 log viewer。

4. **Status must be readable without color**

   * 状态必须同时使用：icon / text / shape / color。
   * 不能只靠红绿。

5. **Phone is command center**

   * 大多数操作单手完成。
   * 危险操作需要防误触。
   * Tap target ≥ 44pt。

---

# 1. Information architecture

Mobile 上建议保留 3 个主层级：

```text
Auth
 └─ Home
     ├─ Daemon section
     │   ├─ Start session
     │   └─ Session rows
     ├─ Permission queue overlay
     ├─ Session full-screen pane
     └─ Settings sheet
```

建议不要做传统 bottom tab。这个产品的核心不是多个频道，而是一个工作台。主导航保持：

```text
Header:
cc-remote | Hub status | Settings
```

Session 是从右侧 / 底部进入的全屏工作区。Permission 是全局 overlay。

---

# 2. Visual direction

## Mood

```text
technical
calm
precise
low-glare
dense
terminal-aware
mobile-native
```

## Visual language

* 背景：轻微分层，不要纯白刺眼。
* Cards：低对比边框 + 微弱阴影。
* Primary color：偏 cyan / blue，和 terminal / network / remote control 语义一致。
* Danger：红色只用于 destructive / denied / expired，不到处使用。
* Permission：使用 amber / orange 作为“需要决策”，不是 error。

---

# 3. Mobile wireframes — 390×844

## 3.1 Sign-in

目标：极简、可信、不是营销页。

```text
┌──────────────────────────────────────┐
│                                      │
│                                      │
│              ┌────────┐              │
│              │  >_    │              │
│              └────────┘              │
│                                      │
│              cc-remote               │
│        Remote Claude Code control    │
│                                      │
│  ┌────────────────────────────────┐  │
│  │        Sign in with SSO         │  │
│  └────────────────────────────────┘  │
│                                      │
│  Secure sign-in via SAP IAS          │
│                                      │
│                                      │
│                                      │
│                                      │
│                                      │
│  v0.1 · self-hosted hub              │
└──────────────────────────────────────┘
```

### Interaction notes

* 单按钮即可。
* 不要暴露 OIDC / IAS 细节太多。
* 登录中状态：

```text
Signing in…
Opening secure browser
```

* 登录失败：

```text
Couldn’t complete sign-in
Check your hub URL or identity provider.
[Try again]
```

---

## 3.2 Home / daemon list

这是最高频 screen。信息密度要高，但 hierarchy 要清楚。

```text
┌──────────────────────────────────────┐
│ cc-remote        ● Connected    ⚙︎   │
│──────────────────────────────────────│
│ Pending permissions                  │
│ ┌──────────────────────────────────┐ │
│ │ ⚠ 1 approval waiting             │ │
│ │ mbp-m3 · repo-web                │ │
│ │ [Review]                         │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Machines                             │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ● mbp-m3.local             3 ses │ │
│ │ Online · last seen now           │ │
│ │                                  │ │
│ │ Start session                    │ │
│ │ ┌──────────────────────────┐ [+] │ │
│ │ │ /Users/me/project        │     │ │
│ │ └──────────────────────────┘     │ │
│ │                                  │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ ⚠ repo-web        WAITING  2 │ │ │
│ │ │ claude-sonnet · /repo-web    │ │ │
│ │ │ unread 4 · tasks 7       ✕   │ │ │
│ │ └──────────────────────────────┘ │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ ◌ api-server      WORKING  0 │ │ │
│ │ │ opus · /api                 │ │ │
│ │ │ running tool · tasks 12  ✕   │ │ │
│ │ └──────────────────────────────┘ │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ ✓ cli-tools       IDLE     0 │ │ │
│ │ │ sonnet · /tools             │ │ │
│ │ │ idle 8m · tasks 3       ✕    │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ◇ dev-vm-eu                1 ses │ │
│ │ Offline · last seen 12m ago      │ │
│ │                                  │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ ◇ infra          OFFLINE   0 │ │ │
│ │ │ /terraform                  │ │ │
│ │ │ paused · tasks 4        ✕    │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Home hierarchy

Header:

```text
cc-remote | hub connection status | settings
```

Then:

```text
Pending permissions, if any
Machines
Daemon cards
Sessions
```

### Compact session row

Each row should show only what matters at a glance:

```text
┌──────────────────────────────┐
│ ⚠ repo-web        WAITING  2 │
│ sonnet · /repo-web           │
│ unread 4 · tasks 7       ✕   │
└──────────────────────────────┘
```

Do not show full session id by default. Show shortened id or tmux name first. Full ID can be visible inside session header / details menu.

### Recommended session row fields

Priority order:

1. Status icon + session display name
2. Status label
3. unread count
4. model + cwd
5. activity summary
6. kill button

### Kill interaction

Do not make `✕` immediately destructive.

Recommended:

```text
tap ✕
→ inline confirmation replaces row actions:

Kill session?
[Cancel] [Kill]
```

For a stuck session, speed matters, but accidental kill is still costly.

---

## 3.3 Session pane — mobile full-screen

Mobile session should be full-screen, not a side pane.

```text
┌──────────────────────────────────────┐
│ ‹ repo-web             ● Online   ⋯  │
│ sonnet · /Users/me/repo-web          │
│──────────────────────────────────────│
│ ↑ Load earlier events                │
│                                      │
│       ┌────────────────────────────┐ │
│       │ You                        │ │
│       │ Fix the failing tests      │ │
│       └────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Claude                           │ │
│ │ I’ll inspect the test failures   │ │
│ │ and run the relevant suite.      │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ $ tool_use · Bash                │ │
│ │ pnpm test -- --runInBand         │ │
│ │ cwd: /Users/me/repo-web          │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ tool_result                      │ │
│ │ 2 failed, 48 passed              │ │
│ │ View output                      │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Claude                           │ │
│ │ Found the issue in auth.test.ts. │ │
│ │ I’m updating the mock setup.     │ │
│ └──────────────────────────────────┘ │
│                                      │
│──────────────────────────────────────│
│ ┌──────────────────────────────┐ ↑  │
│ │ Message Claude…              │    │
│ └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

### Transcript treatment

Use different visual forms:

| Event type         | Visual                                |
| ------------------ | ------------------------------------- |
| User chat          | Right-aligned bubble                  |
| Claude assistant   | Left-aligned soft card                |
| tool_use           | Monospace technical card              |
| tool_result        | Collapsible result card               |
| system             | Small neutral inline notice           |
| permission request | High-priority approval card / overlay |
| error              | Red-tinted compact card               |

### Tool card collapsed state

```text
┌──────────────────────────────────┐
│ $ Bash                      12s  │
│ pnpm test -- --runInBand         │
│ cwd: /repo-web                  │
│ [View output]                   │
└──────────────────────────────────┘
```

Expanded:

```text
┌──────────────────────────────────┐
│ $ Bash                      12s  │
│ pnpm test -- --runInBand         │
│ cwd: /repo-web                  │
│──────────────────────────────────│
│ FAIL src/auth.test.ts            │
│ Expected 200, received 401       │
│ ...                              │
│ [Collapse]                       │
└──────────────────────────────────┘
```

### Composer

Mobile composer should be sticky bottom and safe-area aware.

States:

```text
empty:      Message Claude…
sending:    Sending…
disabled:   Session offline
blocked:    Waiting for permission
```

When permission is pending, composer can remain visible but deprioritized:

```text
Permission required before Claude can continue.
[Review permission]
```

---

## 3.4 Permission approval flow

This is the money moment. I would not use a simple top banner. Use a **permission bottom sheet / focused review card**.

### Global permission prompt — collapsed

Appears on top of Home or Session.

```text
┌──────────────────────────────────────┐
│ ⚠ Permission needed                  │
│ mbp-m3 · repo-web · Bash             │
│ rm -rf node_modules                  │
│ [Review]                             │
└──────────────────────────────────────┘
```

### Permission review — focused sheet

```text
┌──────────────────────────────────────┐
│                                      │
│  background dimmed                   │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ⚠ Claude requests permission     │ │
│ │ repo-web · mbp-m3.local          │ │
│ │                                  │ │
│ │ Tool                             │ │
│ │ Bash                             │ │
│ │                                  │ │
│ │ Working directory                │ │
│ │ /Users/me/repo-web               │ │
│ │                                  │ │
│ │ Command                          │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ rm -rf node_modules          │ │ │
│ │ └──────────────────────────────┘ │ │
│ │                                  │ │
│ │ Risk                             │ │
│ │ ⚠ Deletes files in project dir   │ │
│ │                                  │ │
│ │ 1 of 3 pending                   │ │
│ │                                  │ │
│ │ ┌──────────────┐ ┌────────────┐ │ │
│ │ │ Deny         │ │ Allow once │ │ │
│ │ └──────────────┘ └────────────┘ │ │
│ │                                  │ │
│ │        Allow always…             │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Important: button design

Do **not** present all three actions as equal.

Recommended hierarchy:

```text
Primary:      Allow once
Secondary:    Deny
Tertiary:     Allow always…
```

`Allow always` should open a confirmation step:

```text
Allow this tool automatically?

Bash commands matching:
rm -rf node_modules

For:
repo-web on mbp-m3.local

[Cancel] [Allow always]
```

For dangerous commands, `Allow always` should either be disabled or require explicit confirmation.

### Destructive command treatment

For shell commands, visually parse risk:

```text
Command
┌──────────────────────────────┐
│ rm -rf node_modules          │
└──────────────────────────────┘

Detected:
- removes directory
- inside project path
- does not target system root
```

For high-risk commands:

```text
⚠ High risk
This command can delete files recursively.
```

Examples of high-risk patterns:

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

This does not need to be perfect. Even simple heuristics improve user trust.

### Expired permission

```text
┌──────────────────────────────────┐
│ Permission expired               │
│ Claude no longer needs this      │
│ approval or the session ended.   │
│                                  │
│ [Back to session]                │
└──────────────────────────────────┘
```

### Queue behavior

If multiple permission requests are pending:

```text
1 of 3 pending
[Skip] [Deny] [Allow once]
```

After resolving one, animate to next. Keep context stable:

```text
repo-web · Bash
api-server · Read file
infra · Bash
```

### Notification deep-link behavior

When tapping push notification:

```text
Open app
→ authenticate if needed
→ connect to Hub
→ open exact permission review
→ fallback to session if permission expired
```

Do not land on Home first.

---

## 3.5 Settings drawer / modal

Mobile: use full-height sheet.

```text
┌──────────────────────────────────────┐
│ Settings                         ✕  │
│──────────────────────────────────────│
│ Account                              │
│ gramiria2026@outlook.com             │
│ [Sign out]                           │
│                                      │
│ Paired devices                       │
│ ┌──────────────────────────────────┐ │
│ │ mbp-m3.local              Online │ │
│ │ paired May 20                   │ │
│ │                         Revoke  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ dev-vm-eu               Offline │ │
│ │ paired May 18                   │ │
│ │                         Revoke  │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Pair new daemon                      │
│ ┌──────────────────────────────────┐ │
│ │ Pairing code                     │ │
│ │                                  │ │
│ │        482-913                   │ │
│ │                                  │ │
│ │ Expires in 10:00                 │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Notifications                        │
│ Permission alerts              [on]  │
│                                      │
│ Appearance                           │
│ System / Light / Dark                │
└──────────────────────────────────────┘
```

### Revoke flow

```text
Revoke mbp-m3.local?
This daemon will no longer be able to connect to your hub.

[Cancel] [Revoke]
```

### Pairing flow

Pairing should be explicit and short:

```text
Pair new daemon
1. Run cc-remote daemon pair
2. Enter this code:

482-913

Expires in 10:00
[Copy code]
```

---

# 4. Tablet and desktop adaptation

## Tablet — 768px+

Use two-column layout:

```text
┌────────────────────────────────────────────────────┐
│ cc-remote              ● Connected            ⚙︎   │
│────────────────────────────────────────────────────│
│ Machines                    Session               │
│ ┌──────────────────────┐   ┌────────────────────┐ │
│ │ mbp-m3.local         │   │ repo-web            │ │
│ │ sessions…            │   │ transcript…         │ │
│ │                      │   │                    │ │
│ └──────────────────────┘   │ composer…          │ │
│ ┌──────────────────────┐   └────────────────────┘ │
│ │ dev-vm-eu            │                          │
│ └──────────────────────┘                          │
└────────────────────────────────────────────────────┘
```

Suggested split:

```text
Left rail: 320px
Right pane: remaining width
```

Permission sheet remains centered or bottom sheet depending on device posture.

## Desktop — 1024px+

Use three conceptual zones:

```text
┌──────────────────────────────────────────────────────────────┐
│ cc-remote                      ● Connected  Settings Sign out │
│──────────────────────────────────────────────────────────────│
│ Daemons / Sessions             │ Session transcript           │
│                                │                              │
│ ┌────────────────────────────┐ │ ┌──────────────────────────┐ │
│ │ mbp-m3.local               │ │ │ repo-web                 │ │
│ │ session rows               │ │ │ transcript               │ │
│ └────────────────────────────┘ │ │                          │ │
│                                │ │ composer                 │ │
│                                │ └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Suggested desktop widths:

```text
Sidebar: 360–420px
Session pane: 640–840px
Right margin / details: optional
```

Do not over-expand transcript lines. Long lines should max out around 720px for readability.

---

# 5. Component spec

## 5.1 App header

### Mobile

Height:

```text
56px
```

Contents:

```text
left: product name
center/right: connection pill
right: settings icon
```

Connection pill examples:

```text
● Connected
◌ Reconnecting
◇ Offline
```

Use text plus icon.

---

## 5.2 Daemon card

```text
Card
- title: hostname
- status: online/offline/reconnecting
- metadata: last seen, session count
- start session form
- session list
```

Daemon card density:

```text
padding: 12
gap: 10
radius: 14
```

Offline daemon card should remain visible, but muted.

---

## 5.3 Start session form

Mobile compact:

```text
┌──────────────────────────┐ [+]
│ /Users/me/project        │
└──────────────────────────┘
```

Behavior:

* CWD input uses monospace.
* `+` button is 44×44.
* On failure, error appears below input.
* Recent CWD suggestions can appear after focus.

Suggested suggestions:

```text
Recent
/repo-web
/api-server
/infra
```

---

## 5.4 Session row

Recommended row height:

```text
72–84px
```

States:

```text
waiting permission: amber left rail + ⚠
working: blue/cyan spinner/dot + WORKING
idle: neutral dot + IDLE
offline: muted diamond + OFFLINE
error/stuck: red marker + NEEDS ATTENTION
```

Row anatomy:

```text
┌──────────────────────────────┐
│ icon name        status chip │
│ model · cwd                  │
│ unread · tasks · action      │
└──────────────────────────────┘
```

---

## 5.5 Transcript message

### Assistant

```text
background: elevated card
alignment: left
max width: 92% mobile
```

### User

```text
background: subtle primary tint
alignment: right
max width: 88% mobile
```

### Tool use

```text
monospace command block
tool name header
cwd metadata
duration/status
```

### Tool result

Collapsed by default if long.

Threshold:

```text
collapse after 8 lines or 480px height
```

---

## 5.6 Permission card

This should be the most polished component.

Fields:

```text
title
daemon
session
tool
cwd
input / command
risk hint
queue position
actions
```

Action order:

```text
Deny | Allow once
Allow always…
```

For one-handed use, the primary action can sit on lower right, but do not put it flush against screen edge without spacing.

Minimum action size:

```text
height: 48px
```

---

## 5.7 Buttons

### Primary

Use for:

```text
Allow once
Send
Start session
Sign in
```

Visual:

```text
solid primary background
high contrast text
```

### Secondary

Use for:

```text
Deny
Cancel
Review
Copy code
```

Visual:

```text
neutral background
border
```

### Danger

Use for:

```text
Kill
Revoke
Sign out
Confirm deny destructive? no, deny is safe
```

Visual:

```text
red text or red border
avoid full red fill unless final destructive confirmation
```

### Tertiary

Use for:

```text
Allow always…
View output
Load earlier
```

Visual:

```text
text button
```

---

# 6. Design tokens

Token names are implementation-friendly but not framework-specific.

## 6.1 Color tokens — light

| Token              |     Value | Usage                           |
| ------------------ | --------: | ------------------------------- |
| `bg.canvas`        | `#F7F8FA` | app background                  |
| `bg.surface`       | `#FFFFFF` | cards, sheets                   |
| `bg.surfaceSubtle` | `#F1F3F6` | inputs, tool blocks             |
| `bg.elevated`      | `#FFFFFF` | overlays                        |
| `border.default`   | `#DDE1E7` | cards, dividers                 |
| `border.strong`    | `#C3CAD5` | focused components              |
| `text.primary`     | `#111827` | main text                       |
| `text.secondary`   | `#4B5563` | metadata                        |
| `text.tertiary`    | `#6B7280` | quiet metadata                  |
| `text.inverse`     | `#FFFFFF` | primary button text             |
| `primary.500`      | `#2563EB` | primary action                  |
| `primary.600`      | `#1D4ED8` | pressed primary                 |
| `primary.subtle`   | `#EFF6FF` | user bubble / selected          |
| `success.500`      | `#16A34A` | online / completed              |
| `warning.500`      | `#D97706` | permission pending              |
| `warning.subtle`   | `#FFF7ED` | permission background           |
| `danger.500`       | `#DC2626` | destructive                     |
| `danger.subtle`    | `#FEF2F2` | errors                          |
| `code.bg`          | `#0F172A` | command preview when dark block |
| `code.text`        | `#E5E7EB` | command text                    |

## 6.2 Color tokens — dark

| Token              |     Value | Usage                  |
| ------------------ | --------: | ---------------------- |
| `bg.canvas`        | `#090B10` | app background         |
| `bg.surface`       | `#11141B` | cards                  |
| `bg.surfaceSubtle` | `#171B24` | inputs, tool cards     |
| `bg.elevated`      | `#1A1F2B` | sheets                 |
| `border.default`   | `#262C38` | dividers               |
| `border.strong`    | `#3A4353` | focus                  |
| `text.primary`     | `#F3F4F6` | main text              |
| `text.secondary`   | `#B6BFCC` | metadata               |
| `text.tertiary`    | `#8993A3` | quiet text             |
| `text.inverse`     | `#FFFFFF` | primary button         |
| `primary.500`      | `#60A5FA` | primary action         |
| `primary.600`      | `#3B82F6` | pressed                |
| `primary.subtle`   | `#0B2545` | selected / user bubble |
| `success.500`      | `#22C55E` | online                 |
| `warning.500`      | `#F59E0B` | permission             |
| `warning.subtle`   | `#2A1A05` | permission background  |
| `danger.500`       | `#F87171` | destructive            |
| `danger.subtle`    | `#2A0F12` | errors                 |
| `code.bg`          | `#05070B` | command block          |
| `code.text`        | `#D1D5DB` | command text           |

## 6.3 Type scale

Use system font for UI. Use monospace only for paths, commands, IDs, tool output.

| Token       | Size / Line | Use                     |
| ----------- | ----------- | ----------------------- |
| `text.xs`   | 11 / 16     | tiny metadata, counters |
| `text.sm`   | 13 / 18     | secondary labels        |
| `text.base` | 15 / 22     | normal body             |
| `text.md`   | 16 / 24     | composer, inputs        |
| `text.lg`   | 18 / 26     | section title           |
| `text.xl`   | 22 / 30     | auth title              |
| `mono.sm`   | 12 / 18     | cwd, IDs                |
| `mono.base` | 14 / 22     | commands                |

Suggested font stack:

```text
UI: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
Mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace
```

## 6.4 Spacing scale

| Token      | Value |
| ---------- | ----: |
| `space.1`  |     4 |
| `space.2`  |     8 |
| `space.3`  |    12 |
| `space.4`  |    16 |
| `space.5`  |    20 |
| `space.6`  |    24 |
| `space.8`  |    32 |
| `space.10` |    40 |
| `space.12` |    48 |

Mobile page padding:

```text
16px
```

Dense card inner padding:

```text
12px
```

Transcript gap:

```text
10–12px
```

## 6.5 Radius

| Token         | Value | Use    |
| ------------- | ----: | ------ |
| `radius.sm`   |     6 | chips  |
| `radius.md`   |    10 | inputs |
| `radius.lg`   |    14 | cards  |
| `radius.xl`   |    20 | sheets |
| `radius.full` |   999 | pills  |

## 6.6 Elevation

Keep subtle.

| Token             | Use                           |
| ----------------- | ----------------------------- |
| `shadow.card`     | normal daemon/session card    |
| `shadow.sheet`    | permission/settings overlay   |
| `shadow.floating` | sticky permission mini-banner |

Dark mode should rely more on border and background separation than heavy shadows.

---

# 7. Status indicators

Use icon + label + color.

| State              | Icon         | Label   | Color role | Meaning                      |
| ------------------ | ------------ | ------- | ---------- | ---------------------------- |
| Online             | `●`          | Online  | success    | daemon/session reachable     |
| Offline            | `◇`          | Offline | muted      | disconnected                 |
| Idle               | `✓` or `○`   | Idle    | neutral    | no active work               |
| Working            | `◌` animated | Working | primary    | Claude is processing/tooling |
| Waiting permission | `⚠`          | Waiting | warning    | user action required         |
| Completed          | `✓`          | Done    | success    | task completed               |
| Error              | `!`          | Error   | danger     | failed/stuck                 |

Do not use green/red alone. The text label should always be present in compact chips.

---

# 8. PWA touches

## 8.1 App icon concept

Concept:

```text
rounded square
dark graphite background
terminal prompt >_
small radio / websocket dot in corner
subtle cyan glow
```

ASCII:

```text
┌────────────┐
│ >_      ●  │
│            │
│    cc      │
└────────────┘
```

Light/dark adaptive icon:

* Dark default icon for iOS / Android home screen.
* Inner glyph should remain high contrast.
* Avoid tiny text except optional `cc`.

## 8.2 Splash screen

```text
┌──────────────────────────────────────┐
│                                      │
│                                      │
│              ┌────────┐              │
│              │ >_  ●  │              │
│              └────────┘              │
│                                      │
│              cc-remote               │
│                                      │
│          Connecting to hub…          │
│                                      │
└──────────────────────────────────────┘
```

Splash states:

```text
Connecting to hub…
Restoring session…
Waiting for network…
```

## 8.3 Install prompt

Do not use playful copy. Keep it utilitarian.

```text
┌──────────────────────────────────┐
│ Install cc-remote                │
│ Approve Claude Code requests     │
│ faster from your home screen.    │
│                                  │
│ [Not now]        [Install]       │
└──────────────────────────────────┘
```

Trigger after successful login and hub connection, not before.

## 8.4 Push notification copy

### Permission request

```text
Title:
Claude needs permission

Body:
mbp-m3 · repo-web
Bash: rm -rf node_modules
```

### Safer command

```text
Title:
Claude is waiting

Body:
Allow Bash in repo-web?
pnpm test -- --runInBand
```

### Expired

```text
Title:
Permission no longer needed

Body:
repo-web continued or the request expired.
```

### Session completed

```text
Title:
Claude finished a task

Body:
repo-web · 7 tasks completed
```

### Lost connection

```text
Title:
cc-remote disconnected

Body:
Hub connection lost. Claude sessions may be unreachable.
```

Notification action buttons, where supported:

```text
Review
Deny
```

I would avoid `Allow` directly inside the notification for risky shell commands. It is too easy to approve without enough context.

---

# 9. Empty, loading, and error states

## 9.1 No daemons paired

```text
┌──────────────────────────────────────┐
│ cc-remote        ● Connected    ⚙︎   │
│──────────────────────────────────────│
│                                      │
│              No daemons paired       │
│                                      │
│  Pair your first machine to expose   │
│  Claude Code sessions remotely.      │
│                                      │
│  [Pair daemon]                       │
│                                      │
│  Run the daemon on your machine,     │
│  then enter the pairing code here.   │
│                                      │
└──────────────────────────────────────┘
```

## 9.2 Daemon offline

```text
┌──────────────────────────────────┐
│ ◇ mbp-m3.local           Offline │
│ Last seen 12m ago                │
│                                  │
│ Sessions are read-only until     │
│ this daemon reconnects.          │
│                                  │
│ [View sessions]                  │
└──────────────────────────────────┘
```

## 9.3 Session has no events yet

```text
┌──────────────────────────────────────┐
│ ‹ new-session           ● Online     │
│──────────────────────────────────────│
│                                      │
│          No events yet               │
│                                      │
│  Send a message to start working     │
│  with Claude Code in this directory. │
│                                      │
│──────────────────────────────────────│
│ [Message Claude…                 ↑]  │
└──────────────────────────────────────┘
```

## 9.4 Loading session history

Use skeleton rows, not spinner-only.

```text
┌──────────────────────────────────┐
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                  │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒             │
└──────────────────────────────────┘
┌────────────────────────────┐
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒              │
└────────────────────────────┘
```

## 9.5 Lost hub connection

Global banner:

```text
┌──────────────────────────────────────┐
│ ◌ Reconnecting to hub…               │
│ Sessions may be stale.               │
└──────────────────────────────────────┘
```

If fully offline:

```text
┌──────────────────────────────────────┐
│ ◇ Offline                            │
│ Check your network or hub address.   │
│ [Retry]                              │
└──────────────────────────────────────┘
```

## 9.6 Permission request expired

```text
┌──────────────────────────────────┐
│ Permission expired               │
│ This request can no longer be    │
│ approved or denied.              │
│                                  │
│ [Back to session]                │
└──────────────────────────────────┘
```

---

# 10. Micro-interactions

## Session opening

Mobile:

```text
tap session row
→ full-screen pane slides from right
```

Desktop:

```text
tap row
→ right pane updates
```

## Pending permission arrival

```text
phone notification
in-app haptic / subtle sound optional
permission mini-banner appears
session row status changes to WAITING
```

## Approval result

After Allow once:

```text
button enters loading state: Allowing…
then sheet dismisses
session transcript scrolls to resumed Claude activity
```

After Deny:

```text
Denying…
sheet dismisses
transcript inserts system event:
Permission denied by user
```

After Allow always:

```text
confirmation required
then rule saved
show small toast:
Auto-approval rule added
```

## Composer send

```text
tap send
→ message appears optimistically
→ send button disabled while sending
→ failure shows inline retry
```

---

# 11. Layout details for tight Home screen

To preserve vertical space:

1. Use daemon cards with collapsible session lists.
2. Show at most 3 sessions per daemon by default if there are many.
3. Add:

```text
Show 6 more sessions
```

4. Session row should not show verbose IDs.
5. CWD should be middle-truncated:

```text
/Users/me/…/repo-web
```

6. Completed-task count can be compact:

```text
tasks 7
```

or:

```text
✓7
```

But keep label available for accessibility.

---

# 12. Accessibility requirements

Minimums:

```text
Tap targets: 44×44pt
Text body: 15px minimum
Contrast: WCAG AA
Focus rings: visible in both themes
No color-only status
Reduced motion support
Safe-area padding for iOS
```

Important permission accessibility:

* Permission sheet should trap focus.
* Screen reader announces:

```text
Claude requests permission. Tool Bash. Command rm -rf node_modules. In repo-web on mbp-m3.local.
```

* Buttons should be explicit:

```text
Deny permission
Allow once
Configure allow always
```

Not just:

```text
Deny
Allow
Always
```

---

# 13. Final recommended screen structure

## Mobile

```text
Sign-in
Home
Session full-screen
Permission bottom sheet
Settings full-height sheet
```

## Tablet

```text
Home/session split view
Permission centered sheet
Settings side sheet
```

## Desktop

```text
Left daemon/session sidebar
Right session pane
Floating permission review modal
Settings drawer
```

---

# 14. Strong product recommendation

The current “permission banner at top” should be replaced. For this product, permission approval is not a notification; it is a **decision screen**.

Use this hierarchy:

```text
Pending permission mini-card
→ focused review sheet
→ clear command context
→ Deny / Allow once
→ Allow always behind confirmation
```

That gives you the right tradeoff: fast for common approvals, safe for destructive commands, and credible for a developer audience.

下面这段可以直接补进产品设计文档里，作为 **Responsive UI Logic + Theme Tokens** 章节。

---

# 15. Responsive UI Logic — Mobile / Tablet / Desktop

cc-remote 的 UI 采用 **mobile-first responsive layout**。布局不依赖设备类型判断，而是基于 viewport width / container width 做适配。

## 15.1 Breakpoints

| Device class |  Width range | Primary layout                                                           |
| ------------ | -----------: | ------------------------------------------------------------------------ |
| Mobile       |  `320–599px` | 单列，全屏页面切换                                                                |
| Tablet       | `600–1023px` | 双栏：Daemon list + Session pane                                            |
| Desktop      |    `1024px+` | 多栏工作台：Navigation + Daemon/session list + Session + Permission side panel |

建议以这些断点作为 CSS / layout 规则基础：

```text
mobile:   < 600px
tablet:   600px – 1023px
desktop:  >= 1024px
wide:     >= 1440px
```

---

## 15.2 Mobile behavior — 390×844 primary target

Mobile 是核心使用场景。用户主要在手机上完成：

```text
1. 查看 daemon/session 状态
2. 收到 permission push
3. 快速 approve / deny
4. 发一条 follow-up message
5. 偶尔 kill stuck session
```

### Layout model

Mobile 使用 **single-stack navigation**：

```text
Sign-in
  ↓
Home / Daemon List
  ↓ tap session
Session Full Screen
  ↓
Permission Review Sheet / Settings Sheet
```

### Home

```text
┌──────────────────────────────┐
│ Header                       │
│ Pending permission summary   │
│ Daemon card                  │
│ Session rows                 │
│ Daemon card                  │
└──────────────────────────────┘
```

Rules:

* Home 为单列纵向滚动。
* Header sticky at top。
* Daemon cards 纵向堆叠。
* 每个 daemon 默认显示最多 `3` 个 session。
* 多于 3 个时显示：

```text
View all sessions
```

* CWD、session id、tmux name 均需要支持中间截断。
* Kill action 不直接执行，必须进入 inline confirm。

### Session pane

Mobile 上 Session Pane 必须是 **full-screen route / full-screen panel**，不能是半屏 drawer。

```text
Home
 └─ tap session
     └─ Session full-screen
```

Rules:

* 顶部显示 back button、session name、online status、more menu。
* Transcript 占据主体区域。
* Composer sticky bottom，并处理 iOS safe area。
* History loading 使用 scroll-up infinite load。
* 如果 daemon offline，composer disable，并显示原因。

### Permission review

Mobile 上 permission 是最高优先级 surface。

Priority:

```text
Permission review > Session pane > Home > Settings
```

Permission request 到达时：

```text
App closed:
push notification → open exact permission review

App open on Home:
show mini permission card → tap opens permission sheet

App open in Session:
show sticky permission card above composer or open sheet directly if request belongs to current session
```

Recommended mobile permission UI:

```text
bottom sheet, 90–96% screen height
background dimmed
focus trapped
primary action near bottom
```

Action hierarchy:

```text
Deny          secondary / safe action
Allow once    primary action
Allow always  tertiary, requires confirmation
```

For dangerous command patterns, `Allow always` should not be visually promoted.

Examples:

```text
rm -rf
sudo
chmod -R
chown -R
curl | sh
wget | sh
docker system prune
git reset --hard
```

### Settings

Mobile settings should be a **full-height sheet**:

```text
Settings
Paired devices
Pair new daemon
Notifications
Appearance
Account
```

Rules:

* Open from header gear.
* Close with `X` or swipe-down.
* Revoke device requires confirmation.
* Sign out requires confirmation only if there are active sessions or pending approvals.

---

## 15.3 Tablet behavior — 768×1024 target

Tablet should reduce navigation friction. Use a **two-pane layout**.

```text
┌────────────────────────────────────────────┐
│ Header                                     │
├─────────────────┬──────────────────────────┤
│ Daemons/Sessions│ Session Pane             │
│                 │                          │
│                 │ Transcript               │
│                 │ Composer                 │
└─────────────────┴──────────────────────────┘
```

### Layout widths

| Region                   |                     Width |
| ------------------------ | ------------------------: |
| Left daemon/session pane |               `300–360px` |
| Right session pane       |           remaining width |
| Gutter                   | `1px border` or `8px gap` |

### Home / daemon list behavior

* Daemon list becomes a persistent left pane.
* Tapping a session updates the right pane instead of opening a new full-screen route.
* Selected session row gets a selected background and left accent.
* Start session form remains inside each daemon card.
* If no session is selected, right pane shows empty state:

```text
Select a session
Choose a running Claude Code session from the left.
```

### Session pane behavior

* Transcript is always visible on the right once selected.
* Composer remains sticky at bottom of right pane.
* Header inside session pane should be compact:

```text
session name · status · model · more menu
```

### Permission behavior

Tablet permission should appear as a centered modal or right-side focused sheet.

Recommended:

```text
If permission belongs to selected session:
  show modal centered over session pane

If permission belongs to another session:
  show global permission modal with daemon/session context clearly visible
```

For multiple pending prompts:

```text
Permission Required
work-laptop · repo-web
1 of 3 pending
```

The left session list should also show the waiting status so the user understands which session is blocked.

### Settings

Tablet settings should be a right drawer:

```text
width: 360–420px
height: 100%
position: right
```

Background content remains visible but dimmed.

---

## 15.4 Desktop behavior — 1280×800+ target

Desktop becomes a full control-room layout.

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Header                                                  │
├──────────────┬──────────────────┬───────────────────────────┤
│ App nav      │ Daemons/Sessions │ Session transcript        │
│              │                  │                           │
│              │                  │ Composer                  │
└──────────────┴──────────────────┴───────────────────────────┘
```

When permission is pending, desktop may add a right-side panel:

```text
┌────────┬──────────────┬──────────────────────┬──────────────┐
│ Nav    │ Sessions     │ Transcript           │ Permission   │
│        │              │                      │ Review       │
└────────┴──────────────┴──────────────────────┴──────────────┘
```

### Layout widths

| Region                       |                                Width |
| ---------------------------- | -----------------------------------: |
| App nav                      | `72px` collapsed or `220px` expanded |
| Daemon/session column        |                          `320–400px` |
| Session transcript           |         flexible, max readable width |
| Permission panel             |                          `360–420px` |
| Max transcript content width |                          `720–840px` |

### Desktop nav

Desktop can introduce a left navigation rail:

```text
Daemons
Sessions
Notifications
Settings
```

But the primary workflow should still keep daemon/session list visible.

### Session behavior

* Session pane does not slide; it updates in place.
* Multiple sessions can be switched rapidly from the left column.
* Transcript content should not stretch too wide.
* Tool output cards can be wider than chat bubbles but should still have max width.

### Permission behavior

Desktop should not use a tiny banner for approval. Use either:

#### Option A — right side permission panel

Best for sustained coding work.

```text
Session transcript stays visible.
Permission review appears on the right.
```

#### Option B — centered modal

Best if there are rare permission prompts.

Recommendation for cc-remote:

```text
Use right-side permission panel on desktop.
Use modal only for critical confirmation, such as Allow always or Kill session.
```

### Settings

Desktop settings can be:

```text
right drawer, 420px
```

or

```text
center modal, max-width 560px
```

Recommended: right drawer, because it preserves the control-room feel.

---

# 16. Cross-device UI transformation rules

## 16.1 Navigation

| Surface       | Mobile            | Tablet            | Desktop                  |
| ------------- | ----------------- | ----------------- | ------------------------ |
| Home          | Full screen       | Left pane         | Left pane / main column  |
| Session       | Full-screen push  | Right pane        | Main pane                |
| Permission    | Bottom sheet      | Center modal      | Right side panel         |
| Settings      | Full-height sheet | Right drawer      | Right drawer             |
| Start session | Inline per daemon | Inline per daemon | Inline or toolbar action |

## 16.2 Permission priority

Permission always has the highest priority across devices.

```text
Mobile:
permission bottom sheet covers current screen

Tablet:
permission modal overlays two-pane layout

Desktop:
permission side panel appears without hiding transcript
```

## 16.3 Session list density

| Device  | Session row density                |
| ------- | ---------------------------------- |
| Mobile  | Compact, 72–84px                   |
| Tablet  | Compact-medium, 76–88px            |
| Desktop | Medium, 80–96px with more metadata |

Mobile should hide non-critical metadata. Desktop can expose more:

```text
Mobile:
name, status, cwd, unread, tasks

Desktop:
name, status, cwd, model, unread, tasks, last activity, kill
```

## 16.4 Transcript density

| Device  | Behavior                                           |
| ------- | -------------------------------------------------- |
| Mobile  | Chat-like, narrow bubbles                          |
| Tablet  | Chat + tool cards, moderate width                  |
| Desktop | Chat centered, tool cards wider, output expandable |

Tool results should always be collapsible, especially on mobile.

## 16.5 Composer behavior

| Device  | Composer                                         |
| ------- | ------------------------------------------------ |
| Mobile  | Sticky bottom, full width                        |
| Tablet  | Sticky bottom of session pane                    |
| Desktop | Sticky bottom, max-width aligned with transcript |

When permission is pending:

```text
Mobile:
composer remains visible but blocked with "Permission required"

Tablet:
composer disabled, permission modal visible

Desktop:
composer disabled, permission side panel visible
```

---

# 17. Light / Dark Mode Tokens

The product should support light and dark themes with the same semantic token names. Components must reference semantic tokens, not raw colors.

Recommended token structure:

```text
background
surface
text
border
status
action
code
shadow
```

---

## 17.1 Light theme tokens

| Token                        |                    Value | Usage                          |
| ---------------------------- | -----------------------: | ------------------------------ |
| `color.bg.canvas`            |                `#F7F8FA` | App background                 |
| `color.bg.surface`           |                `#FFFFFF` | Cards, sheets                  |
| `color.bg.surfaceSubtle`     |                `#F1F3F6` | Inputs, secondary cards        |
| `color.bg.elevated`          |                `#FFFFFF` | Modals, floating panels        |
| `color.bg.overlay`           | `rgba(17, 24, 39, 0.36)` | Modal backdrop                 |
| `color.text.primary`         |                `#111827` | Main text                      |
| `color.text.secondary`       |                `#4B5563` | Metadata                       |
| `color.text.tertiary`        |                `#6B7280` | Quiet labels                   |
| `color.text.disabled`        |                `#9CA3AF` | Disabled text                  |
| `color.text.inverse`         |                `#FFFFFF` | Text on primary/danger buttons |
| `color.border.default`       |                `#E5E7EB` | Card borders                   |
| `color.border.strong`        |                `#CBD5E1` | Focused borders                |
| `color.border.subtle`        |                `#EEF0F3` | Internal dividers              |
| `color.action.primary`       |                `#2563EB` | Primary buttons                |
| `color.action.primaryHover`  |                `#1D4ED8` | Primary hover/pressed          |
| `color.action.primarySubtle` |                `#EFF6FF` | Selected row, user bubble      |
| `color.action.secondary`     |                `#F8FAFC` | Secondary button background    |
| `color.status.online`        |                `#16A34A` | Online                         |
| `color.status.offline`       |                `#94A3B8` | Offline                        |
| `color.status.idle`          |                `#3B82F6` | Idle                           |
| `color.status.working`       |                `#F59E0B` | Working                        |
| `color.status.waiting`       |                `#D97706` | Waiting permission             |
| `color.status.completed`     |                `#7C3AED` | Completed                      |
| `color.status.error`         |                `#DC2626` | Error                          |
| `color.status.successSubtle` |                `#ECFDF5` | Online chip background         |
| `color.status.warningSubtle` |                `#FFF7ED` | Permission card background     |
| `color.status.errorSubtle`   |                `#FEF2F2` | Error background               |
| `color.code.bg`              |                `#0F172A` | Code block background          |
| `color.code.text`            |                `#E5E7EB` | Code block text                |
| `color.code.border`          |                `#1E293B` | Code block border              |
| `color.focus.ring`           |                `#60A5FA` | Focus outline                  |

---

## 17.2 Dark theme tokens

| Token                        |                 Value | Usage                          |
| ---------------------------- | --------------------: | ------------------------------ |
| `color.bg.canvas`            |             `#090B10` | App background                 |
| `color.bg.surface`           |             `#11141B` | Cards, sheets                  |
| `color.bg.surfaceSubtle`     |             `#171B24` | Inputs, secondary cards        |
| `color.bg.elevated`          |             `#1A1F2B` | Modals, floating panels        |
| `color.bg.overlay`           | `rgba(0, 0, 0, 0.56)` | Modal backdrop                 |
| `color.text.primary`         |             `#F3F4F6` | Main text                      |
| `color.text.secondary`       |             `#B6BFCC` | Metadata                       |
| `color.text.tertiary`        |             `#8993A3` | Quiet labels                   |
| `color.text.disabled`        |             `#5F6B7A` | Disabled text                  |
| `color.text.inverse`         |             `#FFFFFF` | Text on primary/danger buttons |
| `color.border.default`       |             `#262C38` | Card borders                   |
| `color.border.strong`        |             `#3A4353` | Focused borders                |
| `color.border.subtle`        |             `#1C222D` | Internal dividers              |
| `color.action.primary`       |             `#3B82F6` | Primary buttons                |
| `color.action.primaryHover`  |             `#60A5FA` | Primary hover/pressed          |
| `color.action.primarySubtle` |             `#0B2545` | Selected row, user bubble      |
| `color.action.secondary`     |             `#171B24` | Secondary button background    |
| `color.status.online`        |             `#22C55E` | Online                         |
| `color.status.offline`       |             `#64748B` | Offline                        |
| `color.status.idle`          |             `#60A5FA` | Idle                           |
| `color.status.working`       |             `#F59E0B` | Working                        |
| `color.status.waiting`       |             `#FBBF24` | Waiting permission             |
| `color.status.completed`     |             `#A78BFA` | Completed                      |
| `color.status.error`         |             `#F87171` | Error                          |
| `color.status.successSubtle` |             `#052E16` | Online chip background         |
| `color.status.warningSubtle` |             `#2A1A05` | Permission card background     |
| `color.status.errorSubtle`   |             `#2A0F12` | Error background               |
| `color.code.bg`              |             `#05070B` | Code block background          |
| `color.code.text`            |             `#D1D5DB` | Code block text                |
| `color.code.border`          |             `#1E293B` | Code block border              |
| `color.focus.ring`           |             `#60A5FA` | Focus outline                  |

---

# 18. Shared non-color tokens

These tokens should stay consistent across light and dark mode.

## 18.1 Typography

| Token                  | Size / Line height | Weight | Usage          |
| ---------------------- | -----------------: | -----: | -------------- |
| `font.size.caption`    |          `12 / 16` |    400 | tiny metadata  |
| `font.size.small`      |          `13 / 18` |    400 | secondary text |
| `font.size.body`       |          `15 / 22` |    400 | default body   |
| `font.size.bodyStrong` |          `15 / 22` |    600 | row title      |
| `font.size.input`      |          `16 / 24` |    400 | input/composer |
| `font.size.title`      |          `18 / 26` |    600 | section title  |
| `font.size.largeTitle` |          `28 / 36` |    700 | sign-in title  |
| `font.size.monoSmall`  |          `12 / 18` |    400 | paths, ids     |
| `font.size.monoBody`   |          `14 / 22` |    400 | commands       |

Font families:

```text
font.family.ui:
system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif

font.family.mono:
ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace
```

---

## 18.2 Spacing

| Token      |  Value |
| ---------- | -----: |
| `space.1`  |  `4px` |
| `space.2`  |  `8px` |
| `space.3`  | `12px` |
| `space.4`  | `16px` |
| `space.5`  | `20px` |
| `space.6`  | `24px` |
| `space.8`  | `32px` |
| `space.10` | `40px` |
| `space.12` | `48px` |

Device-specific page padding:

| Device  | Padding |
| ------- | ------: |
| Mobile  |  `16px` |
| Tablet  |  `20px` |
| Desktop |  `24px` |

---

## 18.3 Radius

| Token         |   Value | Usage               |
| ------------- | ------: | ------------------- |
| `radius.xs`   |   `4px` | tiny badge          |
| `radius.sm`   |   `6px` | status chip         |
| `radius.md`   |  `10px` | input, small card   |
| `radius.lg`   |  `14px` | daemon/session card |
| `radius.xl`   |  `20px` | modal, sheet        |
| `radius.full` | `999px` | pills               |

---

## 18.4 Component sizing

| Token                          |       Value | Usage                      |
| ------------------------------ | ----------: | -------------------------- |
| `size.tapTarget.min`           |      `44px` | minimum interactive target |
| `size.header.mobile`           |      `56px` | mobile header              |
| `size.header.desktop`          |      `64px` | desktop header             |
| `size.button.sm`               |      `36px` | compact buttons            |
| `size.button.md`               |      `44px` | normal buttons             |
| `size.button.lg`               |      `48px` | permission actions         |
| `size.input.md`                |      `44px` | cwd input                  |
| `size.sessionRow.mobile`       |   `72–84px` | mobile session row         |
| `size.sessionRow.desktop`      |   `80–96px` | desktop session row        |
| `size.permissionPanel.desktop` | `360–420px` | desktop right panel        |
| `size.settingsDrawer`          | `360–420px` | tablet/desktop settings    |

---

## 18.5 Elevation

Light mode:

| Token             | Value                                |
| ----------------- | ------------------------------------ |
| `shadow.card`     | `0 1px 2px rgba(15, 23, 42, 0.06)`   |
| `shadow.elevated` | `0 8px 24px rgba(15, 23, 42, 0.12)`  |
| `shadow.sheet`    | `0 16px 48px rgba(15, 23, 42, 0.18)` |

Dark mode:

| Token             | Value                             |
| ----------------- | --------------------------------- |
| `shadow.card`     | `0 1px 2px rgba(0, 0, 0, 0.28)`   |
| `shadow.elevated` | `0 8px 24px rgba(0, 0, 0, 0.36)`  |
| `shadow.sheet`    | `0 16px 48px rgba(0, 0, 0, 0.48)` |

Dark mode should rely more on borders and surface contrast than heavy shadow.

---

# 19. Theme switching rules

Theme options:

```text
System
Light
Dark
```

Rules:

* Default: `System`
* Follow OS preference when set to System.
* Store user preference locally.
* Theme switch should not reload app.
* Push notification content is theme-independent.
* Splash screen should match active theme where supported.

Component behavior:

```text
Cards:
light = white surface with subtle border
dark = dark surface with stronger border

Permission:
light = warm subtle background
dark = dark elevated surface with amber border

Code blocks:
use dark code block in both themes for command readability

Danger:
red should stay reserved for destructive actions and errors
```

---

# 20. Recommended implementation note for tokens

Use semantic tokens only in components.

Good:

```text
background: color.bg.surface
color: color.text.primary
border: color.border.default
```

Avoid:

```text
background: #FFFFFF
color: #111827
```

This makes light/dark switching predictable and keeps future theme changes cheap.

