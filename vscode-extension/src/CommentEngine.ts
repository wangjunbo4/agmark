import { StorageManager } from './StorageManager';
import { AnchorResolver } from './AnchorResolver';
import type { CommentFile, CommentThread, Comment, CommentAnchor, ResolvedAnchor } from './types';

let nextId = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

export class CommentEngine {
  private storage = new StorageManager();
  private resolver = new AnchorResolver();

  /** Expose resolver for debugging */
  getResolver(): AnchorResolver { return this.resolver; }

  /** Get or create a comment file */
  async getOrCreate(documentPath: string, documentContent: string): Promise<CommentFile> {
    let file = await this.storage.read(documentPath);
    if (!file) {
      file = await this.storage.init(documentPath, documentContent);
    }
    return file;
  }

  /** Add a new comment thread */
  async addThread(
    documentPath: string,
    documentContent: string,
    body: string,
    paragraphIndex: number,
    selection?: { startOffset: number; endOffset: number; selectedText: string; endParagraphIndex?: number },
  ): Promise<CommentFile> {
    const file = await this.getOrCreate(documentPath, documentContent);

    let anchor: CommentAnchor;
    if (selection) {
      anchor = this.resolver.buildSelectionAnchor(
        documentContent, paragraphIndex,
        selection.startOffset, selection.endOffset, selection.selectedText,
      );
      if (selection.endParagraphIndex != null && selection.endParagraphIndex !== paragraphIndex) {
        anchor.endParagraphIndex = selection.endParagraphIndex;
      }
    } else {
      anchor = this.resolver.buildAnchor(documentContent, paragraphIndex);
    }

    const thread: CommentThread = {
      id: genId('thr'),
      status: 'open',
      anchor,
      comments: [
        {
          id: genId('cmt'),
          author: 'user',
          body,
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    file.threads.push(thread);
    await this.storage.save(documentPath, file);
    return file;
  }

  /** Add a reply to an existing thread */
  async addReply(
    documentPath: string,
    threadId: string,
    body: string,
    author: string = 'user',
  ): Promise<CommentFile> {
    const file = await this.storage.read(documentPath);
    if (!file) throw new Error('No comment file found');

    const thread = file.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    thread.comments.push({
      id: genId('cmt'),
      author,
      body,
      createdAt: new Date().toISOString(),
    });
    thread.updatedAt = new Date().toISOString();

    await this.storage.save(documentPath, file);
    return file;
  }

  /** Resolve a thread */
  async resolveThread(documentPath: string, threadId: string): Promise<CommentFile> {
    return this.setThreadStatus(documentPath, threadId, 'resolved');
  }

  /** Reopen a thread */
  async reopenThread(documentPath: string, threadId: string): Promise<CommentFile> {
    return this.setThreadStatus(documentPath, threadId, 'open');
  }

  /** Delete a thread */
  async deleteThread(documentPath: string, threadId: string): Promise<CommentFile> {
    const file = await this.storage.read(documentPath);
    if (!file) throw new Error('No comment file found');

    file.threads = file.threads.filter((t) => t.id !== threadId);
    await this.storage.save(documentPath, file);
    return file;
  }

  private async setThreadStatus(
    documentPath: string,
    threadId: string,
    status: 'open' | 'resolved' | 'wontfix',
  ): Promise<CommentFile> {
    const file = await this.storage.read(documentPath);
    if (!file) throw new Error('No comment file found');

    const thread = file.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    thread.status = status;
    thread.updatedAt = new Date().toISOString();
    await this.storage.save(documentPath, file);
    return file;
  }

  /** Re-resolve all anchors against the current document content */
  refreshAnchors(documentPath: string, documentContent: string): CommentFile | null {
    // This is a read-only check — returns the file with updated confidence
    // but does not save. The caller decides what to do.
    return null; // For MVP, handled by resolver in the frontend
  }

  /** Get stats for a comment file */
  getStats(file: CommentFile): { total: number; open: number; resolved: number; wontfix: number } {
    const stats = { total: 0, open: 0, resolved: 0, wontfix: 0 };
    for (const thread of file.threads) {
      stats.total++;
      if (thread.status === 'open') stats.open++;
      else if (thread.status === 'resolved') stats.resolved++;
      else if (thread.status === 'wontfix') stats.wontfix++;
    }
    return stats;
  }

  /** Clean up (delete) the comment file */
  async clean(documentPath: string): Promise<boolean> {
    return this.storage.delete(documentPath);
  }
}
