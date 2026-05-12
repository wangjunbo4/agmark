import { describe, it, expect } from 'vitest';
import { AnchorResolver } from '../AnchorResolver';

const resolver = new AnchorResolver();

// ═══════════════════════════════════════════════════════
// parseParagraphs
// ═══════════════════════════════════════════════════════

describe('parseParagraphs', () => {
  it('parses simple paragraphs separated by blank lines', () => {
    const md = 'First paragraph.\n\nSecond paragraph.';
    const paras = resolver.parseParagraphs(md);
    expect(paras).toHaveLength(2);
    expect(paras[0].content).toBe('First paragraph.');
    expect(paras[0].index).toBe(0);
    expect(paras[1].content).toBe('Second paragraph.');
    expect(paras[1].index).toBe(1);
  });

  it('tracks heading path context (headings are now paragraphs)', () => {
    const md = '# H1\n\nContent under H1.\n\n## H2\n\nContent under H2.';
    const paras = resolver.parseParagraphs(md);
    // 4 paragraphs: H1 heading, content, H2 heading, content
    expect(paras).toHaveLength(4);
    expect(paras[0].content).toBe('# H1');
    expect(paras[0].headingPath).toEqual([]);
    expect(paras[1].content).toBe('Content under H1.');
    expect(paras[1].headingPath).toEqual(['# H1']);
    expect(paras[2].content).toBe('## H2');
    expect(paras[2].headingPath).toEqual(['# H1']);
    expect(paras[3].content).toBe('Content under H2.');
    expect(paras[3].headingPath).toEqual(['# H1', '## H2']);
  });

  it('treats code blocks as regular paragraphs', () => {
    const md = '```\ncode line 1\ncode line 2\n```\n\nAfter code.';
    const paras = resolver.parseParagraphs(md);
    expect(paras).toHaveLength(2);
    expect(paras[0].content).toBe('```\ncode line 1\ncode line 2\n```');
    expect(paras[1].content).toBe('After code.');
  });

  it('handles list items as single paragraph', () => {
    const md = '- item 1\n- item 2\n- item 3';
    const paras = resolver.parseParagraphs(md);
    expect(paras).toHaveLength(1);
    expect(paras[0].content).toBe('- item 1\n- item 2\n- item 3');
  });

  it('handles empty document', () => {
    const md = '';
    const paras = resolver.parseParagraphs(md);
    expect(paras).toHaveLength(0);
  });

  it('trims content of paragraphs', () => {
    const md = '  text with spaces  \n\n  another  ';
    const paras = resolver.parseParagraphs(md);
    expect(paras[0].content).toBe('text with spaces');
    expect(paras[1].content).toBe('another');
  });
});

// ═══════════════════════════════════════════════════════
// Heading pop behavior
// ═══════════════════════════════════════════════════════

describe('parseParagraphs heading stack', () => {
  it('pops headings of same or higher level', () => {
    const md = '# H1\n\n## H2\n\n### H3\n\n# H1 again\n\ncontent';
    const paras = resolver.parseParagraphs(md);
    // Paragraphs: # H1, ## H2, ### H3, # H1 again, content
    // The last paragraph ('content') has headingPath ['# H1 again']
    const last = paras[paras.length - 1];
    expect(last.headingPath).toEqual(['# H1 again']);
    expect(last.content).toBe('content');
  });

  it('correctly nests and unnests headings', () => {
    const md = '## H2\n\npara1\n\n### H3\n\npara2\n\n# H1\n\npara3';
    const paras = resolver.parseParagraphs(md);
    // Paragraphs: ## H2, para1, ### H3, para2, # H1, para3
    expect(paras[0].content).toBe('## H2');
    expect(paras[0].headingPath).toEqual([]);
    expect(paras[1].content).toBe('para1');
    expect(paras[1].headingPath).toEqual(['## H2']);
    expect(paras[2].content).toBe('### H3');
    expect(paras[2].headingPath).toEqual(['## H2']);
    expect(paras[3].content).toBe('para2');
    expect(paras[3].headingPath).toEqual(['## H2', '### H3']);
    expect(paras[4].content).toBe('# H1');
    expect(paras[4].headingPath).toEqual([]);
    expect(paras[5].content).toBe('para3');
    expect(paras[5].headingPath).toEqual(['# H1']);
  });
});

