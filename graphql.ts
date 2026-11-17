// GraphQL v4 at POST /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server send — viewer, repository reads, issue/pull-request connections with cursor
// pagination, the create/close/merge/comment mutations, Relay node(id:) lookups, batched
// operations, and the __type introspection probes gh feature-detects with. Global ids are opaque
// base64, stable across reads, and decode back to the object they name.

import {
  Forge,
  type Repo,
  type Issue,
  type Pull,
  VIEWER,
  commitTree,
  createIssue,
  createPull,
  diffTrees,
  mergeBase,
  mergePullSquash,
  planMerge,
} from './forge.ts';

// -------------------------------------------------------------------------------------------------
// Global ids
// -------------------------------------------------------------------------------------------------

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
  fragment?: string; // set for `...Name` spreads
  inlineType?: string; // set for `... on Type` fragments
}

interface Operation {
  type: 'query' | 'mutation';
  selection: FieldNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if ('{}()[]:=@$!'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.') {
      if (input.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      throw new GqlSyntaxError('unexpected .');
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${input.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          out += input[j + 1] === 'n' ? '\n' : input[j + 1] === 't' ? '\t' : input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const rest = input.slice(i);
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (name) {
      tokens.push(name[0]);
      i += name[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      tokens.push(number[0]);
      i += number[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { type: string; selection: FieldNode[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        this.next();
        if (this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
        if (this.peek() === '(') this.skipParens(); // variable definitions
        operations.push({ type: head, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const type = this.next();
        fragments.set(name, { type, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const type = this.next();
        return { name: '', alias: null, args: new Map(), selection: this.parseSelectionSet(), inlineType: type };
      }
      const name = this.next();
      return { name: '', alias: null, args: new Map(), selection: null, fragment: name };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    if (this.peek() === '@') {
      // A directive: skip its name and any argument list.
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Schema surface
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'updatedAt', 'repository', 'author', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'updatedAt', 'repository', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// -------------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------------

interface GObj {
  __type: string;
  data: unknown;
}

interface Context {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { type: string; selection: FieldNode[] }>;
  errors: Array<{ message: string }>;
}

function obj(type: string, data: unknown): GObj {
  return { __type: type, data };
}

function repoOf(g: GObj): Repo {
  return g.data as Repo;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const matched = /^cursor:(\d+)$/.exec(text);
    return matched ? Number(matched[1]) : null;
  } catch {
    return null;
  }
}

interface Connection {
  items: GObj[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
  numbers: number[];
}

function issueConnection(repo: Repo, args: Map<string, Value>, ctx: Context): Connection {
  const states = args.has('states') ? (resolveValue(args.get('states')!, ctx.variables) as string[]) : null;
  const orderBy = args.has('orderBy') ? (resolveValue(args.get('orderBy')!, ctx.variables) as { direction?: string }) : null;
  let issues = [...repo.issues.values()];
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  return pageOf(issues.map((issue) => obj('Issue', { repo, issue })), issues.map((issue) => issue.number), args, ctx);
}

function pullConnection(repo: Repo, args: Map<string, Value>, ctx: Context): Connection {
  let pulls = [...repo.pulls.values()];
  const states = args.has('states') ? (resolveValue(args.get('states')!, ctx.variables) as string[]) : null;
  if (states !== null) {
    pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  pulls.sort((a, b) => a.number - b.number);
  return pageOf(pulls.map((pull) => obj('PullRequest', { repo, pull })), pulls.map((pull) => pull.number), args, ctx);
}

function pageOf(items: GObj[], numbers: number[], args: Map<string, Value>, ctx: Context): Connection {
  let start = 0;
  const after = args.has('after') ? (resolveValue(args.get('after')!, ctx.variables) as string | null) : null;
  if (after !== null && after !== undefined) {
    const number = numberOfCursor(after);
    if (number !== null) {
      const index = numbers.indexOf(number);
      if (index >= 0) start = index + 1;
    }
  }
  const first = args.has('first') ? (resolveValue(args.get('first')!, ctx.variables) as number) : null;
  const slice = first !== null && first !== undefined ? items.slice(start, start + first) : items.slice(start);
  const sliceNumbers = first !== null && first !== undefined ? numbers.slice(start, start + first) : numbers.slice(start);
  return {
    items: slice,
    total: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: sliceNumbers.length > 0 ? cursorOf(sliceNumbers[sliceNumbers.length - 1]) : null,
    numbers: sliceNumbers,
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

function findRepoByDbId(forge: Forge, dbId: number): Repo | undefined {
  return forge.listRepos().find((repo) => repo.dbId === dbId);
}

function resolveField(ctx: Context, source: GObj | null, field: FieldNode): unknown {
  const typeName = source === null ? (field.name === '__type' || field.name === '__schema' ? 'Query' : 'Query') : source.__type;
  const name = field.name;
  if (name === '__typename') return typeName;
  const known = TYPE_FIELDS[typeName];
  if (name !== '__type' && name !== '__schema' && (!known || !known.includes(name))) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const arg = (key: string): unknown => (field.args.has(key) ? resolveValue(field.args.get(key)!, ctx.variables) : undefined);
  const forge = ctx.forge;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return obj('User', VIEWER);
      if (name === 'repository') {
        const repo = forge.getRepo(String(arg('owner')), String(arg('name')));
        return repo ? obj('Repository', repo) : null;
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(String(arg('id')));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoByDbId(forge, Number(decoded.key));
          return repo ? obj('Repository', repo) : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoDb, number] = decoded.key.split(':').map(Number);
          const repo = findRepoByDbId(forge, repoDb);
          if (!repo) return null;
          if (decoded.type === 'Issue') {
            const issue = repo.issues.get(number);
            return issue ? obj('Issue', { repo, issue }) : null;
          }
          const pull = repo.pulls.get(number);
          return pull ? obj('PullRequest', { repo, pull }) : null;
        }
        if (decoded.type === 'User') return obj('User', VIEWER);
        return null;
      }
      if (name === '__type') return typeInfo(String(arg('name')));
      if (name === '__schema') return obj('__Schema', null);
      return null;
    }
    case 'Mutation': {
      const input = (arg('input') ?? {}) as Record<string, unknown>;
      if (name === 'createIssue') {
        const decoded = decodeGlobalId(String(input.repositoryId));
        const repo = decoded ? findRepoByDbId(forge, Number(decoded.key)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const issue = createIssue(forge, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return obj('CreateIssuePayload', { repo, issue });
      }
      if (name === 'closeIssue') {
        const decoded = decodeGlobalId(String(input.issueId));
        if (!decoded) return null;
        const [repoDb, number] = decoded.key.split(':').map(Number);
        const repo = findRepoByDbId(forge, repoDb);
        const issue = repo?.issues.get(number);
        if (!repo || !issue) return null;
        issue.state = 'closed';
        issue.updatedAt = forge.nowIso();
        return obj('CloseIssuePayload', { repo, issue });
      }
      if (name === 'createPullRequest') {
        const decoded = decodeGlobalId(String(input.repositoryId));
        const repo = decoded ? findRepoByDbId(forge, Number(decoded.key)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
          ctx.errors.push({ message: 'Invalid head or base branch' });
          return null;
        }
        const pull = createPull(forge, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return obj('CreatePullRequestPayload', { repo, pull });
      }
      if (name === 'mergePullRequest') {
        const decoded = decodeGlobalId(String(input.pullRequestId));
        if (!decoded) return null;
        const [repoDb, number] = decoded.key.split(':').map(Number);
        const repo = findRepoByDbId(forge, repoDb);
        const pull = repo?.pulls.get(number);
        if (!repo || !pull) return null;
        if (!pull.merged) {
          const sha = mergePullSquash(forge, repo, pull);
          if (sha === null) {
            ctx.errors.push({ message: 'Pull Request is not mergeable' });
            return null;
          }
        }
        return obj('MergePullRequestPayload', { repo, pull });
      }
      if (name === 'addComment') {
        const decoded = decodeGlobalId(String(input.subjectId));
        if (!decoded) return null;
        const [repoDb, number] = decoded.key.split(':').map(Number);
        const repo = findRepoByDbId(forge, repoDb);
        if (!repo || (!repo.issues.has(number) && !repo.pulls.has(number))) return null;
        const comment = { id: forge.nextCommentId(), body: String(input.body ?? ''), createdAt: forge.nowIso() };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return obj('AddCommentPayload', { repo, number, comment });
      }
      return null;
    }
    case 'User': {
      const user = source!.data as typeof VIEWER;
      if (name === 'login') return user.login;
      if (name === 'id') return globalId('User', user.login);
      if (name === 'name') return user.name;
      if (name === 'email') return user.email;
      if (name === 'url') return `https://forge.invalid/${user.login}`;
      return null;
    }
    case 'Repository': {
      const repo = repoOf(source!);
      switch (name) {
        case 'id':
          return globalId('Repository', String(repo.dbId));
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return obj('User', VIEWER);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : obj('Ref', { name: repo.defaultBranch, target: tip });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'issue': {
          const issue = repo.issues.get(Number(arg('number')));
          return issue ? obj('Issue', { repo, issue }) : null;
        }
        case 'issues':
          return obj('IssueConnection', issueConnection(repo, field.args, ctx));
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(arg('number')));
          return pull ? obj('PullRequest', { repo, pull }) : null;
        }
        case 'pullRequests':
          return obj('PullRequestConnection', pullConnection(repo, field.args, ctx));
        default:
          return null;
      }
    }
    case 'Ref': {
      const ref = source!.data as { name: string; target: string };
      if (name === 'name') return ref.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return null;
      return null;
    }
    case 'Issue': {
      const { repo, issue } = source!.data as { repo: Repo; issue: Issue };
      switch (name) {
        case 'id':
          return globalId('Issue', `${repo.dbId}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'repository':
          return obj('Repository', repo);
        case 'author':
          return obj('User', VIEWER);
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source!.data as { repo: Repo; pull: Pull };
      switch (name) {
        case 'id':
          return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return planMerge(repo, pull.baseRef, pull.headRef).ok ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
          if (baseTip === undefined || headTip === undefined) return obj('PullRequestConnection', emptyConnection());
          const fork = mergeBase(repo, baseTip, headTip);
          const changes = diffTrees(repo, fork === null ? null : commitTree(repo, fork), commitTree(repo, headTip));
          const first = field.args.has('first') ? (resolveValue(field.args.get('first')!, ctx.variables) as number) : changes.length;
          const nodes = changes.slice(0, first).map((change) => obj('PullRequestChangedFile', change));
          return obj('PullRequestConnection', { items: nodes, total: changes.length, hasNextPage: false, endCursor: null, numbers: [] });
        }
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'repository':
          return obj('Repository', repo);
        case 'author':
          return obj('User', VIEWER);
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const connection = source!.data as Connection;
      if (name === 'nodes') return connection.items;
      if (name === 'totalCount') return connection.total;
      if (name === 'pageInfo') return obj('PageInfo', connection);
      if (name === 'edges') {
        return connection.items.map((item, index) => obj('CommentEdge', { nodeRaw: item, cursor: cursorOf(connection.numbers[index] ?? index) }));
      }
      return null;
    }
    case 'PageInfo': {
      const connection = source!.data as Connection;
      if (name === 'hasNextPage') return connection.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return connection.endCursor;
      if (name === 'startCursor') return connection.numbers.length > 0 ? cursorOf(connection.numbers[0]) : null;
      return null;
    }
    case 'PullRequestChangedFile': {
      const change = source!.data as { path: string };
      if (name === 'path') return change.path;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const { repo, issue } = source!.data as { repo: Repo; issue: Issue };
      if (name === 'issue') return obj('Issue', { repo, issue });
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const { repo, pull } = source!.data as { repo: Repo; pull: Pull };
      if (name === 'pullRequest') return obj('PullRequest', { repo, pull });
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      const { repo, number, comment } = source!.data as { repo: Repo; number: number; comment: { id: number; body: string; createdAt: string } };
      if (name === 'commentEdge') return obj('CommentEdge', { nodeRaw: obj('IssueComment', { repo, number, comment }) });
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CommentEdge': {
      const edge = source!.data as { nodeRaw?: GObj; cursor?: string };
      if (name === 'node') return edge.nodeRaw ?? null;
      if (name === 'cursor') return edge.cursor ?? '';
      return null;
    }
    case 'IssueComment': {
      const { repo, number, comment } = source!.data as { repo: Repo; number: number; comment: { id: number; body: string; createdAt: string } };
      if (name === 'id') return globalId('IssueComment', `${repo.dbId}:${number}:${comment.id}`);
      if (name === 'body') return comment.body;
      if (name === 'createdAt' || name === 'updatedAt') return comment.createdAt;
      if (name === 'author') return obj('User', VIEWER);
      return null;
    }
    case '__Type': {
      const info = source!.data as { name: string; kind: string; fields: string[]; enumValues: string[] } | null;
      if (!info) return null;
      if (name === 'name') return info.name;
      if (name === 'kind') return info.kind;
      if (name === 'description') return null;
      if (name === 'fields') return info.fields.map((fieldName) => obj('__Field', { name: fieldName }));
      if (name === 'enumValues') return info.enumValues.map((value) => obj('__EnumValue', { name: value }));
      if (name === 'possibleTypes') return null;
      if (name === 'inputFields') return null;
      if (name === 'ofType') return null;
      if (name === 'specifiedByURL') return null;
      return null;
    }
    case '__Field': {
      const info = source!.data as { name: string };
      if (name === 'name') return info.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      if (name === 'args') return [];
      if (name === 'type') return null;
      return null;
    }
    case '__EnumValue': {
      const info = source!.data as { name: string };
      if (name === 'name') return info.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return typeInfo('Query');
      if (name === 'mutationType') return typeInfo('Mutation');
      if (name === 'subscriptionType') return null;
      if (name === 'types') return Object.keys(TYPE_FIELDS).map((typeName) => typeInfo(typeName));
      if (name === 'directives') return [];
      return null;
    }
    default:
      return null;
  }
}

function emptyConnection(): Connection {
  return { items: [], total: 0, hasNextPage: false, endCursor: null, numbers: [] };
}

function typeInfo(name: string): GObj | null {
  if (ENUM_VALUES[name]) {
    return obj('__Type', { name, kind: 'ENUM', fields: [], enumValues: ENUM_VALUES[name] });
  }
  if (TYPE_FIELDS[name]) {
    return obj('__Type', { name, kind: 'OBJECT', fields: TYPE_FIELDS[name], enumValues: [] });
  }
  return null;
}

function executeSelection(ctx: Context, source: GObj | null, selection: FieldNode[], rootType: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const expand = (fields: FieldNode[], current: GObj | null): void => {
    for (const field of fields) {
      if (field.inlineType !== undefined) {
        if (current !== null && current.__type === field.inlineType) expand(field.selection ?? [], current);
        continue;
      }
      if (field.fragment !== undefined) {
        const fragment = ctx.fragments.get(field.fragment);
        if (fragment && current !== null && current.__type === fragment.type) expand(fragment.selection, current);
        continue;
      }
      const key = field.alias ?? field.name;
      const value = field.name === '__type' || field.name === '__schema'
        ? resolveRootMeta(ctx, field)
        : resolveField(ctx, current, field);
      out[key] = materialize(ctx, value, field);
    }
  };
  expand(selection, source);
  return out;
}

function resolveRootMeta(ctx: Context, field: FieldNode): unknown {
  if (field.name === '__type') {
    const nameArg = field.args.has('name') ? resolveValue(field.args.get('name')!, ctx.variables) : '';
    return typeInfo(String(nameArg));
  }
  return obj('__Schema', null);
}

function materialize(ctx: Context, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => materialize(ctx, item, field));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const g = value as GObj;
    if (!field.selection) return null;
    return executeSelection(ctx, g, field.selection, g.__type);
  }
  return value;
}

// -------------------------------------------------------------------------------------------------
// HTTP entry
// -------------------------------------------------------------------------------------------------

export interface GraphQLAnswer {
  status: number;
  body: unknown;
}

function runOperation(forge: Forge, queryText: string, variables: Record<string, unknown>): Record<string, unknown> {
  let parsed: { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> };
  try {
    parsed = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation = parsed.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Context = { forge, variables, fragments: parsed.fragments, errors: [] };
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', null);
  // Root fields resolve against the operation type as their parent "type".
  const data = executeRoot(ctx, root, operation);
  const answer: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) answer.errors = ctx.errors;
  return answer;
}

function executeRoot(ctx: Context, root: GObj, operation: Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of operation.selection) {
    if (field.inlineType !== undefined || field.fragment !== undefined) continue;
    const key = field.alias ?? field.name;
    const value = field.name === '__type' || field.name === '__schema'
      ? resolveRootMeta(ctx, field)
      : resolveField(ctx, root, field);
    out[key] = materialize(ctx, value, field);
  }
  return out;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). Auth is the caller's. */
export function handleGraphQL(forge: Forge, bodyText: string): GraphQLAnswer {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'request body is not JSON' }] } };
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const item = (entry ?? {}) as { query?: unknown; variables?: unknown };
      const variables = typeof item.variables === 'string' ? (JSON.parse(item.variables) as Record<string, unknown>) : ((item.variables ?? {}) as Record<string, unknown>);
      return runOperation(forge, typeof item.query === 'string' ? item.query : '', variables);
    });
    return { status: 200, body: results };
  }
  const item = (body ?? {}) as { query?: unknown; variables?: unknown };
  const variables = typeof item.variables === 'string' ? (JSON.parse(item.variables) as Record<string, unknown>) : ((item.variables ?? {}) as Record<string, unknown>);
  return { status: 200, body: runOperation(forge, typeof item.query === 'string' ? item.query : '', variables) };
}
