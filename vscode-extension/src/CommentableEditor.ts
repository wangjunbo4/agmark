import * as vscode from 'vscode';
import * as path from 'path';
import { CommentEngine } from './CommentEngine';
import { StorageManager } from './StorageManager';
import type { ExtensionToWebview, WebviewToExtension, CommentFile } from './types';

export class AGMarkEditorProvider implements vscode.CustomTextEditorProvider {
  private engine = new CommentEngine();
  private storage = new StorageManager();

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      'agmark.markdownPreview',
      new AGMarkEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
        ],
      };

      const documentPath = document.uri.fsPath;
      webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);

      // Track disposal to avoid posting to dead webview
      let disposed = false;
      const safePost = (msg: ExtensionToWebview) => {
        if (!disposed) {
          try { webviewPanel.webview.postMessage(msg); } catch { /* disposed */ }
        }
      };

      let latestComments: CommentFile | null = await this.storage.read(documentPath);
      let initSent = false;
      let fallbackTimer: ReturnType<typeof setTimeout>;

      const sendInit = () => {
        if (initSent || disposed) return;
        initSent = true;
        safePost({ type: 'init', documentPath, documentContent: document.getText(), comments: latestComments });
      };

      webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
        if (disposed) return;
        try {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'ready') { console.log('[AGMark] webview ready'); sendInit(); return; }
          console.log('[AGMark] received message:', msg.type, JSON.stringify(msg.payload?.anchor).substring(0, 200));
          const result = await this.handleMessage(msg, documentPath, document.getText());
          console.log('[AGMark] handleMessage result:', result ? `${result.threads.length} threads` : 'null');
          if (result && !disposed) {
            latestComments = result;
            safePost({ type: 'commentsUpdated', comments: result });
            console.log('[AGMark] sent commentsUpdated with', result.threads.length, 'threads');
          }
        } catch (err) {
          console.error('[AGMark] message error:', err);
        }
      });

      fallbackTimer = setTimeout(sendInit, 1500);

      let changeTimer: ReturnType<typeof setTimeout>;
      const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (disposed || e.document.uri.fsPath !== documentPath) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          if (!disposed) {
            safePost({ type: 'init', documentPath, documentContent: e.document.getText(), comments: latestComments });
          }
        }, 300);
      });

      webviewPanel.onDidDispose(() => {
        disposed = true;
        changeListener.dispose();
        clearTimeout(changeTimer);
        clearTimeout(fallbackTimer);
      });
    } catch (err) {
      console.error('[AGMark] resolveCustomTextEditor failed:', err);
    }
  }

  private async handleMessage(
    msg: any,
    documentPath: string,
    documentContent: string,
  ): Promise<CommentFile | null> {
    switch (msg.type) {
      case 'addThread': {
        const docParagraphs = this.engine.getResolver().parseParagraphs(documentContent);
        console.log('[AGMark] addThread: paragraphIndex=' + msg.payload.anchor.paragraphIndex + ' type=' + msg.payload.anchor.type + ' docParagraphs=' + docParagraphs.length);
        return this.engine.addThread(
          documentPath, documentContent,
          msg.payload.body,
          msg.payload.anchor.paragraphIndex,
          msg.payload.anchor.type === 'selection'
            ? {
                startOffset: msg.payload.anchor.startOffset!,
                endOffset: msg.payload.anchor.endOffset!,
                selectedText: msg.payload.anchor.selectedText!,
                endParagraphIndex: msg.payload.anchor.endParagraphIndex,
              }
            : undefined,
        );
      }
      case 'addReply':
        return this.engine.addReply(documentPath, msg.payload.threadId, msg.payload.body);
      case 'resolveThread':
        return this.engine.resolveThread(documentPath, msg.payload.threadId);
      case 'reopenThread':
        return this.engine.reopenThread(documentPath, msg.payload.threadId);
      case 'deleteThread':
        return this.engine.deleteThread(documentPath, msg.payload.threadId);
      case 'sendToClaude':
        await this.sendToClaude(documentPath, msg.payload.documentContent);
        return null;
      default:
        return null;
    }
  }

  private async sendToClaude(documentPath: string, documentContent: string): Promise<void> {
    const file = await this.storage.read(documentPath);
    if (!file || file.threads.length === 0) {
      vscode.window.showInformationMessage('No annotations to send.');
      return;
    }

    const openThreads = file.threads.filter((t) => t.status === 'open');
    if (openThreads.length === 0) {
      vscode.window.showInformationMessage('All annotations are resolved.');
      return;
    }

    const docName = path.basename(documentPath);
    const prompt = `list_pending and get_annotations for ${docName}, address each open thread`;

    // Open Claude Code sidebar + copy prompt
    await vscode.env.clipboard.writeText(prompt);
    try {
      await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    } catch {
      // Fallback: generic chat
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      } catch { /* ignore */ }
    }
    vscode.window.showInformationMessage(
      `AGMark: ${openThreads.length} open. Paste (Cmd+V) in Claude to process.`,
    );
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview.js')),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
  <title>AGMark</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:var(--vscode-editor-background,#1e1e1e);
      --fg:var(--vscode-editor-foreground,#d4d4d4);
      --border:var(--vscode-panel-border,#3c3c3c);
      --accent:var(--vscode-textLink-foreground,#3794ff);
      --badge-bg:var(--vscode-badge-background,#4d4d4d);
      --badge-fg:var(--vscode-badge-foreground,#fff);
      --input-bg:var(--vscode-input-background,#3c3c3c);
      --input-fg:var(--vscode-input-foreground,#ccc);
      --button-bg:var(--vscode-button-background,#0078d4);
      --button-fg:var(--vscode-button-foreground,#fff)
    }
    body{font-family:var(--vscode-editor-font-family,sans-serif);font-size:var(--vscode-editor-font-size,14px);background:var(--bg);color:var(--fg);height:100vh;overflow:hidden}
    #app{height:100%;display:flex;flex-direction:column}
    .agmark-preview h1{font-size:1.8em;margin:.6em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.2em}
    .agmark-preview h2{font-size:1.5em;margin:.6em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.2em}
    .agmark-preview h3{font-size:1.25em;margin:.5em 0 .2em}
    .agmark-preview p,.agmark-preview li{margin:.3em 0;line-height:1.6}
    .agmark-preview code{font-family:var(--vscode-editor-font-family,monospace);background:var(--input-bg);padding:1px 4px;border-radius:3px;font-size:.9em}
    .agmark-preview pre{background:var(--input-bg);padding:12px 16px;border-radius:6px;overflow-x:auto;margin:.5em 0}
    .agmark-preview pre code{background:none;padding:0}
    .agmark-preview blockquote{border-left:3px solid var(--accent);padding:.2em 1em;margin:.5em 0;opacity:.85}
    .agmark-preview ul,.agmark-preview ol{padding-left:2em;margin:.3em 0}
    .agmark-preview a{color:var(--accent);text-decoration:none}
    [data-block].agmark-has-threads{border-left:2px solid #3794ff;padding-left:8px;cursor:pointer}
    [data-block].agmark-has-threads:hover{background:rgba(255,255,255,0.03)}
    [data-block].agmark-hl-sel{background:rgba(100,180,255,0.18)}
    [data-block].agmark-hl-open{background:rgba(255,213,79,0.10)}
    [data-block].agmark-hl-resolved{background:rgba(76,175,80,0.06)}
    .agmark-badge{display:inline-flex;align-items:center;gap:3px;background:#4d4d4d;color:#fff;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;margin-left:6px;cursor:pointer;vertical-align:middle}
    .agmark-badge:hover{background:#3794ff}
    .agmark-hl-sel{background:rgba(100,180,255,0.22)!important}
    .agmark-hl-open{background:rgba(255,213,79,0.12)!important}
    .agmark-hl-resolved{background:rgba(76,175,80,0.08)!important}
    .agmark-text-hl{border-radius:2px}
    .agmark-text-open{background:rgba(255,213,79,0.35);border-bottom:2px solid rgba(255,180,0,0.6)}
    .agmark-text-resolved{background:rgba(76,175,80,0.18);border-bottom:2px solid rgba(76,175,80,0.4)}
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
