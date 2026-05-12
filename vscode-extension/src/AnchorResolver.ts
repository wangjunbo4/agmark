import * as crypto from 'crypto';
import type { CommentAnchor, ResolvedAnchor, AnchorDrift, DriftSummary, CommentThread } from './types';

interface Paragraph {
  index: number;
  headingPath: string[];
  content: string;
  startLine: number;
}

export class AnchorResolver {
  /**
   * Parse markdown content into a list of paragraphs with their heading context.
   */
  parseParagraphs(markdown: string): Paragraph[] {
    const lines = markdown.split('\n');
    const headingStack: string[] = [];
    const paragraphs: Paragraph[] = [];
    let currentParagraph: string[] = [];
    let paragraphStartLine = 0;
    let paragraphIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

      if (headingMatch) {
        // Flush current paragraph
        if (currentParagraph.length > 0) {
          const content = currentParagraph.join('\n').trim();
          if (content) {
            paragraphs.push({
              index: paragraphIndex++,
              headingPath: [...headingStack],
              content,
              startLine: paragraphStartLine,
            });
          }
          currentParagraph = [];
        }

        const level = headingMatch[1].length;
        const title = `${'#'.repeat(level)} ${headingMatch[2]}`;
        // Pop headings of same or higher level
        while (headingStack.length >= level) {
          headingStack.pop();
        }
        // Add heading as a paragraph so it can be annotated/selected
        paragraphs.push({
          index: paragraphIndex++,
          headingPath: [...headingStack],
          content: title,
          startLine: i,
        });
        headingStack.push(title);
        paragraphStartLine = i;
        continue;
      }

      if (line.trim() === '') {
        // Empty line: flush paragraph
        if (currentParagraph.length > 0) {
          const content = currentParagraph.join('\n').trim();
          if (content) {
            paragraphs.push({
              index: paragraphIndex++,
              headingPath: [...headingStack],
              content,
              startLine: paragraphStartLine,
            });
          }
          currentParagraph = [];
        }
        continue;
      }

      if (currentParagraph.length === 0) {
        paragraphStartLine = i;
      }
      currentParagraph.push(line);
    }

    // Flush final paragraph
    if (currentParagraph.length > 0) {
      const content = currentParagraph.join('\n').trim();
      if (content) {
        paragraphs.push({
          index: paragraphIndex++,
          headingPath: [...headingStack],
          content,
          startLine: paragraphStartLine,
        });
      }
    }

