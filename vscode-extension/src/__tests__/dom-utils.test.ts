import { describe, it, expect } from 'vitest';
import {
  findBlockAncestor, findTextContainer, getTextContainers,
  indexOfTC, walkTextNodes, charOffsetIn, mapCharOffset,
  highlightRange, highlightBlockRange, clearHighlights, clearTempHighlight,
  TEXT_TAGS, blockIndex,
} from '../webview/dom-utils';
import { annotateBlocks, renderMarkdown as mdRender } from '../webview/renderer';

// ── Helper: create a root div and set innerHTML ──
function setup(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

// ═══════════════════════════════════════════════════════
// Basic helpers
// ═══════════════════════════════════════════════════════

describe('walkTextNodes', () => {
  it('iterates all text nodes in order', () => {
    const root = setup('<p>Hello <strong>world</strong>!</p>');
    const p = root.firstChild as Element;
    const texts: string[] = [];
    walkTextNodes(p, (node, start) => texts.push(`${start}:${node.textContent}`));
    expect(texts).toEqual(['0:Hello ', '6:world', '11:!']);
  });

  it('handles empty container', () => {
    const root = setup('<p></p>');
    const p = root.firstChild as Element;
    const texts: string[] = [];
    walkTextNodes(p, (node, start) => texts.push(node.textContent || ''));
    expect(texts).toEqual([]);
  });
});

describe('charOffsetIn', () => {
  it('returns correct offset for text node in simple paragraph', () => {
    const root = setup('<p>Hello World</p>');
    const p = root.firstChild as Element;
    const textNode = p.firstChild as Text;
    // "Hello World" - offset of 'W' should be 6
    expect(charOffsetIn(p, textNode, 6)).toBe(6);
  });

  it('returns correct offset when target node is nested in inline element', () => {
    const root = setup('<p>Hello <strong>bold</strong> text</p>');
    const p = root.firstChild as Element;
    // Find the "bold" text node inside <strong>
    const strong = p.querySelector('strong')!;
    const boldText = strong.firstChild as Text;
    // "Hello bold text" - "bold" starts at offset 6
    expect(charOffsetIn(p, boldText, 0)).toBe(6);
    expect(charOffsetIn(p, boldText, 2)).toBe(8); // "ld" within "bold"
  });

  it('returns 0 when targetNode is not in container', () => {
    const root = setup('<p>Hello</p><p>World</p>');
    const p1 = root.children[0];
    const p2Text = root.children[1].firstChild as Text;
    // p2Text is not a descendant of p1
    expect(charOffsetIn(p1, p2Text, 0)).toBe(0);
  });
});

describe('mapCharOffset', () => {
  it('maps offset to correct node in simple paragraph', () => {
    const root = setup('<p>Hello World</p>');
    const p = root.firstChild as Element;
    const result = mapCharOffset(p, 6);
    expect(result).not.toBeNull();
    expect(result!.node.textContent).toBe('Hello World');
    expect(result!.offset).toBe(6);
  });

  it('maps offset to correct node across inline elements', () => {
    const root = setup('<p>Hello <strong>bold</strong> text</p>');
    const p = root.firstChild as Element;
    // "Hello bold text" - offset 8 should be inside "bold" (at "ld")
    const result = mapCharOffset(p, 8);
    expect(result).not.toBeNull();
    expect(result!.node.textContent).toBe('bold');
    expect(result!.offset).toBe(2);
  });

  it('maps offset at exact boundary to earlier node', () => {
    const root = setup('<p>Hello <strong>world</strong></p>');
    const p = root.firstChild as Element;
    // offset 6 is the boundary between "Hello " (len 6) and "world" (len 5)
    const result = mapCharOffset(p, 6);
    expect(result).not.toBeNull();
    // Should map to "Hello " with offset 6 (right at end)
    expect(result!.node.textContent).toBe('Hello ');
    expect(result!.offset).toBe(6);
  });

  it('clamps to last valid position for out-of-range offset', () => {
    const root = setup('<p>Hi</p>');
    const p = root.firstChild as Element;
    const result = mapCharOffset(p, 100);
    // Clamped to end of "Hi": offset 2 in the "Hi" text node
    expect(result).not.toBeNull();
    expect(result!.offset).toBe(2);
    expect(result!.node.textContent).toBe('Hi');
  });
});

// ═══════════════════════════════════════════════════════
// findBlockAncestor / findTextContainer / getTextContainers
// ═══════════════════════════════════════════════════════

describe('findBlockAncestor', () => {
  it('finds the nearest ancestor with data-block', () => {
    const root = setup('<div><p data-block="3">Hello <strong>world</strong></p></div>');
    annotateBlocks(root);
    const strong = root.querySelector('strong')!;
    const textNode = strong.firstChild!;
    const block = findBlockAncestor(textNode, root);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.block).toBe('0');
  });

  it('returns null when no data-block ancestor exists', () => {
    const root = setup('<div><span>no block</span></div>');
    const span = root.querySelector('span')!;
    expect(findBlockAncestor(span.firstChild!, root)).toBeNull();
  });
});

