// The forge's state and git object machinery: an in-memory store of repositories, each holding a
// real git object store (SHA-1 blobs, trees, commits, tags), refs, labels, issues, pull requests
// and comments. Every surface (REST, GraphQL, MCP, git smart HTTP) works on this one store, so an
// object created through one surface is the same object through all the others.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a
// logical clock that advances one second per stamped event, so the same request sequence always
// produces the same bytes, the same object ids and the same answers.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The one user the trial's token names (wire.ts's seeded scenario viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const ZERO_SHA = '0'.repeat(40);
const CLOCK_BASE_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface Issue {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  dbId: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  createdHeadSha: string;
  createdBaseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
}

// -------------------------------------------------------------------------------------------------
// Object ids and storage
// -------------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

// -------------------------------------------------------------------------------------------------
// Commits and trees
// -------------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function parseTagTarget(data: Buffer): string {
  const match = /^object ([0-9a-f]{40})/m.exec(data.toString('utf8'));
  return match ? match[1] : '';
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob sha. An absent tree flattens to nothing. */
export function flattenTree(repo: Repo, treeSha: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (treeSha === null) return out;
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry.sha);
    }
  };
  walk(treeSha, '');
  return out;
}

/** Build (and store) a tree holding exactly `files` (path -> blob sha); returns its sha. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], sha);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** The tree of a commit, or null when the commit is unknown. */
export function commitTree(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Create a commit object authored by the viewer at the forge's logical time. */
export function makeCommit(forge: Forge, repo: Repo, treeSha: string, parents: string[], message: string): string {
  const stamp = forge.nowSec();
  const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8'));
}

// -------------------------------------------------------------------------------------------------
// History walks
// -------------------------------------------------------------------------------------------------

/** Every commit reachable from `tip`, tip first, parents after children (BFS by generation). */
export function commitHistory(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return order;
}

export function ancestorSet(repo: Repo, tip: string): Set<string> {
  return new Set(commitHistory(repo, tip));
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  return ancestorSet(repo, descendant).has(ancestor);
}

/** The nearest common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  for (const candidate of commitHistory(repo, b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

/** Peel a ref target to a commit sha (through tag objects), or null. */
export function peelToCommit(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTagTarget(obj.data);
      continue;
    }
    return null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Tree diffs and three-way merges (the pull-request machinery)
// -------------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  baseSha: string | null;
  headSha: string | null;
}

export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const before = flattenTree(repo, baseTree);
  const after = flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path) ?? null;
    const h = after.get(path) ?? null;
    if (b === h) continue;
    changes.push({ path, status: b === null ? 'added' : h === null ? 'removed' : 'modified', baseSha: b, headSha: h });
  }
  return changes;
}

/**
 * Three-way merge of flattened trees. Returns the merged path -> blob map, or the first
 * conflicting path. A path conflicts when both sides changed it differently (edit/edit,
 * edit/delete, add/add with different bytes).
 */
export function mergeFileMaps(
  base: Map<string, string>,
  ours: Map<string, string>,
  theirs: Map<string, string>,
): { files: Map<string, string> } | { conflict: string } {
  const merged = new Map<string, string>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, t);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { files: merged };
}

/** Try to merge `headRef` into the current tip of `baseRef`; used by REST, GraphQL and MCP alike. */
export function planMerge(
  repo: Repo,
  baseRef: string,
  headRef: string,
): { ok: true; treeSha: string; baseTip: string; headTip: string } | { ok: false; reason: 'missing' | 'conflict' } {
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'missing' };
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'missing' };
  const fork = mergeBase(repo, baseCommit, headCommit);
  const forkTree = fork === null ? null : commitTree(repo, fork);
  const baseTree = commitTree(repo, baseCommit);
  const headTree = commitTree(repo, headCommit);
  const merged = mergeFileMaps(flattenTree(repo, forkTree), flattenTree(repo, baseTree), flattenTree(repo, headTree));
  if ('conflict' in merged) return { ok: false, reason: 'conflict' };
  return { ok: true, treeSha: buildTreeFromFiles(repo, merged.files), baseTip: baseCommit, headTip: headCommit };
}

// -------------------------------------------------------------------------------------------------
// Packfiles
// -------------------------------------------------------------------------------------------------

/** Write a version-2 pack holding `objects` whole (no deltas), with its SHA-1 trailer. */
export function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const first = (size & 0x0f) | (TYPE_CODE[obj.type] << 4) | (size > 0x0f ? 0x80 : 0);
    const varint: number[] = [first];
    size >>= 4;
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      varint.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one deflated stream starting at `offset`; returns the data and the offset just past it. */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git binary delta (`base` -> result) as senders encode it. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let from = 0;
      let size = 0;
      if (op & 0x01) { from = delta[offset]; offset += 1; }
      if (op & 0x02) { from |= delta[offset] << 8; offset += 1; }
      if (op & 0x04) { from |= delta[offset] << 16; offset += 1; }
      if (op & 0x08) { from |= delta[offset] << 24; offset += 1; }
      if (op & 0x10) { size = delta[offset]; offset += 1; }
      if (op & 0x20) { size |= delta[offset] << 8; offset += 1; }
      if (op & 0x40) { size |= delta[offset] << 16; offset += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(from, from + size));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Read a pack received over receive-pack. Objects are resolved (deltas applied, thin-pack bases
 * taken from `lookup`) and returned whole. Throws on any structural problem.
 */
