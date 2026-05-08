export interface CommentAnchor {
  type: 'heading-path' | 'selection';
  headingPath: string[];
  paragraphIndex: number;
  contentHash: string;
  textFingerprint: string;
  confidence: number;
  startOffset?: number;
  endOffset?: number;
  endParagraphIndex?: number;   // cross-paragraph: last paragraph index
  selectedText?: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  editedAt?: string;
}

export interface CommentThread {
  id: string;
  status: 'open' | 'resolved' | 'wontfix';
  anchor: CommentAnchor;
  tags?: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface CommentFile {
  version: 1;
  document: string;
  snapshot: {
    gitCommit?: string;
    documentHash: string;
    createdAt: string;
  };
  updatedAt: string;
  threads: CommentThread[];
}

// ── Webview protocol ──

export type ExtensionToWebview =
  | {
      type: 'init';
      documentPath: string;
      documentContent: string;
      comments: CommentFile | null;
    }
  | {
      type: 'commentsUpdated';
      comments: CommentFile;
    };

export type WebviewToExtension =
  | {
      type: 'addThread';
      payload: {
        anchor: Omit<CommentAnchor, 'confidence'>;
        body: string;
      };
    }
  | {
      type: 'addReply';
      payload: {
        threadId: string;
        body: string;
      };
    }
  | {
      type: 'resolveThread';
      payload: {
        threadId: string;
      };
    }
  | {
      type: 'reopenThread';
      payload: {
        threadId: string;
      };
    }
  | {
      type: 'deleteThread';
      payload: {
        threadId: string;
      };
    }
  | {
      type: 'sendToClaude';
      payload: {
        documentContent: string;
      };
    };

// ── Anchor resolution ──

export interface ResolvedAnchor {
  paragraphIndex: number;
  confidence: number;
  matchLevel: 1 | 2; // 1 = structural, 2 = fuzzy
  content: string;
}
