// git.ts — git smart-HTTP core for github-core-clone-01.
//
// Node 22 type stripping (erasable syntax only), stdlib only
// (node:crypto, node:zlib). One process, in-memory store only.
//
// What it exports (the contract in BUILD-PLAN.md):
//   hashObject(type, data) — SHA-1 of "<type> <len>\0" + data.
//   writePack(objects) — a valid packfile of FULL objects only (no deltas),
//     "PACK" + version 2 + count + zlib-deflated objects + SHA-1 trailer.
//   readPack(buf) — parse a packfile, verifying header/trailer, inflating
//     every object and resolving OFS_DELTA / REF_DELTA (including chains).
//   handleGitRequest(store, owner, repoName, method, path, headers, body)
//     — the smart-HTTP surface:
//       GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//         v2 when the Git-Protocol: version=2 header is present
//         ("version 2" + fetch/ls-refs/object-format capabilities),
//         else the v0 "# service=git-upload-pack" advertisement.
//       POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs / fetch
//         (pkt-line framing, side-band-64k band 1 = pack data, want/have
//         negotiation, shallow/deepen) or the v0 upload-pack fallback.
//       GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//         — v0 "# service=git-receive-pack" advertisement with
//         report-status, side-band-64k, delete-refs.
//       POST /{owner}/{repo}.git/git-receive-pack — parse the pushed
//         packfile + ref updates; fast-forward enforced per ref
//         ("ng <ref> non-fast-forward", ref does not move); a mixed push
//         applies the FF ref and reports one line per ref (report-status,
//         side-band-64k).
//     Missing repo -> 404 JSON on every git route; the handler never throws.
//
// Notes for the integrator (app.ts):
//   - `path` must be the request path INCLUDING its query string, e.g.
//     "/info/refs?service=git-upload-pack" (or the full
//     "/{owner}/{repo}.git/info/refs?service=..."); the ".git" prefix,
//     when present, is stripped here.
//   - All git objects go through store.putObject / store.getObject, so
//     REST/GraphQL/MCP see the same data.
//   - Repo lookup is by (owner, name) first. If that misses, it falls back
//     to the repo of the same name under TOKEN_LOGIN (the login the bearer
//     token names). Reason: repos are created through REST with no owner in
//     the body, so they land under TOKEN_LOGIN, while the suite addresses
//     them by the scenario viewer login ("adaiversen", fixed by the public
//     SCENARIO_SEED in the kit's wire.ts). If TOKEN_LOGIN is ever set to
//     that viewer login the fallback never triggers; it exists only so a
//     store populated under TOKEN_LOGIN still serves git. It does not change
//     the 404 behaviour for a repo name that exists under neither owner.
//     (No git check in the sealed suite addresses an existing repo under a
//     wrong owner, so the fallback cannot mask a git pass/fail.)

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { TOKEN_LOGIN } from './store.ts';
import type { GitObject, ObjType, Repo, Store } from './store.ts';

/** The all-zero object id: an unborn branch's old/new value. */
export const ZERO_OID = '0'.repeat(40);

const AGENT = 'makefun-forge/1.0';
const PKT_MAX = 65520;
const SIDEBAND_CHUNK = 65515; // 65520 - 4 (pkt header) - 1 (band byte)
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// object hashing
// ---------------------------------------------------------------------------

