#!/usr/bin/env node
'use strict';

// Plume Vault MCP server.
//
// Gives Claude Code, Codex or any MCP client a place to keep project memory,
// notes and write-ups that survives between sessions and follows you between
// machines — the same vault the Plume app syncs to.
//
// Usage, in an MCP client's config:
//
//   {
//     "mcpServers": {
//       "plume-vault": {
//         "command": "npx",
//         "args": ["-y", "@plume-md/vault-mcp"],
//         "env": { "PLUME_TOKEN": "plm_…" }
//       }
//     }
//   }
//
// Create the token at https://plume-md.com/app.html under "API tokens".
//
// Speaks MCP over stdio with no dependencies: the protocol is JSON-RPC 2.0
// framed as newline-delimited JSON, which is a few dozen lines to implement
// and leaves nothing to keep up to date.

const readline = require('node:readline');

const API = (process.env.PLUME_API || 'https://plume-md.com/api').replace(/\/+$/, '');
const TOKEN = process.env.PLUME_TOKEN || '';
const PROTOCOL_VERSION = '2024-11-05';
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Talking to the vault

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  if (!TOKEN) {
    throw new Error('PLUME_TOKEN is not set. Create one at https://plume-md.com/app.html under "API tokens".');
  }

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError'
      ? 'The vault did not answer in time.'
      : `Could not reach the vault at ${API}.`);
  }

  if (res.status === 401) throw new Error('That token was not accepted. It may have been revoked.');

  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `The vault refused that (${res.status}).`);
    return data;
  }
  if (!res.ok) throw new Error(`The vault refused that (${res.status}).`);
  return res;
}

const q = (path) => `?path=${encodeURIComponent(path)}`;

// ---------------------------------------------------------------------------
// The tools

