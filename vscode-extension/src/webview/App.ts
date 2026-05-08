import { h, render } from 'preact';
import { useEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import { renderMarkdown, annotateBlocks } from './renderer';
import type { CommentFile } from './types';

const vscode = acquireVsCodeApi();
function truncate(t: string, n: number): string { return t.length <= n ? t : t.substring(0, n) + '...'; }

// ── State ──
interface SelInfo {
  pIdx: number;                  // start paragraph index
  startOffset: number;
  endParagraphIdx: number;       // end paragraph index (same as pIdx if single paragraph)
  endOffset: number;             // offset within end paragraph
  text: string;
}
interface State {
  docContent: string; comments: CommentFile | null;
  activeId: string | null; filter: string;
  sel: SelInfo | null;            // pending selection for comment bar
}
type Action =
  | { t: 'init'; dc: string; cm: CommentFile | null }
  | { t: 'upd'; cm: CommentFile }
  | { t: 'thr'; id: string | null }
  | { t: 'fil'; f: string }
  | { t: 'sel'; s: SelInfo | null };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'init': return { ...s, docContent: a.dc, comments: a.cm, sel: null };
    case 'upd':  return { ...s, comments: a.cm };
    case 'thr':  return { ...s, activeId: a.id };
    case 'fil':  return { ...s, filter: a.f, activeId: null };
    case 'sel':  return { ...s, sel: a.s };
    default:     return s;
  }
}

// ── DOM text-node helpers ──

/** Find the nearest ancestor block element (one with data-block) */
function findBlockAncestor(node: Node, root: Element): Element | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && (n as Element).hasAttribute('data-block')) return n as Element;
    n = n.parentNode;
  }
  return null;
}

/** Get block index from a data-block element */
function blockIndex(el: Element): number {
  return parseInt((el as HTMLElement).dataset.block || '', 10);
}

/** Walk text nodes within container (skipping existing highlight spans), calling fn for each */
function walkTextNodes(container: Element, fn: (node: Text, charStart: number) => void): void {
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement?.closest('.agmark-text-hl') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    fn(node as Text, offset);
    offset += (node.textContent || '').length;
  }
}

/** Compute character offset of (targetNode, targetOffset) within container */
function charOffsetIn(container: Element, targetNode: Node, targetOffset: number): number {
  let result = -1;
  walkTextNodes(container, (node, charStart) => {
    if (node === targetNode) result = charStart + targetOffset;
  });
  return result >= 0 ? result : 0;
}

/** Map a character offset to {node, offsetWithinNode} */
function mapCharOffset(container: Element, target: number): { node: Text; offset: number } | null {
  let prev: { node: Text; start: number; len: number } | null = null;
  walkTextNodes(container, (node, charStart) => {
    const len = (node.textContent || '').length;
    if (prev === null && target >= charStart && target <= charStart + len) {
      prev = { node, start: charStart, len };
    }
  });
  if (!prev) return null;
  return { node: prev.node, offset: target - prev.start };
}

/** Wrap [startOffset, endOffset] within container in a <span class="..."> */
function highlightRange(container: Element, startOffset: number, endOffset: number, cls: string): void {
  if (startOffset >= endOffset) return;
  const a = mapCharOffset(container, startOffset);
  const b = mapCharOffset(container, endOffset);
  if (!a || !b) return;

  if (a.node === b.node) {
    const t = a.node.textContent || '';
    const before = t.substring(0, a.offset), mid = t.substring(a.offset, b.offset), after = t.substring(b.offset);
    const parent = a.node.parentNode!;
    const span = document.createElement('span'); span.className = cls; span.textContent = mid;
    parent.insertBefore(document.createTextNode(before), a.node);
    parent.insertBefore(span, a.node);
    parent.insertBefore(document.createTextNode(after), a.node);
    parent.removeChild(a.node);
    return;
  }

  // Multi-node: split start, build span, collect nodes in between, split end
  const span = document.createElement('span'); span.className = cls;

  // Split start node
  const st = a.node.textContent || '';
  a.node.textContent = st.substring(0, a.offset);
  const startTail = document.createTextNode(st.substring(a.offset));
  a.node.parentNode!.insertBefore(startTail, a.node.nextSibling);
  span.appendChild(startTail);

  // Collect middle nodes
  let cur: Node | null = span.lastChild!.nextSibling;
  while (cur) {
    if (cur === b.node) break;
    const next: Node | null = cur.nextSibling;
    span.appendChild(cur);
    cur = next;
  }

  // Handle end node
  const et = b.node.textContent || '';
  b.node.textContent = et.substring(0, b.offset);
  span.appendChild(b.node);
  if (et.substring(b.offset)) {
    span.parentNode!.insertBefore(document.createTextNode(et.substring(b.offset)), span.nextSibling);
  }

  // Insert span after start node
  a.node.parentNode!.insertBefore(span, a.node.nextSibling);
}

