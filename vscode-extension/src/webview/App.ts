import { h, render } from 'preact';
import { useEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import { renderMarkdown, annotateBlocks } from './renderer';
import type { CommentFile } from './types';
import {
  findBlockAncestor, findTextContainer, blockIndex,
  getTextContainers, indexOfTC, charOffsetIn,
  highlightRange, highlightBlockRange, clearHighlights, clearTempHighlight,
} from './dom-utils';

const vscode = acquireVsCodeApi();
function truncate(t: string, n: number): string { return t.length <= n ? t : t.substring(0, n) + '...'; }

// ── State ──
interface SelInfo {
  mode: 'selection' | 'paragraph';  // text selection or paragraph-level comment
  pIdx: number;
  startOffset: number;
  startTCIdx: number;
  endParagraphIdx: number;
  endOffset: number;
  endTCIdx: number;
  text: string;                      // selected text (selection) or paragraph preview (paragraph)
}
interface State {
  docContent: string; comments: CommentFile | null;
  activeId: string | null; filter: 'open' | 'resolved' | 'all';
  sel: SelInfo | null;
  xdotoolAvailable: boolean;
}
type Action =
  | { t: 'init'; dc: string; cm: CommentFile | null; xd: boolean }
  | { t: 'upd'; cm: CommentFile }
  | { t: 'thr'; id: string | null }
  | { t: 'fil'; f: 'open' | 'resolved' | 'all' }
  | { t: 'sel'; s: SelInfo | null };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'init': return { ...s, docContent: a.dc, comments: a.cm, sel: null, xdotoolAvailable: a.xd };
    case 'upd':  return { ...s, comments: a.cm };
    case 'thr':  return { ...s, activeId: a.id };
    case 'fil':  return { ...s, filter: a.f, activeId: null };
    case 'sel':  return { ...s, sel: a.s };
    default:     return s;
  }
}

