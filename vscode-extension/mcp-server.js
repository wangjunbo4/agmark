#!/usr/bin/env node
"use strict";

// ── AgentMark MCP Server ──
// Reads/writes .comments/ files. Claude Code connects via stdio MCP.

const fs = require('fs');
const path = require('path');
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