describe('findTextContainer', () => {
  it('finds P as text container', () => {
    const root = setup('<p>Hello <strong>world</strong></p>');
    const strong = root.querySelector('strong')!;
    expect(findTextContainer(strong.firstChild!, root).tagName).toBe('P');
  });

  it('finds TD inside table as text container', () => {
    const root = setup('<table><tr><td data-block="0">cell text</td></tr></table>');
    const td = root.querySelector('td')!;
    expect(findTextContainer(td.firstChild!, root).tagName).toBe('TD');
  });
});

describe('getTextContainers', () => {
  it('returns self if element is a text container', () => {
    const root = setup('<p>text</p>');
    const p = root.firstChild as Element;
    expect(getTextContainers(p)).toEqual([p]);
  });

  it('finds all text containers inside a table block', () => {
    // annotateBlocks will assign data-block to TABLE
    const root = setup(`
      <table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
      </table>
    `);
    annotateBlocks(root);
    const table = root.querySelector('table')!;
    const tcs = getTextContainers(table);
    expect(tcs.length).toBe(4);
    expect(tcs.map(tc => tc.textContent)).toEqual(['Name', 'Age', 'Alice', '30']);
  });
});

describe('indexOfTC', () => {
  it('returns correct index of text container within block', () => {
    const root = setup(`
      <table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
      </table>
    `);
    annotateBlocks(root);
    const table = root.querySelector('table')!;
    const cells = table.querySelectorAll('td, th');
    expect(indexOfTC(table, cells[0])).toBe(0);
    expect(indexOfTC(table, cells[1])).toBe(1);
    expect(indexOfTC(table, cells[2])).toBe(2);
    expect(indexOfTC(table, cells[3])).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════
// highlightRange — core highlighting
// ═══════════════════════════════════════════════════════

describe('highlightRange', () => {
  it('highlights within a single text node (same-node path)', () => {
    const root = setup('<p>Hello World</p>');
    const p = root.firstChild as Element;
    highlightRange(p, 0, 5, 'test-hl');
    // Should produce: <span class="test-hl">Hello</span> World
    expect(p.innerHTML).toContain('<span class="test-hl">Hello</span>');
    expect(p.textContent).toBe('Hello World');
  });

  it('highlights entire text content', () => {
    const root = setup('<p>Hello</p>');
    const p = root.firstChild as Element;
    highlightRange(p, 0, 5, 'test-hl');
    expect(p.innerHTML).toContain('<span class="test-hl">Hello</span>');
    expect(p.textContent).toBe('Hello');
  });

  it('no-op when startOffset >= endOffset', () => {
    const root = setup('<p>Hello World</p>');
    const p = root.firstChild as Element;
    const original = p.innerHTML;
    highlightRange(p, 5, 5, 'test-hl');
    expect(p.innerHTML).toBe(original);
  });

  it('handles multi-node highlight across plain text nodes', () => {
    // Two adjacent text nodes (hard to create via innerHTML, so use DOM API)
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    p.appendChild(document.createTextNode('World'));
    // Total: "Hello World" (len 11)
    highlightRange(p, 3, 8, 'test-hl');
    // Should produce: Hel<span>lo Wo</span>rld
    expect(p.textContent).toBe('Hello World');
    const span = p.querySelector('span.test-hl');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('lo Wo');
  });

  // ═══ BUG REPRODUCTION: inline elements ═══

  it('handles highlight across <strong> inline element correctly', () => {
    // markdown: "Hello **bold** text" → <p>Hello <strong>bold</strong> text</p>
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    const strong = document.createElement('strong');
    strong.appendChild(document.createTextNode('bold'));
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' text'));
    // Text nodes: "Hello "(6), "bold"(4), " text"(5) → total 15 chars

    // Select from "llo " (offset 2) to "xt" (offset 13) = highlight "llo bold te"
    // startOffset=2 in "Hello ", endOffset=13 which is inside " text" at offset 2
    highlightRange(p, 2, 13, 'test-hl');

    // This is expected to work: a.node = "Hello ", b.node = " text"
    // Both are direct children of p, so the multi-node path should work.
    // But the while loop will also move the <strong> element into the span.
    // Let's see what happens...
    expect(p.textContent).toBe('Hello bold text');

    // The bug is more pronounced when b.node is NESTED inside an inline element.
    // See next test.
  });

  it('handles highlight ending inside <strong> correctly (Range API fix)', () => {
    // markdown: "Hello **bold** text" → <p>Hello <strong>bold</strong> text</p>
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    const strong = document.createElement('strong');
    strong.appendChild(document.createTextNode('bold'));
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' text'));

    // Select "Hello bo" (char 0 to 8)
    // startOffset=0 → a.node = "Hello ", a.offset = 0
    // endOffset=8 → b.node = "bold" (inside strong), b.offset = 2
    highlightRange(p, 0, 8, 'test-hl');

    // Text content preserved
    expect(p.textContent).toBe('Hello bold text');
    // The Range API correctly splits text nodes and preserves structure
    const span = p.querySelector('span.test-hl');
    expect(span).not.toBeNull();
    // Highlighted text should be in the span: "Hello bo"
    expect(span!.textContent).toBe('Hello bo');
  });

  it('handles highlight ending inside <em> with multiple inline elements', () => {
    // markdown: "a **b** c *d* e" → <p>a <strong>b</strong> c <em>d</em> e</p>
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('a '));
    const strong = document.createElement('strong');
    strong.appendChild(document.createTextNode('b'));
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' c '));
    const em = document.createElement('em');
    em.appendChild(document.createTextNode('d'));
    p.appendChild(em);
    p.appendChild(document.createTextNode(' e'));

    // Select from "a" (offset 0) to "d" (offset 7)
    highlightRange(p, 0, 7, 'test-hl');

    // Text content preserved
    expect(p.textContent).toBe('a b c d e');
    // Range API correctly extracts and wraps the selected range
    const span = p.querySelector('span.test-hl');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('a b c d');
  });
});

