import * as vscode from 'vscode';
import * as path from 'path';
import { AGMarkEditorProvider } from './CommentableEditor';
import { CommentEngine } from './CommentEngine';
import { StorageManager } from './StorageManager';

export function activate(context: vscode.ExtensionContext) {
  console.log('[AGMark] EXTENSION ACTIVATED v' + (context.extension?.packageJSON?.version || '?'));
  const engine = new CommentEngine();
  const storage = new StorageManager();

  // Register the custom editor provider
  context.subscriptions.push(AGMarkEditorProvider.register(context));

  // Command: Init Annotations
  context.subscriptions.push(
    vscode.commands.registerCommand('agmark.init', async (uri?: vscode.Uri) => {
      const document = await resolveDocument(uri);
      if (!document) return;

      const exists = await storage.exists(document.uri.fsPath);
      if (exists) {
        const overwrite = await vscode.window.showWarningMessage(
          'Annotations already exist for this file. Overwrite?',
          'Yes',
          'No',
        );
        if (overwrite !== 'Yes') return;
      }

      await engine.getOrCreate(document.uri.fsPath, document.getText());
      vscode.window.showInformationMessage(
        `AGMark: Annotations initialized for ${path.basename(document.uri.fsPath)}`,
      );

      // Open the preview
      await vscode.commands.executeCommand(
        'vscode.openWith',
        document.uri,
        'agmark.markdownPreview',
      );
    }),
  );

  // Command: Open Preview
  context.subscriptions.push(
    vscode.commands.registerCommand('agmark.openPreview', async (uri?: vscode.Uri) => {
      const document = await resolveDocument(uri);
      if (!document) return;

      await vscode.commands.executeCommand(
        'vscode.openWith',
        document.uri,
        'agmark.markdownPreview',
      );
    }),
  );

  // Command: Clean Annotations
  context.subscriptions.push(
    vscode.commands.registerCommand('agmark.cleanAnnotations', async (uri?: vscode.Uri) => {
      const document = await resolveDocument(uri);
      if (!document) return;

      const file = await storage.read(document.uri.fsPath);
      if (!file) {
        vscode.window.showInformationMessage('No annotations to clean.');
        return;
      }

      const openCount = file.threads.filter((t) => t.status === 'open').length;
      if (openCount > 0) {
        const proceed = await vscode.window.showWarningMessage(
          `${openCount} thread(s) still open. Clean anyway?`,
          'Clean All',
          'Cancel',
        );
        if (proceed !== 'Clean All') return;
      }

      await storage.delete(document.uri.fsPath);
      vscode.window.showInformationMessage(
        `AGMark: Annotations cleaned for ${path.basename(document.uri.fsPath)}`,
      );
    }),
  );
}

async function resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | null> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    return editor.document;
  }
  vscode.window.showWarningMessage('No markdown file selected.');
  return null;
}

export function deactivate() {}
