# AGMark — AI Agent 可批注的 Markdown 交互系统

## 是什么

在 VSCode 中选中文字即可批注，Claude 通过 MCP 工具在同一会话中直接处理。`.comments/` 目录是唯一的通信协议。

## 核心洞察

### 批注是临时的

和 PR Review Comment 一样，批注是**审查周期内的通信工具**，不是文档的永久附属物。

```
选中文字 → 批注 → Claude MCP 工具处理 → 修改文档 → 提交 → agmark clean
─────────────────────────────────────────────────────────────────────→
                        一个审查周期
```

### 文件即协议

不建服务器、不建数据库。人类用 AgentMark (VSCode) 读写，Claude 通过 MCP 工具读写 `.comments/` 下的 JSON 文件。

```
project/
├── .comments/
│   ├── design.md.json          ← 批注数据
│   └── architecture.md.json
├── design.md
└── architecture.md
```

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                  Claude Code（同一会话）             │
│                                                     │
│  MCP Tools: get_annotations / reply / list_pending  │
└──────────────────────┬──────────────────────────────┘
                       │ MCP (stdio)
┌──────────────────────▼──────────────────────────────┐
│              mcp-server.js (Node.js)                │
│              VSCode Extension                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              .comments/ 目录（文件协议）             │
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
Level 2: 文本指纹模糊匹配（前缀编辑距离 + Jaccard + trigram Dice）
    ↓ 失败
Level 3: 孤立 — UI 标记 "⚠️ 段落已变更"
```

### 段落模型

前后端共享同一段落模型：

- **H1-H6 是段落**：标题可被选中和批注
- **TABLE/UL/OL 是原子段落**：整个表格/列表计为一个段落，内部 TD/LI 作为独立 text container
- **不递归进入 block 元素**：避免嵌套 block 被重复计数

---

## MCP Tools

| Tool | 参数 | 作用 |
|------|------|------|
| `get_annotations` | document, status? | 获取文档结构化批注 |
| `reply_to_annotation` | document, threadId, body, resolve? | 回复并解决批注 |
| `list_pending` | — | 扫描项目所有待解决批注 |
| `get_stats` | document? | 批注统计 |

---

## VSCode Extension（Phase 1）

### 交互模型

选中文字 → 自动弹出 CommentBar → Ctrl+Enter 提交。支持跨元素选择（跨段落、跨表格单元格、标题+正文等）。

### 高亮

| 状态 | 颜色 |
|------|------|
| 选中中 | 蓝色（临时） |
| 批注 open | 金色（持久） |
| 批注 resolved | 绿色（持久） |

### Claude Code 集成

| 方式 | 说明 |
|------|------|
| MCP Tools | Claude 主动调用 `get_annotations` / `reply_to_annotation` / `list_pending` / `get_stats` |
| `/agmark review` | Claude 内斜杠命令 |
| Ask Claude 按钮 | 打开 Claude Code 侧栏 |
| Stop Hook | Claude 每次响应后检测 `.comments/` 中待处理批注 |
| CLAUDE.md | Claude 会话始终知道 AgentMark 协议 |

### 技术栈

TypeScript + Preact (webview) + markdown-it + esbuild。测试 vitest + jsdom，纯终端运行，不依赖 VSCode。

---

## 项目结构

```
agmark/
├── Cargo.toml                        # Rust workspace
├── crates/
│   ├── core/                         # agmark-core（types, storage, anchor, engine）
│   ├── cli/                          # agmark CLI（clap 10 子命令）
│   └── tui/                          # agmark-tui（ratatui 双面板 TUI）
├── vscode-extension/                 # VSCode 扩展
│   ├── mcp-server.js                 # MCP 服务器（stdio）
│   ├── src/
│   │   ├── extension.ts              # 入口
│   │   ├── StorageManager.ts         # .comments/ 读写
│   │   ├── AnchorResolver.ts         # 三级锚定
│   │   ├── CommentEngine.ts          # 批注 CRUD
│   │   ├── CommentableEditor.ts      # CustomTextEditorProvider
│   │   ├── __tests__/                # 单元测试（vitest + jsdom）
│   │   └── webview/
│   │       ├── App.ts                # Preact UI
│   │       ├── renderer.ts           # markdown-it + annotateBlocks
│   │       └── dom-utils.ts          # DOM 文本操作 + 高亮
│   └── dist/                         # esbuild 构建产物
├── .claude/commands/agmark.md        # /agmark slash command
├── CLAUDE.md
└── DESIGN.md
```

---

## 分阶段计划

### Phase 1：VSCode Extension + MCP — 已完成

- [x] Selection-only 交互（跨元素、跨段落）
- [x] 持久高亮（选中=蓝色 / open=金色 / resolved=绿色）
- [x] 三级递进锚定
- [x] `.comments/` 读写
- [x] MCP Server（4 tools，Node.js stdio）
- [x] Claude Code 集成（Ask Claude、`/agmark review`、Stop Hook、CLAUDE.md）
- [x] 单元测试（vitest + jsdom, 71 tests）

### Phase 2：Rust Core + CLI + TUI — 已完成

- [x] Cargo workspace + agmark-core
- [x] `agmark` CLI（init, clean, view, list, add, reply, resolve, reopen, check, stats）
- [x] `agmark-tui` 终端交互浏览器（ratatui，双面板，vim 键位）
- [ ] Git hook 集成（post-commit 自动清理）

### Phase 3：增强（按需）

- [ ] Post-commit 自动清理
- [ ] 锚点漂移批量修复工具
