// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over streamable HTTP, legacy handshake revision
// (initialize + notifications/initialized; server/discover is refused with -32601, which the
// suite accepts as a pre-discover server). The tools act on the same store as REST and GraphQL,
// so an object made here reads back identically everywhere.

import { Forge, VIEWER, createIssue, createPull, mergePullSquash, type Repo } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpAnswer {
  status: number;
  body: unknown; // null means an empty body
}

const SERVER_INFO = { name: 'ochamoko-forge', version: '1.0.0' };
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
];

/** The tools/list payload, built once so repeated answers are byte-identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (!spec) return null;
  for (const required of spec.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  const repoOf = (): Repo | undefined => forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const issue = createIssue(forge, repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return toolOk(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return toolError('issue not found');
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
      const pull = createPull(forge, repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError('pull request not found');
      if (!pull.merged) {
        const sha = mergePullSquash(forge, repo, pull);
        if (sha === null) return toolError('pull request is not mergeable');
      }
      return toolOk(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = repoOf();
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      return toolOk(pulls.map((pull) => pullJson(repo, pull)));
    }
    default:
      return null;
  }
}

function handleOne(forge: Forge, message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcError(id, -32601, 'method not found: server/discover');
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = callTool(forge, name, args);
      if (result === null) return rpcError(id, -32602, `unknown tool: ${name}`);
      return rpcResult(id, result);
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Handle one POST /mcp body. Auth is the caller's job. */
export function handleMcp(forge: Forge, bodyText: string): McpAnswer {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(body)) {
    const answers = body
      .map((entry) => handleOne(forge, (entry ?? {}) as Record<string, unknown>))
      .filter((answer) => answer !== null);
    return { status: 200, body: answers };
  }
  const answer = handleOne(forge, (body ?? {}) as Record<string, unknown>);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