// ═══════════════════════════════════════════════════════
// highlightBlockRange — cross-TC within same block
// ═══════════════════════════════════════════════════════

describe('highlightBlockRange', () => {
  it('highlights across multiple text containers within same block', () => {
    // Simulate a table: 4 cells in one TABLE block
    const table = document.createElement('table');
    const row1 = document.createElement('tr');
    const td0 = document.createElement('td'); td0.textContent = 'Alpha';
    const td1 = document.createElement('td'); td1.textContent = 'Beta';
    row1.appendChild(td0); row1.appendChild(td1);
    const row2 = document.createElement('tr');
    const td2 = document.createElement('td'); td2.textContent = 'Gamma';
    const td3 = document.createElement('td'); td3.textContent = 'Delta';
    row2.appendChild(td2); row2.appendChild(td3);
    table.appendChild(row1); table.appendChild(row2);

    // Highlight from middle of TD[0] ("ph" at offset 2) to middle of TD[2] ("Gam" at offset 3)
    // TC indices: td0=0, td1=1, td2=2, td3=3
    highlightBlockRange(table, 0, 2, 2, 3, 'test-hl');

    expect(table.textContent).toBe('AlphaBetaGammaDelta');
    // td0: "Alpha" → "Al" outside highlight, "pha" inside
    expect(td0.querySelector('span.test-hl')).not.toBeNull();
    // td1: "Beta" → entirely inside highlight
    expect(td1.querySelector('span.test-hl')).not.toBeNull();
    // td2: "Gamma" → "Gam" inside highlight, "ma" outside
    expect(td2.querySelector('span.test-hl')).not.toBeNull();
    // td3 should NOT be highlighted
    expect(td3.querySelector('span.test-hl')).toBeNull();
  });

  it('highlights across multiple LIs in a UL block (checklist scenario)', () => {
    // Simulate a markdown checklist: - [x] item1 \n - [x] item2 \n - [x] item3
    const ul = document.createElement('ul');
    const li0 = document.createElement('li'); li0.textContent = '[x] 持久高亮';
    const li1 = document.createElement('li'); li1.textContent = '[x] 三级递进锚定';
    const li2 = document.createElement('li'); li2.textContent = '[x] 单元测试';
    ul.appendChild(li0); ul.appendChild(li1); ul.appendChild(li2);

    // Select from middle of li0 to middle of li2
    highlightBlockRange(ul, 0, 4, 2, 4, 'test-hl');

    expect(ul.textContent).toBe('[x] 持久高亮[x] 三级递进锚定[x] 单元测试');
    expect(li0.querySelector('span.test-hl')).not.toBeNull();
    expect(li1.querySelector('span.test-hl')).not.toBeNull();
    expect(li2.querySelector('span.test-hl')).not.toBeNull();
  });

  it('highlights when start and end are in same TC (single TC case)', () => {
    const p = document.createElement('p');
    p.textContent = 'Hello World';
    highlightBlockRange(p, 0, 0, 0, 5, 'test-hl');
    expect(p.textContent).toBe('Hello World');
    expect(p.querySelector('span.test-hl')).not.toBeNull();
    expect(p.querySelector('span.test-hl')!.textContent).toBe('Hello');
  });
});

