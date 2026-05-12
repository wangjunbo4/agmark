#!/usr/bin/env node
"use strict";

// ── AgentMark MCP Server ──
// Reads/writes .comments/ files. Claude Code connects via stdio MCP.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ── File I/O ──

function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.comments'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir || process.cwd();
}

function getCommentPath(projectRoot, docName) {
  const baseName = path.basename(docName, '.md') + '.md.json';
  return path.join(projectRoot, '.comments', baseName);
}

function readComments(projectRoot, docName) {
  const p = getCommentPath(projectRoot, docName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeComments(projectRoot, docName, data) {
  const p = getCommentPath(projectRoot, docName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function listPending(projectRoot) {
  const commentsDir = path.join(projectRoot, '.comments');
  if (!fs.existsSync(commentsDir)) return [];
  const results = [];
  for (const f of fs.readdirSync(commentsDir)) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(commentsDir, f), 'utf-8'));
    const docName = f.replace(/\.json$/, '');
    const open = data.threads.filter(t => t.status === 'open');
    if (open.length > 0) {
      results.push({ document: docName, openCount: open.length, totalCount: data.threads.length });
    }
  }
  return results;
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Drift detection (JS port of AnchorResolver) ──

function parseParagraphs(markdown) {
  const lines = markdown.split('\n');
  const headingStack = [];
  const paragraphs = [];
  let currentParagraph = [];
  let paragraphStartLine = 0;
  let paragraphIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      if (currentParagraph.length > 0) {
        const content = currentParagraph.join('\n').trim();
        if (content) paragraphs.push({ index: paragraphIndex++, headingPath: [...headingStack], content, startLine: paragraphStartLine });
        currentParagraph = [];
      }
      const level = headingMatch[1].length;
      const title = '#'.repeat(level) + ' ' + headingMatch[2];
      while (headingStack.length >= level) headingStack.pop();
      paragraphs.push({ index: paragraphIndex++, headingPath: [...headingStack], content: title, startLine: i });
      headingStack.push(title);
      paragraphStartLine = i;
      continue;
    }

    if (line.trim() === '') {
      if (currentParagraph.length > 0) {
        const content = currentParagraph.join('\n').trim();
        if (content) paragraphs.push({ index: paragraphIndex++, headingPath: [...headingStack], content, startLine: paragraphStartLine });
        currentParagraph = [];
      }
      continue;
    }

    if (currentParagraph.length === 0) paragraphStartLine = i;
    currentParagraph.push(line);
  }

  if (currentParagraph.length > 0) {
    const content = currentParagraph.join('\n').trim();
    if (content) paragraphs.push({ index: paragraphIndex++, headingPath: [...headingStack], content, startLine: paragraphStartLine });
  }

  return paragraphs;
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

function textFingerprint(content) {
  return content.substring(0, 150).replace(/\s+/g, ' ').trim();
}

function prefixSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return 1.0 - dist / maxLen;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function trigramDice(a, b) {
  const getTrigrams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 2; i++) set.add(s.substring(i, i + 3)); return set; };
  const ta = getTrigrams(a), tb = getTrigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1.0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return (2 * intersection) / (ta.size + tb.size);
}

