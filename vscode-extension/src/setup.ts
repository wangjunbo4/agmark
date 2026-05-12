import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const AGMARK_BODY = `
### MCP Tools

| Tool | Purpose |
|------|---------|
| \`list_pending\` | List all open threads across the project |
| \`get_annotations(document, status?)\` | Get threads for a document |
| \`reply_to_annotation(document, threadId, body, resolve?)\` | Reply and resolve a thread |
| \`refresh_document(document)\` | Signal extension to refresh after edits |
| \`get_stats(document?)\` | Annotation statistics |

### Review workflow

1. Call \`get_annotations <document>\` to see open threads
2. Address each thread by modifying the markdown document
3. Call \`reply_to_annotation\` for each thread to mark it resolved
4. Call \`refresh_document <document>\` to sync the extension UI

### Slash command

- \`/agmark review <file>\` — shorthand for reviewing annotations on a file
`;

const CLAUDE_MD_NEW = `# AGMark

This project uses AGMark for document annotation. Annotations live in \`.comments/\` directory.
` + AGMARK_BODY;

const CLAUDE_MD_APPEND = `

## AGMark

This project uses AGMark for document annotation. Annotations live in \`.comments/\` directory.
` + AGMARK_BODY;

const COMMAND_CONTENT = `Read \`.comments/<file>.json\` for the specified markdown file. For each open thread:
1. Understand the user's annotation/comment
2. Edit \`<file>\` to address the annotation
3. Edit \`.comments/<file>.json\` to add your reply and mark the thread as "resolved"
4. After all threads are resolved, remind user to run \`agmark clean <file>\`
`;

/**
 * Run auto-setup when the extension activates. Idempotent — skips
 * steps that are already configured. Asks user once before modifying files.
 */
export async function autoSetup(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const setupDone = context.globalState.get<boolean>('agmark.setupDone', false);
  if (setupDone) return;

  const choice = await vscode.window.showInformationMessage(
    'AGMark: Auto-configure Claude Code integration (CLAUDE.md, slash command, MCP)?',
    'Yes', 'Ask Later', 'No',
  );
  if (choice !== 'Yes') {
    if (choice === 'No') context.globalState.update('agmark.setupDone', true);
    return;
  }

  let count = 0;
  if (ensureSlashCommand(workspaceRoot)) count++;
  if (ensureClaudeMd(workspaceRoot)) count++;
  if (ensureMcpConfig(context, workspaceRoot)) count++;

  if (count > 0) {
    vscode.window.showInformationMessage(`AGMark: Setup complete (${count} file(s) updated).`);
  } else {
    vscode.window.showInformationMessage('AGMark: Already configured.');
  }

  context.globalState.update('agmark.setupDone', true);
}

function ensureSlashCommand(workspaceRoot: string): boolean {
  const dir = path.join(workspaceRoot, '.claude', 'commands');
  const file = path.join(dir, 'agmark.md');
  if (fs.existsSync(file)) return false;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, COMMAND_CONTENT);
    console.log('[AGMark] Created slash command: ' + file);
    return true;
  } catch (e) {
    console.error('[AGMark] Failed to create slash command:', e);
    return false;
  }
}

function ensureClaudeMd(workspaceRoot: string): boolean {
  const file = path.join(workspaceRoot, 'CLAUDE.md');
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (content.includes('AGMark')) return false;
    try {
      fs.appendFileSync(file, CLAUDE_MD_APPEND);
      console.log('[AGMark] Appended to CLAUDE.md');
      return true;
    } catch (e) {
      console.error('[AGMark] Failed to update CLAUDE.md:', e);
      return false;
    }
  } else {
    try {
      fs.writeFileSync(file, CLAUDE_MD_NEW.trimStart());
      console.log('[AGMark] Created CLAUDE.md');
      return true;
    } catch (e) {
      console.error('[AGMark] Failed to create CLAUDE.md:', e);
      return false;
    }
  }
}

function ensureMcpConfig(context: vscode.ExtensionContext, workspaceRoot: string): boolean {
  const file = path.join(workspaceRoot, '.claude', 'settings.local.json');
  const mcpServerPath = path.join(context.extensionPath, 'mcp-server.js');

  let config: any = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { /* corrupt, overwrite */ }
  }

  if (config.mcpServers?.agentmark) return false;

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.agentmark = {
    command: 'node',
    args: [mcpServerPath],
  };

  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    console.log('[AGMark] MCP config written to ' + file);
    return true;
  } catch (e) {
    console.error('[AGMark] Failed to write MCP config:', e);
    return false;
  }
}