// ── App ──
function App() {
  const [s, d] = useReducer(reducer, { docContent: '', comments: null, activeId: null, filter: 'open', sel: null, xdotoolAvailable: false });
  const ref = useRef<HTMLDivElement>(null);

  // Init
  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const h = (e: MessageEvent) => {
      const m = e.data; if (!m || typeof m !== 'object') return;
      console.log('[AGMark:webview] rx:', m.type);
      if (m.type === 'init') d({ t: 'init', dc: m.documentContent, cm: m.comments, xd: m.xdotoolAvailable });
      else if (m.type === 'commentsUpdated') d({ t: 'upd', cm: m.comments });
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  // Selection → open comment bar
  const onMouseUp = () => {
    const sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
    const raw = sel.toString().trim(); if (!raw) return;
    const root = ref.current; if (!root) return;

    annotateBlocks(root);

    // Paragraph blocks (for backend alignment)
    const anchorBlock = findBlockAncestor(sel.anchorNode!, root);
    const focusBlock = findBlockAncestor(sel.focusNode!, root);
    if (!anchorBlock || !focusBlock) return;

    // Text containers (for DOM offsets)
    const anchorTC = findTextContainer(sel.anchorNode!, root);
    const focusTC = findTextContainer(sel.focusNode!, root);
    const anchorTCIdx = indexOfTC(anchorBlock, anchorTC);
    const focusTCIdx = indexOfTC(focusBlock, focusTC);

    const anchorBlkIdx = blockIndex(anchorBlock);
    const focusBlkIdx = blockIndex(focusBlock);

    // Determine which end is start vs end
    let startBlkIdx: number, endBlkIdx: number, startTCIdx: number, endTCIdx: number;
    let so: number, eo: number;
    if (anchorBlkIdx < focusBlkIdx || (anchorBlkIdx === focusBlkIdx && (
      anchorTCIdx < focusTCIdx || (anchorTCIdx === focusTCIdx && sel.anchorOffset <= sel.focusOffset)
    ))) {
      startBlkIdx = anchorBlkIdx; endBlkIdx = focusBlkIdx;
      startTCIdx = anchorTCIdx; endTCIdx = focusTCIdx;
      so = charOffsetIn(anchorTC, sel.anchorNode!, sel.anchorOffset);
      eo = charOffsetIn(focusTC, sel.focusNode!, sel.focusOffset);
    } else {
      startBlkIdx = focusBlkIdx; endBlkIdx = anchorBlkIdx;
      startTCIdx = focusTCIdx; endTCIdx = anchorTCIdx;
      so = charOffsetIn(focusTC, sel.focusNode!, sel.focusOffset);
      eo = charOffsetIn(anchorTC, sel.anchorNode!, sel.anchorOffset);
    }

    const si: SelInfo = { mode: 'selection', pIdx: startBlkIdx, startOffset: so, startTCIdx, endParagraphIdx: endBlkIdx, endOffset: eo, endTCIdx, text: raw };
    console.log('[AGMark:webview] sel: blk' + startBlkIdx + '.tc' + startTCIdx + '[' + so + '] -> blk' + endBlkIdx + '.tc' + endTCIdx + '[' + eo + ']', JSON.stringify(raw.substring(0, 40)));
    d({ t: 'sel', s: si });
  };
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.addEventListener('mouseup', onMouseUp);
    return () => el.removeEventListener('mouseup', onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.docContent]);

  // Right-click → paragraph-level comment
  const onContextMenu = (e: MouseEvent) => {
    const root = ref.current; if (!root) return;
    annotateBlocks(root);
    // Find which block was right-clicked
    const block = findBlockAncestor(e.target as Node, root);
    if (!block) return;
    const pIdx = blockIndex(block);
    const blockText = (block as HTMLElement).textContent?.trim() || '';
    const si: SelInfo = { mode: 'paragraph', pIdx, startOffset: 0, startTCIdx: 0, endParagraphIdx: pIdx, endOffset: 0, endTCIdx: 0, text: blockText };
    d({ t: 'sel', s: si });
    e.preventDefault();
  };
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.addEventListener('contextmenu', onContextMenu);
    return () => el.removeEventListener('contextmenu', onContextMenu);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.docContent]);

  // ── Derived ──
  const html = useMemo(() => renderMarkdown(s.docContent), [s.docContent]);
  const allThreads = s.comments?.threads || [];
  const filtered = s.filter === 'all' ? allThreads : allThreads.filter(t => t.status === s.filter);
  const counts = { open: allThreads.filter(t => t.status === 'open').length, resolved: allThreads.filter(t => t.status === 'resolved').length };

  // Apply text-level highlights after render
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    annotateBlocks(el);
    clearHighlights(el);

    // Remove old block-level classes
    el.querySelectorAll('[data-block]').forEach((b) => {
      b.classList.remove('agmark-has-threads', 'agmark-hl-open', 'agmark-hl-resolved');
    });

    if (allThreads.length === 0) return;

    const blocks = el.querySelectorAll('[data-block]');
    const hlAllTCs = (blk: Element | undefined, cls: string) => {
      if (!blk) return;
      for (const tc of getTextContainers(blk)) highlightRange(tc, 0, tc.textContent?.length || 99999, cls);
    };

    for (const t of allThreads) {
      const cls = t.status === 'open' ? 'agmark-text-hl agmark-text-open' : 'agmark-text-hl agmark-text-resolved';
      const { paragraphIndex: pIdx, endParagraphIndex: endPIdx, type, startOffset: so, endOffset: eo } = t.anchor;
      const endBlockIdx = endPIdx ?? pIdx;
      const startTCIdx = (t.anchor as any).startTCIdx ?? 0;
      const endTCIdx = (t.anchor as any).endTCIdx ?? 0;

      // Add has-threads class to all involved blocks
      for (let i = pIdx; i <= endBlockIdx; i++) {
        (blocks[i] as HTMLElement | undefined)?.classList.add('agmark-has-threads');
      }

      if (type !== 'selection' || eo == null) continue;

      if (pIdx === endBlockIdx) {
        // Same block — may be cross-TC (e.g. table cells)
        highlightBlockRange(
          blocks[pIdx] as HTMLElement | undefined,
          startTCIdx, so ?? 0, endTCIdx, eo, cls,
        );
      } else {
        // Cross-block: first block from startTC/offset to end, last block from start to endTC/offset
        const firstBlk = blocks[pIdx] as HTMLElement | undefined;
        const firstTCs = firstBlk ? getTextContainers(firstBlk) : [];
        highlightBlockRange(firstBlk, startTCIdx, so ?? 0, firstTCs.length - 1, 99999, cls);
        for (let i = pIdx + 1; i < endBlockIdx; i++) hlAllTCs(blocks[i] as HTMLElement | undefined, cls);
        highlightBlockRange(blocks[endBlockIdx] as HTMLElement | undefined, 0, 0, endTCIdx, eo, cls);
      }
    }
    console.log('[AGMark:webview] highlights applied, threads=' + allThreads.length);
  }, [html, allThreads]);

  // Temporary selection highlight — persists when focus moves to comment box
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    clearTempHighlight(root);
    if (!s.sel || s.sel.mode === 'paragraph') return;
    annotateBlocks(root);
    const blocks = root.querySelectorAll('[data-block]');
    const { pIdx, startTCIdx, startOffset, endParagraphIdx, endTCIdx, endOffset } = s.sel;
    const cls = 'agmark-temp-hl agmark-temp-sel';
    const hlAllTCs = (blk: Element | undefined) => {
      if (!blk) return;
      for (const tc of getTextContainers(blk)) highlightRange(tc, 0, tc.textContent?.length || 99999, cls);
    };

    if (pIdx === endParagraphIdx) {
      // Same block — may be cross-TC
      highlightBlockRange(blocks[pIdx] as HTMLElement | undefined, startTCIdx, startOffset, endTCIdx, endOffset, cls);
    } else {
      // Cross-block
      const firstBlk = blocks[pIdx] as HTMLElement | undefined;
      const firstTCs = firstBlk ? getTextContainers(firstBlk) : [];
      highlightBlockRange(firstBlk, startTCIdx, startOffset, firstTCs.length - 1, 99999, cls);
      for (let i = pIdx + 1; i < endParagraphIdx; i++) hlAllTCs(blocks[i] as HTMLElement | undefined);
      highlightBlockRange(blocks[endParagraphIdx] as HTMLElement | undefined, 0, 0, endTCIdx, endOffset, cls);
    }
  }, [s.sel]);

  // Submit
  const submit = (body: string) => {
    if (!body.trim() || !s.sel) return;
    const { mode, pIdx, startOffset, startTCIdx, endParagraphIdx, endOffset, endTCIdx, text } = s.sel;
    if (mode === 'paragraph') {
      console.log('[AGMark:webview] submit: para P' + pIdx);
      vscode.postMessage({
        type: 'addThread', payload: {
          anchor: {
            type: 'heading-path',
            headingPath: [],
            paragraphIndex: pIdx,
            contentHash: '',
            textFingerprint: '',
          },
          body,
        },
      });
    } else {
      const isXPara = endParagraphIdx !== pIdx;
      console.log('[AGMark:webview] submit: blk' + pIdx + '.tc' + startTCIdx + '->blk' + endParagraphIdx + '.tc' + endTCIdx + ' off=' + startOffset + '-' + endOffset);
      vscode.postMessage({
        type: 'addThread', payload: {
          anchor: {
            type: 'selection',
            headingPath: [],
            paragraphIndex: pIdx,
            contentHash: '',
            textFingerprint: '',
            startOffset,
            endOffset,
            endParagraphIndex: isXPara ? endParagraphIdx : undefined,
            selectedText: text,
            startTCIdx,
            endTCIdx: (pIdx !== endParagraphIdx || startTCIdx !== endTCIdx) ? endTCIdx : undefined,
          },
          body,
        },
      });
    }
    d({ t: 'sel', s: null });
  };

  // Actions
  const doDelete = (threadId: string) => {
    console.log('[AGMark:webview] delete:', threadId);
    vscode.postMessage({ type: 'deleteThread', payload: { threadId } });
    if (s.activeId === threadId) d({ t: 'thr', id: null });
  };
  const doAskClaude = () => {
    vscode.postMessage({ type: 'sendToClaude', payload: { documentContent: s.docContent } });
  };
  const doRefresh = () => {
    vscode.postMessage({ type: 'requestRefresh' });
  };

  // ── Render ──
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'var(--vscode-editor-font-family,sans-serif)', fontSize: '14px', color: '#d4d4d4', background: '#1e1e1e', overflow: 'hidden' } },
    // Header
    h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #3c3c3c', flexShrink: 0 } },
      h('span', { style: { fontWeight: 600 } }, 'AGMark'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('button', { onClick: doRefresh, style: btnStyle }, '↻'),
        counts.open > 0 ? h('button', {
          onClick: doAskClaude,
          title: s.xdotoolAvailable ? 'Auto-send to Claude Code' : 'Copy prompt + focus Claude (Cmd+V Enter to send)',
          style: { ...btnStyle, background: s.xdotoolAvailable ? '#0078d4' : '#c62828', color: '#fff', border: 'none' },
        }, 'Ask Claude') : null,
      ),
    ),
    // Main
    h('div', { style: { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 } },
      // Preview
      h('div', { ref, class: 'agmark-preview', style: { flex: 1, overflow: 'auto', padding: '16px 24px', borderRight: '1px solid #3c3c3c', lineHeight: 1.7 }, dangerouslySetInnerHTML: { __html: html } }),
      // Sidebar
      h('div', { style: { width: '320px', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 } },
        // Tabs
        h('div', { style: { display: 'flex', gap: '4px', padding: '8px 12px', borderBottom: '1px solid #3c3c3c' } },
          h('button', { onClick: () => d({ t: 'fil', f: 'open' }), style: tabStyle(s.filter === 'open') }, 'Open (' + counts.open + ')'),
          h('button', { onClick: () => d({ t: 'fil', f: 'resolved' }), style: tabStyle(s.filter === 'resolved') }, 'Resolved (' + counts.resolved + ')'),
          h('button', { onClick: () => d({ t: 'fil', f: 'all' }), style: tabStyle(s.filter === 'all') }, 'All (' + allThreads.length + ')'),
        ),
        // Thread list
        h('div', { style: { flex: 1, overflow: 'auto', padding: '8px' } },
          filtered.length === 0
            ? h('div', { style: { padding: '20px', textAlign: 'center', opacity: 0.5, fontSize: '13px' } }, 'No ' + s.filter + ' threads')
            : filtered.map(t => h('div', {
                key: t.id,
                onClick: () => d({ t: 'thr', id: t.id }),
                style: { padding: '8px', border: '1px solid #3c3c3c', borderRadius: '4px', marginBottom: '6px', cursor: 'pointer', background: s.activeId === t.id ? 'rgba(255,255,255,0.06)' : 'transparent' },
              },
              h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
                t.status + ' · ' + (t.anchor.type === 'selection'
                  ? '"' + truncate(t.anchor.selectedText || '', 30) + '"'
                  : 'P' + (t.anchor.paragraphIndex + 1))),
              h('div', { style: { fontSize: '13px', opacity: 0.7 } }, truncate(t.comments[0]?.body || '', 120)),
              s.activeId === t.id ? h('div', { style: { marginTop: '8px', borderTop: '1px solid #3c3c3c', paddingTop: '8px' } },
                t.comments.map(c => h('div', { key: c.id, style: { marginBottom: '6px' } },
                  h('strong', { style: { fontSize: '12px' } }, c.author + ': '),
                  h('span', { style: { fontSize: '13px' } }, c.body),
                )),
                h('button', { onClick: (e: Event) => { e.stopPropagation(); doDelete(t.id); }, style: { ...btnStyle, color: '#f44336' } }, 'Delete'),
              ) : null,
            ))
        ),
        // Comment bar
        h('div', { style: { flexShrink: 0, padding: '10px 12px', borderTop: '2px solid #3794ff', background: '#1e1e1e' } },
          s.sel ? h('div', null,
            h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
              s.sel.mode === 'paragraph'
                ? 'Comment on P' + (s.sel.pIdx + 1)
                : 'Comment on ' + (s.sel.endParagraphIdx !== s.sel.pIdx
                  ? 'P' + (s.sel.pIdx + 1) + '–P' + (s.sel.endParagraphIdx + 1)
                  : 'P' + (s.sel.pIdx + 1))),
            s.sel.mode === 'selection' ? h('div', { style: { padding: '4px 8px', marginBottom: '6px', borderLeft: '3px solid #3794ff', fontSize: '11px', fontStyle: 'italic', background: 'rgba(255,255,255,0.05)' } },
              '"' + truncate(s.sel.text, 120) + '"') : null,
            h('textarea', { id: 'agmark-input', style: { width: '100%', padding: '8px', border: '1px solid #3c3c3c', borderRadius: '4px', background: '#3c3c3c', color: '#ccc', fontFamily: 'inherit', fontSize: '13px', resize: 'vertical', boxSizing: 'border-box' }, placeholder: 'Write... Ctrl+Enter to submit', rows: 2, onKeyDown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { submit((e.target as HTMLTextAreaElement).value); (e.target as HTMLTextAreaElement).value = ''; }
              if (e.key === 'Escape') d({ t: 'sel', s: null });
            } }),
            h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
              h('button', { onClick: () => d({ t: 'sel', s: null }), style: btnStyle }, 'Dismiss'),
              h('button', { onClick: () => { const ta = document.getElementById('agmark-input') as HTMLTextAreaElement; if (ta) { submit(ta.value); ta.value = ''; } }, style: { ...btnStyle, background: '#0078d4', color: '#fff', border: 'none' } }, 'Comment'),
            ),
          ) : h('div', { style: { fontSize: '12px', textAlign: 'center', opacity: 0.4, padding: '16px 0' } }, 'Select text or right-click a paragraph to comment'),
        ),
      ),
    ),
  );
}

const tabStyle = (active: boolean) => ({
  padding: '4px 10px', border: '1px solid #3c3c3c', borderRadius: '4px', background: active ? '#0078d4' : 'transparent', color: active ? '#fff' : 'inherit', cursor: 'pointer', fontSize: '12px',
} as const);
const btnStyle = { padding: '3px 8px', border: '1px solid #3c3c3c', borderRadius: '3px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px' } as const;

try { const el = document.getElementById('app'); if (el) render(h(App, null), el); } catch (err) { console.error(err); }
