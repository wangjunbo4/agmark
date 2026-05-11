# AGMark

Interactive markdown annotation system for AI agent collaboration. Select text in VSCode to annotate — Claude processes annotations in the same session via MCP tools.

## Workflow

```
Select text → Annotate → Send to Claude → MCP processes → Edit document → clean
───────────────────────────────────────────────────────────────────────────────→
                           One review cycle
```

## Quick Start

### VSCode Extension

```bash
cd vscode-extension
npm install
npm run build
```

Right-click any `.md` file → `AGMark Preview`, or use the command palette: `AGMark: Init Annotations`.

### Rust CLI

```bash
cargo build --release
./target/release/agmark --help
```

### MCP Server

Register in your Claude Code configuration:

```json
{
  "mcpServers": {
    "agentmark": {
      "command": "node",
      "args": ["path/to/vscode-extension/mcp-server.js"]
    }
  }
}
```

## Project Structure

```
agmark/
├── crates/                   # Rust workspace
│   ├── core/                 #   Annotation storage, anchor resolution, engine
│   ├── cli/                  #   agmark CLI (10 subcommands)
│   └── tui/                  #   agmark-tui terminal browser
├── vscode-extension/         # VSCode extension
│   ├── src/
│   │   ├── webview/          #   Preact UI + highlight engine
│   │   ├── __tests__/        #   Unit tests (vitest + jsdom)
│   │   ├── AnchorResolver.ts #   Three-level anchor resolution
│   │   └── CommentableEditor.ts
│   └── mcp-server.js         # MCP server (stdio)
├── docs/                     # Design documentation
└── README.md
```

## Anchor Strategy

Three-level progressive resolution to survive document edits:

1. **Heading path + paragraph index** — 100% accurate when structure is unchanged
2. **Fuzzy text fingerprint matching** — prefix edit distance + Jaccard + trigram Dice
3. **Orphan** — degraded marker: "paragraph changed"

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_pending` | List all open threads across the project |
| `get_annotations(document, status?)` | Get threads for a document |
| `reply_to_annotation(document, threadId, body, resolve?)` | Reply and resolve a thread |
| `refresh_document(document)` | Signal the extension to refresh after edits |
| `get_stats(document?)` | Annotation statistics |

## Tests

```bash
cd vscode-extension
npm test          # vitest run (79 tests, terminal-only)
npm run test:watch
```

## Documentation

- [Design document](docs/DESIGN.md) — data format, architecture, roadmap
