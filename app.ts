// The forge's HTTP server: one process serving git smart HTTP at /<owner>/<repo>.git, REST v3
// under /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, all over the forge's one store.
// main.ts owns the entry <-> env lifecycle; this file is the whole surface.
//
// Auth: every surface but /healthz takes the trial's bearer token (MAKEFUN_SHOP_TOKEN in this
// process's environment). A request without it, or with a different one, is a 401 — a repository
// the token does not own is then never even looked up under another owner's name (404, not 403).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleGitRequest } from './githttp.ts';
import { handleRest, type RestAnswer } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (body === null || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, req, res).catch(() => {
      // A handler failure must never take the forge down with it.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const pathname = url.pathname;
  const segments = pathSegments(pathname);

  // The env's boot check: no auth, always up.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isApi = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
  const isGraphQL = pathname === '/api/graphql';
  const isMcp = pathname === '/mcp';
  const isGit = segments.length >= 2 && segments[1].endsWith('.git');

  if (!isApi && !isGraphQL && !isMcp && !isGit) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (isGit) {
    const answer = handleGitRequest(forge, method, segments, url.searchParams, req.headers['git-protocol'] ?? '', body);
    res.writeHead(answer.status, {
      'content-type': answer.contentType,
      'content-length': answer.body.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(answer.body);
    return;
  }

  if (isGraphQL) {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const answer = handleGraphQL(forge, body.toString('utf8'));
    sendJson(res, answer.status, answer.body);
    return;
  }

  if (isMcp) {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const answer = handleMcp(forge, body.toString('utf8'));
    sendJson(res, answer.status, answer.body);
    return;
  }

  // REST v3.
  let jsonBody: Record<string, unknown> | undefined;
  if (body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      jsonBody = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }
  const restSegments = segments.slice(2); // drop "api" and "v3"
  const answer: RestAnswer = handleRest(forge, {
    method,
    segments: restSegments,
    path: pathname,
    query: url.searchParams,
    origin: `http://${req.headers.host ?? 'localhost'}`,
    body: jsonBody,
  });
  const headers: Record<string, string> = { 'x-oauth-scopes': 'repo, read:org' };
  if (answer.link) headers.link = answer.link;
  sendJson(res, answer.status, answer.body, headers);
}
