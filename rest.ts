// The REST v3 surface under /api/v3: repositories, branches, refs, commits, contents, labels,
// issues, comments and pull requests, with GitHub's status codes and JSON shapes. Everything is
// backed by the forge's one store, so git pushes, GraphQL mutations and MCP calls all show here.

import {
  Forge,
  type Repo,
  type Issue,
  type Pull,
  VIEWER,
  ZERO_SHA,
  buildTreeFromFiles,
  commitHistory,
  commitTree,
  createIssue,
  createPull,
  diffTrees,
  flattenTree,
  makeCommit,
  mergeBase,
  mergePullSquash,
  parseCommit,
  parseTree,
  planMerge,
  storeObject,
} from './forge.ts';

export interface RestAnswer {
  status: number;
  body: unknown; // null means an empty body (204)
  link?: string;
}

const NOT_FOUND: RestAnswer = { status: 404, body: { message: 'Not Found' } };

function message(status: number, text: string): RestAnswer {
  return { status, body: { message: text } };
}

// -------------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    archived: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? 'ededed',
    })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function branchTip(repo: Repo, ref: string): string {
  return repo.refs.get(`refs/heads/${ref}`) ?? ZERO_SHA;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.createdHeadSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.createdBaseSha;
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// -------------------------------------------------------------------------------------------------
// Pagination (the Link-header chain the user/repos check follows)
// -------------------------------------------------------------------------------------------------

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate(items: unknown[], query: URLSearchParams, origin: string, path: string): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const last = Math.ceil(items.length / perPage);
    const base = `${origin}${path}?per_page=${perPage}`;
    link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${last}>; rel="last"`;
  }
  return { items: slice, link };
}

function listAnswer(items: unknown[], query: URLSearchParams, origin: string, path: string): RestAnswer {
  const page = paginate(items, query, origin, path);
  return { status: 200, body: page.items, link: page.link ?? undefined };
}

// -------------------------------------------------------------------------------------------------
// Contents helpers
// -------------------------------------------------------------------------------------------------

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/** Resolve a ref parameter (branch name or commit sha) to a commit sha. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  return null;
}

/** Walk a tree to `path`; returns the entry found (blob or subtree) with its sha. */
function treeEntryAt(repo: Repo, treeSha: string, path: string): { kind: 'file' | 'dir'; sha: string } | null {
  if (path === '') return { kind: 'dir', sha: treeSha };
  const segments = path.split('/');
  let current = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', sha: entry.sha };
    }
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

// -------------------------------------------------------------------------------------------------
// The router
// -------------------------------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the API root). */
  segments: string[];
  /** The request path under /api/v3, for Link headers. */
  path: string;
  query: URLSearchParams;
  /** The entry's origin as the client reached it (http://host), for Link headers. */
  origin: string;
  /** The parsed JSON body for POST/PUT/PATCH/DELETE, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
}

export function handleRest(forge: Forge, request: RestRequest): RestAnswer {
  const { method, segments, query } = request;
  const body = request.body ?? {};

  // The API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: { installed_version: '1.0.0', gitlab_version: undefined, verifiable_password_authentication: false } };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: userJson() };
  }

  // The token owner's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      return listAnswer(forge.listRepos().map(repoJson), query, request.origin, request.path);
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return message(422, 'Validation Failed: name is required');
      if (forge.getRepo(VIEWER.login, name)) return message(422, 'Validation Failed: name already exists on this account');
      const repo = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      return { status: 201, body: repoJson(repo) };
    }
    return NOT_FOUND;
  }

  if (segments[0] !== 'repos' || segments.length < 3) return NOT_FOUND;
  const owner = segments[1];
  const repo = forge.getRepo(owner, segments[2]);
  if (!repo) return NOT_FOUND;
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repo.name);
      return { status: 204, body: null };
    }
    return NOT_FOUND;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
      return listAnswer(branches, query, request.origin, request.path);
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return NOT_FOUND;
      return { status: 200, body: { name, commit: { sha } } };
    }
    return NOT_FOUND;
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return message(422, 'Validation Failed: not a valid ref or object');
      if (repo.refs.has(ref)) return message(422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return NOT_FOUND;
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    return NOT_FOUND;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha'));
    if (tip === null) {
      if (repo.refs.size === 0) return message(409, 'Git Repository is empty.');
      return NOT_FOUND;
    }
    const items = commitHistory(repo, tip).map((sha) => {
      const obj = repo.objects.get(sha)!;
      const view = parseCommit(obj.data);
      const raw = obj.data.toString('utf8');
      const authorLine = /^author (.*)$/m.exec(raw)?.[1] ?? '';
      const committerLine = /^committer (.*)$/m.exec(raw)?.[1] ?? '';
      const person = (line: string): Record<string, unknown> => {
        const matched = /^(.*) <(.*)> (\d+) /.exec(line);
        return {
          name: matched?.[1] ?? VIEWER.name,
          email: matched?.[2] ?? VIEWER.email,
          date: new Date(Number(matched?.[3] ?? '0') * 1000).toISOString(),
        };
      };
      return {
        sha,
        commit: {
          message: view.message.replace(/\n+$/, ''),
          author: person(authorLine),
          committer: person(committerLine),
          tree: { sha: view.tree },
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
      };
    });
    return listAnswer(items, query, request.origin, request.path);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, query.get('ref'));
      if (tip === null) return NOT_FOUND;
      const tree = commitTree(repo, tip);
      if (tree === null) return NOT_FOUND;
      const found = treeEntryAt(repo, tree, path);
      if (!found) return NOT_FOUND;
      if (found.kind === 'file') {
        const blob = repo.objects.get(found.sha)!;
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            name: basename(path),
            path,
            sha: found.sha,
            size: blob.data.length,
            content: blob.data.toString('base64'),
          },
        };
      }
      const treeObj = repo.objects.get(found.sha)!;
      const entries = parseTree(treeObj.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.sha,
      }));
      return { status: 200, body: entries };
    }
    if (method === 'PUT') {
      if (path === '') return message(422, 'Validation Failed: no path given');
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      const files = flattenTree(repo, tip === undefined ? null : commitTree(repo, tip));
      const existing = files.get(path);
      const shaGiven = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
      if (existing !== undefined) {
        if (shaGiven === undefined) return message(422, 'Validation Failed: sha is required when updating a file');
        if (shaGiven !== existing.toLowerCase()) return message(409, 'Validation Failed: the sha does not match the current file');
      }
      const data = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
      const blobSha = storeObject(repo, 'blob', data);
      files.set(path, blobSha);
      const newTree = buildTreeFromFiles(repo, files);
      const commitSha = makeCommit(forge, repo, newTree, tip === undefined ? [] : [tip], typeof body.message === 'string' ? body.message : 'Update file');
      repo.refs.set(refName, commitSha);
      return {
        status: existing !== undefined ? 200 : 201,
        body: {
          content: { name: basename(path), path, sha: blobSha, size: data.length, encoding: 'base64' },
          commit: { sha: commitSha, message: typeof body.message === 'string' ? body.message : 'Update file' },
        },
      };
    }
    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (tip === undefined) return NOT_FOUND;
      const files = flattenTree(repo, commitTree(repo, tip));
      const existing = files.get(path);
      if (existing === undefined) return NOT_FOUND;
      const shaGiven = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
      if (shaGiven !== undefined && shaGiven !== existing.toLowerCase()) return message(409, 'Validation Failed: the sha does not match the current file');
      files.delete(path);
      const newTree = buildTreeFromFiles(repo, files);
      const commitSha = makeCommit(forge, repo, newTree, [tip], typeof body.message === 'string' ? body.message : 'Delete file');
      repo.refs.set(refName, commitSha);
      return { status: 200, body: { content: null, commit: { sha: commitSha } } };
    }
    return NOT_FOUND;
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') {
      return listAnswer([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })), query, request.origin, request.path);
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return message(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return message(422, 'Validation Failed: a label with that name already exists');
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name, { name, color });
      return { status: 201, body: { name, color, default: false, description: typeof body.description === 'string' ? body.description : null } };
    }
    return NOT_FOUND;
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return listAnswer(issues.map((issue) => issueJson(repo, issue)), query, request.origin, request.path);
      }
      if (method === 'POST') {
        const labelNames = labelNamesOf(body.labels);
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return message(422, `Validation Failed: label '${name}' does not exist in this repository`);
        }
        const issue = createIssue(
          forge,
          repo,
          typeof body.title === 'string' ? body.title : '',
          typeof body.body === 'string' ? body.body : '',
          labelNames,
        );
        return { status: 201, body: issueJson(repo, issue) };
      }
      return NOT_FOUND;
    }
    const number = Number.parseInt(rest[1], 10);
    if (rest.length === 2) {
      const issue = repo.issues.get(number);
      if (!issue) return NOT_FOUND;
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.labels !== undefined) {
          const labelNames = labelNamesOf(body.labels);
          for (const name of labelNames) {
            if (!repo.labels.has(name)) return message(422, `Validation Failed: label '${name}' does not exist in this repository`);
          }
          issue.labels = labelNames;
        }
        issue.updatedAt = forge.nowIso();
        return { status: 200, body: issueJson(repo, issue) };
      }
      return NOT_FOUND;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!repo.issues.has(number) && !repo.pulls.has(number)) return NOT_FOUND;
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        }));
        return listAnswer(comments, query, request.origin, request.path);
      }
      if (method === 'POST') {
        const comment = {
          id: forge.nextCommentId(),
          body: typeof body.body === 'string' ? body.body : '',
          createdAt: forge.nowIso(),
        };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return {
          status: 201,
          body: {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          },
        };
      }
      return NOT_FOUND;
    }
    return NOT_FOUND;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => a.number - b.number);
        return listAnswer(pulls.map((pull) => pullJson(repo, pull)), query, request.origin, request.path);
      }
      if (method === 'POST') {
        const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
        const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '');
        if (!repo.refs.has(`refs/heads/${head}`)) return message(422, `Validation Failed: head branch '${head}' does not exist`);
        if (!repo.refs.has(`refs/heads/${base}`)) return message(422, `Validation Failed: base branch '${base}' does not exist`);
        const duplicate = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
        );
        if (duplicate) return message(422, 'Validation Failed: a pull request already exists for this head and base');
        const pull = createPull(
          forge,
          repo,
          typeof body.title === 'string' ? body.title : '',
          typeof body.body === 'string' ? body.body : '',
          head,
          base,
        );
        return { status: 201, body: pullJson(repo, pull) };
      }
      return NOT_FOUND;
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return NOT_FOUND;
      if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
      return NOT_FOUND;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return NOT_FOUND;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) return { status: 200, body: [] };
      const fork = mergeBase(repo, baseTip, headTip);
      const changes = diffTrees(repo, fork === null ? null : commitTree(repo, fork), commitTree(repo, headTip));
      const files = changes.map((change) => {
        const baseData = change.baseSha ? repo.objects.get(change.baseSha)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
        const headData = change.headSha ? repo.objects.get(change.headSha)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
        const additions = change.status === 'removed' ? 0 : lineCount(headData);
        const deletions = change.status === 'added' ? 0 : lineCount(baseData);
        return {
          filename: change.path,
          status: change.status,
          additions,
          deletions,
          changes: additions + deletions,
          sha: change.headSha ?? ZERO_SHA,
        };
      });
      return listAnswer(files, query, request.origin, request.path);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return NOT_FOUND;
      if (pull.state !== 'open') return message(405, 'Pull Request is not mergeable');
      const plan = planMerge(repo, pull.baseRef, pull.headRef);
      if (!plan.ok) return message(405, 'Pull Request is not mergeable');
      const sha = mergePullSquash(forge, repo, pull);
      if (sha === null) return message(405, 'Pull Request is not mergeable');
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

function labelNamesOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function stripOwnerPrefix(ref: string): string {
  const at = ref.indexOf(':');
  return at < 0 ? ref : ref.slice(at + 1);
}