function computeSimilarity(textA, textB) {
  if (textA === textB) return 1.0;
  if (!textA || !textB) return 0;
  const fpA = textFingerprint(textA), fpB = textFingerprint(textB);
  const prefixLen = Math.min(fpA.length, fpB.length);
  const prefixScore = prefixSimilarity(fpA.substring(0, Math.min(60, prefixLen)), fpB.substring(0, Math.min(60, prefixLen)));
  const wordsA = new Set(fpA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(fpB.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const inter = new Set([...wordsA].filter(w => wordsB.has(w)));
  const uni = new Set([...wordsA, ...wordsB]);
  const jaccardScore = uni.size > 0 ? inter.size / uni.size : 0;
  const trigramScore = trigramDice(fpA.toLowerCase(), fpB.toLowerCase());
  return prefixScore * 0.4 + jaccardScore * 0.35 + trigramScore * 0.25;
}

function resolveAnchor(anchor, paragraphs) {
  // Level 1: structural
  const structural = paragraphs.find(p =>
    p.index === anchor.paragraphIndex &&
    p.headingPath.length === (anchor.headingPath || []).length &&
    (anchor.headingPath || []).every((h, i) => h === p.headingPath[i])
  );
  if (structural) {
    const hash = contentHash(structural.content);
    if (hash === anchor.contentHash) return { paragraphIndex: structural.index, confidence: 1.0, content: structural.content };
  }

  // Level 2: fuzzy
  const fingerprint = anchor.textFingerprint || (anchor.selectedText ? textFingerprint(anchor.selectedText) : '');
  if (fingerprint) {
    let bestScore = 0, bestPara = null;
    for (const p of paragraphs) {
      const score = computeSimilarity(fingerprint, textFingerprint(p.content));
      if (score > bestScore) { bestScore = score; bestPara = p; }
    }
    if (bestPara && bestScore >= 0.5) return { paragraphIndex: bestPara.index, confidence: bestScore, content: bestPara.content };
  }

  // Level 3: structural with wrong hash
  if (structural) return { paragraphIndex: structural.index, confidence: 0.5, content: structural.content };

  return null;
}

function detectDrift(anchor, resolved) {
  if (!anchor.paragraphSnapshot) return { status: 'unknown', similarity: -1, snapshotText: '', currentText: '' };
  if (!resolved) return { status: 'missing', similarity: 0, snapshotText: anchor.paragraphSnapshot, currentText: '' };
  if (resolved.confidence === 1.0) return { status: 'intact', similarity: 1.0, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
  const sim = computeSimilarity(anchor.paragraphSnapshot, resolved.content);
  if (sim >= 0.7) return { status: 'minor', similarity: sim, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
  return { status: 'major', similarity: sim, snapshotText: anchor.paragraphSnapshot, currentText: resolved.content };
}

// ── MCP Protocol ──

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'get_annotations',
    description: 'Get all annotation threads for a markdown document. Returns open and resolved threads with their comments.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Markdown file name (e.g., "design.md")' },
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by status (default: all)' }
      },
      required: ['document']
    }
  },
  {
    name: 'reply_to_annotation',
    description: 'Reply to an annotation thread and optionally mark it resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Markdown file name' },
        threadId: { type: 'string', description: 'Thread ID to reply to' },
        body: { type: 'string', description: 'Reply text' },
        resolve: { type: 'boolean', description: 'Mark thread as resolved after replying (default: true)' }
      },
      required: ['document', 'threadId', 'body']
    }
  },
  {
    name: 'list_pending',
    description: 'List all documents with open annotations across the project.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_stats',
    description: 'Get annotation statistics for the project or a specific document.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Optional: specific markdown file' }
      }
    }
  },
  {
    name: 'refresh_document',
    description: 'Signal the VSCode extension to refresh the document and annotation state. Call this after completing a round of review edits.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Markdown file name to refresh' }
      },
      required: ['document']
    }
  },
  {
    name: 'refresh_drift',
    description: 'Run drift detection on all resolved annotations. Algorithm classifies into intact/minor/major/missing. For major drift threads, returns original vs current text for Agent (Claude) to judge semantic relevance. Call this at the END of each review cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Markdown file name (e.g., "README.md")' }
      },
      required: ['document']
    }
  }
];

const projectRoot = findProjectRoot(process.cwd());

// ── Tool handlers ──

