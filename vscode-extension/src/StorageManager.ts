import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CommentFile } from './types';

export class StorageManager {
  /** Get the .comments/ directory for a given document */
  private getCommentsDir(documentPath: string): vscode.Uri {
    const dir = path.dirname(documentPath);
    return vscode.Uri.file(path.join(dir, '.comments'));
  }

  /** Get the comment file URI for a document */
  private getCommentFileUri(documentPath: string): vscode.Uri {
    const baseName = path.basename(documentPath);
    const dir = this.getCommentsDir(documentPath);
    return vscode.Uri.file(path.join(dir.fsPath, `${baseName}.json`));
  }

  /** Compute SHA256 hash of content */
  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
  }

  /** Compute full SHA256 hash */
  computeFullHash(content: string): string {
    return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  }

  /** Check if a comment file exists for the document */
  async exists(documentPath: string): Promise<boolean> {
    const uri = this.getCommentFileUri(documentPath);
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a new comment file (init) */
  async init(documentPath: string, documentContent: string): Promise<CommentFile> {
    const uri = this.getCommentFileUri(documentPath);
    const dir = this.getCommentsDir(documentPath);

    // Ensure .comments/ directory exists
    await vscode.workspace.fs.createDirectory(dir);

    // Try to get current git commit
    let gitCommit: string | undefined;
    try {
      const gitDir = path.dirname(documentPath);
      // Simple git rev-parse via workspace
      // We skip this if git is not available
    } catch {
      // Not a git repo, skip
    }

    const commentFile: CommentFile = {
      version: 1,
      document: path.basename(documentPath),
      snapshot: {
        gitCommit,
        documentHash: this.computeFullHash(documentContent),
        createdAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
      threads: [],
    };

    await this.save(documentPath, commentFile);
    return commentFile;
  }

  /** Read the comment file */
  async read(documentPath: string): Promise<CommentFile | null> {
    const uri = this.getCommentFileUri(documentPath);
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(data).toString('utf-8')) as CommentFile;
    } catch {
      return null;
    }
  }

  /** Save the comment file */
  async save(documentPath: string, commentFile: CommentFile): Promise<void> {
    const uri = this.getCommentFileUri(documentPath);
    const dir = this.getCommentsDir(documentPath);

    // Ensure directory exists
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // Already exists
    }

    commentFile.updatedAt = new Date().toISOString();
    const data = Buffer.from(JSON.stringify(commentFile, null, 2), 'utf-8');
    await vscode.workspace.fs.writeFile(uri, data);
  }

  /** Delete the comment file (clean) */
  async delete(documentPath: string): Promise<boolean> {
    const uri = this.getCommentFileUri(documentPath);
    try {
      await vscode.workspace.fs.delete(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** List all comment files in the project */
  async listAll(workspaceRoot: string): Promise<string[]> {
    const commentsDir = vscode.Uri.file(path.join(workspaceRoot, '.comments'));
    try {
      const files = await vscode.workspace.fs.readDirectory(commentsDir);
      return files
        .filter(([name]) => name.endsWith('.json'))
        .map(([name]) => name.replace(/\.json$/, '.md'));
    } catch {
      return [];
    }
  }

  /** Check if document has changed since snapshot */
  async hasChanged(documentPath: string, documentContent: string): Promise<boolean> {
    const commentFile = await this.read(documentPath);
    if (!commentFile) return false;
    const currentHash = this.computeFullHash(documentContent);
    return currentHash !== commentFile.snapshot.documentHash;
  }
}
