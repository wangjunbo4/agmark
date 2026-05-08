import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: true });

let blockCounter = 0;
let headingStack: string[] = [];

export function renderMarkdown(content: string): string {
  blockCounter = 0;
  headingStack = [];
  return md.render(content);
}

// — Post-processing: inject data-block attributes into block-level elements —
export function injectBlockAnchors(html: string): string {
  blockCounter = 0;
  headingStack = [];

  // We use a simple regex-free approach: inject a <script> trick, or just use the browser.
  // Better: use a zero-width marker approach.
  // Actually: just return the HTML and use DOM querySelector in the browser.
  return html;
}

// — Browser-side: add data-block attributes to block elements —
// IMPORTANT: must match the indexing produced by AnchorResolver.parseParagraphs().
// We use UL/OL as atomic blocks (not LI) because the backend treats contiguous
// list items as a single paragraph. We also don't recurse into block elements
// to avoid double-counting nested blocks (e.g. <p> inside <li> or <blockquote>).
export function annotateBlocks(container: HTMLElement): void {
  let idx = 0;
  const stack: string[] = [];

  const blockTags = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'PRE', 'TABLE', 'BLOCKQUOTE', 'UL', 'OL', 'HR'];

  function walk(el: Element) {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName;
      if (blockTags.includes(tag)) {
        if (tag.startsWith('H')) {
          const level = parseInt(tag.charAt(1), 10);
          while (stack.length >= level) stack.pop();
          stack.push('#'.repeat(level) + ' ' + (child.textContent || '').trim());
        }
        (child as HTMLElement).dataset.block = String(idx);
        (child as HTMLElement).dataset.headings = encodeURIComponent(JSON.stringify([...stack]));
        idx++;
        // Don't recurse into block elements — they are atomic paragraphs
      } else {
        walk(child);
      }
    }
  }
  walk(container);
}

// — Get text content of a block (excluding badges) —
export function getBlockText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.agmark-badge').forEach((b) => b.remove());
  return clone.textContent || '';
}