const TOOLS = [
  {
    name: 'list_notes',
    description:
      'List every document in the Plume Vault, with its size and when it last changed. '
      + 'Call this first to find out what is already remembered about a project.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description: 'Only list documents whose path starts with this, e.g. "projects/plume/".',
        },
      },
    },
    async run({ prefix }) {
      const data = await call('/vault/list');
      let files = data.files;
      if (prefix) files = files.filter((f) => f.path.startsWith(prefix));
      if (!files.length) return prefix ? `No documents under "${prefix}".` : 'The vault is empty.';

      const lines = files.map((f) => `${f.path}  (${f.size} bytes, updated ${f.updatedAt})`);
      const used = Math.round((data.account.usedBytes / data.account.quotaBytes) * 100);
      return `${files.length} document${files.length === 1 ? '' : 's'}; vault ${used}% full.\n\n${lines.join('\n')}`;
    },
  },
  {
    name: 'read_note',
    description: 'Read one document out of the vault, by its exact path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. "projects/plume/decisions.md"' } },
      required: ['path'],
    },
    async run({ path }) {
      const res = await call(`/vault/file${q(path)}`);
      return await res.text();
    },
  },
  {
    name: 'write_note',
    description:
      'Create or replace a document in the vault. Use this to record project memory, decisions, '
      + 'notes and write-ups that should outlive this session. Markdown, and wiki links in '
      + '[[double brackets]] show up in the vault graph.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to keep it, e.g. "projects/plume/decisions.md". Must end in .md or another document extension.' },
        content: { type: 'string', description: 'The whole document. This replaces whatever was there.' },
      },
      required: ['path', 'content'],
    },
    async run({ path, content }) {
      const data = await call(`/vault/file${q(path)}`, {
        method: 'PUT',
        body: Buffer.from(String(content), 'utf8'),
      });
      return data.unchanged
        ? `${path} was already up to date.`
        : `Saved ${path} (${data.file.size} bytes).`;
    },
  },
  {
    name: 'append_note',
    description:
      'Add to the end of a document, creating it if it is not there yet. Better than write_note '
      + 'for a running log, because it cannot lose what is already written.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'The text to add at the end.' },
      },
      required: ['path', 'content'],
    },
    async run({ path, content }) {
      let existing = '';
      try {
        const res = await call(`/vault/file${q(path)}`);
        existing = await res.text();
      } catch (err) {
        if (!/not in your vault/.test(err.message)) throw err;
      }
      const joined = existing
        ? `${existing.replace(/\s*$/, '')}\n\n${content}\n`
        : `${content}\n`;
      const data = await call(`/vault/file${q(path)}`, {
        method: 'PUT',
        body: Buffer.from(joined, 'utf8'),
      });
      return `${existing ? 'Appended to' : 'Started'} ${path} (now ${data.file.size} bytes).`;
    },
  },
  {
    name: 'search_notes',
    description:
      'Search the text of every document in the vault and return the matching lines with their paths. '
      + 'Use this to recall what was decided or noted before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for. Case-insensitive.' },
        prefix: { type: 'string', description: 'Only search documents under this path.' },
      },
      required: ['query'],
    },
    async run({ query, prefix }) {
      const data = await call('/vault/list');
      const needle = String(query).toLowerCase();
      const searchable = data.files.filter((f) =>
        /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|txt|csv|json|ya?ml)$/i.test(f.path)
        && (!prefix || f.path.startsWith(prefix)));

      const hits = [];
      for (const file of searchable) {
        if (hits.length >= 80) break;
        let text;
        try {
          const res = await call(`/vault/file${q(file.path)}`);
          text = await res.text();
        } catch (err) {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push(`${file.path}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
            if (hits.length >= 80) break;
          }
        }
      }
      return hits.length ? hits.join('\n') : `Nothing in the vault matches "${query}".`;
    },
  },
  {
    name: 'delete_note',
    description: 'Remove a document from the vault for good. There is no undo.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async run({ path }) {
      await call(`/vault/file${q(path)}`, { method: 'DELETE' });
      return `Deleted ${path}.`;
    },
  },
  {
    name: 'vault_graph',
    description:
      'Show how the documents in the vault link to each other, and which links point at documents '
      + 'that do not exist yet. Useful for seeing the shape of what is remembered.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const data = await call('/vault/graph');
      if (!data.nodes.length) return 'The vault is empty.';

      const lines = [`${data.nodes.length} documents, ${data.edges.length} links.`, ''];
      const out = new Map();
      for (const edge of data.edges) {
        if (!out.has(edge.from)) out.set(edge.from, []);
        out.get(edge.from).push(edge.to);
      }
      for (const node of [...data.nodes].sort((a, b) => b.links - a.links)) {
        const targets = out.get(node.path) || [];
        lines.push(targets.length ? `${node.path} -> ${targets.join(', ')}` : `${node.path} (no outgoing links)`);
      }
      if (data.unresolved.length) {
        lines.push('', 'Linked but missing:');
        for (const miss of data.unresolved) lines.push(`  [[${miss.target}]] (${miss.count}x)`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'vault_status',
    description: 'How much of the vault is used, and which account this token belongs to.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const data = await call('/me');
      const a = data.account;
      const mb = (n) => (n / 1048576).toFixed(1);
      return `${a.email}\n${mb(a.usedBytes)} MB of ${mb(a.quotaBytes)} MB used across ${a.fileCount} documents.`;
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC over stdio

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return;   // a notification wants no answer
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'plume-vault', version: '1.0.0' },
        instructions:
          'Plume Vault is durable storage for project memory and notes. Read what is already '
          + 'there with list_notes and search_notes before answering questions about past work, '
          + 'and record decisions worth keeping with write_note or append_note.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = BY_NAME.get(params && params.name);
      if (!tool) return replyError(id, -32602, `No tool called ${params && params.name}`);
      try {
        const text = await tool.run((params && params.arguments) || {});
        return reply(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (err) {
        // A failed tool call is a result the model should see and can act on,
        // not a transport error.
        return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      return replyError(id, -32601, `Unknown method ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Requests are answered in order. A client may send several before reading any
// reply, and nothing here should let a later, quicker call overtake an earlier
// one — or let the process leave while any of them are still unanswered.
let queue = Promise.resolve();
let outstanding = 0;
let inputClosed = false;

function maybeExit() {
  if (inputClosed && outstanding === 0) process.exit(0);
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (err) {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  outstanding += 1;
  queue = queue
    .then(() => handle(message))
    .catch((err) => {
      replyError(message.id, -32603, err && err.message ? err.message : 'Internal error');
    })
    .finally(() => {
      outstanding -= 1;
      maybeExit();
    });
});

// stdin closing means the client has finished sending, not that work in flight
// should be abandoned half-done — a write_note must not be cut off mid-save.
rl.on('close', () => {
  inputClosed = true;
  maybeExit();
});

// stdout is the protocol; anything informational has to go to stderr.
if (!TOKEN) {
  process.stderr.write('[plume-vault] PLUME_TOKEN is not set — every tool call will fail.\n');
}
