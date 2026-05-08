# AgentMark — AI Agent 可批注的 Markdown 交互系统

## 是什么

将 Claude Code Plan Mode 的交互式批注体验泛化为通用工具。在 VSCode 中选中文字即可批注，Claude 通过 MCP 工具在同一会话中直接处理，无需文件转圈。

## 核心洞察

### 批注是临时的

和 PR Review Comment 一样，批注是**审查周期内的通信工具**，不是文档的永久附属物。

```
选中文字 → 批注 → Claude MCP 工具处理 → 修改文档 → 提交 → agmark clean
─────────────────────────────────────────────────────────────────────→
                        一个审查周期
```

### 文件即协议

`.comments/` 目录是唯一的通信协议。不建服务器、不建数据库。

```
project/
├── .comments/
│   ├── design.md.json          ← 批注数据
│   └── architecture.md.json
├── design.md
└── architecture.md
```

人类用 AgentMark (VSCode) 读写，Claude 通过 MCP 工具读写。同一份数据，零依赖。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                  Claude Code（同一会话）               │
│                                                     │
│  MCP Tools: get_annotations / reply / list_pending  │
└──────────────────────┬──────────────────────────────┘
                       │ MCP (stdio)
┌──────────────────────▼──────────────────────────────┐
│              mcp-server.js (Node.js)                 │
│              VSCode Extension                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              .comments/ 目录（文件协议）               │
└─────────────────────────────────────────────────────┘
```

---

## 数据格式

```jsonc
// .comments/design.md.json
{
  "version": 1,
  "document": "design.md",
  "snapshot": {
    "documentHash": "sha256:...",
    "createdAt": "2026-05-07T10:00:00Z"
  },
  "threads": [
    {
      "id": "thr_xxx",
      "status": "open",                    // open | resolved
      "anchor": {
        "type": "selection",               // selection | heading-path
        "headingPath": ["## 总体架构"],
        "paragraphIndex": 2,
        "startOffset": 10,                 // selection 专用
        "endOffset": 24,
        "selectedText": "微服务架构",
        "contentHash": "a3f8b2c1",
        "textFingerprint": "系统采用微服务...",
        "confidence": 1.0
      },
      "comments": [
        {
          "id": "cmt_xxx",
          "author": "user",
          "body": "为什么选微服务？",
          "createdAt": "2026-05-07T10:05:00Z"
        }
      ]
    }
  ]
}
```

---

## 锚定策略：三级递进

```
Level 1: 标题路径 + 段落索引（结构不变时 100% 准确）
    ↓ 失败
Level 2: 文本指纹模糊匹配（前缀 + Jaccard + trigram）
    ↓ 失败
Level 3: 孤立 — UI 标记 "⚠️ 段落已变更"
```

---

## MCP Tools

Claude 在同一会话中可主动调用的工具：

| Tool | 参数 | 作用 |
|------|------|------|
| `get_annotations` | document, status? | 获取文档结构化批注 |
| `reply_to_annotation` | document, threadId, body, resolve? | 回复并解决批注 |
| `list_pending` | — | 扫描项目所有待解决批注 |
| `get_stats` | document? | 批注统计 |

Claude 会话开始时自动调用 `list_pending`，编辑文件前调用 `get_annotations`，处理完调用 `reply_to_annotation`。上下文始终在同一会话中，不丢失。

配置：`~/.claude/settings.json` 中的 `mcpServers.agentmark`。

---

## VSCode Extension（Phase 1 — 已完成）

### 交互模型：仅选择

预览是纯只读。唯一批注入口：选中文字。支持跨元素选择（标题+正文、正文+代码块等）。

```
选中文字 → 自动弹出 CommentBar → 输入 → Ctrl+Enter 提交
                                       → Esc 取消（空内容不产生批注）