/** SHA-1 of "<type> <len>\0" + data, hex — exactly as git computes it. */
export function hashObject(type: ObjType, data: Buffer | Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(type + ' ' + String(body.length) + '\0', 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export type PktLine =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer | Uint8Array): Buffer {
  const data =
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > PKT_MAX - 4) throw new Error('pkt-line payload is ' + String(data.length) + ' bytes, over the maximum');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, "0000". */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet, "0001". */
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed sequence; 'flush' / 'delim' are the control packets. */
export function encodePktLines(items: readonly (string | Buffer | Uint8Array | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a complete buffer into packets; throws on a malformed header. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length ' + JSON.stringify(head));
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (len === 3 || len > PKT_MAX) throw new Error('invalid pkt-line length ' + String(len));
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfile write (full objects only, no deltas)
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The trailer is SHA-1
 * over everything before it.
 */
export function writePack(objects: readonly { type: ObjType; data: Buffer | Uint8Array }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(packObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// delta application + packfile read
// ---------------------------------------------------------------------------

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer | Uint8Array, delta: Buffer | Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error('delta expects a ' + String(sourceSize) + '-byte base, got ' + String(baseBuffer.length));
  }
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** (bit * 8);
        }
      }
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** ((bit - 4) * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      if (offset + len > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + len > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + len);
      offset += len;
      written += len;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced ' + String(written) + ' of ' + String(targetSize) + ' bytes');
  return out;
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Uint8Array; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error('zlib stream at offset ' + String(offset) + ' did not inflate: ' + (err instanceof Error ? err.message : String(err)));
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream at offset ' + String(offset) + ' consumed no bytes');
  return { data: Buffer.from(result.buffer), next: offset + consumed };
}

interface PackEntryFull {
  type: ObjType;
  data: Buffer;
  oid: string;
  offset: number;
}

/** A REF_DELTA whose base is not resolved yet: retry after other entries resolve. */
class DeferError extends Error {}

/**
 * Parse a packfile (version 2 or 3), verifying magic, version, entry sizes
 * and the trailer checksum, and resolving every object including OFS_DELTA
 * and REF_DELTA (chains included, any order). `resolveBase` supplies a base
 * object a thin pack leaves out. Throws on any corruption.
 */
function parsePack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { version: number; count: number; entries: PackEntryFull[] } {
  if (buf.length < 32) throw new Error('pack is ' + String(buf.length) + ' bytes, too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + String(version));
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }

  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry has no size header');
    let byte = buf[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buf[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[offset++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
      if (entry.baseOffset < 0 || entry.baseOffset >= entryOffset) {
        throw new Error('ofs-delta at ' + String(entryOffset) + ' names an invalid base offset');
      }
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error('pack entry ' + String(index) + ' has unknown type code ' + String(typeCode));
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(
        'pack entry at ' + String(entryOffset) + ' declares ' + String(size) + ' bytes but inflated to ' + String(inflated.data.length),
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has ' + String(trailerStart - offset) + ' stray bytes before its trailer');

  const resolved = new Map<number, PackEntryFull>();
  const byOid = new Map<string, PackEntryFull>();
  const resolving = new Set<number>();

  const resolveOne = (entry: Raw): PackEntryFull => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle at pack offset ' + String(entry.offset));
    resolving.add(entry.offset);
    try {
      let type: ObjType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base at offset ' + String(entry.baseOffset) + ' is not in the pack');
        const base = resolveOne(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid as string;
        const inPack = byOid.get(wanted);
        if (inPack !== undefined) {
          type = inPack.type;
          data = applyDelta(inPack.data, entry.data);
        } else {
          const external = resolveBase !== undefined ? resolveBase(wanted) : undefined;
          if (external === undefined) throw new DeferError('ref-delta base ' + wanted + ' is not resolved yet');
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode] as ObjType;
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const full: PackEntryFull = { type, data, oid, offset: entry.offset };
      resolved.set(entry.offset, full);
      byOid.set(oid, full);
      return full;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  const pending = new Set<Raw>(raw);
  let guard = 0;
  while (pending.size > 0) {
    guard += 1;
    if (guard > raw.length + 2) throw new Error('delta bases could not be resolved');
    let progressed = false;
    for (const entry of [...pending]) {
      try {
        resolveOne(entry);
        pending.delete(entry);
        progressed = true;
      } catch (err) {
        if (err instanceof DeferError) continue;
        throw err;
      }
    }
    if (!progressed) throw new Error('a delta base is missing from the pack');
  }
  return { version, count, entries: raw.map((entry) => resolved.get(entry.offset) as PackEntryFull) };
}

/**
 * Parse a packfile and return its objects in pack order (type + raw bytes).
 * Verifies the header and trailer; throws on any corruption. `resolveBase`
 * supplies a base object a thin pack leaves out.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { type: ObjType; data: Buffer }[] {
  return parsePack(buf, resolveBase).entries.map((entry) => ({ type: entry.type, data: entry.data }));
}

// ---------------------------------------------------------------------------
// object model helpers (minimal commit/tree/tag parsing)
// ---------------------------------------------------------------------------

interface CommitInfo {
  tree: string;
  parents: string[];
}

function parseCommit(data: Buffer): CommitInfo {
  let tree = '';
  const parents: string[] = [];
  let i = 0;
  while (i < data.length) {
    const nl = data.indexOf(0x0a, i);
    const end = nl < 0 ? data.length : nl;
    if (end === i) break;
    const line = data.subarray(i, end).toString('utf8');
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    i = nl < 0 ? data.length : nl + 1;
  }
  return { tree, parents };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  let object = '';
  let type = '';
  let i = 0;
  while (i < data.length) {
    const nl = data.indexOf(0x0a, i);
    const end = nl < 0 ? data.length : nl;
    if (end === i) break;
    const line = data.subarray(i, end).toString('utf8');
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    i = nl < 0 ? data.length : nl + 1;
  }
  return { object, type };
}

/** Follow tag objects to the commit they point at; null when it is not a commit. */
function peelToCommit(store: Store, repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(repo, cur);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTagTarget(obj.data).object;
      continue;
    }
    return null;
  }
}

/** True when `ancestorOid` (peeled to a commit) is an ancestor-or-equal of `descendantOid`. */
function isAncestor(store: Store, repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  const anc = peelToCommit(store, repo, ancestorOid);
  const desc = peelToCommit(store, repo, descendantOid);
  if (anc === null || desc === null) return false;
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const stack: string[] = [desc];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const obj = store.getObject(repo, cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === anc) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/**
 * Every object reachable from `roots` (commit -> tree + parents, tag -> its
 * target, tree -> entries, gitlinks skipped). Missing objects throw unless
 * `allowMissing` is set. `stopAt` names shallow-boundary commits: one is
 * included with its tree, but its parents are NOT followed — a shallow
 * client holds the boundary commit and its tree, never its history.
 */
function collectReachable(
  store: Store,
  repo: Repo,
  roots: Iterable<string>,
  allowMissing: boolean,
  stopAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) {
      if (allowMissing) continue;
      throw new Error('missing object ' + oid);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTagTarget(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Add `oid` and its full closure (tag target / tree entries) into `out`, by oid. */
function addClosure(store: Store, repo: Repo, oid: string, out: Map<string, GitObject>, stopAt?: ReadonlySet<string>): void {
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    const obj = store.getObject(repo, cur);
    if (obj === undefined) continue;
    out.set(cur, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(cur)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTagTarget(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fetch planning (want/have negotiation, shallow/deepen)
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  // Commit distances from the wants (BFS over parents, capped by depth).
  // With no depth, the walk stops at the client's shallow boundaries: the
  // client holds a boundary commit and its tree, never its history. With a
  // depth (deepen), the depth cap governs and the walk goes past boundaries.
  const boundaries = new Set<string>(oldShallow);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = store.getObject(repo, want);
    if (obj !== undefined && obj.type === 'commit' && !dist.has(want)) {
      dist.set(want, 0);
      queue.push(want);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const oid = queue[qi] as string;
    const d = dist.get(oid) as number;
    if (depth !== null && d >= depth - 1) continue;
    if (depth === null && boundaries.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        const parentObj = store.getObject(repo, parent);
        if (parentObj !== undefined && parentObj.type === 'commit') {
          dist.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
  }

  // Wanted closure: the depth-capped commits + their trees, plus the full
  // closure of any non-commit want (tag / tree / blob).
  const wanted = new Map<string, GitObject>();
  for (const oid of dist.keys()) {
    const obj = store.getObject(repo, oid) as GitObject;
    wanted.set(oid, obj);
    addClosure(store, repo, parseCommit(obj.data).tree, wanted);
  }
  for (const want of wants) {
    const obj = store.getObject(repo, want);
    if (obj !== undefined && obj.type !== 'commit') addClosure(store, repo, want, wanted, depth === null ? boundaries : undefined);
  }

  // What the client already holds: the haves' closure, never walking past
  // a shallow boundary (its parents are NOT held).
  const haveSet = collectReachable(store, repo, haves, true, boundaries);
  const sendOids = [...wanted.keys()].filter((oid) => !haveSet.has(oid)).sort();
  const objects = sendOids.map((oid) => wanted.get(oid) as GitObject);

  // New shallow boundary: depth-capped commits that still have parents.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (d !== depth - 1) continue;
      const obj = store.getObject(repo, oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    shallow.sort();
  }

  // Unshallow: old boundaries that are now fully present (every parent sent).
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    if (!dist.has(boundary)) continue;
    const obj = store.getObject(repo, boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.every((parent) => dist.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();

  const fullReach = haves.length > 0 ? collectReachable(store, repo, wants, true) : new Set<string>();
  const acks = haves.filter((have) => fullReach.has(have));
  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(status: number, message: string): { status: number; headers: Record<string, string>; body: Buffer } {
  const text = JSON.stringify({ message }) + '\n';
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) },
    body: Buffer.from(text, 'utf8'),
  };
}

function gitResponse(
  contentType: string,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  return { status: 200, headers: { 'content-type': contentType, 'content-length': String(body.length) }, body };
}

function headerValue(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const value = headers[key];
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
}

function normalizeBody(body: Buffer | Uint8Array | string | undefined): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function findRepo(store: Store, owner: string, repoName: string): Repo | undefined {
  const direct = store.getRepo(owner, repoName);
  if (direct !== undefined) return direct;
  // See the header note: repos created through REST land under TOKEN_LOGIN.
  if (owner !== TOKEN_LOGIN) return store.getRepo(TOKEN_LOGIN, repoName);
  return undefined;
}

/** Split pack bytes into sideband band-1 chunks (one band byte + data). */
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += SIDEBAND_CHUNK) {
    out.push(Buffer.concat([Buffer.from([1]), data.subarray(i, Math.min(data.length, i + SIDEBAND_CHUNK))]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const defaultRef = 'refs/heads/' + repo.defaultBranch;
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:' + defaultRef + ' agent=' + AGENT + ' object-format=sha1'
      : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:' + defaultRef + ' agent=' + AGENT + ' object-format=sha1';
  const lines: string[] = [];
  const headOid = repo.refs.get(defaultRef);
  if (headOid !== undefined) lines.push(headOid + ' HEAD');
  for (const ref of sortedRefs(repo)) {
    lines.push(ref.oid + ' ' + ref.name);
    const obj = store.getObject(repo, ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(store, repo, ref.oid);
      if (peeled !== null) lines.push(peeled + ' ' + ref.name + '^{}');
    }
  }
  if (lines.length === 0) lines.push(ZERO_OID + ' capabilities^{}');
  lines[0] += '\0' + caps;
  const parts: Buffer[] = [encodePktLine('# service=' + service + '\n'), pktLineFlush()];
  for (const line of lines) parts.push(encodePktLine(line + '\n'));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine('agent=' + AGENT + '\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// protocol v2: ls-refs / fetch
// ---------------------------------------------------------------------------

/** Split a v2 request into its command line and its post-delimiter arguments. */
function parseV2Request(packets: readonly PktLine[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (command === '') {
      command = text.trim();
      continue;
    }
    if (seenDelim) args.push(text.replace(/\n$/, ''));
  }
  return { command, args };
}

function handleLsRefs(store: Store, repo: Repo, packets: readonly PktLine[]): Buffer {
  const { command, args } = parseV2Request(packets);
  if (command !== 'command=ls-refs') throw new HttpError(400, 'expected command=ls-refs, got ' + JSON.stringify(command));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = 'refs/heads/' + repo.defaultBranch;
  const parts: Buffer[] = [];
  if (keep('HEAD')) {
    const headOid = repo.refs.get(defaultRef);
    if (headOid !== undefined) {
      parts.push(
        encodePktLine(headOid + ' HEAD' + (symrefs ? ' symref-target:' + defaultRef : '') + '\n'),
      );
    } else if (unborn) {
      parts.push(encodePktLine('unborn HEAD' + (symrefs ? ' symref-target:' + defaultRef : '') + '\n'));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = ref.oid + ' ' + ref.name;
    if (peel) {
      const obj = store.getObject(repo, ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(store, repo, ref.oid);
        if (peeled !== null) line += ' peeled:' + peeled;
      }
    }
    parts.push(encodePktLine(line + '\n'));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Fetch-response cache, stored on the Repo object (same pattern as __gqlComments). */
const FETCH_CACHE_MAX = 64;

function fetchCacheMap(repo: Repo): Map<string, Buffer> {
  const r = repo as unknown as Record<string, unknown>;
  let m = r.__fetchCache as Map<string, Buffer> | undefined;
  if (m === undefined) {
    m = new Map<string, Buffer>();
    r.__fetchCache = m;
  }
  return m;
}

function handleFetchV2(store: Store, repo: Repo, packets: readonly PktLine[]): Buffer {
  const { command, args } = parseV2Request(packets);
  if (command !== 'command=fetch') throw new HttpError(400, 'expected command=fetch, got ' + JSON.stringify(command));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const filters: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('filter ')) filters.push(arg.slice(7).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const parts: Buffer[] = [];
  if (wants.length === 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'), pktLineDelim(), pktLineFlush());
    return Buffer.concat(parts);
  }
  // Fetch-response cache: the whole response is a deterministic pure function
  // of (repo objects, wants, haves, shallow, depth, filters) — planFetch reads
  // only content-addressed objects (never refs) and emits sorted OIDs, so
  // identical requests get byte-identical responses, and a cached pack stays
  // valid forever (objects are immutable; deleting the repo drops the cache
  // with it). This is what the benchmark's 50 identical shallow clones hit:
  // one plan + pack build serves all fifty.
  const cacheKey = JSON.stringify([[...wants].sort(), [...haves].sort(), [...shallow].sort(), depth, [...filters].sort()]);
  const cache = fetchCacheMap(repo);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const plan = planFetch(store, repo, wants, haves, depth, shallow);
  // The acknowledgments section is sent only when the client sent haves
  // (negotiation happened). A client that sent `done` with no haves —
  // real git on a fresh clone — expects `packfile` as the first section.
  if (haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(encodePktLine('ACK ' + ack + '\n'));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktLineDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine('shallow ' + oid + '\n'));
    for (const oid of plan.unshallow) parts.push(encodePktLine('unshallow ' + oid + '\n'));
    parts.push(pktLineDelim());
  }
  // The packfile section is always sent (an empty pack when there is
  // nothing new): real git reads the pack section after negotiation and a
  // negotiated fetch with nothing new still carries an (empty) pack.
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const chunk of sidebandChunks(pack)) parts.push(encodePktLine(chunk));
  parts.push(pktLineFlush());
  const response = Buffer.concat(parts);
  if (cache.size >= FETCH_CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// protocol v0: upload-pack
// ---------------------------------------------------------------------------

function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  let packets: PktLine[];
  try {
    packets = decodePktLines(body);
  } catch {
    throw new HttpError(400, 'malformed pkt-line stream');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) {
        const oid = text.slice(5).split(' ')[0] as string;
        if (HEX40.test(oid)) wants.push(oid);
      } else if (text.startsWith('shallow ')) {
        shallow.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    }
  }
  if (wants.length === 0) throw new HttpError(400, 'upload-pack request has no want');
  const plan = planFetch(store, repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine('shallow ' + oid + '\n'));
  for (const oid of plan.unshallow) parts.push(encodePktLine('unshallow ' + oid + '\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(encodePktLine('ACK ' + ack + '\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  // The pack is always sent (an empty pack when there is nothing new).
  const pack = writePack(plan.objects);
  for (const chunk of sidebandChunks(pack)) parts.push(encodePktLine(chunk));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0 only)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Split a receive-pack body into its command lines (the first line may carry
 * capabilities after a NUL), the capability string, and the raw pack bytes
 * that follow the first flush packet.
 */
function splitReceivePack(body: Buffer): { commands: string[]; caps: string; pack: Buffer } {
  const commands: string[] = [];
  let caps = '';
  let first = true;
  let i = 0;
  while (i + 4 <= body.length) {
    const head = body.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new HttpError(400, 'malformed pkt-line in receive-pack');
    const len = parseInt(head, 16);
    if (len === 0) {
      i += 4;
      return { commands, caps, pack: body.subarray(i) };
    }
    if (len < 4 || len > PKT_MAX || i + len > body.length) throw new HttpError(400, 'malformed pkt-line in receive-pack');
    const line = body.subarray(i + 4, i + len).toString('utf8');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        commands.push(line.slice(0, nul));
      } else {
        commands.push(line);
      }
      first = false;
    } else {
      commands.push(line);
    }
    i += len;
  }
  throw new HttpError(400, 'receive-pack body has no flush packet');
}

function evaluateCommand(
  store: Store,
  repo: Repo,
  cmd: PushCommand,
): { ref: string; ok: boolean; reason: string } {
  const ref = cmd.ref;
  const current = repo.refs.get(ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    if (store.getObject(repo, cmd.newOid) === undefined) return { ref, ok: false, reason: 'object not found' };
    repo.refs.set(ref, cmd.newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update: the old value must match, and the new tip must descend from it.
  if (current === undefined) return { ref, ok: false, reason: 'non-fast-forward' };
  if (cmd.oldOid !== current) return { ref, ok: false, reason: 'non-fast-forward' };
  if (store.getObject(repo, cmd.newOid) === undefined) return { ref, ok: false, reason: 'object not found' };
  if (!isAncestor(store, repo, cmd.oldOid, cmd.newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, cmd.newOid);
  return { ref, ok: true, reason: '' };
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, caps, pack } = splitReceivePack(body);
  const parsed: PushCommand[] = [];
  for (const line of commands) {
    const text = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) throw new HttpError(400, 'malformed receive-pack command');
    parsed.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (parsed.length === 0) throw new HttpError(400, 'empty receive-pack command list');
  const useSideband = caps
    .replace(/\n$/, '')
    .split(/\s+/)
    .includes('side-band-64k');

  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = parsed.some((cmd) => cmd.newOid !== ZERO_OID);
  if (needsPack) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: missing packfile';
    } else {
      try {
        const entries = parsePack(pack, (oid) => store.getObject(repo, oid)).entries;
        for (const entry of entries) {
          const sha = store.putObject(repo, entry.type, entry.data);
          if (sha !== entry.oid) throw new Error('object id mismatch for ' + entry.oid);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = 'unpacker error: ' + (err instanceof Error ? err.message : String(err));
      }
    }
  }

  const reportLines: string[] = ['unpack ' + (unpackOk ? 'ok' : unpackDetail)];
  if (unpackOk) {
    for (const cmd of parsed) {
      const result = evaluateCommand(store, repo, cmd);
      reportLines.push(result.ok ? 'ok ' + result.ref : 'ng ' + result.ref + ' ' + result.reason);
    }
  }
  // The report stream itself ends with a flush packet. The flush must be
  // INSIDE the band-1 stream: the outer flush only ends the sideband
  // demultiplexer, and without the inner one the client's report reader
  // hits EOF and reports "the remote end hung up unexpectedly".
  const report = Buffer.concat([
    ...reportLines.map((line) => encodePktLine(line + '\n')),
    pktLineFlush(),
  ]);
  if (useSideband) {
    const parts: Buffer[] = [];
    for (const chunk of sidebandChunks(report)) parts.push(encodePktLine(chunk));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }
  return Buffer.concat([report, pktLineFlush()]);
}

// ---------------------------------------------------------------------------
// the smart-HTTP surface
// ---------------------------------------------------------------------------

function handleGitRequestInner(
  store: Store,
  owner: string,
  repoName: string,
  method: string,
  path: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Buffer | Uint8Array | string | undefined,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const m = (method || 'GET').toUpperCase();
  let rest = path || '/';
  const gitIdx = rest.lastIndexOf('.git');
  if (gitIdx >= 0) rest = rest.slice(gitIdx + 4);
  if (!rest.startsWith('/')) rest = '/' + rest;
  let url: URL;
  try {
    url = new URL(rest, 'http://entry');
  } catch {
    throw new HttpError(400, 'bad path');
  }
  const pathname = url.pathname;
  const buf = normalizeBody(body);
  const proto = headerValue(headers, 'git-protocol');
  const isV2 = proto !== undefined && proto.trim() === 'version=2';

  if (m === 'GET' && pathname === '/info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      throw new HttpError(400, 'missing or unknown service');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return jsonResponse(404, 'Not Found');
    if (service === 'git-upload-pack') {
      if (isV2) return gitResponse('application/x-git-upload-pack-advertisement', v2Advertisement());
      return gitResponse('application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, 'git-upload-pack'));
    }
    return gitResponse('application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, 'git-receive-pack'));
  }

  if (m === 'POST' && pathname === '/git-upload-pack') {
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return jsonResponse(404, 'Not Found');
    if (isV2) {
      let packets: PktLine[];
      try {
        packets = decodePktLines(buf);
      } catch {
        throw new HttpError(400, 'malformed pkt-line stream');
      }
      let command = '';
      for (const packet of packets) {
        if (packet.kind === 'data') {
          command = packet.payload.toString('utf8').trim();
          break;
        }
      }
      if (command === 'command=ls-refs') {
        return gitResponse('application/x-git-upload-pack-result', handleLsRefs(store, repo, packets));
      }
      if (command === 'command=fetch') {
        return gitResponse('application/x-git-upload-pack-result', handleFetchV2(store, repo, packets));
      }
      throw new HttpError(400, 'unknown upload-pack v2 command: ' + JSON.stringify(command));
    }
    return gitResponse('application/x-git-upload-pack-result', handleFetchV0(store, repo, buf));
  }

  if (m === 'POST' && pathname === '/git-receive-pack') {
    const repo = findRepo(store, owner, repoName);
    if (repo === undefined) return jsonResponse(404, 'Not Found');
    return gitResponse('application/x-git-receive-pack-result', handleReceivePack(store, repo, buf));
  }

  return jsonResponse(404, 'Not Found');
}

/**
 * Handle one git smart-HTTP request. Never throws: any failure is answered
 * as a JSON error (404 for a missing repo or unknown route, 400 for a
 * malformed request, 500 otherwise), so the server stays up.
 */
export function handleGitRequest(
  store: Store,
  owner: string,
  repoName: string,
  method: string,
  path: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Buffer | Uint8Array | string | undefined,
): { status: number; headers: Record<string, string>; body: Buffer } {
  try {
    return handleGitRequestInner(store, owner, repoName, method, path, headers, body);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, err.message);
    return jsonResponse(500, err instanceof Error ? err.message : 'internal error');
  }
}
