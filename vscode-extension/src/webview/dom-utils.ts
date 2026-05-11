// DOM text-node helpers extracted from App.ts for testability.
// These functions are pure DOM logic with no VSCode or Preact dependencies.

// Block elements for backend paragraph alignment (must match annotateBlocks blockTags)
// Text containers for DOM-level text operations (innermost text-containing elements)
export const TEXT_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'DT', 'DD'];

/** Find the nearest ancestor block element (one with data-block — for paragraph index) */
export function findBlockAncestor(node: Node, root: Element): Element | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && (n as Element).hasAttribute('data-block')) return n as Element;
    n = n.parentNode;
  }
  return null;
}

/** Find the closest text container element (for character offset calculation) */
export function findTextContainer(node: Node, root: Element): Element {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && TEXT_TAGS.includes((n as Element).tagName)) return n as Element;
    n = n.parentNode;
  }
  // Fallback: if we reached root without finding a text container, the node
  // might be a whitespace text node between block children (e.g. between <li>s).
  // Walk up from the original node to the nearest data-block, then take its
  // first/last text container depending on position.
  let fallback: Node | null = node;
  while (fallback && fallback !== root) {
    if (fallback.nodeType === 1 && (fallback as Element).hasAttribute('data-block')) {
      const tcs = getTextContainers(fallback as Element);
      if (tcs.length > 0) return tcs[0];
    }
    fallback = fallback.parentNode;
  }
  return root;
}

/** Get block index from a data-block element */
export function blockIndex(el: Element): number {
  return parseInt((el as HTMLElement).dataset.block || '', 10);
}

/** Get all text containers within a block element, in document order */
export function getTextContainers(block: Element): Element[] {
  if (TEXT_TAGS.includes(block.tagName)) return [block];
  const result: Element[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => TEXT_TAGS.includes((n as Element).tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  let n: Node | null;
  while ((n = walker.nextNode())) result.push(n as Element);
  return result;
}

/** Find the index of a text container within its parent block */
export function indexOfTC(block: Element, tc: Element): number {
  return getTextContainers(block).indexOf(tc);
}

/** Walk all text nodes within container (raw text, including highlight spans), calling fn for each */
export function walkTextNodes(container: Element, fn: (node: Text, charStart: number) => void): void {
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    fn(node as Text, offset);
    offset += (node.textContent || '').length;
  }
}

/** Compute character offset of (targetNode, targetOffset) within container */
export function charOffsetIn(container: Element, targetNode: Node, targetOffset: number): number {
  let result = -1;
  walkTextNodes(container, (node, charStart) => {
    if (node === targetNode) result = charStart + targetOffset;
  });
  return result >= 0 ? result : 0;
}

/** Map a character offset to {node, offsetWithinNode}. Clamps to last valid position. */
export function mapCharOffset(container: Element, target: number): { node: Text; offset: number } | null {
  let result: { node: Text; offset: number } | null = null;
  let lastNode: Text | null = null;
  let lastEnd = 0;
  walkTextNodes(container, (node, charStart) => {
    const len = (node.textContent || '').length;
    lastNode = node;
    lastEnd = charStart + len;
    if (result === null && target >= charStart && target <= charStart + len) {
      result = { node, offset: target - charStart };
    }
  });
  // Clamp to end: if target is past all text, return last position
  if (!result && lastNode && target >= lastEnd) {
    result = { node: lastNode, offset: lastNode.textContent?.length || 0 };
  }
  return result;
}

/** Wrap [startOffset, endOffset] within container in a <span class="..."> */
export function highlightRange(container: Element, startOffset: number, endOffset: number, cls: string): void {
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

  // Multi-node: use Range API to correctly handle nested inline elements
  // (e.g. <strong>, <em>, <code>) — the old manual tree walk failed when
  // b.node was nested inside an inline element and not a direct sibling of a.node.
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);

  const span = document.createElement('span');
  span.className = cls;
  span.appendChild(range.extractContents());
  range.insertNode(span);
}

/**
 * Highlight a range that may span multiple text containers within the same block.
 * This is the common case for table selections (cross-cell) and other multi-TC blocks.
 */
export function highlightBlockRange(
  block: Element | undefined,
  startTCIdx: number, startOffset: number,
  endTCIdx: number, endOffset: number,
  cls: string,
): void {
  if (!block) return;
  const tcs = getTextContainers(block);
  if (startTCIdx === endTCIdx) {
    const tc = tcs[startTCIdx];
    if (tc) highlightRange(tc, startOffset, endOffset, cls);
    return;
  }
  // First TC: from startOffset to end
  const firstTC = tcs[startTCIdx];
  if (firstTC) highlightRange(firstTC, startOffset, firstTC.textContent?.length || 99999, cls);
  // Intermediate TCs: entire content
  for (let i = startTCIdx + 1; i < endTCIdx; i++) {
    const tc = tcs[i];
    if (tc) highlightRange(tc, 0, tc.textContent?.length || 99999, cls);
  }
  // Last TC: from 0 to endOffset
  const lastTC = tcs[endTCIdx];
  if (lastTC) highlightRange(lastTC, 0, endOffset, cls);
}

/** Unwrap all .agmark-text-hl spans (permanent), then normalize */
export function clearHighlights(root: Element): void {
  root.querySelectorAll('.agmark-text-hl').forEach((span) => {
    const p = span.parentNode; if (!p) return;
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
  });
  root.normalize();
}

/** Unwrap all .agmark-temp-hl spans (temporary selection) */
export function clearTempHighlight(root: Element): void {
  root.querySelectorAll('.agmark-temp-hl').forEach((span) => {
    const p = span.parentNode; if (!p) return;
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
  });
  root.normalize();
}
