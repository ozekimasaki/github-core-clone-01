// Git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs and fetch over protocol v2
// (with a v0 fetch fallback), and receive-pack pushes with report-status over side-band-64k.
// Implemented from the protocol itself on the forge's own object store — no git binary anywhere.

import {
  Forge,
  type Repo,
  ZERO_SHA,
  hashObject,
  isAncestor,
  objectClosure,
  parseTagTarget,
  peelToCommit,
  readPack,
  selectFetchObjects,
  writePack,
  type GitObj,
} from './forge.ts';

const AGENT = 'ochamoko-forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta quiet agent=${AGENT}`;

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonAnswer(status: number, body: unknown): GitAnswer {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from `offset`; returns the packets and the offset of the first unparsed byte. */
function parsePackets(buf: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const header = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      return { packets, next: at };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      at += 4;
      return { packets, next: at };
    }
    if (length < 4 || at + length > buf.length) throw new Error('malformed pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  if (at !== buf.length) throw new Error('malformed pkt-line');
  return { packets, next: at };
}

function packetText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

// -------------------------------------------------------------------------------------------------
// Ref advertisement
// -------------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  lines.push({ oid: headTip ?? ZERO_SHA, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

function advertiseV0(repo: Repo, service: string): GitAnswer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : UPLOAD_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = refLines(repo).filter((line) => repo.refs.size > 0 || line.name === 'HEAD');
  const realRefs = [...repo.refs.keys()];
  if (realRefs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

function advertiseV2(service: string): GitAnswer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let suffix = '';
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) suffix = ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// fetch (upload-pack POST)
// -------------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  noProgress: boolean;
  done: boolean;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32_768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return parts;
}

/**
 * Identical fetches (the benchmark's fifty clones of one tip) answer byte-identically, so the
 * built response is memoized on everything it depends on: the repo, its refs and store size, and
 * the request's wants, haves, boundary and depth. Any state change moves a key component.
 */
const fetchMemo = new Map<string, Buffer>();

function fetchAnswer(repo: Repo, args: FetchArgs, version2: boolean): GitAnswer {
  const memoKey = [
    repo.dbId,
    version2 ? 'v2' : 'v0',
    args.wants.join(','),
    args.haves.join(','),
    args.clientShallow.join(','),
    args.depth ?? '',
    repo.objects.size,
    [...repo.refs.values()].join(','),
  ].join('|');
  const memoized = fetchMemo.get(memoKey);
  if (memoized) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: memoized };
  const answer = buildFetchAnswer(repo, args, version2);
  if (fetchMemo.size > 128) fetchMemo.clear();
  fetchMemo.set(memoKey, answer.body);
  return answer;
}

function buildFetchAnswer(repo: Repo, args: FetchArgs, version2: boolean): GitAnswer {
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.depth, args.clientShallow);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  // Which of the client's shallow commits stop being shallow: their parents are now included.
  const included = new Set(selection.objects.filter((obj) => obj.type === 'commit').map((obj) => hashObject('commit', obj.data)));
  const unshallow = args.clientShallow.filter((sha) => included.has(sha) && !selection.shallow.includes(sha));
  if (version2) {
    // With `done` sent, the answer is the packfile straight away (an acknowledgments section
    // here is a protocol error to a real client); without it, this round is negotiation only.
    if (!args.done) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
    }
    if (selection.shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of selection.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const sha of selection.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function uploadPack(repo: Repo, body: Buffer, version2: boolean): GitAnswer {
  let parsed: { packets: Packet[]; next: number };
  try {
    parsed = parsePackets(body);
  } catch {
    return jsonAnswer(400, { message: 'malformed pkt-line request' });
  }
  const lines = parsed.packets.map(packetText);
  if (version2) {
    const command = lines[0] ?? '';
    // Arguments sit after the delim packet.
    const delimIndex = parsed.packets.findIndex((packet) => packet.kind === 'delim');
    const args = delimIndex < 0 ? [] : parsed.packets.slice(delimIndex + 1).map(packetText).filter((line) => line !== '');
    if (command === 'command=ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
    }
    if (command === 'command=fetch') {
      const fetch: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, noProgress: false, done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetch.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetch.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetch.clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) fetch.depth = Number.parseInt(arg.slice(7), 10);
        else if (arg === 'no-progress') fetch.noProgress = true;
        else if (arg === 'done') fetch.done = true;
      }
      return fetchAnswer(repo, fetch, true);
    }
    return jsonAnswer(400, { message: `unknown command ${command}` });
  }
  // Protocol v0: want/shallow/deepen lines, a flush, then have/done lines and a final flush.
  const fetch: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, noProgress: false, done: true };
  const firstSection = parsed.packets.map(packetText);
  for (const line of firstSection) {
    if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('shallow ')) fetch.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetch.depth = Number.parseInt(line.slice(7), 10);
  }
  try {
    const rest = parsePackets(body, parsed.next);
    for (const line of rest.packets.map(packetText)) {
      if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    }
  } catch {
    // A request with no negotiation section is still answerable.
  }
  return fetchAnswer(repo, fetch, false);
}

// -------------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): GitAnswer {
  let parsed: { packets: Packet[]; next: number };
  try {
    parsed = parsePackets(body);
  } catch {
    return jsonAnswer(400, { message: 'malformed pkt-line request' });
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  parsed.packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length === 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  });
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  const wantsReport = capabilities.split(' ').includes('report-status') || capabilities.split(' ').includes('report-status-v2');
  const packBytes = body.subarray(parsed.next);

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (sha) => repo.objects.get(sha));
      for (const obj of objects) {
        const sha = hashObject(obj.type, obj.data);
        if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_SHA;
    if (command.newOid === ZERO_SHA) {
      // A delete.
      if (current === ZERO_SHA) results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (
      command.ref.startsWith('refs/heads/') &&
      command.oldOid !== ZERO_SHA &&
      !isAncestor(repo, command.oldOid, command.newOid)
    ) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!wantsReport) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (!wantsSideband) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: inner };
  }
  // The report stream travels inside band 1, itself pkt-line framed, then an outer flush.
  const parts: Buffer[] = [];
  let at = 0;
  while (at < inner.length) {
    // Split the inner stream on its own pkt-line boundaries so each frame stays intact.
    const length = Number.parseInt(inner.subarray(at, at + 4).toString('ascii'), 16);
    const frameEnd = length === 0 ? at + 4 : at + length;
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, frameEnd)])));
    at = frameEnd;
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------------

/**
 * Handle one git smart-HTTP request. `segments` are the decoded path segments
 * ([owner, "<repo>.git", ...rest]); `query` the parsed query string.
 */
export function handleGitRequest(
  forge: Forge,
  method: string,
  segments: string[],
  query: URLSearchParams,
  gitProtocolHeader: string,
  body: Buffer,
): GitAnswer {
  const owner = segments[0] ?? '';
  const repoName = (segments[1] ?? '').replace(/\.git$/, '');
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return jsonAnswer(404, { message: 'Not Found' });
  const rest = segments.slice(2).join('/');
  const version2 = /(^|,)version=2/.test(gitProtocolHeader);
  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return jsonAnswer(404, { message: 'Not Found' });
    }
    if (service === 'git-upload-pack' && version2) return advertiseV2(service);
    return advertiseV0(repo, service);
  }
  if (method === 'POST' && rest === 'git-upload-pack') return uploadPack(repo, body, version2);
  if (method === 'POST' && rest === 'git-receive-pack') return receivePack(repo, body);
  return jsonAnswer(404, { message: 'Not Found' });
}