/** Unwrap all .agmark-text-hl spans, then normalize */
function clearHighlights(root: Element): void {
  root.querySelectorAll('.agmark-text-hl').forEach((span) => {
    const p = span.parentNode; if (!p) return;
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
  });
  root.normalize();
}

// ── App ──
function App() {
  const [s, d] = useReducer(reducer, { docContent: '', comments: null, activeId: null, filter: 'open', sel: null });
  const ref = useRef<HTMLDivElement>(null);

  // Init
  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const h = (e: MessageEvent) => {
      const m = e.data; if (!m || typeof m !== 'object') return;
      console.log('[AGMark:webview] rx:', m.type);
      if (m.type === 'init') d({ t: 'init', dc: m.documentContent, cm: m.comments });
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

    annotateBlocks(root); // ensure data-block attrs are fresh

    const anchorBlock = findBlockAncestor(sel.anchorNode!, root);
    const focusBlock = findBlockAncestor(sel.focusNode!, root);
    if (!anchorBlock || !focusBlock) return;

    const anchorIdx = blockIndex(anchorBlock);
    const focusIdx = blockIndex(focusBlock);

    // Ensure anchor < focus
    let startBlock: Element, endBlock: Element, startIdx: number, endIdx: number;
    let anchorIsStart: boolean;
    const pos = sel.anchorNode!.compareDocumentPosition(sel.focusNode!);
    if (anchorIdx < focusIdx || (anchorIdx === focusIdx && sel.anchorOffset <= sel.focusOffset)) {
      startBlock = anchorBlock; endBlock = focusBlock;
      startIdx = anchorIdx; endIdx = focusIdx;
      anchorIsStart = true;
    } else {
      startBlock = focusBlock; endBlock = anchorBlock;
      startIdx = focusIdx; endIdx = anchorIdx;
      anchorIsStart = false;
    }

    const startOff = anchorIsStart
      ? charOffsetIn(startBlock, sel.anchorNode!, sel.anchorOffset)
      : charOffsetIn(startBlock, sel.focusNode!, sel.focusOffset);
    const endOff = anchorIsStart
      ? charOffsetIn(endBlock, sel.focusNode!, sel.focusOffset)
      : charOffsetIn(endBlock, sel.anchorNode!, sel.anchorOffset);

    const si: SelInfo = { pIdx: startIdx, startOffset: startOff, endParagraphIdx: endIdx, endOffset: endOff, text: raw };
    console.log('[AGMark:webview] sel: p' + startIdx + '[' + startOff + '] -> p' + endIdx + '[' + endOff + ']', JSON.stringify(raw.substring(0, 40)));
    d({ t: 'sel', s: si });
  };
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.addEventListener('mouseup', onMouseUp);
    return () => el.removeEventListener('mouseup', onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.docContent]);

  // ── Derived ──
  const html = useMemo(() => renderMarkdown(s.docContent), [s.docContent]);
  const threads = s.comments?.threads || [];
  const filtered = s.filter === 'all' ? threads : threads.filter(t => t.status === s.filter);
  const stats = { open: threads.filter(t => t.status === 'open').length, resolved: threads.filter(t => t.status === 'resolved').length, total: threads.length };

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

    if (threads.length === 0) return;

    for (const t of threads) {
      const cls = t.status === 'open' ? 'agmark-text-hl agmark-text-open' : 'agmark-text-hl agmark-text-resolved';
      const pIdx = t.anchor.paragraphIndex;
      const endPIdx = t.anchor.endParagraphIndex ?? pIdx;
      const so = t.anchor.startOffset ?? 0;

      // Add has-threads class to all involved blocks
      const blocks = el.querySelectorAll('[data-block]');
      for (let i = pIdx; i <= endPIdx; i++) {
        const block = blocks[i] as HTMLElement | undefined;
        if (block) block.classList.add('agmark-has-threads');
      }

      if (t.anchor.type !== 'selection' || t.anchor.endOffset == null) continue;

      const eo = t.anchor.endOffset;

      // Text-level highlight
      if (pIdx === endPIdx) {
        // Single paragraph
        const block = blocks[pIdx] as HTMLElement | undefined;
        if (block) highlightRange(block, so, eo, cls);
      } else {
        // Cross-paragraph: highlight start paragraph tail, middle paragraphs, end paragraph head
        const startBlock = blocks[pIdx] as HTMLElement | undefined;
        const endBlock = blocks[endPIdx] as HTMLElement | undefined;
        if (startBlock) highlightRange(startBlock, so, startBlock.textContent?.length || 99999, cls);
        for (let i = pIdx + 1; i < endPIdx; i++) {
          const mb = blocks[i] as HTMLElement | undefined;
          if (mb) highlightRange(mb, 0, mb.textContent?.length || 99999, cls);
        }
        if (endBlock) highlightRange(endBlock, 0, eo, cls);
      }
    }
    console.log('[AGMark:webview] highlights applied, threads=' + threads.length);
  }, [html, threads]);

  // Submit
  const submit = (body: string) => {
    if (!body.trim() || !s.sel) return;
    const { pIdx, startOffset, endParagraphIdx, endOffset, text } = s.sel;
    const isXPara = endParagraphIdx !== pIdx;
    console.log('[AGMark:webview] submit: p' + pIdx + '->p' + endParagraphIdx + ' off=' + startOffset + '-' + endOffset + ' txt=' + JSON.stringify(text.substring(0, 40)));
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
        },
        body,
      },
    });
    d({ t: 'sel', s: null });
  };

  // Actions
  const doResolve = (t: { id: string; status: string }) => {
    vscode.postMessage({ type: t.status === 'open' ? 'resolveThread' : 'reopenThread', payload: { threadId: t.id } });
  };
  const doDelete = (threadId: string) => {
    console.log('[AGMark:webview] delete:', threadId);
    vscode.postMessage({ type: 'deleteThread', payload: { threadId } });
    if (s.activeId === threadId) d({ t: 'thr', id: null });
  };

  // ── Render ──
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'var(--vscode-editor-font-family,sans-serif)', fontSize: '14px', color: '#d4d4d4', background: '#1e1e1e', overflow: 'hidden' } },
    // Header
    h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #3c3c3c', flexShrink: 0 } },
      h('span', { style: { fontWeight: 600 } }, 'AGMark'),
      h('span', { style: { fontSize: '12px', opacity: 0.7 } }, 'open:' + stats.open + ' resolved:' + stats.resolved),
    ),
    // Main
    h('div', { style: { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 } },
      // Preview
      h('div', { ref, style: { flex: 1, overflow: 'auto', padding: '16px 24px', borderRight: '1px solid #3c3c3c', lineHeight: 1.7 }, dangerouslySetInnerHTML: { __html: html } }),
      // Sidebar
      h('div', { style: { width: '320px', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 } },
        // Tabs
        h('div', { style: { display: 'flex', gap: '4px', padding: '8px 12px', borderBottom: '1px solid #3c3c3c' } },
          h('button', { onClick: () => d({ t: 'fil', f: 'open' }), style: tabStyle(s.filter === 'open') }, 'Open(' + stats.open + ')'),
          h('button', { onClick: () => d({ t: 'fil', f: 'resolved' }), style: tabStyle(s.filter === 'resolved') }, 'Resolved(' + stats.resolved + ')'),
          h('button', { onClick: () => d({ t: 'fil', f: 'all' }), style: tabStyle(s.filter === 'all') }, 'All(' + stats.total + ')'),
        ),
        // Thread list
        h('div', { style: { flex: 1, overflow: 'auto', padding: '8px' } },
          filtered.length === 0
            ? h('div', { style: { padding: '20px', textAlign: 'center', opacity: 0.5, fontSize: '13px' } }, 'No threads')
            : filtered.map(t => h('div', {
                key: t.id,
                onClick: () => d({ t: 'thr', id: t.id }),
                style: { padding: '8px', border: '1px solid #3c3c3c', borderRadius: '4px', marginBottom: '6px', cursor: 'pointer', background: s.activeId === t.id ? 'rgba(255,255,255,0.06)' : 'transparent' },
              },
              h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
                t.status + ' · ' + (t.anchor.type === 'selection' ? 'sel' : 'P' + (t.anchor.paragraphIndex + 1))),
              h('div', { style: { fontSize: '13px', opacity: 0.8 } }, truncate(t.comments[0]?.body || '', 120)),
              t.comments.length > 1 ? h('div', { style: { fontSize: '11px', opacity: 0.4, marginTop: '4px' } }, (t.comments.length - 1) + ' replies') : null,
              s.activeId === t.id ? h('div', { style: { marginTop: '8px', borderTop: '1px solid #3c3c3c', paddingTop: '8px' } },
                t.comments.map(c => h('div', { key: c.id, style: { marginBottom: '6px' } },
                  h('strong', { style: { fontSize: '12px' } }, c.author + ': '),
                  h('span', { style: { fontSize: '13px' } }, c.body),
                )),
                h('button', { onClick: (e: Event) => { e.stopPropagation(); doResolve(t); }, style: btnStyle }, t.status === 'open' ? 'Resolve' : 'Reopen'),
                h('button', { onClick: (e: Event) => { e.stopPropagation(); doDelete(t.id); }, style: { ...btnStyle, color: '#f44336', marginLeft: '6px' } }, 'Delete'),
              ) : null,
            ))
        ),
        // Comment bar
        h('div', { style: { flexShrink: 0, padding: '10px 12px', borderTop: '2px solid #3794ff', background: '#1e1e1e' } },
          s.sel ? h('div', null,
            h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
              'Comment on ' + (s.sel.endParagraphIdx !== s.sel.pIdx
                ? 'P' + (s.sel.pIdx + 1) + '–P' + (s.sel.endParagraphIdx + 1)
                : 'P' + (s.sel.pIdx + 1))),
            h('div', { style: { padding: '4px 8px', marginBottom: '6px', borderLeft: '3px solid #3794ff', fontSize: '11px', fontStyle: 'italic', background: 'rgba(255,255,255,0.05)' } },
              '"' + truncate(s.sel.text, 120) + '"'),
            h('textarea', { id: 'agmark-input', style: { width: '100%', padding: '8px', border: '1px solid #3c3c3c', borderRadius: '4px', background: '#3c3c3c', color: '#ccc', fontFamily: 'inherit', fontSize: '13px', resize: 'vertical', boxSizing: 'border-box' }, placeholder: 'Write... Ctrl+Enter to submit', rows: 2, onKeyDown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { submit((e.target as HTMLTextAreaElement).value); (e.target as HTMLTextAreaElement).value = ''; }
              if (e.key === 'Escape') d({ t: 'sel', s: null });
            } }),
            h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
              h('button', { onClick: () => d({ t: 'sel', s: null }), style: btnStyle }, 'Dismiss'),
              h('button', { onClick: () => { const ta = document.getElementById('agmark-input') as HTMLTextAreaElement; if (ta) { submit(ta.value); ta.value = ''; } }, style: { ...btnStyle, background: '#0078d4', color: '#fff', border: 'none' } }, 'Comment'),
            ),
          ) : h('div', { style: { fontSize: '12px', textAlign: 'center', opacity: 0.4, padding: '16px 0' } }, 'Select text to comment'),
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