export function readPack(buf: Buffer, lookup: (sha: string) => GitObj | undefined): GitObj[] {
  if (buf.length < 12 + 20 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseSha?: string;
    start: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === 6) {
      let b = buf[offset];
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset];
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseSha = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateOne(buf, offset);
    offset = inflated.next;
    byOffset.set(start, raw.length);
    raw.push({
      type: typeCode === 6 ? 'ofs-delta' : typeCode === 7 ? 'ref-delta' : CODE_TYPE[typeCode],
      data: inflated.data,
      baseOffset,
      baseSha,
      start,
    });
  }
  const resolved = new Map<number, GitObj>();
  const resolve = (index: number): GitObj => {
    const memo = resolved.get(index);
    if (memo) return memo;
    const entry = raw[index];
    let obj: GitObj;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset!);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      const base = lookup(entry.baseSha!) ?? (() => {
        const inPack = raw.findIndex((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseSha);
        return inPack >= 0 ? resolve(inPack) : undefined;
      })();
      if (!base) throw new Error('ref-delta base not found');
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: entry.type, data: entry.data };
    }
    resolved.set(index, obj);
    return obj;
  };
  return raw.map((_, index) => resolve(index));
}

// -------------------------------------------------------------------------------------------------
// Reachability for upload-pack: what a fetch must carry
// -------------------------------------------------------------------------------------------------

/**
 * The full object closure of `tips` (commits, their trees and blobs, tags peeled through).
 * Commits in `boundary` (a shallow client's declared boundary) count as parentless: the client
 * holds the commit but none of its history, so a fetch must not treat that history as held.
 */
export function objectClosure(repo: Repo, tips: Iterable<string>, boundary?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const visitObject = (sha: string): void => {
    if (out.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj) return;
    out.add(sha);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      visitObject(view.tree);
      if (boundary === undefined || !boundary.has(sha)) {
        for (const parent of view.parents) visitObject(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) visitObject(entry.sha);
    } else if (obj.type === 'tag') {
      visitObject(parseTagTarget(obj.data));
    }
  };
  for (const tip of tips) visitObject(tip);
  return out;
}

export interface FetchSelection {
  objects: GitObj[];
  shallow: string[];
}

/**
 * Choose the objects a fetch answers with: the closure of `wants`, depth-limited when `depth` is
 * set, minus everything reachable from `haves`. Commits at the depth boundary are reported as
 * shallow. Objects come out in a stable order (commits by generation, then the rest by sha).
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: readonly string[] = [],
): FetchSelection {
  const haveClosure = objectClosure(repo, haves, new Set(clientShallow));
  // Generation of each wanted commit: 1 for a want itself, +1 per parent step.
  const generation = new Map<string, number>();
  const queue: Array<{ sha: string; gen: number }> = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !generation.has(commit)) {
      generation.set(commit, 1);
      queue.push({ sha: commit, gen: 1 });
    }
  }
  const includedCommits: string[] = [];
  const shallow: string[] = [];
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    if (depth !== null && gen > depth) continue;
    includedCommits.push(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (depth !== null && gen === depth && parents.length > 0) shallow.push(sha);
    for (const parent of parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push({ sha: parent, gen: gen + 1 });
      }
    }
  }
  const wanted = new Set<string>();
  // Tag objects pointing at wanted commits travel too.
  for (const want of wants) {
    if (want !== peelToCommit(repo, want) && repo.objects.has(want)) wanted.add(want);
  }
  for (const commit of includedCommits) {
    wanted.add(commit);
    const tree = commitTree(repo, commit);
    if (tree !== null) for (const sha of objectClosure(repo, [tree])) wanted.add(sha);
  }
  const objects: GitObj[] = [];
  for (const sha of wanted) {
    if (haveClosure.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj) objects.push(obj);
  }
  return { objects, shallow };
}

// -------------------------------------------------------------------------------------------------
// The forge itself
// -------------------------------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueDbSeq = 0;
  private commentSeq = 0;
  private clockTicks = 0;

  /** The next logical timestamp, in seconds since the epoch. */
  nowSec(): number {
    this.clockTicks += 1;
    return CLOCK_BASE_SEC + this.clockTicks;
  }

  /** The next logical timestamp as an ISO string. */
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      dbId: this.repoSeq,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  nextIssueDbId(): number {
    this.issueDbSeq += 1;
    return this.issueDbSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

/** Create an issue in `repo` (shared numbering with pull requests, as on GitHub). */
export function createIssue(forge: Forge, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const stamp = forge.nowIso();
  const issue: Issue = {
    number: repo.nextNumber,
    dbId: forge.nextIssueDbId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request in `repo` between two existing branches. */
export function createPull(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const stamp = forge.nowIso();
  const pull: Pull = {
    number: repo.nextNumber,
    dbId: forge.nextIssueDbId(),
    title,
    body,
    headRef,
    baseRef,
    createdHeadSha: repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_SHA,
    createdBaseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_SHA,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/**
 * Merge a pull request with the squash method: one commit on the base branch carrying the merged
 * tree. Returns the merge commit sha, or null when the merge conflicts.
 */
export function mergePullSquash(forge: Forge, repo: Repo, pull: Pull): string | null {
  const plan = planMerge(repo, pull.baseRef, pull.headRef);
  if (!plan.ok) return null;
  const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
  const sha = makeCommit(forge, repo, plan.treeSha, [plan.baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return sha;
}