    return paragraphs;
  }

  /** Compute short hash of content */
  contentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
  }

  /** Extract text fingerprint (first 150 chars) */
  textFingerprint(content: string): string {
    return content.substring(0, 150).replace(/\s+/g, ' ').trim();
  }

  /**
   * Public similarity computation using the three-strategy fuzzy match.
   * Reuses the same weights as resolveByFuzzy: prefix 0.4 + Jaccard 0.35 + trigram 0.25.
   */
  computeSimilarity(textA: string, textB: string): number {
    if (textA === textB) return 1.0;
    if (!textA || !textB) return 0;

    const fpA = this.textFingerprint(textA);
    const fpB = this.textFingerprint(textB);

    // Prefix edit distance (weight 0.4)
    const prefixLen = Math.min(fpA.length, fpB.length);
    const prefixA = fpA.substring(0, Math.min(60, prefixLen));
    const prefixB = fpB.substring(0, Math.min(60, prefixLen));
    const prefixScore = this.prefixSimilarity(prefixA, prefixB);

    // Word Jaccard (weight 0.35)
    const wordsA = new Set(fpA.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(fpB.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    const jaccardScore = union.size > 0 ? intersection.size / union.size : 0;

    // Trigram Dice (weight 0.25)
    const trigramScore = this.trigramDice(fpA.toLowerCase(), fpB.toLowerCase());

    return prefixScore * 0.4 + jaccardScore * 0.35 + trigramScore * 0.25;
  }

  /**
   * Detect how much a resolved anchor's paragraph has drifted from its snapshot.
   */
  detectDrift(anchor: CommentAnchor, resolved: ResolvedAnchor | null): AnchorDrift {
    const fallback = { status: 'unknown' as const, similarity: -1, snapshotText: '', currentText: '' };
    if (!anchor.paragraphSnapshot) return fallback;
    if (!resolved) {
      return { status: 'missing', similarity: 0, snapshotText: anchor.paragraphSnapshot, currentText: '' };
    }
    if (resolved.confidence === 1.0) {
      return { status: 'intact', similarity: 1.0, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
    }
    const sim = this.computeSimilarity(anchor.paragraphSnapshot, resolved.content);
    if (sim >= 0.7) {
      return { status: 'minor', similarity: sim, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
    }
    return { status: 'major', similarity: sim, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
  }

  /**
   * Batch drift detection for all resolved threads in a document.
   * Parses the document once, then resolves + detects drift for each thread.
   */
  batchDetectDrift(markdown: string, threads: CommentThread[]): DriftSummary {
    const paragraphs = this.parseParagraphs(markdown);
    const summary: DriftSummary = { intact: 0, minor: 0, major: 0, majorDrifts: [], missing: 0, unknown: 0 };

    for (const thread of threads) {
      if (thread.status === 'open') continue;
      const resolved = this.resolve(thread.anchor, markdown);
      const drift = this.detectDrift(thread.anchor, resolved);
      thread.drift = drift;

      switch (drift.status) {
        case 'intact': summary.intact++; break;
        case 'minor': summary.minor++; break;
        case 'major':
          summary.major++;
          summary.majorDrifts.push({
            threadId: thread.id,
            snapshotText: drift.snapshotText,
            currentText: drift.currentText,
            similarity: drift.similarity,
          });
          break;
        case 'missing': summary.missing++; break;
        case 'unknown': summary.unknown++; break;
      }
    }
    return summary;
  }

  // ── Level 1: Structural matching ──

  resolveByStructure(anchor: CommentAnchor, paragraphs: Paragraph[]): ResolvedAnchor | null {
    const candidates = paragraphs.filter((p) => {
      if (p.index !== anchor.paragraphIndex) return false;
      if (p.headingPath.length !== anchor.headingPath.length) return false;
      return p.headingPath.every((h, i) => h === anchor.headingPath[i]);
    });

    if (candidates.length === 1) {
      const hash = this.contentHash(candidates[0].content);
      const confidence = hash === anchor.contentHash ? 1.0 : 0.5;
      return {
        paragraphIndex: candidates[0].index,
        confidence,
        matchLevel: 1,
        content: candidates[0].content,
      };
    }

    return null;
  }

  // ── Level 2: Fuzzy matching ──

  resolveByFuzzy(anchor: CommentAnchor, paragraphs: Paragraph[]): ResolvedAnchor | null {
    const fingerprint = anchor.textFingerprint;
    if (!fingerprint) return null;

    let bestScore = 0;
    let bestParagraph: Paragraph | null = null;

    for (const p of paragraphs) {
      const pFingerprint = this.textFingerprint(p.content);

      // Strategy 1: Prefix edit distance (weight 0.4)
      const prefixLen = Math.min(fingerprint.length, pFingerprint.length);
      const prefixA = fingerprint.substring(0, Math.min(60, prefixLen));
      const prefixB = pFingerprint.substring(0, Math.min(60, prefixLen));
      const prefixScore = this.prefixSimilarity(prefixA, prefixB);

      // Strategy 2: Word Jaccard (weight 0.35)
      const wordsA = new Set(fingerprint.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      const wordsB = new Set(pFingerprint.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
      const union = new Set([...wordsA, ...wordsB]);
      const jaccardScore = union.size > 0 ? intersection.size / union.size : 0;

      // Strategy 3: Trigram Dice coefficient (weight 0.25)
      const trigramScore = this.trigramDice(fingerprint.toLowerCase(), pFingerprint.toLowerCase());

      const score = prefixScore * 0.4 + jaccardScore * 0.35 + trigramScore * 0.25;

      if (score > bestScore) {
        bestScore = score;
        bestParagraph = p;
      }
    }

    if (bestParagraph && bestScore >= 0.5) {
      return {
        paragraphIndex: bestParagraph.index,
        confidence: bestScore,
        matchLevel: 2,
        content: bestParagraph.content,
      };
    }

    return null;
  }

  /** Normalized prefix similarity based on Levenshtein */
  private prefixSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (!a || !b) return 0;

    const maxLen = Math.max(a.length, b.length);
    const dist = this.levenshtein(a, b);
    return 1.0 - dist / maxLen;
  }

  /** Levenshtein distance */
  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  /** Dice coefficient on character trigrams */
  private trigramDice(a: string, b: string): number {
    const trigramsA = this.getTrigrams(a);
    const trigramsB = this.getTrigrams(b);

    if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
    if (trigramsA.size === 0 || trigramsB.size === 0) return 0;

    let intersection = 0;
    for (const t of trigramsA) {
      if (trigramsB.has(t)) intersection++;
    }

    return (2 * intersection) / (trigramsA.size + trigramsB.size);
  }

  private getTrigrams(s: string): Set<string> {
    const trigrams = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) {
      trigrams.add(s.substring(i, i + 3));
    }
    return trigrams;
  }

  // ── Top-level resolution ──

  /**
   * Resolve an anchor against the current document content.
   * Returns the best match with confidence score.
   */
  resolve(anchor: CommentAnchor, markdown: string): ResolvedAnchor | null {
    const paragraphs = this.parseParagraphs(markdown);

    // Level 1: structural
    const structural = this.resolveByStructure(anchor, paragraphs);
    if (structural && structural.confidence === 1.0) {
      return structural;
    }

    // Level 2: fuzzy
    const fuzzy = this.resolveByFuzzy(anchor, paragraphs);
    if (fuzzy && fuzzy.confidence >= 0.5) {
      return fuzzy;
    }

    // If structural matched but hash was wrong, return it with low confidence
    if (structural) return structural;

    // Level 3: orphan
    return null;
  }

  /**
   * Build anchor metadata for a given paragraph in the document.
   */
  buildAnchor(markdown: string, paragraphIndex: number): CommentAnchor {
    const paragraphs = this.parseParagraphs(markdown);
    const paragraph = paragraphs.find((p) => p.index === paragraphIndex);

    if (!paragraph) {
      throw new Error(`Paragraph index ${paragraphIndex} not found in document`);
    }

    return {
      type: 'heading-path',
      headingPath: paragraph.headingPath,
      paragraphIndex: paragraph.index,
      contentHash: this.contentHash(paragraph.content),
      textFingerprint: this.textFingerprint(paragraph.content),
      confidence: 1.0,
      paragraphSnapshot: paragraph.content,
    };
  }

  /**
   * Build a selection-based anchor for text selected within a paragraph.
   */
  buildSelectionAnchor(
    markdown: string,
    paragraphIndex: number,
    startOffset: number,
    endOffset: number,
    selectedText: string,
  ): CommentAnchor {
    const paragraphs = this.parseParagraphs(markdown);
    const paragraph = paragraphs.find((p) => p.index === paragraphIndex);

    if (!paragraph) {
      throw new Error(`Paragraph index ${paragraphIndex} not found in document`);
    }

    // Use selected text as the fingerprint for fuzzy re-anchoring
    const fingerprint = this.textFingerprint(selectedText);

    return {
      type: 'selection',
      headingPath: paragraph.headingPath,
      paragraphIndex: paragraph.index,
      startOffset,
      endOffset,
      selectedText,
      contentHash: this.contentHash(paragraph.content),
      textFingerprint: fingerprint,
      confidence: 1.0,
      paragraphSnapshot: paragraph.content,
    };
  }

  /**
   * Fuzzy resolve for selection anchors: try to find the selected text
   * within the target paragraph using sliding window matching.
   */
  resolveSelectionInParagraph(selectedText: string, paragraphContent: string): number | null {
    if (!selectedText || !paragraphContent) return null;

    const needle = selectedText.trim();
    const haystack = paragraphContent;

    // Exact match
    const exactIdx = haystack.indexOf(needle);
    if (exactIdx !== -1) return exactIdx;

    // Sliding window fuzzy match for short selections
    if (needle.length < 20) return null; // too short for fuzzy

    const needleWords = new Set(needle.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (needleWords.size < 2) return null;

    const winSize = Math.max(needle.length, 80);
    let bestScore = 0;
    let bestIdx: number | null = null;

    for (let i = 0; i < haystack.length - needle.length / 2; i += 10) {
      const window = haystack.substring(i, i + winSize);
      const windowWords = new Set(window.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      const intersection = new Set([...needleWords].filter((w) => windowWords.has(w)));
      const union = new Set([...needleWords, ...windowWords]);
      const score = union.size > 0 ? intersection.size / union.size : 0;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return bestScore >= 0.6 ? bestIdx : null;
  }
}
