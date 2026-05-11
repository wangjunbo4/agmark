import { describe, it, expect } from 'vitest';
import { renderMarkdown, annotateBlocks, getBlockText } from '../webview/renderer';
import { AnchorResolver } from '../AnchorResolver';

// ═══════════════════════════════════════════════════════
// renderMarkdown
// ═══════════════════════════════════════════════════════

describe('renderMarkdown', () => {
  it('renders plain paragraphs', () => {
    const html = renderMarkdown('Hello World');
    expect(html).toContain('<p>Hello World</p>');
  });

  it('renders headings', () => {
    const html = renderMarkdown('# Title');
    expect(html).toContain('<h1>Title</h1>');
  });

  it('renders bold and italic', () => {
    const html = renderMarkdown('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders code blocks', () => {
    const html = renderMarkdown('```\ncode\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>code\n</code>');
  });

  it('renders lists', () => {
    const html = renderMarkdown('- item 1\n- item 2');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item 1</li>');
  });
});

// ═══════════════════════════════════════════════════════
// annotateBlocks
// ═══════════════════════════════════════════════════════

describe('annotateBlocks', () => {
  it('assigns sequential data-block indices to content block elements', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('Para 1\n\nPara 2\n\nPara 3');
    annotateBlocks(root);

    const blocks = root.querySelectorAll('[data-block]');
    expect(blocks.length).toBe(3);
    expect((blocks[0] as HTMLElement).dataset.block).toBe('0');
    expect((blocks[1] as HTMLElement).dataset.block).toBe('1');
    expect((blocks[2] as HTMLElement).dataset.block).toBe('2');
  });

  it('assigns data-block to headings (backend now includes them as paragraphs)', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('# Title\n\nParagraph one.\n\n## Subtitle\n\nParagraph two.');
    annotateBlocks(root);

    const h1 = root.querySelector('h1')!;
    const h2 = root.querySelector('h2')!;
    expect(h1.hasAttribute('data-block')).toBe(true);
    expect(h2.hasAttribute('data-block')).toBe(true);

    // All 4 block elements should have data-block: H1, P, H2, P
    const blocks = root.querySelectorAll('[data-block]');
    expect(blocks.length).toBe(4);
  });

  it('assigns data-block to TABLE as atomic block', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter');
    annotateBlocks(root);

    const blocks = root.querySelectorAll('[data-block]');
    const tableBlock = root.querySelector('table')!;
    expect(tableBlock.hasAttribute('data-block')).toBe(true);

    // Table cells should NOT have data-block themselves (TABLE is the block)
    const tdBlocks = root.querySelectorAll('td[data-block], th[data-block]');
    expect(tdBlocks.length).toBe(0);
  });

  it('assigns data-block to UL/OL as atomic block (not individual LI)', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('- item 1\n- item 2\n- item 3');
    annotateBlocks(root);

    const ul = root.querySelector('ul')!;
    expect(ul.hasAttribute('data-block')).toBe(true);
    const liBlocks = root.querySelectorAll('li[data-block]');
    expect(liBlocks.length).toBe(0);
  });

  it('assigns data-headings with heading path to content blocks', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('# H1\n\n## H2\n\nparagraph');
    annotateBlocks(root);

    // H1=0, H2=1, P=2 — all get data-block and data-headings
    const para = root.querySelector('p')!;
    expect((para as HTMLElement).dataset.block).toBe('2');
    const headingsRaw = (para as HTMLElement).dataset.headings;
    expect(headingsRaw).toBeDefined();
    const headings = JSON.parse(decodeURIComponent(headingsRaw!));
    expect(headings).toEqual(['# H1', '## H2']);
  });

  it('does not assign data-block to inline elements', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('**bold** and *italic*');
    annotateBlocks(root);

    const strong = root.querySelector('strong')!;
    const em = root.querySelector('em')!;
    expect(strong.hasAttribute('data-block')).toBe(false);
    expect(em.hasAttribute('data-block')).toBe(false);
  });

  it('handles blockquote', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('> quoted text');
    annotateBlocks(root);

    const bq = root.querySelector('blockquote')!;
    expect(bq.hasAttribute('data-block')).toBe(true);
  });

  it('idempotent — re-annotating restarts from 0', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('A\n\nB');
    annotateBlocks(root);
    annotateBlocks(root); // second call should reassign
    const first = root.querySelector('[data-block]')!;
    expect((first as HTMLElement).dataset.block).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════
// Paragraph alignment between annotateBlocks and AnchorResolver
// ═══════════════════════════════════════════════════════

describe('paragraph index alignment (webview vs backend)', () => {
  it('produces same number of blocks as backend paragraphs (headings included)', () => {
    const md = '# Title\n\nParagraph one.\n\n## Sub\n\nParagraph two.\n\n- list 1\n- list 2';
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(md);
    annotateBlocks(root);

    const blockCount = root.querySelectorAll('[data-block]').length;
    const resolver = new AnchorResolver();
    const paras = resolver.parseParagraphs(md);

    // Both should count 5: H1, P1, H2, P2, UL (headings are now paragraphs)
    expect(blockCount).toBe(5);
    expect(blockCount).toBe(paras.length);
  });

  it('TABLE block index matches backend paragraph index', () => {
    const md = 'Before table.\n\n| Name | Age |\n|------|-----|\n| Alice | 30 |\n\nAfter table.';
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(md);
    annotateBlocks(root);

    const blocks = root.querySelectorAll('[data-block]');
    // blocks[0] = P "Before table.", blocks[1] = TABLE, blocks[2] = P "After table."
    const tableBlock = root.querySelector('table')!;
    expect((tableBlock as HTMLElement).dataset.block).toBe('1');

    const resolver2 = new AnchorResolver();
    const paras = resolver2.parseParagraphs(md);
    expect(paras[1].content).toContain('| Name | Age |');
  });
});

// ═══════════════════════════════════════════════════════
// getBlockText
// ═══════════════════════════════════════════════════════

describe('getBlockText', () => {
  it('returns text content without badge elements', () => {
    const el = document.createElement('div');
    el.innerHTML = 'Hello <span class="agmark-badge">(1)</span> World';
    expect(getBlockText(el)).toBe('Hello  World');
  });
});
