// Webview-side type definitions (mirrors shared types)
// Duplicated here because the webview bundle is separate from the extension bundle.

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
  startTCIdx?: number;          // text container index within the paragraph block
  endTCIdx?: number;            // text container index for end paragraph
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

export type ExtensionToWebview =
  | { type: 'init'; documentPath: string; documentContent: string; comments: CommentFile | null; xdotoolAvailable: boolean }
  | { type: 'commentsUpdated'; comments: CommentFile };

export type WebviewToExtension =
  | { type: 'addThread'; payload: { anchor: Omit<CommentAnchor, 'confidence'>; body: string } }
  | { type: 'addReply'; payload: { threadId: string; body: string } }
  | { type: 'resolveThread'; payload: { threadId: string } }
  | { type: 'reopenThread'; payload: { threadId: string } }
  | { type: 'deleteThread'; payload: { threadId: string } }
  | { type: 'sendToClaude'; payload: { documentContent: string } }
  | { type: 'requestRefresh' };