```

### 高亮

| 状态 | 颜色 |
|------|------|
| 选中中 | 🟡 亮黄色（临时） |
| 批注 open | 🟠 暖橙色（持久） |
| 批注 resolved | 🟢 浅绿色（持久） |

### 激活方式

- 命令面板：`AgentMark: Init Annotations` / `Open Preview` / `Clean Annotations`
- 右键菜单：`.md` 文件 → `AgentMark Preview`
- 编辑器标题栏：💬 图标按钮

### 技术栈

TypeScript + Preact (webview) + markdown-it + esbuild，target `node10`。

### Claude Code 集成

| 方式 | 触发 | 说明 |
|------|------|------|
| **MCP Tools** | Claude 主动调用 | `get_annotations` / `reply_to_annotation` / `list_pending` / `get_stats` |
| **Ask Claude 按钮** | 人类点击 | 打开 Claude Code 侧栏 + 复制提示词到剪贴板 |
| **`/agmark review`** | Claude 内输入 | 斜杠命令，当前会话内处理 |
| **Stop Hook** | 自动 | Claude 每次响应后检测 `.comments/` 中待处理批注 |
| **CLAUDE.md** | 会话初始化 | Claude 始终知道 AgentMark 协议 |

---

## 项目结构

```
agmark/
├── Cargo.toml                        # Rust workspace
├── crates/
│   ├── core/                         # agmark-core
│   │   └── src/
│   │       ├── types.rs              # 数据结构（与 JSON schema 一致）
│   │       ├── storage.rs            # .comments/ 读写
│   │       ├── anchor.rs             # markdown 解析 + 锚定
│   │       └── engine.rs             # 批注 CRUD
│   └── cli/                          # agmark CLI
│       └── src/
│           └── main.rs               # clap 10 子命令
├── vscode-extension/                 # VSCode 扩展
│   ├── package.json
│   ├── esbuild.config.js
│   ├── mcp-server.js                 # MCP 服务器
│   ├── dist/
│   └── src/
│       ├── extension.ts              # 入口
│       ├── StorageManager.ts
│       ├── AnchorResolver.ts
│       ├── CommentEngine.ts
│       ├── CommentableEditor.ts
│       └── webview/
│           ├── renderer.ts           # markdown-it 锚点注入
│           └── App.ts                # Preact UI
├── .claude/
│   └── commands/agmark.md            # /agmark slash command
├── CLAUDE.md
└── DESIGN.md
```

---

## 分阶段计划

### Phase 1：VSCode Extension + MCP — 已完成

- [x] Selection-only 交互（跨元素支持）
- [x] 持久高亮（选中=蓝色 / open=亮黄 / resolved=绿色）
- [x] 三级递进锚定
- [x] `.comments/` 读写
- [x] MCP Server（4 tools，Node.js stdio）
- [x] Ask Claude 按钮（一键打开 Claude Code）
- [x] `/agmark review` 斜杠命令
- [x] CLAUDE.md 指令 + Stop Hook
- [x] Crash 修复（disposed guard, 稳定监听器, 定时器清理）

### Phase 2：Rust Core + CLI + TUI — 已完成

- [x] Cargo workspace + agmark-core（types, storage, anchor, engine）
- [x] `agmark` CLI（init, clean, view, list, add, reply, resolve, reopen, check, stats）
- [x] `agmark-tui` 终端交互浏览器（ratatui，双面板，vim 键位）
- [ ] Git hook 集成（post-commit 自动清理）— 待做

### Phase 3：增强（按需）

- [ ] Post-commit 自动清理
- [ ] 锚点漂移批量修复工具

---

## 交付物清单

| 组件 | 文件 | 行数 | 状态 |
|------|------|------|------|
| VSCode Extension | `vscode-extension/src/` | 1,735 | ✅ |
| MCP Server | `vscode-extension/mcp-server.js` | 264 | ✅ |
| Rust Core | `crates/core/src/` | 583 | ✅ |
| CLI | `crates/cli/src/main.rs` | 282 | ✅ |
| TUI | `crates/tui/src/main.rs` | 330 | ✅ |
| 斜杠命令 | `.claude/commands/agmark.md` | — | ✅ |
| 项目文档 | `CLAUDE.md` + `DESIGN.md` | — | ✅ |
| **总计** | | **~3,200** | |