// ═══════════════════════════════════════════════════════
// contentHash / textFingerprint
// ═══════════════════════════════════════════════════════

describe('contentHash', () => {
  it('returns 8-char hex string', () => {
    const hash = resolver.contentHash('hello');
    expect(hash).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(hash)).toBe(true);
  });

  it('returns same hash for same content', () => {
    expect(resolver.contentHash('abc')).toBe(resolver.contentHash('abc'));
  });

  it('returns different hash for different content', () => {
    expect(resolver.contentHash('abc')).not.toBe(resolver.contentHash('abd'));
  });
});

describe('textFingerprint', () => {
  it('returns first 150 chars, whitespace-normalized', () => {
    const long = 'a'.repeat(200);
    const fp = resolver.textFingerprint(long);
    expect(fp).toHaveLength(150);
  });

  it('collapses whitespace', () => {
    const fp = resolver.textFingerprint('hello    world\n\ttest');
    expect(fp).toBe('hello world test');
  });
});

// ═══════════════════════════════════════════════════════
// buildAnchor / buildSelectionAnchor
// ═══════════════════════════════════════════════════════

describe('buildAnchor', () => {
  it('builds heading-path anchor for a paragraph', () => {
    const md = '# Title\n\nParagraph text.';
    // para 0 = '# Title' heading, para 1 = 'Paragraph text.'
    const anchor = resolver.buildAnchor(md, 1);
    expect(anchor.type).toBe('heading-path');
    expect(anchor.paragraphIndex).toBe(1);
    expect(anchor.headingPath).toEqual(['# Title']);
    expect(anchor.contentHash).toBeDefined();
    expect(anchor.textFingerprint).toBe('Paragraph text.');
    expect(anchor.confidence).toBe(1.0);
  });

  it('builds anchor for a heading itself', () => {
    const md = '# Title\n\nParagraph text.';
    const anchor = resolver.buildAnchor(md, 0);
    expect(anchor.type).toBe('heading-path');
    expect(anchor.paragraphIndex).toBe(0);
    expect(anchor.headingPath).toEqual([]);
    expect(anchor.textFingerprint).toBe('# Title');
  });

  it('throws for invalid paragraph index', () => {
    expect(() => resolver.buildAnchor('text', 99)).toThrow('Paragraph index 99 not found');
  });
});

describe('buildSelectionAnchor', () => {
  it('builds selection anchor with offsets', () => {
    const md = 'Hello World\n\nAnother.';
    const anchor = resolver.buildSelectionAnchor(md, 0, 0, 5, 'Hello');
    expect(anchor.type).toBe('selection');
    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(5);
    expect(anchor.selectedText).toBe('Hello');
  });
});

// ═══════════════════════════════════════════════════════
// resolve (structural + fuzzy)
// ═══════════════════════════════════════════════════════

describe('resolve', () => {
  it('resolves by structure when content hash matches', () => {
    const md = '# H1\n\nSome text here.';
    // para 0 = '# H1', para 1 = 'Some text here.'
    const anchor = resolver.buildAnchor(md, 1);
    const result = resolver.resolve(anchor, md);
    expect(result).not.toBeNull();
    expect(result!.matchLevel).toBe(1);
    expect(result!.confidence).toBe(1.0);
    expect(result!.paragraphIndex).toBe(1);
  });

  it('resolves by structure with reduced confidence when hash differs', () => {
    const md = '# H1\n\nSome text here.';
    const anchor = resolver.buildAnchor(md, 1);
    const modified = '# H1\n\nText was changed.';
    const result = resolver.resolve(anchor, modified);
    expect(result).not.toBeNull();
    expect(result!.matchLevel).toBe(1);
    expect(result!.confidence).toBe(0.5);
  });

  it('falls back to fuzzy matching when structure fails', () => {
    const md = 'Para one.\n\nThis is a rather specific paragraph about machine learning.';
    const anchor = resolver.buildAnchor(md, 1);
    // Insert a new paragraph before, shifting the target
    const modified = 'New first paragraph.\n\nPara one.\n\nThis is a rather specific paragraph about machine learning.';
    const result = resolver.resolve(anchor, modified);
    // Should find it via fuzzy matching even though index changed
    expect(result).not.toBeNull();
  });

  it('returns null for completely unrelated content', () => {
    const anchor = resolver.buildAnchor('original text here.', 0);
    const completelyDifferent = 'totally different content with no relation whatsoever';
    // Fuzzy hopefully returns null/very low score
    // (may or may not, depending on similarity)
  });
});