// ═══════════════════════════════════════════════════════
// End-to-end: selection → anchor → highlight for checklist
// ═══════════════════════════════════════════════════════

describe('full selection flow for cross-LI highlighting', () => {
  it('detects block and TCs correctly for cross-LI selection', () => {
    // Render a checklist via markdown-it and annotateBlocks
    const html = mdRender('- [x] AAA\n- [x] BBB\n- [x] CCC');
    const root = document.createElement('div');
    root.innerHTML = html;
    annotateBlocks(root);

    const ul = root.querySelector('ul')!;
    expect(ul.hasAttribute('data-block')).toBe(true);
    expect((ul as HTMLElement).dataset.block).toBe('0');

    const lis = ul.querySelectorAll('li');
    expect(lis.length).toBe(3);

    // Simulate selection from "AA" (offset 4 in li0) to "BB" (offset 4 in li1)
    const anchorNode = lis[0].firstChild as Text;
    const focusNode = lis[1].firstChild as Text;

    const anchorBlock = findBlockAncestor(anchorNode, root);
    const focusBlock = findBlockAncestor(focusNode, root);
    expect(anchorBlock).toBe(ul);
    expect(focusBlock).toBe(ul);

    const anchorTC = findTextContainer(anchorNode, root);
    const focusTC = findTextContainer(focusNode, root);
    expect(anchorTC).toBe(lis[0]);
    expect(focusTC).toBe(lis[1]);

    const pIdx = blockIndex(ul);
    const startTCIdx = indexOfTC(ul, lis[0]);
    const endTCIdx = indexOfTC(ul, lis[1]);
    expect(pIdx).toBe(0);
    expect(startTCIdx).toBe(0);
    expect(endTCIdx).toBe(1);

    const so = charOffsetIn(lis[0], anchorNode, 4); // "AA" starts at offset 4 in "[x] AAA"
    const eo = charOffsetIn(lis[1], focusNode, 4); // "BB" starts at offset 4 in "[x] BBB"

    // Apply highlight
    clearHighlights(root);
    highlightBlockRange(ul, startTCIdx, so, endTCIdx, eo, 'agmark-text-hl agmark-text-open');

    // Verify highlights: li0 and li1 get highlights, li2 does not
    expect(lis[0].querySelector('span.agmark-text-hl')).not.toBeNull();
    expect(lis[1].querySelector('span.agmark-text-hl')).not.toBeNull();
    expect(lis[2].querySelector('span.agmark-text-hl')).toBeNull();
    // Verify individual LI text is preserved
    expect(lis[0].textContent).toContain('[x] AAA');
    expect(lis[1].textContent).toContain('[x] BBB');
    expect(lis[2].textContent).toContain('[x] CCC');
  });
});

// ═══════════════════════════════════════════════════════
// Reproduce: cross-block selection (H3 heading → UL list)
// using actual DESIGN.md Phase 1 content
// ═══════════════════════════════════════════════════════