function handleGetAnnotations(params) {
  const docName = params.document;
  const data = readComments(projectRoot, docName);
  if (!data) return { document: docName, threads: [], message: 'No annotations found for ' + docName };

  let threads = data.threads;
  if (params.status === 'open') threads = threads.filter(t => t.status === 'open');
  else if (params.status === 'resolved') threads = threads.filter(t => t.status === 'resolved');

  // Format for Claude readability
  const formatted = threads.map(t => ({
    id: t.id,
    status: t.status,
    heading: t.anchor.headingPath.length > 0 ? t.anchor.headingPath[t.anchor.headingPath.length - 1] : 'Paragraph ' + (t.anchor.paragraphIndex + 1),
    paragraphIndex: t.anchor.paragraphIndex,
    selectedText: t.anchor.type === 'selection' ? t.anchor.selectedText : null,
    drift: t.drift ? { status: t.drift.status, similarity: Math.round(t.drift.similarity * 100) / 100 } : undefined,
    comments: t.comments.map(c => ({ author: c.author, body: c.body, time: c.createdAt })),
    createdAt: t.createdAt
  }));

  return { document: docName, threads: formatted, total: data.threads.length, open: data.threads.filter(t => t.status === 'open').length };
}

function handleReply(params) {
  const docName = params.document;
  const data = readComments(projectRoot, docName);
  if (!data) throw new Error('No annotations found for ' + docName);

  const thread = data.threads.find(t => t.id === params.threadId);
  if (!thread) throw new Error('Thread not found: ' + params.threadId);

  thread.comments.push({
    id: genId('cmt'),
    author: 'claude',
    body: params.body,
    createdAt: new Date().toISOString()
  });

  if (params.resolve !== false) {
    thread.status = 'resolved';
  }
  thread.updatedAt = new Date().toISOString();

  writeComments(projectRoot, docName, data);
  return { success: true, threadId: params.threadId, status: thread.status };
}

function handleListPending() {
  const pending = listPending(projectRoot);
  return {
    projectRoot,
    pendingCount: pending.reduce((s, p) => s + p.openCount, 0),
    documents: pending
  };
}

function handleRefreshDocument(params) {
  const docName = params.document;
  // Touch the comments file to trigger the VSCode file watcher
  const data = readComments(projectRoot, docName);
  if (data) {
    writeComments(projectRoot, docName, data);
  }
  const open = data ? data.threads.filter(t => t.status === 'open').length : 0;
  const total = data ? data.threads.length : 0;
  return { document: docName, refreshed: true, open, total };
}

