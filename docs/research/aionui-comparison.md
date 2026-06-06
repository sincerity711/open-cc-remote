# AionUi 调研：UI 渲染、Agent 集成、通知，以及和 cc-remote 的对比

调研对象：[`iOfficeAI/AionUi`](https://github.com/iOfficeAI/AionUi)（截至 2026-06-06 的 main 分支快照）。
本地路径：`/Users/i060912/SAPDevelop/AionUi`（用 `codeload.github.com` tar.gz 拉的 — git clone 走 3128 代理总会 `HTTP/2 stream CANCEL`，无 `.git`）。

---

## TL;DR

- AionUi **不旁路观测 jsonl**。它是 **Electron 桌面 app + 内嵌 aioncore Rust 后端**，aioncore 用 `child_process.spawn` 把 `claude --acp` / `codex --acp` / `goose acp` 拉起来当 **headless JSON-RPC server**，通过 stdin/stdout 跑 ACP（Agent Client Protocol）。
- 前端有完整一套 ACP message 组件（`MessageAcpToolCall` / `MessageAcpPermission` / `MessagePlan` / `MessageThinking`），按 `session/update` 事件类型分发。
- 通知分 4 层：Electron 系统通知 / 消息流内嵌状态条 / Arco Toast / IM Channel 推送（Telegram、Lark、DingTalk、WeChat、WeCom）。**没有 web push (VAPID)** — 它是常驻桌面进程，不需要离线唤醒。
- 和我们的根本差异：AionUi 把 CC 当受控子进程，**用户失去 TUI**；我们附加观测 + hook 注入，**用户保留真 TUI**。两条路线产品定位不同，不是优劣关系。
- 借鉴优先级最高的 5 件事：①消息流按 ACP `SessionUpdate` 重建模 ②`useAddOrUpdateMessage` 同 msg_id 覆盖的流式合并 ③`agent-process-registry.json` 进程残留兜底 ④`MessageAcpPermission` 的 UX 抄一版 ⑤`AgentHandshake.{capabilities, modes, models, commands}` 4 块独立元数据。

---

## 1. AionUi 项目形态

```
packages/
├─ desktop/         Electron 主/渲染/preload — 桌面 app 本体
├─ web-host/        独立的 backend-launcher + static-server，能脱离 Electron 跑成 WebUI
├─ web-cli/         CLI 启动器（`AionUi --webui`）
└─ shared-scripts/  构建辅助
```

| 形态 | 怎么起 | UI 怎么进 |
|---|---|---|
| 桌面 app | 直接运行 `AionUi.app` | Electron 自己的窗口 |
| WebUI 模式 | `AionUi --webui` 或 `aionui` CLI | 浏览器访问 `http://<host>:25808` |

aioncore 是 **AionUi 自己的 Rust 二进制**，不是 CC 也不是任何已有 agent。它扮演 ACP **client**：把前端的请求翻译成 ACP JSON-RPC 调用，分发到下游 N 个 CLI agent；多 agent 同前端就是它的核心卖点。

---

## 2. UI 怎么渲染

`packages/desktop/src/renderer` 是标准 React + react-router + **Arco Design** SPA。

- 路由：`HashRouter` + `React.lazy`，12 条路由（`Router.tsx`）。
- UI 库强约束（来自 `AGENTS.md`）：只用 `@arco-design/web-react`、图标必须 `@icon-park/react`、颜色走 UnoCSS semantic token。
- 国际化：10 种语言，所有用户可见文本必须是 i18n key。

### 消息流的视图组合

`pages/conversation/Messages/`：

```
MessageList.tsx                  容器 + 分组合并 + 自动滚动
├─ MessageText                    普通文本
├─ MessageThinking                思考过程，折叠 + 实时 elapsed 计时
├─ MessageToolCall / ToolGroup    工具调用卡，pending/in_progress/done
├─ MessageAcpToolCall             ACP 协议工具卡（含 diff 视图）
├─ MessageAcpPermission           权限审批卡（Radio + Approve/Reject + 防重复提交）
├─ MessagePlan                    AI 计划列表
├─ MessageAgentStatus             "Agent 已连接 / 已断开" 状态条
├─ MessageCronTrigger / Badge     定时任务触发标记
└─ MessageSkillSuggest            Skill 推荐卡
```

每种消息独立组件，统一通过 `TMessage` discriminated union（`common/chat/chatLib.ts`）派发。新增消息类型 = 新增一个 type literal + 一个组件 + 在 MessageList 的 switch 加一支。

### 流式合并：`useAddOrUpdateMessage()`

ACP 流式 chunk 通过"同 msg_id 覆盖"合并到 React state。一个统一的合并函数处理所有 agent 的 chunk，避免每个消息类型自己维护 reducer。

### IPC / WebSocket 同前端

- 桌面下：`packages/desktop/src/preload/main.ts` 暴露 `ipcBridge`，渲染端 `ipcBridge.xxx.yyy.invoke(payload)` / `.on(handler)`。
- 浏览器下：`common/electronSafe.ts` 把 `ipcBridge` 替换为 `api/ws.ts` 的 `createWebSocketClient`（145 行：指数退避 + 心跳 30s + 类型化 event/payload）。**同一份前端代码，两种通道**。

---

## 3. Agent 集成 — 核心是 ACP

### 3.1 协议触点：`claude --acp`

`docs/guides/hub-testing.md` L3 smoke test：

| Backend | 命令 | ACP 参数 |
|---|---|---|
| claude | `claude` | `--acp` |
| codex | `codex` | `--acp` |
| goose | `goose` | `acp` |
| fake-acp-cli | `node index.js` | — |

`claude --acp` 是 Anthropic CC 的隐藏入口（Agent Client Protocol，Zed 推动的开放规范，CC 实现了它）。**进了 ACP 模式后，CC 不渲染 TUI，只在 stdin/stdout 上跑 JSON-RPC 2.0**。

### 3.2 ACP 协议长什么样

`tests/fixtures/fake-acp-cli/index.js` 是 100 行参考实现。**NDJSON over stdio 的 JSON-RPC 2.0**。

#### 入站 method（aioncore → CC）

```
initialize                  握手，拿 capabilities / serverInfo
session/new                 创建 session，拿 sessionId / modes / models / configOptions
session/prompt              发送一轮用户消息 (params.prompt = [{type:'text', text:...}])
session/cancel              停止当前回复
session/set_mode            切换 plan/agent/ask 模式
session/set_model           换模型
session/set_config_option   调参
```

#### 流式回包：`session/update` notification

```js
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId": "...",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": { "type":"text", "text":"..." }
  }
}}
```

`update.sessionUpdate` 取值：`agent_message_chunk` / `tool_call` / `plan` / `thought_chunk` / `request_permission`。每种对应前端一种 Message 组件。

#### turn 结束

`session/prompt` 的 **response**（不是 notification）带 `stopReason: end_turn` + `usage: {inputTokens, outputTokens, totalTokens}`。前端拿这个翻译成 `MessageAgentStatus` 状态条 + 关闭"running"标志。

#### 反向调用 — CC → aioncore

ACP 是双向的。CC 在写文件 / 跑命令前会发 **`session/request_permission`** 给 aioncore，等回 `{outcome: 'allow_once'}` 才动手。这就是 `MessageAcpPermission` 卡片的来源 —— 不是从 jsonl 反推，而是 CC 主动 request。

### 3.3 aioncore 进程模型

```
Electron Main                        aioncore                          claude --acp
┌──────────────┐  spawn           ┌──────────────┐   spawn stdio    ┌────────────┐
│ web-host/    │ ───────────────► │ Rust binary  │ ───────────────► │ CC headless│
│ backend-     │                  │ HTTP :25808  │                  │ JSON-RPC   │
│ launcher.ts  │ ◄──────────────  │ /api /ws     │ ◄──────────────  │ on stdio   │
└──────────────┘  WebSocket       └──────────────┘  ACP NDJSON      └────────────┘
```

- aioncore 启动参数（`buildSpawnArgs`）：`--port` `--data-dir` `--log-level` `--app-version` `--log-dir` `--work-dir` `--local`。
- `agent_metadata` 表里每个 agent 一行（数据库 + 扩展贡献）：
  ```json
  { "id": "claude", "connectionType": "cli", "cliCommand": "claude",
    "acpArgs": ["--acp"], "icon": "...", "authRequired": true }
  ```
- `web-host/src/agent-process-registry.ts` 把 CLI 子进程的 `(pid, process_group_id, conversation_id)` 落到 `runtime/agent-process-registry.json`，aioncore 重启时遍历并 SIGTERM → grace 1s → SIGKILL。

### 3.4 AcpAgentCapabilities — 从 `initialize` 拿到的能力清单

```ts
type AcpAgentCapabilities = {
  loadSession: boolean;
  promptCapabilities: { image, audio, embeddedContext };
  mcpCapabilities: { stdio, http, sse };
  sessionCapabilities: { fork, resume, list, close };
  _meta: Record<string, unknown>;
};
```

加上独立的 `AgentHandshake.{available_modes, available_models, available_commands}`，前端按需读：要不要显示 image upload、要不要列 fork session、要不要画 mode switcher，全靠这几块决定。

---

## 4. AskUserQuestion — ACP 支持吗？

**结论：ACP 没有"任意自由文本问答"原语，但有两个相邻能力**。

### 4.1 ACP 自带：`session/request_permission`

CC 主动发一个带 N 个 `option_id` 的请求，前端弹 `MessageAcpPermission` 卡，用户**只能选 option，不能写文字**：

```ts
type AcpPermissionOption = {
  option_id: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};
```

这能覆盖**多选题型**的 AskUserQuestion（"用 npm 还是 yarn？""目标分支选 main 还是 develop？"），但覆盖不了**自由文本**（"请告诉我 API key"）。

### 4.2 AionUi 自定义：side question / `/btw`

为了补 ACP 缺的能力，AionUi 自己加了一层：

- `common/chat/sideQuestion.ts`:
  ```ts
  export function isSideQuestionSupported(target) {
    return target.type === 'acp' && target.backend === 'claude';
  }
  ```
  **只对 Claude Code 启用**。（侧面证明：side question 用了 CC 特有的某个机制，不是协议层的）
- 用户视角：在主对话外按 `/btw` 弹一个浮层（`BtwOverlay`），临时插一句问题给 CC，不打断主 turn，回答完自动 dismiss。
- `behavior_policy.supports_side_question` 是 agent-level flag，每个 ACP adapter 自己声明支不支持。

**底层猜测**：CC 的 ACP 实现里应该暴露了一个非 spec 的 RPC method（比如 `session/aside` 之类），AionUi 的 aioncore 调它发问、收答。**ACP 主线协议不保证这个能力**，所以代码里用白名单 (`backend === 'claude'`) 拦死。

### 4.3 我们的 AskUserQuestion 怎么办

我们当前是 `.claude/hooks/ask-user-relay.ts` PreToolUse hook → unix socket → daemon → hub → PWA。这条路不走 ACP 也独立工作。

**结论：如果迁到 ACP**，可以分两段：

1. **option 型问题** → 映射到 `session/request_permission`，前端用 `MessageAcpPermission` 直接渲染。我们的 PWA 现在如果是临时实现，搬过来等于免费拿到一份成熟 UX。
2. **自由文本问题** → 不能用 ACP 标准能力。要么继续靠 PreToolUse hook（注入到 stdin）+ 自定义 frame，要么跟 AionUi 一样定一个非标准的 RPC method 自己玩。

对 cc-remote 来说，我倾向**保留 hook 路径**，因为它和 ACP 解耦 —— 即使 daemon 切到 ACP attach 模式，hook 仍然是 CC 进程内的注入点，hook → daemon 的 socket 通道一样能用。

---

## 5. 通知怎么做

| 维度 | 实现 | 触发场景 |
|---|---|---|
| 桌面系统通知 | `process/bridge/notificationBridge.ts` — Electron `Notification` API | turn 结束、需要确认 |
| 内嵌状态条 | `MessageAgentStatus` 在消息流里 | 已连接 / 已断开 / 正在思考 |
| Toast | Arco `Message` 组件 | 错误恢复、端口占用、配对成功 |
| IM 推送 | Channel Plugin 体系（见下） | 用户人在外面，要继续聊 |

**Web push (VAPID) 没有** — 桌面 app 常驻，不需要离线唤醒。这是和我们的核心产品形态差异。

### Channel Plugin 体系（`.aionui/FEATURE_CHANNELS.md`）

把 Telegram / Lark / DingTalk / WeChat / WeCom 抽象成 plugin：

```
BasePlugin (抽象类)
├─ initialize(config) / start() / stop()
├─ sendMessage(...)         系统 → 平台
├─ editMessage(...)         流式更新已发送消息（重要）
└─ onIncomingMessage(...)   平台 → 系统
```

- 入站统一格式 `IUnifiedIncomingMessage`、出站 `IUnifiedOutgoingMessage`。
- 平台特异性（HTML vs Markdown vs Lark Card）藏在 adapter。
- **配对模型**：用户在 IM 里发消息 → bot 回配对码 + 引导用户去 AionUi 设置页 [批准] → 批准后 IM 才能用。6 位随机码 / 10 分钟过期 / 用户白名单 / Token bcrypt 加密。

---

## 6. 和 cc-remote 的对比

| | AionUi | cc-remote |
|---|---|---|
| **形态** | Electron app + WebUI 子模式 | 真 CC TUI + PWA 远程接管 |
| **谁拉起 CC** | aioncore `spawn(claude, ['--acp'])` | 用户在 tmux/终端自己跑 `claude` |
| **CC 角色** | 受控子进程，stdio 是协议通道 | 独立 TUI，自由的 |
| **怎么发提示** | `session/prompt` 写到 stdin | 不能 — 改用 PreToolUse hook 注入 |
| **怎么收回复** | stdout NDJSON | tail `~/.claude/projects/.../*.jsonl` |
| **权限审批** | CC `session/request_permission` → 前端卡 → 写回 stdin | CC PreToolUse hook → unix socket → daemon → hub → PWA |
| **Tool call 实时** | 流式 push，毫秒级 | 跟随 CC 写 jsonl 节奏（也是流式） |
| **能停止 turn** | `session/cancel`，干净 | 只能让 hook 拒绝下一次或杀进程 |
| **能换模型 / 模式** | `session/set_model` / `session/set_mode` | 不能，得用户在 TUI 里 `/model` |
| **能拿 capabilities** | `initialize` 响应里有完整结构 | 只能 sniff `~/.claude/settings.json` |
| **跨机** | 浏览器跨网段访问本机 WebUI | hub 在 docker 桥接，daemon 和 PWA 各在任意网络 |
| **离线唤醒** | 不需要（桌面常驻） | 必须（VAPID web push） |
| **多 agent** | 是核心卖点（13+ adapter） | 当前只 1 种（CC） |

### 路线本质差异

- **ACP 路线** = "把 CC 当 headless server 用"。aioncore 是 client、TUI 不存在。代价：用户失去原生 TUI；收益：程序化可控 + 多 agent 同前端。
- **jsonl 旁路路线** = "附加观测者"。CC 是用户的 TUI、daemon 旁观。代价：单向受限；收益：用户保留真 TUI 体验，PWA 是远程伴侣不是替代。

---

## 7. ACP 路线对 cc-remote 不适用（已决策）

**结论：不走 ACP**。

简短理由：
- ACP 路线的本质是把 CC 当受控子进程跑，**和 cc-remote "用户保留真 TUI、PWA 远程伴侣"的产品定位冲突**。要么放弃 TUI（变成 AionUi 同形态），要么搞模式切换（drive ↔ observe），后者实现复杂、in-flight turn 协调和 hook 去重都麻烦，收益跟不上代价。
- 跨机和离线唤醒是我们的核心场景，ACP 都不解决（它本来就只关心本机的 stdio）。
- 现有 jsonl 旁路 + PreToolUse hook 已经覆盖观测 + 注入两条路径，没有需要 ACP 才能解决的硬问题。

**但 ACP 的 message schema 仍值得借鉴**，见下面的"消息流按 ACP `SessionUpdate` 重建模"建议 — 那只是抄 schema 设计，不引入协议依赖。

---

## 8. 可借鉴清单（按性价比排序）

### A. 强烈建议借鉴

1. **消息流按 ACP `SessionUpdate` 重新建模**
   把 daemon 的 jsonl→PWA 事件流，按 ACP 的 update 类型枚举（`agent_message_chunk` / `tool_call` / `plan` / `thought_chunk` / `request_permission`）重新设计 frame schema。收益：①前端组件可直接抄 AionUi 的 6 个 Message 组件；②长期对齐开放协议，未来对接任何 ACP 客户端零成本。
   - 涉及文件：`packages/proto/frames.ts`, `packages/daemon/src/jsonl-bind.ts`

2. **`useAddOrUpdateMessage()` 同 msg_id 覆盖的流式合并**
   PWA 端的消息状态从 append-only 数组改成 `id => message` Map，React reconciler 友好（尤其工具调用更新）。
   - 参考：`packages/desktop/src/renderer/pages/conversation/Messages/hooks.ts`

3. **`agent-process-registry.json` 进程残留兜底**
   `web-host/src/agent-process-registry.ts` 把 `(pid, process_group_id, conversation_id)` 落到磁盘，daemon 冷启动遍历并 SIGTERM → grace 1s → SIGKILL。我们 daemon 也是宿主进程，断电/崩溃残留的 CC 进程场景完全适用。
   - 参考：`packages/web-host/src/agent-process-registry.ts`（157 行）

4. **`MessageAcpPermission` UX 直接抄一版**
   图标 + 命令 code block + Radio.Group + 单一确认按钮 + 已响应后的绿色 ✓ banner。140 行带 i18n。**注意它的"防重复提交"二态**：`hasResponded` + `isResponding`。
   - 参考：`packages/desktop/src/renderer/pages/conversation/Messages/acp/MessageAcpPermission.tsx`

5. **`AgentHandshake` 4 块独立元数据**
   `agent_capabilities / available_modes / available_models / available_commands` 各自独立。我们的 `slash-inventory.ts` 已经有 `available_commands` 雏形，提前留 capabilities + modes 接口比事后改省事。
   - 参考：`packages/desktop/src/common/types/agent/agentTypes.ts:50`

### B. 中等价值

6. **WebSocket 客户端**：`api/ws.ts` 145 行，指数退避 + 心跳 30s + 类型化 event/payload。和我们 PWA 现状对齐"心跳 + 自动重连"。
7. **ipcBridge / WebSocket 双后端同前端**：`@/common/electronSafe.ts` 的分层。我们如果未来要"daemon 直接服务本地 PWA、跳过 hub"的本地模式，这个分层值得抄。
8. **扩展贡献机制**：`hub.ts` 里 `IHubExtension.contributes.acpAdapters` 的声明式注册。让"加一个新 agent (Codex / Cursor / Snow CLI)"只需要写一个 JSON 而不是改代码。
9. **`MessageAgentStatus` 内嵌状态条**：把"已连接 / 已断开 / 正在思考"作为消息流的一部分而不是顶部 chip。好处：用户回滚历史能看到当时的状态。
10. **Router lazy import**：所有路由 `React.lazy`。如果首屏 bundle 大可以顺手做。

### C. 不建议照抄

- **Channel Plugin 体系（Telegram/Lark/...）** — 我们的产品定位是 "PWA 远程 CC"，不应去做 IM 集成。
- **Arco Design** — PWA 已经有自己的设计语言，不要换 UI 库。
- **强制 i18n 流水线** — 用户面是 1，i18n 还早。
- **WebUI 模式** — 我们就是 PWA + daemon，没必要在 daemon 里再嵌 web-host。
- **OpenClaw 远端 Agent**（Ed25519 配对那套） — hub 已经在做配对。

---

## 9. 落地建议

如果只挑 1 件先做：**(1) 消息流按 ACP SessionUpdate 重建模**。

理由：
- 一举对齐开放协议、AionUi 的 6 个组件、ACP 生态。
- `proto/frames.ts` 改造是几小时工作，但收益是长期。
- 改完之后 ②③④ 都顺势能做。

如果挑 2 件：再加 **(3) agent-process-registry**。daemon 健壮性立刻提升，跟 (1) 是不同维度互不干扰。

如果挑 3 件：加 **(4) `MessageAcpPermission` UX**。这个跟 AskUserQuestion 远程 relay 直接相关，PWA 卡片体验立刻提升一档。

---

## 附录 A：ACP 协议参考链接

- 规范源头：[Zed Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol)（推测 — AionUi 没明确指 spec 源，但 method 名一致）
- AionUi 类型定义：`packages/desktop/src/common/types/platform/acpTypes.ts`
- 100 行参考实现：`tests/fixtures/fake-acp-cli/index.js`

## 附录 B：本调研涉及的关键文件

| 文件 | 作用 |
|---|---|
| `packages/web-host/src/backend-launcher.ts` | aioncore spawn 逻辑 + health check |
| `packages/web-host/src/agent-process-registry.ts` | 子进程残留兜底 |
| `packages/desktop/src/process/backend/binaryResolver.ts` | aioncore 二进制定位 |
| `packages/desktop/src/common/types/platform/acpTypes.ts` | ACP 类型定义 |
| `packages/desktop/src/renderer/pages/conversation/platforms/acp/useAcpMessage.ts` | ACP session 状态机 hook |
| `packages/desktop/src/renderer/pages/conversation/Messages/acp/MessageAcpPermission.tsx` | 权限审批卡 UX |
| `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageThinking.tsx` | 思考过程展示（95 行参考） |
| `packages/desktop/src/renderer/api/ws.ts` | WS 客户端（145 行参考） |
| `tests/fixtures/fake-acp-cli/index.js` | 100 行 ACP server 参考实现 |
| `docs/guides/hub-testing.md` | ACP backend 测试指南（清楚列出 claude/codex/goose 的命令参数） |
| `.aionui/FEATURE_CHANNELS.md` | Channel Plugin 体系完整设计（1000+ 行） |