describe('cross-block selection: heading into checklist', () => {
  it('highlights from H3 heading text into UL list items', () => {
    const md = '- [x] AAA\n- [x] BBB\n- [x] 单元测试（vitest + jsdom, 71 tests）';
    const html = mdRender('### Phase 1\n\n' + md + '\n\n### Phase 2');
    const root = document.createElement('div');
    root.innerHTML = html;
    annotateBlocks(root);

    // After annotateBlocks: H3(Phase1)=0, UL=1, H3(Phase2)=2
    const h3_0 = root.querySelector('h3')!;
    const ul = root.querySelector('ul')!;
    const lis = ul.querySelectorAll('li');

    expect((h3_0 as HTMLElement).dataset.block).toBe('0');
    expect((ul as HTMLElement).dataset.block).toBe('1');

    // Simulate selection from "Phase" (offset 0) in H3 to "单元测试" (offset 4) in li[2]
    const anchorNode = h3_0.firstChild as Text;  // "### Phase 1..."
    const focusNode = lis[2].firstChild as Text; // "[x] 单元测试（vitest + jsdom, 71 tests）"

    const anchorBlock = findBlockAncestor(anchorNode, root)!;
    const focusBlock = findBlockAncestor(focusNode, root)!;
    expect(anchorBlock).toBe(h3_0);
    expect(focusBlock).toBe(ul);

    const pIdx = blockIndex(anchorBlock);      // 0
    const endPIdx = blockIndex(focusBlock);     // 1
    const startTCIdx = indexOfTC(h3_0, findTextContainer(anchorNode, root));
    const endTCIdx = indexOfTC(ul, findTextContainer(focusNode, root));

    const so = charOffsetIn(h3_0, anchorNode, 0);
    const eo = charOffsetIn(lis[2], focusNode, 4);

    const cls = 'agmark-text-hl agmark-text-open';
    clearHighlights(root);

    // Apply cross-block highlight (same logic as App.ts)
    const blocks = root.querySelectorAll('[data-block]');
    const firstTCs = getTextContainers(h3_0);
    highlightBlockRange(h3_0, startTCIdx, so, firstTCs.length - 1, 99999, cls);
    // No intermediate blocks (1..0)
    highlightBlockRange(ul, 0, 0, endTCIdx, eo, cls);

    // Verify: H3 should have highlight
    expect(h3_0.querySelector('span.agmark-text-hl')).not.toBeNull();
    // All three LIs should have highlights
    expect(lis[0].querySelector('span.agmark-text-hl')).not.toBeNull();
    expect(lis[1].querySelector('span.agmark-text-hl')).not.toBeNull();
    expect(lis[2].querySelector('span.agmark-text-hl')).not.toBeNull();
    // Phase 2 H3 should NOT have highlights
    const h3_1 = root.querySelectorAll('h3')[1];
    expect(h3_1.querySelector('span.agmark-text-hl')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// Edge case: whitespace text nodes between block children
// ═══════════════════════════════════════════════════════

describe('findTextContainer edge cases', () => {
  it('falls back to data-block text container for whitespace node between LIs', () => {
    // Simulate the whitespace text node that markdown-it produces between <li>s
    const ul = document.createElement('ul');
    (ul as HTMLElement).dataset.block = '0';
    const li0 = document.createElement('li'); li0.textContent = 'AAA';
    const li1 = document.createElement('li'); li1.textContent = 'BBB';
    ul.appendChild(li0);
    ul.appendChild(document.createTextNode('\n')); // whitespace between LIs
    ul.appendChild(li1);
    const root = document.createElement('div');
    root.appendChild(ul);

    // The whitespace text node is a child of UL but not inside any LI
    const wsNode = ul.childNodes[1]; // the '\n' text node
    expect(wsNode.nodeType).toBe(Node.TEXT_NODE);

    const tc = findTextContainer(wsNode, root);
    // Should return an LI (first text container in the UL block), not root
    expect(tc.tagName).toBe('LI');
  });
});

// ═══════════════════════════════════════════════════════
// clearHighlights / clearTempHighlight
// ═══════════════════════════════════════════════════════

describe('clearHighlights', () => {
  it('unwraps highlight spans and restores text', () => {
    const root = setup('<div><p>Hello <span class="agmark-text-hl">World</span></p></div>');
    clearHighlights(root);
    expect(root.querySelector('.agmark-text-hl')).toBeNull();
    expect(root.querySelector('p')!.textContent).toBe('Hello World');
  });
});

describe('clearTempHighlight', () => {
  it('only unwraps temp highlights, not permanent ones', () => {
    const root = setup(`
      <div>
        <p>Hello <span class="agmark-temp-hl agmark-temp-sel">temp</span></p>
        <p>World <span class="agmark-text-hl agmark-text-open">perm</span></p>
      </div>
    `);
    clearTempHighlight(root);
    expect(root.querySelector('.agmark-temp-hl')).toBeNull();
    expect(root.querySelector('.agmark-text-hl')).not.toBeNull();
    expect(root.textContent).toContain('perm');
    expect(root.textContent).toContain('temp');
  });
});