function handleRefreshDrift(params) {
  const docName = params.document;
  const data = readComments(projectRoot, docName);
  if (!data) return { error: 'No annotations found for ' + docName };

  // Read the actual markdown document
  const docPath = path.join(projectRoot, docName);
  if (!fs.existsSync(docPath)) return { error: 'Document not found: ' + docPath };
  const markdown = fs.readFileSync(docPath, 'utf-8');

  const paragraphs = parseParagraphs(markdown);
  const resolvedThreads = data.threads.filter(t => t.status === 'resolved');
  const majorDrifts = [];
  const stats = { intact: 0, minor: 0, major: 0, missing: 0, unknown: 0 };

  for (const thread of data.threads) {
    if (thread.status === 'open') continue;
    const resolved = thread.anchor ? resolveAnchor(thread.anchor, paragraphs) : null;
    const drift = detectDrift(thread.anchor, resolved || undefined);
    thread.drift = drift;

    switch (drift.status) {
      case 'intact': stats.intact++; break;
      case 'minor': stats.minor++; break;
      case 'major':
        stats.major++;
        majorDrifts.push({
          threadId: thread.id,
          heading: thread.anchor.headingPath && thread.anchor.headingPath.length > 0
            ? thread.anchor.headingPath.join(' > ') : 'Paragraph ' + (thread.anchor.paragraphIndex + 1),
          selectedText: thread.anchor.selectedText || '(paragraph-level)',
          similarity: drift.similarity,
          snapshotText: drift.snapshotText,
          currentText: drift.currentText,
        });
        break;
      case 'missing': stats.missing++; break;
      case 'unknown': stats.unknown++; break;
    }
  }

  // Save updated drift data back
  writeComments(projectRoot, docName, data);

  // Format report for Claude
  let report = `=== Drift Report for ${docName} ===\n\n`;
  report += `intact:  ${stats.intact} threads (content unchanged)\n`;
  report += `minor:   ${stats.minor} threads (minor edits, still relevant)\n`;
  report += `major:   ${stats.major} threads → NEED AGENT JUDGMENT\n`;
  report += `missing: ${stats.missing} threads (paragraph deleted)\n`;
  report += `unknown: ${stats.unknown} threads\n`;

  if (majorDrifts.length > 0) {
    report += '\n';
    majorDrifts.forEach((d, i) => {
      report += `--- Major Drift #${i + 1} ---\n`;
      report += `Thread: ${d.threadId}\n`;
      report += `Heading: ${d.heading}\n`;
      report += `Selected text: "${d.selectedText}"\n`;
      report += `Similarity: ${Math.round(d.similarity * 100)}%\n\n`;
      report += `Original paragraph:\n  ${d.snapshotText.replace(/\n/g, '\n  ')}\n\n`;
      report += `Current paragraph:\n  ${d.currentText.replace(/\n/g, '\n  ')}\n\n`;
      report += `For each major drift, use reply_to_annotation with:\n`;
      report += `  still_valid  — text changed but meaning is the same, annotation still applies\n`;
      report += `  needs_review — content changed significantly, annotation may need updating\n`;
      report += `  obsolete     — annotation is no longer relevant\n\n`;
    });
  } else {
    report += '\nNo major drifts — all resolved annotations are either intact or have only minor edits.\n';
  }

  return {
    document: docName,
    stats,
    majorDrifts: majorDrifts.map(d => ({
      threadId: d.threadId,
      heading: d.heading,
      similarity: Math.round(d.similarity * 100) / 100,
    })),
    report,
  };
}

function handleGetStats(params) {
  if (params.document) {
    const data = readComments(projectRoot, params.document);
    if (!data) return { document: params.document, total: 0, open: 0, resolved: 0 };
    return {
      document: params.document,
      total: data.threads.length,
      open: data.threads.filter(t => t.status === 'open').length,
      resolved: data.threads.filter(t => t.status === 'resolved').length
    };
  }
  const pending = listPending(projectRoot);
  return { projectRoot, documentsWithAnnotations: pending.length, totalOpen: pending.reduce((s, p) => s + p.openCount, 0) };
}

// ── Main ──

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (!msg.jsonrpc || msg.jsonrpc !== '2.0') return;

    // Handle initialize
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'agmark', version: '1.6.0' },
          capabilities: { tools: {} }
        }
      });
      initialized = true;
      return;
    }

    // Handle notifications (no id)
    if (msg.method === 'notifications/initialized') {
      return; // no response needed
    }

    if (!msg.id) return; // notification, ignore

    // Handle tools/list
    if (msg.method === 'tools/list') {
      respond(msg.id, { tools: TOOLS });
      return;
    }

    // Handle tools/call
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      try {
        let result;
        switch (name) {
          case 'get_annotations': result = handleGetAnnotations(args); break;
          case 'reply_to_annotation': result = handleReply(args); break;
          case 'list_pending': result = handleListPending(); break;
          case 'get_stats': result = handleGetStats(args); break;
          case 'refresh_document': result = handleRefreshDocument(args); break;
          case 'refresh_drift': result = handleRefreshDrift(args); break;
          default: return respondError(msg.id, -32601, 'Unknown tool: ' + name);
        }
        respond(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        respond(msg.id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
      return;
    }

    respondError(msg.id, -32601, 'Unknown method: ' + msg.method);
  } catch (e) {
    // Ignore parse errors for non-JSON lines
  }
});

rl.on('close', () => process.exit(0));

// Log to stderr (not stdout, which is the MCP transport)
process.stderr.write('[AgentMark MCP] Server started, project root: ' + projectRoot + '\n');