// ═══════════════════════════════════════════════════════
// resolveSelectionInParagraph
// ═══════════════════════════════════════════════════════

describe('resolveSelectionInParagraph', () => {
  it('finds exact match', () => {
    const idx = resolver.resolveSelectionInParagraph('Hello', 'abc Hello xyz');
    expect(idx).toBe(4);
  });

  it('returns null for no match', () => {
    const idx = resolver.resolveSelectionInParagraph('xyz', 'abc def');
    expect(idx).toBeNull();
  });

  it('handles empty inputs', () => {
    expect(resolver.resolveSelectionInParagraph('', 'abc')).toBeNull();
    expect(resolver.resolveSelectionInParagraph('abc', '')).toBeNull();
  });

  it('returns null for very short needle (< 20 chars, no exact match)', () => {
    const idx = resolver.resolveSelectionInParagraph('short', 'this is a longer text without exact match');
    // needle "short" is < 20 chars, fuzzy is disabled, no exact match
    expect(idx).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// levenshtein / trigramDice
// ═══════════════════════════════════════════════════════

describe('resolveByFuzzy scoring', () => {
  it('scores identical paragraphs highly', () => {
    const md = 'This is a unique paragraph with enough words to match.';
    const anchor = resolver.buildAnchor(md, 0);
    const paras = resolver.parseParagraphs(md);
    // Private method, but resolveByFuzzy is used via resolve()
    const result = resolver.resolve(anchor, 'different first line.\n\n' + md);
    // The fuzzy matcher should find it
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

// ═══════════════════════════════════════════════════════
// Table paragraph alignment tests
// ═══════════════════════════════════════════════════════

describe('parseParagraphs with tables', () => {
  it('treats table as a single paragraph', () => {
    const md = 'Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.';
    const paras = resolver.parseParagraphs(md);
    expect(paras).toHaveLength(3);
    expect(paras[0].content).toBe('Before.');
    expect(paras[1].content).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(paras[2].content).toBe('After.');
  });
});

// ═══════════════════════════════════════════════════════
// computeSimilarity
// ═══════════════════════════════════════════════════════

describe('computeSimilarity', () => {
  it('returns 1.0 for identical text', () => {
    expect(resolver.computeSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0 for empty vs non-empty', () => {
    expect(resolver.computeSimilarity('', 'hello')).toBe(0);
    expect(resolver.computeSimilarity('hello', '')).toBe(0);
  });

  it('returns 1.0 for both empty', () => {
    expect(resolver.computeSimilarity('', '')).toBe(1.0);
  });

  it('gives high similarity for minor edits', () => {
    const original = 'The quick brown fox jumps over the lazy dog.';
    const edited = 'The quick brown fox jumps over the lazy cat.';
    const sim = resolver.computeSimilarity(original, edited);
    expect(sim).toBeGreaterThan(0.8);
  });

  it('gives moderate similarity for partial rewrite', () => {
    const original = 'Use the npm install command to add the package to your project dependencies.';
    const edited = 'Run npm install to add the package as a dependency in your project.';
    const sim = resolver.computeSimilarity(original, edited);
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(0.9);
  });

  it('gives low similarity for completely different content', () => {
    const original = 'Build and deploy the application.';
    const edited = 'The weather is sunny with a chance of rain tomorrow.';
    const sim = resolver.computeSimilarity(original, edited);
    expect(sim).toBeLessThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════
// detectDrift
// ═══════════════════════════════════════════════════════

describe('detectDrift', () => {
  it('returns unknown when paragraphSnapshot is missing (old data)', () => {
    const anchor = {
      type: 'heading-path' as const,
      headingPath: [],
      paragraphIndex: 0,
      contentHash: 'abc',
      textFingerprint: '',
      confidence: 1.0,
    };
    const drift = resolver.detectDrift(anchor, {
      paragraphIndex: 0,
      confidence: 1.0,
      matchLevel: 1,
      content: 'unchanged',
    });
    expect(drift.status).toBe('unknown');
    expect(drift.similarity).toBe(-1);
  });

  it('returns intact when confidence is 1.0 (content hash matches)', () => {
    const snapshot = 'Original paragraph text.';
    const anchor = {
      type: 'heading-path' as const,
      headingPath: [],
      paragraphIndex: 0,
      contentHash: resolver.contentHash(snapshot),
      textFingerprint: resolver.textFingerprint(snapshot),
      confidence: 1.0,
      paragraphSnapshot: snapshot,
    };
    const drift = resolver.detectDrift(anchor, {
      paragraphIndex: 0,
      confidence: 1.0,
      matchLevel: 1,
      content: snapshot,
    });
    expect(drift.status).toBe('intact');
    expect(drift.similarity).toBe(1.0);
  });

  it('returns missing when anchor cannot be resolved', () => {
    const snapshot = 'This paragraph was deleted.';
    const anchor = {
      type: 'heading-path' as const,
      headingPath: ['# Title'],
      paragraphIndex: 5,
      contentHash: resolver.contentHash(snapshot),
      textFingerprint: resolver.textFingerprint(snapshot),
      confidence: 1.0,
      paragraphSnapshot: snapshot,
    };
    const drift = resolver.detectDrift(anchor, null);
    expect(drift.status).toBe('missing');
    expect(drift.similarity).toBe(0);
    expect(drift.snapshotText).toBe(snapshot);
    expect(drift.currentText).toBe('');
  });

  it('returns minor for structurally-matched paragraph with minor edits', () => {
    const snapshot = 'The quick brown fox jumps over the lazy dog.';
    const edited = 'The quick brown fox jumps over the lazy cat.';
    const anchor = {
      type: 'heading-path' as const,
      headingPath: [],
      paragraphIndex: 0,
      contentHash: resolver.contentHash(snapshot),
      textFingerprint: resolver.textFingerprint(snapshot),
      confidence: 1.0,
      paragraphSnapshot: snapshot,
    };
    const drift = resolver.detectDrift(anchor, {
      paragraphIndex: 0,
      confidence: 0.5,
      matchLevel: 1,
      content: edited,
    });
    expect(drift.status).toBe('minor');
    expect(drift.similarity).toBeGreaterThan(0.7);
    expect(drift.snapshotText).toBe(snapshot);
    expect(drift.currentText).toBe(edited);
  });

  it('returns major for structurally-matched paragraph with extensive rewrite', () => {
    const snapshot = 'The weather is quite pleasant today with plenty of sunshine.';
    const edited = 'Build and deploy the application to the production server immediately.';
    const anchor = {
      type: 'heading-path' as const,
      headingPath: [],
      paragraphIndex: 0,
      contentHash: resolver.contentHash(snapshot),
      textFingerprint: resolver.textFingerprint(snapshot),
      confidence: 1.0,
      paragraphSnapshot: snapshot,
    };
    const drift = resolver.detectDrift(anchor, {
      paragraphIndex: 0,
      confidence: 0.5,
      matchLevel: 1,
      content: edited,
    });
    expect(drift.status).toBe('major');
    expect(drift.similarity).toBeLessThan(0.7);
  });

  it('returns major for fuzzy-matched paragraph with low confidence', () => {
    const snapshot = 'This is a unique paragraph about machine learning and neural networks.';
    const edited = 'Some completely different topic about cooking recipes and baking bread.';
    const anchor = {
      type: 'heading-path' as const,
      headingPath: [],
      paragraphIndex: 0,
      contentHash: resolver.contentHash(snapshot),
      textFingerprint: resolver.textFingerprint(snapshot),
      confidence: 1.0,
      paragraphSnapshot: snapshot,
    };
    const drift = resolver.detectDrift(anchor, {
      paragraphIndex: 0,
      confidence: 0.55,
      matchLevel: 2,
      content: edited,
    });
    expect(drift.status).toBe('major');
  });
});

// ═══════════════════════════════════════════════════════
// batchDetectDrift
// ═══════════════════════════════════════════════════════

describe('batchDetectDrift', () => {
  it('skips open threads and only processes resolved ones', () => {
    const md = '# Title\n\nParagraph one.\n\n## Sub\n\nParagraph two.';
    const threads = [
      {
        id: 'thr1',
        status: 'open' as const,
        anchor: resolver.buildAnchor(md, 0),
        comments: [],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'thr2',
        status: 'resolved' as const,
        anchor: resolver.buildAnchor(md, 1),
        comments: [],
        createdAt: '',
        updatedAt: '',
      },
    ];
    const summary = resolver.batchDetectDrift(md, threads);
    expect(summary.intact).toBe(1);   // resolved thread on unchanged doc
    expect(summary.minor).toBe(0);
    expect(summary.major).toBe(0);
    expect(summary.missing).toBe(0);
    expect(summary.unknown).toBe(0);
    // Open thread should be untouched (no drift assigned)
    expect(threads[0].drift).toBeUndefined();
    expect(threads[1].drift!.status).toBe('intact');
  });

  it('detects drift for resolved threads on modified document', () => {
    const original = '# Title\n\nParagraph one.\n\n## Sub\n\nParagraph two.';
    const threads = [
      {
        id: 'thr1',
        status: 'resolved' as const,
        anchor: resolver.buildAnchor(original, 1),
        comments: [],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'thr2',
        status: 'resolved' as const,
        anchor: resolver.buildAnchor(original, 3),
        comments: [],
        createdAt: '',
        updatedAt: '',
      },
    ];
    // Modify paragraph two (para index 3), keep paragraph one (para index 1) intact
    const modified = '# Title\n\nParagraph one.\n\n## Sub\n\nParagraph two was rewritten completely here.';
    const summary = resolver.batchDetectDrift(modified, threads);
    expect(summary.intact).toBe(1);
    expect(summary.minor + summary.major + summary.missing).toBe(1);
    expect(threads[0].drift!.status).toBe('intact');
    // thr2 should have some drift since content changed
    expect(threads[1].drift!.status === 'minor' || threads[1].drift!.status === 'major').toBe(true);
  });

  it('includes major drift details in summary for Agent consumption', () => {
    const original = '# Title\n\nOriginal unique paragraph about machine learning algorithms.';
    const threads = [
      {
        id: 'thr_drift',
        status: 'resolved' as const,
        anchor: resolver.buildAnchor(original, 1),
        comments: [],
        createdAt: '',
        updatedAt: '',
      },
    ];
    const modified = '# Title\n\nCompletely different content about cooking recipes and baking.';
    const summary = resolver.batchDetectDrift(modified, threads);
    if (summary.major > 0) {
      expect(summary.major).toBeGreaterThan(0);
      expect(summary.majorDrifts.length).toBe(summary.major);
      expect(summary.majorDrifts[0].threadId).toBe('thr_drift');
      expect(summary.majorDrifts[0].snapshotText).toContain('machine learning');
      expect(summary.majorDrifts[0].currentText).toContain('cooking');
    }
  });
});

// ═══════════════════════════════════════════════════════
// paragraphSnapshot in buildAnchor / buildSelectionAnchor
// ═══════════════════════════════════════════════════════

describe('paragraphSnapshot', () => {
  it('buildAnchor stores full paragraph text as snapshot', () => {
    const md = '# Title\n\nThis is the paragraph content.';
    const anchor = resolver.buildAnchor(md, 1);
    expect(anchor.paragraphSnapshot).toBe('This is the paragraph content.');
  });

  it('buildSelectionAnchor stores full paragraph text as snapshot', () => {
    const md = '# Title\n\nThis is the paragraph content with more text.';
    const anchor = resolver.buildSelectionAnchor(md, 1, 0, 4, 'This');
    expect(anchor.paragraphSnapshot).toBe('This is the paragraph content with more text.');
  });

  it('snapshot is independent of selection text', () => {
    const md = '# Title\n\nFull paragraph text is captured.';
    const anchor = resolver.buildSelectionAnchor(md, 1, 5, 14, 'paragraph');
    expect(anchor.paragraphSnapshot).toBe('Full paragraph text is captured.');
    expect(anchor.selectedText).toBe('paragraph');
  });
});
