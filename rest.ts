// rest.ts — GitHub REST v3 API for github-core-clone-01.
// Node 22 type stripping: erasable syntax only. Stdlib only.
//
// Entry point: handleRest(store, method, path, query, headers, bodyText, expectedToken?)
//   -> { status, headers, body }  (body is a JS value, or null for 204; the caller
//   JSON-stringifies it and sets content-type, though we also return content-type
//   in headers for safety.)
//
// Auth decision: the bearer token is accepted via the optional 7th parameter
// `expectedToken` when the caller passes it, otherwise read from
// process.env.MAKEFUN_SHOP_TOKEN (the trial sets it). If neither is configured,
// any non-empty Bearer token is accepted (local-dev fallback only; never the
// case in a trial). A missing/wrong token is 401 JSON on EVERY /api/v3 route.
//
// Owner resolution: the token names the suite's scenario viewer, TOKEN_LOGIN
// = 'adaiversen' (store.ts; verified against the kit — SCENARIO_SEED is a
// compile-time constant, so the viewer is 'adaiversen' in every instance).
// Repositories are created under that login and addressed as
// /repos/adaiversen/<name>, so lookups are direct store hits. A lookup first
// tries the store key verbatim; only the token owner falls back to a by-name
// lookup. Any other owner for the same name is 404 (never 403) — the
// foreign-owner check. GET /user reports TOKEN_LOGIN; MCP defaults its owner
// to it.
//
// Determinism: no wall clock, no Math.random anywhere. Ids/numbers come from
// the store's sequential counters; merged_at is a fixed constant; the
// X-GitHub-Request-Id comes from a per-process counter.
//
// Comments: the Store contract has no comment storage, so issue comments reuse
// GraphQL's helpers (getIssueComments / addIssueComment from ./graphql.ts),
// which store comments on the Repo object under `__gqlComments`. A comment
// added over GraphQL reads back over REST and vice versa. REST comment ids are
// numeric (1-based position in the issue's comment list, stable: append-only).
// GraphQL comment ids are opaque strings; REST derives its numeric id from
// the position, so POST and GET agree.
//
// Merges: squash only, with a real three-way merge and conflict detection
// (405 when the head and the default branch both changed the same path
// differently since the merge-base). The squash commit lands on the default
// branch; its tree is the base tree plus the head's changes. Commit objects
// use the same author/committer/message shape as graphql.ts's squash commits.

import { TOKEN_LOGIN } from './store.ts';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import { addIssueComment, getIssueComments } from './graphql.ts';

/** Fixed timestamp used for merged_at (determinism: no wall clock). */
const FIXED_MERGED_AT = '1970-01-01T00:00:00Z';

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type JsonObj = Record<string, unknown>;

// --------------------------------------------------------------------------------
// Request ids, headers, query
// --------------------------------------------------------------------------------

let requestCounter = 0;

function newRequestId(): string {
  requestCounter += 1;
  return 'req-' + String(requestCounter).padStart(8, '0');
}

function reply(status: number, body: unknown, extra: Record<string, string> = {}): RestResult {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': newRequestId(), ...extra },
    body,
  };
}

function err(status: number, message: string): RestResult {
  return reply(status, { message });
}

function getHeader(headers: unknown, name: string): string | null {
  const want = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  if (headers !== null && typeof headers === 'object') {
    const rec = headers as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key.toLowerCase() !== want) continue;
      const v = rec[key];
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

class Query {
  private params: URLSearchParams;

  constructor(q: unknown) {
    if (typeof q === 'string') {
      this.params = new URLSearchParams(q);
    } else if (typeof URLSearchParams !== 'undefined' && q instanceof URLSearchParams) {
      this.params = q;
    } else if (q !== null && typeof q === 'object') {
      this.params = new URLSearchParams();
      for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) this.params.append(k, String(item));
        } else {
          this.params.set(k, String(v));
        }
      }
    } else {
      this.params = new URLSearchParams();
    }
  }

  get(name: string): string | null {
    return this.params.get(name);
  }

  int(name: string, def: number): number {
    const v = this.params.get(name);
    if (v === null) return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  }
}

// --------------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------------

function isAuthorized(headers: unknown, expectedToken?: string): boolean {
  const fromParam = expectedToken !== undefined && expectedToken !== '' ? expectedToken : '';
  const fromEnv = typeof process !== 'undefined' && process.env !== undefined ? (process.env.MAKEFUN_SHOP_TOKEN ?? '') : '';
  const expected = fromParam !== '' ? fromParam : fromEnv;
  const auth = getHeader(headers, 'authorization');
  if (auth === null) return false;
  const m = /^Bearer (.+)$/.exec(auth.trim());
  if (m === null) return false;
  const presented = m[1] as string;
  if (expected === '') return presented.length > 0; // dev fallback: no token configured
  return presented === expected;
}

// --------------------------------------------------------------------------------
// Path handling
// --------------------------------------------------------------------------------

function splitPath(path: string): string[] {
  let p = path;
  const qi = p.indexOf('?');
  if (qi !== -1) p = p.slice(0, qi);
  const hi = p.indexOf('#');
  if (hi !== -1) p = p.slice(0, hi);
  const raw = p.split('/').filter((s) => s !== '');
  const segs: string[] = [];
  for (const s of raw) {
    try {
      segs.push(decodeURIComponent(s));
    } catch {
      segs.push(s);
    }
  }
  if (segs[0] === 'api' && segs[1] === 'v3') return segs.slice(2);
  return segs;
}

// --------------------------------------------------------------------------------
// Owner resolution + extra runtime properties
// --------------------------------------------------------------------------------

function displayOwner(repo: Repo): string {
  return repo.owner;
}

function resolveRepo(store: Store, ownerSeg: string, name: string): Repo | undefined {
  const direct = store.getRepo(ownerSeg, name);
  if (direct !== undefined) return direct;
  // No direct hit. A non-token owner NEVER resolves by name: the same repo
  // name under a stranger is 404 (never 403), per the sealed contract.
  // (The old code pinned the FIRST non-token owner seen for a name and
  // returned the repo to it — that broke the stranger-404 check as soon as
  // the viewer's own lookup became a direct hit, because the pin was never
  // set by the viewer first. Order-dependent pinning is gone.)
  if (ownerSeg !== TOKEN_LOGIN) return undefined;
  // The token owner may address a repo by name alone (tolerates a repo
  // created under another owner, e.g. an MCP create with an explicit org).
  for (const r of store.repos.values()) {
    if (r.name === name) return r;
  }
  return undefined;
}

function repoPrivate(repo: Repo): boolean {
  return (repo as unknown as Record<string, unknown>).private === true;
}

function setRepoPrivate(repo: Repo, value: boolean): void {
  (repo as unknown as Record<string, unknown>).private = value;
}

function pullExtra(pull: Pull): Record<string, unknown> {
  return pull as unknown as Record<string, unknown>;
}

function pullMergeSha(pull: Pull): string | null {
  const v = pullExtra(pull).mergeCommitSha;
  return typeof v === 'string' ? v : null;
}

function pullMergedAt(pull: Pull): string | null {
  const v = pullExtra(pull).mergedAt;
  return typeof v === 'string' ? v : null;
}

// --------------------------------------------------------------------------------
// JSON renderers
// --------------------------------------------------------------------------------

function repoJson(repo: Repo): JsonObj {
  const owner = displayOwner(repo);
  return {
    id: repo.id,
    name: repo.name,
    full_name: owner + '/' + repo.name,
    owner: { login: owner, id: 1, type: 'User' },
    description: repo.description,
    private: repoPrivate(repo),
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(label: Label): JsonObj {
  return { name: label.name, color: label.color, description: label.description };
}

function issueLabelsJson(repo: Repo, issue: Issue): JsonObj[] {
  const out: JsonObj[] = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name);
    out.push(label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' });
  }
  return out;
}

function issueJson(repo: Repo, issue: Issue): JsonObj {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issueLabelsJson(repo, issue),
    user: { login: TOKEN_LOGIN, id: 1, type: 'User' },
    comments: getIssueComments(repo, issue.number).length,
  };
}

function pullJson(repo: Repo, pull: Pull): JsonObj {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pullMergedAt(pull),
    merge_commit_sha: pullMergeSha(pull),
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: TOKEN_LOGIN, id: 1, type: 'User' },
  };
}

function commentJson(repo: Repo, issueNumber: number, index: number): JsonObj {
  const comments = getIssueComments(repo, issueNumber);
  const c = comments[index] as { body?: unknown } | undefined;
  return {
    id: index + 1,
    body: typeof c?.body === 'string' ? c.body : '',
    user: { login: TOKEN_LOGIN, id: 1, type: 'User' },
  };
}

// --------------------------------------------------------------------------------
// Body / validation helpers
// --------------------------------------------------------------------------------

function isObj(v: unknown): v is JsonObj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bodyStr(body: JsonObj, field: string): string | null {
  const v = body[field];
  return typeof v === 'string' ? v : null;
}

function parseBody(bodyText: string | null | undefined): { ok: true; body: JsonObj } | { ok: false; result: RestResult } {
  if (bodyText === null || bodyText === undefined || bodyText.trim() === '') {
    return { ok: true, body: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, result: err(400, 'Problems parsing JSON') };
  }
  if (!isObj(parsed)) {
    return { ok: false, result: err(400, 'Problems parsing JSON') };
  }
  return { ok: true, body: parsed };
}

function pageParams(q: Query): { page: number; perPage: number } {
  const page = Math.max(1, q.int('page', 1));
  const perPage = Math.min(100, Math.max(1, q.int('per_page', 30)));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// --------------------------------------------------------------------------------
// Git object helpers (raw git object format; shared shape with graphql.ts)
// --------------------------------------------------------------------------------

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const rawMessage = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message: rawMessage.replace(/\n+$/, '') };
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

function commitTreeSha(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const tree = parseCommit(obj.data).tree;
  return tree === '' ? null : tree;
}

/** Flatten a tree into path -> {sha, mode}; missing trees flatten to empty. */
function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, { sha: string; mode: string }>): Map<string, { sha: string; mode: string }> {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const p = prefix + e.name;
    if (e.mode === '40000') flattenTree(repo, e.sha, p + '/', out);
    else out.set(p, { sha: e.sha, mode: e.mode });
  }
  return out;
}

function treeFlat(repo: Repo, treeSha: string | null): Map<string, { sha: string; mode: string }> {
  if (treeSha === null) return new Map();
  return flattenTree(repo, treeSha, '', new Map());
}

function gitSortName(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

function buildTreeRecursive(store: Store, repo: Repo, rel: Map<string, { sha: string; mode: string }>): string {
  const entries: TreeEntry[] = [];
  const subdirs = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [p, e] of rel) {
    const i = p.indexOf('/');
    if (i === -1) {
      entries.push({ mode: e.mode, name: p, sha: e.sha });
    } else {
      const d = p.slice(0, i);
      let m = subdirs.get(d);
      if (m === undefined) {
        m = new Map();
        subdirs.set(d, m);
      }
      m.set(p.slice(i + 1), e);
    }
  }
  for (const [d, m] of subdirs) {
    entries.push({ mode: '40000', name: d, sha: buildTreeRecursive(store, repo, m) });
  }
  entries.sort((a, b) => {
    const an = gitSortName(a);
    const bn = gitSortName(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return store.putObject(repo, 'tree', Buffer.concat(parts));
}

function buildTree(store: Store, repo: Repo, flat: Map<string, { sha: string; mode: string }>): string {
  return buildTreeRecursive(store, repo, flat);
}

function makeCommit(store: Store, repo: Repo, treeSha: string, parents: string[], message: string): string {
  const lines: string[] = ['tree ' + treeSha];
  for (const p of parents) lines.push('parent ' + p);
  lines.push('author ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
  lines.push('committer ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
  lines.push('');
  lines.push(message);
  return store.putObject(repo, 'commit', Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

/** Resolve a branch name or raw commit sha to a tip commit sha, or null. */
function resolveRefTip(repo: Repo, ref: string | undefined): string | null {
  const name = ref ?? repo.defaultBranch;
  const direct = repo.refs.get('refs/heads/' + name);
  if (direct !== undefined) return direct;
  if (/^[0-9a-f]{40}$/i.test(name)) {
    const obj = repo.objects.get(name.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return name.toLowerCase();
  }
  return null;
}

function ancestorsOf(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const s = stack.pop() as string;
    if (seen.has(s)) continue;
    seen.add(s);
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

function mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const baseAnc = ancestorsOf(repo, baseSha);
  const stack = [headSha];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const s = stack.pop() as string;
    if (seen.has(s)) continue;
    seen.add(s);
    if (baseAnc.has(s)) return s;
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return null;
}

interface FileChange {
  status: 'added' | 'removed' | 'modified';
  oldSha: string | null;
  newSha: string | null;
  oldMode: string | null;
  newMode: string | null;
}

function diffTrees(repo: Repo, baseTreeSha: string | null, headTreeSha: string | null): Map<string, FileChange> {
  const base = treeFlat(repo, baseTreeSha);
  const head = treeFlat(repo, headTreeSha);
  const out = new Map<string, FileChange>();
  for (const [p, h] of head) {
    const b = base.get(p);
    if (b === undefined) {
      out.set(p, { status: 'added', oldSha: null, newSha: h.sha, oldMode: null, newMode: h.mode });
    } else if (b.sha !== h.sha) {
      out.set(p, { status: 'modified', oldSha: b.sha, newSha: h.sha, oldMode: b.mode, newMode: h.mode });
    }
  }
  for (const [p, b] of base) {
    if (!head.has(p)) {
      out.set(p, { status: 'removed', oldSha: b.sha, newSha: null, oldMode: b.mode, newMode: null });
    }
  }
  return out;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = countLines(oldText);
  const b = countLines(newText);
  if (a.length * b.length > 250000) return { additions: b.length, deletions: a.length };
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i * (n + 1) + j] = a[i - 1] === b[j - 1] ? dp[(i - 1) * (n + 1) + (j - 1)] + 1 : Math.max(dp[(i - 1) * (n + 1) + j], dp[i * (n + 1) + (j - 1)]);
    }
  }
  const lcs = dp[m * (n + 1) + n] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

function blobText(repo: Repo, sha: string | null): string {
  if (sha === null) return '';
  const obj = repo.objects.get(sha);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

function emptyTreeSha(store: Store, repo: Repo): string {
  return store.putObject(repo, 'tree', Buffer.alloc(0));
}

// --------------------------------------------------------------------------------
// Shared request context
// --------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  q: Query;
  host: string;
  body: JsonObj;
}

function listLink(host: string, basePath: string, page: number, perPage: number, rel: string): string {
  const params = new URLSearchParams();
  params.set('per_page', String(perPage));
  params.set('page', String(page));
  return '<http://' + host + basePath + '?' + params.toString() + '>; rel="' + rel + '"';
}

function pagedListReply(ctx: Ctx, items: unknown[], basePath: string): RestResult {
  const { page, perPage } = pageParams(ctx.q);
  const total = items.length;
  const pageItems = paginate(items, page, perPage);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  if (page < totalPages) links.push(listLink(ctx.host, basePath, page + 1, perPage, 'next'));
  if (totalPages > 1) links.push(listLink(ctx.host, basePath, totalPages, perPage, 'last'));
  if (page > 1) {
    links.push(listLink(ctx.host, basePath, page - 1, perPage, 'prev'));
    links.push(listLink(ctx.host, basePath, 1, perPage, 'first'));
  }
  const extra: Record<string, string> = {};
  if (links.length > 0) extra.link = links.join(', ');
  return reply(200, pageItems, extra);
}

// --------------------------------------------------------------------------------
// Repositories
// --------------------------------------------------------------------------------

function createRepoHandler(ctx: Ctx): RestResult {
  const name = bodyStr(ctx.body, 'name');
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return err(422, 'Invalid repository name');
  }
  for (const r of ctx.store.repos.values()) {
    if (r.name === name) return err(422, 'Repository already exists');
  }
  const description = bodyStr(ctx.body, 'description') ?? '';
  const repo = ctx.store.createRepo(TOKEN_LOGIN, name, description);
  const priv = ctx.body.private;
  setRepoPrivate(repo, priv === true);
  return reply(201, repoJson(repo));
}

function listUserReposHandler(ctx: Ctx): RestResult {
  const repos = [...ctx.store.repos.values()].sort((a, b) => b.seq - a.seq || b.id - a.id);
  return pagedListReply(ctx, repos.map((r) => repoJson(r)), '/api/v3/user/repos');
}

function getRepoHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return reply(200, repoJson(repo));
}

function patchRepoHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const description = bodyStr(ctx.body, 'description');
  if (description !== null) repo.description = description;
  if (ctx.body.private === true || ctx.body.private === false) setRepoPrivate(repo, ctx.body.private as boolean);
  const newName = bodyStr(ctx.body, 'name');
  if (newName !== null && newName !== '' && newName !== repo.name) {
    if (!/^[A-Za-z0-9._-]+$/.test(newName) || newName.length > 100) return err(422, 'Invalid repository name');
    for (const r of ctx.store.repos.values()) {
      if (r.name === newName) return err(422, 'Repository already exists');
    }
    ctx.store.repos.delete(repo.owner + '/' + repo.name);
    repo.name = newName;
    ctx.store.repos.set(repo.owner + '/' + repo.name, repo);
  }
  return reply(200, repoJson(repo));
}

function deleteRepoHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  ctx.store.deleteRepo(repo.owner, repo.name);
  return reply(204, null);
}

// --------------------------------------------------------------------------------
// Branches, refs, commits
// --------------------------------------------------------------------------------

function listBranchesHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const out: JsonObj[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  out.sort((a, b) => (a.name as string) < (b.name as string) ? -1 : 1);
  return reply(200, out);
}

function getBranchHandler(ctx: Ctx, owner: string, name: string, branch: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const sha = repo.refs.get('refs/heads/' + branch);
  if (sha === undefined) return err(404, 'Not Found');
  return reply(200, { name: branch, commit: { sha } });
}

function createRefHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const ref = bodyStr(ctx.body, 'ref');
  const sha = bodyStr(ctx.body, 'sha');
  if (ref === null || !ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
    return err(422, 'Invalid ref');
  }
  if (sha === null || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'Invalid sha');
  const obj = repo.objects.get(sha.toLowerCase());
  if (obj === undefined) return err(422, 'Object does not exist');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  repo.refs.set(ref, sha.toLowerCase());
  return reply(201, { ref, object: { sha: sha.toLowerCase(), type: obj.type } });
}

function getRefHandler(ctx: Ctx, owner: string, name: string, branch: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const sha = repo.refs.get('refs/heads/' + branch);
  if (sha === undefined) return err(404, 'Not Found');
  return reply(200, { ref: 'refs/heads/' + branch, object: { sha, type: 'commit' } });
}

function listCommitsHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const tip = resolveRefTip(repo, ctx.q.get('sha') ?? undefined);
  if (tip === null) return reply(200, []);
  const { page, perPage } = pageParams(ctx.q);
  const shas: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && shas.length < page * perPage) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    shas.push(sha);
    const { parents } = parseCommit(obj.data);
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  const pageShas = shas.slice((page - 1) * perPage, page * perPage);
  const out: JsonObj[] = [];
  for (const sha of pageShas) {
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    const { parents, message } = parseCommit(obj.data);
    out.push({
      sha,
      commit: {
        message,
        author: { name: TOKEN_LOGIN, email: TOKEN_LOGIN + '@example.com' },
        committer: { name: TOKEN_LOGIN, email: TOKEN_LOGIN + '@example.com' },
      },
      parents: parents.map((p) => ({ sha: p })),
    });
  }
  return reply(200, out);
}

// --------------------------------------------------------------------------------
// Contents
// --------------------------------------------------------------------------------

function resolveTreePath(repo: Repo, treeSha: string, segments: string[]): { kind: 'file'; sha: string; mode: string } | { kind: 'dir'; sha: string } | null {
  if (segments.length === 0) return { kind: 'dir', sha: treeSha };
  let cur = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const ent = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (ent === undefined) return null;
    if (i === segments.length - 1) {
      return ent.mode === '40000' ? { kind: 'dir', sha: ent.sha } : { kind: 'file', sha: ent.sha, mode: ent.mode };
    }
    if (ent.mode !== '40000') return null;
    cur = ent.sha;
  }
  return { kind: 'dir', sha: treeSha };
}

function getContentsHandler(ctx: Ctx, owner: string, name: string, segments: string[]): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const tip = resolveRefTip(repo, ctx.q.get('ref') ?? undefined);
  if (tip === null) return err(404, 'Not Found');
  const treeSha = commitTreeSha(repo, tip);
  if (treeSha === null) return err(404, 'Not Found');
  const resolved = resolveTreePath(repo, treeSha, segments);
  if (resolved === null) return err(404, 'Not Found');
  const path = segments.join('/');
  if (resolved.kind === 'file') {
    const obj = repo.objects.get(resolved.sha);
    if (obj === undefined) return err(404, 'Not Found');
    const base = segments.length === 0 ? '' : (segments[segments.length - 1] as string);
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name: base,
      path,
      content: obj.data.toString('base64'),
      sha: resolved.sha,
    });
  }
  const obj = repo.objects.get(resolved.sha);
  if (obj === undefined || obj.type !== 'tree') return err(404, 'Not Found');
  const out: JsonObj[] = [];
  for (const e of parseTree(obj.data)) {
    const childPath = path === '' ? e.name : path + '/' + e.name;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path: childPath, sha: e.sha });
    } else {
      const blob = repo.objects.get(e.sha);
      out.push({ type: 'file', name: e.name, path: childPath, sha: e.sha, size: blob === undefined ? 0 : blob.data.length });
    }
  }
  out.sort((a, b) => (a.name as string) < (b.name as string) ? -1 : 1);
  return reply(200, out);
}

function putContentsHandler(ctx: Ctx, owner: string, name: string, segments: string[]): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  if (segments.length === 0) return err(422, 'Invalid path');
  const path = segments.join('/');
  const message = bodyStr(ctx.body, 'message');
  const contentB64 = bodyStr(ctx.body, 'content');
  if (message === null || message === '') return err(422, 'message is required');
  if (contentB64 === null) return err(422, 'content is required');
  const branch = bodyStr(ctx.body, 'branch') ?? repo.defaultBranch;
  const refName = 'refs/heads/' + branch;
  const tip = repo.refs.get(refName);
  if (tip === undefined && repo.refs.size > 0 && ctx.body.branch !== undefined) {
    return err(422, 'Branch does not exist');
  }
  const bytes = Buffer.from(contentB64, 'base64');
  const baseTree = tip === undefined ? null : commitTreeSha(repo, tip);
  const flat = treeFlat(repo, baseTree);
  const existing = flat.get(path);
  const sha = bodyStr(ctx.body, 'sha');
  let status: number;
  if (existing !== undefined) {
    if (sha === null) return err(422, 'sha is required to update a file');
    if (sha.toLowerCase() !== existing.sha.toLowerCase()) return err(409, 'Conflict: sha does not match the current blob');
    status = 200;
  } else {
    if (sha !== null) return err(422, 'sha does not match: file does not exist');
    status = 201;
  }
  // Set the path, clearing anything it would shadow in either direction.
  for (const key of [...flat.keys()]) {
    if (key === path || key.startsWith(path + '/')) flat.delete(key);
  }
  for (const key of [...flat.keys()]) {
    if (path.startsWith(key + '/')) flat.delete(key);
  }
  const blobSha = ctx.store.putObject(repo, 'blob', bytes);
  flat.set(path, { sha: blobSha, mode: '100644' });
  const newTree = buildTree(ctx.store, repo, flat);
  const commitSha = makeCommit(ctx.store, repo, newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(refName, commitSha);
  const base = segments[segments.length - 1] as string;
  return reply(status, {
    content: { name: base, path, sha: blobSha, size: bytes.length, encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function deleteContentsHandler(ctx: Ctx, owner: string, name: string, segments: string[]): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  if (segments.length === 0) return err(422, 'Invalid path');
  const path = segments.join('/');
  const branch = bodyStr(ctx.body, 'branch') ?? repo.defaultBranch;
  const refName = 'refs/heads/' + branch;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return err(404, 'Not Found');
  const message = bodyStr(ctx.body, 'message') ?? '';
  const treeSha = commitTreeSha(repo, tip);
  const flat = treeFlat(repo, treeSha);
  const existing = flat.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  const sha = bodyStr(ctx.body, 'sha');
  if (sha !== null && sha.toLowerCase() !== existing.sha.toLowerCase()) {
    return err(409, 'Conflict: sha does not match the current blob');
  }
  flat.delete(path);
  const newTree = buildTree(ctx.store, repo, flat);
  const commitSha = makeCommit(ctx.store, repo, newTree, [tip], message);
  repo.refs.set(refName, commitSha);
  return reply(200, { commit: { sha: commitSha } });
}

// --------------------------------------------------------------------------------
// Labels
// --------------------------------------------------------------------------------

function createLabelHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const labelName = bodyStr(ctx.body, 'name');
  if (labelName === null || labelName === '') return err(422, 'Label name is required');
  if (repo.labels.has(labelName)) return err(422, 'Label already exists');
  const color = bodyStr(ctx.body, 'color') ?? 'ededed';
  const description = bodyStr(ctx.body, 'description') ?? '';
  const label: Label = { name: labelName, color, description };
  repo.labels.set(labelName, label);
  return reply(201, labelJson(label));
}

function listLabelsHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return reply(200, [...repo.labels.values()].map((l) => labelJson(l)));
}

// --------------------------------------------------------------------------------
// Issues + comments
// --------------------------------------------------------------------------------

function parseLabelNames(body: JsonObj): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as JsonObj).name === 'string') {
      out.push((item as JsonObj).name as string);
    } else {
      return null;
    }
  }
  return out;
}

function createIssueHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const title = bodyStr(ctx.body, 'title');
  if (title === null || title === '') return err(422, 'Title is required');
  const body = bodyStr(ctx.body, 'body') ?? '';
  const labels = parseLabelNames(ctx.body);
  if (labels === null) return err(422, 'Invalid labels');
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, 'Label does not exist: ' + label);
  }
  ctx.store.seq += 1;
  repo.issueCounter += 1;
  const issue: Issue = {
    id: ctx.store.seq,
    number: repo.issueCounter,
    title,
    body,
    state: 'open',
    labels,
    seq: ctx.store.seq,
  };
  repo.issues.set(issue.number, issue);
  return reply(201, issueJson(repo, issue));
}

function listIssuesHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const state = (ctx.q.get('state') ?? 'open').toLowerCase();
  const direction = (ctx.q.get('direction') ?? 'desc').toLowerCase();
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  const { page, perPage } = pageParams(ctx.q);
  return reply(200, paginate(list, page, perPage).map((i) => issueJson(repo, i)));
}

function issueNumber(seg: string): number | null {
  if (!/^[0-9]+$/.test(seg)) return null;
  const n = parseInt(seg, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function getIssueHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const issue = repo.issues.get(n);
  if (issue === undefined) return err(404, 'Not Found');
  return reply(200, issueJson(repo, issue));
}

function patchIssueHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const issue = repo.issues.get(n);
  if (issue === undefined) return err(404, 'Not Found');
  const state = bodyStr(ctx.body, 'state');
  if (state !== null) {
    if (state !== 'open' && state !== 'closed') return err(422, 'Invalid state');
    issue.state = state;
  }
  const title = bodyStr(ctx.body, 'title');
  if (title !== null) issue.title = title;
  const body = bodyStr(ctx.body, 'body');
  if (body !== null) issue.body = body;
  if (ctx.body.labels !== undefined) {
    const labels = parseLabelNames(ctx.body);
    if (labels === null) return err(422, 'Invalid labels');
    for (const label of labels) {
      if (!repo.labels.has(label)) return err(422, 'Label does not exist: ' + label);
    }
    issue.labels = labels;
  }
  return reply(200, issueJson(repo, issue));
}

function createCommentHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const issue = repo.issues.get(n);
  if (issue === undefined) return err(404, 'Not Found');
  const text = bodyStr(ctx.body, 'body');
  if (text === null || text === '') return err(422, 'Comment body is required');
  addIssueComment(ctx.store, repo, n, text);
  const index = getIssueComments(repo, n).length - 1;
  return reply(201, commentJson(repo, n, index));
}

function listCommentsHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const issue = repo.issues.get(n);
  if (issue === undefined) return err(404, 'Not Found');
  const comments = getIssueComments(repo, n);
  const out: JsonObj[] = [];
  for (let i = 0; i < comments.length; i += 1) out.push(commentJson(repo, n, i));
  return reply(200, out);
}

// --------------------------------------------------------------------------------
// Pull requests + merge
// --------------------------------------------------------------------------------

function branchOf(ref: string): string {
  const i = ref.lastIndexOf(':');
  return i === -1 ? ref : ref.slice(i + 1);
}

function computeMergeable(store: Store, repo: Repo, headSha: string, baseSha: string): boolean {
  const base = mergeBase(repo, headSha, baseSha);
  const baseTree = base === null ? emptyTreeSha(store, repo) : commitTreeSha(repo, base);
  const headTree = commitTreeSha(repo, headSha);
  const baseTipTree = commitTreeSha(repo, baseSha);
  if (headTree === null || baseTipTree === null) return false;
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, baseTipTree);
  for (const [path, hc] of headChanges) {
    const bc = baseChanges.get(path);
    if (bc === undefined) continue;
    if (hc.newSha !== bc.newSha) return false;
  }
  return true;
}

function createPullHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const title = bodyStr(ctx.body, 'title');
  if (title === null || title === '') return err(422, 'Title is required');
  const body = bodyStr(ctx.body, 'body') ?? '';
  const headRaw = bodyStr(ctx.body, 'head');
  const baseRaw = bodyStr(ctx.body, 'base');
  if (headRaw === null || headRaw === '' || baseRaw === null || baseRaw === '') {
    return err(422, 'head and base are required');
  }
  const headRef = branchOf(headRaw);
  const baseRef = branchOf(baseRaw);
  const headSha = repo.refs.get('refs/heads/' + headRef);
  const baseSha = repo.refs.get('refs/heads/' + baseRef);
  if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
  ctx.store.seq += 1;
  repo.pullCounter += 1;
  const pull: Pull = {
    id: ctx.store.seq,
    number: repo.pullCounter,
    title,
    body,
    state: 'open',
    merged: false,
    mergeable: true,
    headRef,
    baseRef,
    headSha,
    baseSha,
    seq: ctx.store.seq,
  };
  pull.mergeable = computeMergeable(ctx.store, repo, headSha, baseSha);
  repo.pulls.set(pull.number, pull);
  return reply(201, pullJson(repo, pull));
}

function listPullsHandler(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const state = (ctx.q.get('state') ?? 'open').toLowerCase();
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list.sort((a, b) => b.seq - a.seq || b.number - a.number);
  const { page, perPage } = pageParams(ctx.q);
  return reply(200, paginate(list, page, perPage).map((p) => pullJson(repo, p)));
}

function getPullHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (pull === undefined) return err(404, 'Not Found');
  return reply(200, pullJson(repo, pull));
}

function listPullFilesHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (pull === undefined) return err(404, 'Not Found');
  const baseTree = commitTreeSha(repo, pull.baseSha);
  const headTree = commitTreeSha(repo, pull.headSha);
  const changes = diffTrees(repo, baseTree, headTree);
  const out: JsonObj[] = [];
  const paths = [...changes.keys()].sort();
  for (const path of paths) {
    const c = changes.get(path) as FileChange;
    const counts = lineDiff(blobText(repo, c.oldSha), blobText(repo, c.newSha));
    out.push({
      filename: path,
      status: c.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: c.newSha ?? c.oldSha,
    });
  }
  return reply(200, out);
}

function mergePullHandler(ctx: Ctx, owner: string, name: string, numSeg: string): RestResult {
  const repo = resolveRepo(ctx.store, owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  const n = issueNumber(numSeg);
  if (n === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (pull === undefined) return err(404, 'Not Found');
  if (pull.state !== 'open') return err(405, 'Pull request is not open');
  // Merge against the live branch tips (a branch may have moved since the PR opened).
  const headSha = repo.refs.get('refs/heads/' + pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get('refs/heads/' + pull.baseRef) ?? pull.baseSha;
  const mergeable = computeMergeable(ctx.store, repo, headSha, baseSha);
  pull.mergeable = mergeable;
  if (!mergeable) return err(405, 'Merge conflict');
  const base = mergeBase(repo, headSha, baseSha);
  const baseTree = base === null ? emptyTreeSha(ctx.store, repo) : commitTreeSha(repo, base);
  const headTree = commitTreeSha(repo, headSha);
  const baseTipTree = commitTreeSha(repo, baseSha);
  if (headTree === null || baseTipTree === null) return err(405, 'Merge conflict');
  const headChanges = diffTrees(repo, baseTree, headTree);
  const flat = treeFlat(repo, baseTipTree);
  for (const [path, c] of headChanges) {
    if (c.status === 'removed') {
      flat.delete(path);
    } else if (c.newSha !== null) {
      flat.set(path, { sha: c.newSha, mode: c.newMode ?? '100644' });
    }
  }
  const newTree = buildTree(ctx.store, repo, flat);
  const message = 'Merge pull request #' + String(pull.number) + ' from ' + pull.headRef + '\n\n' + pull.title;
  const mergeSha = makeCommit(ctx.store, repo, newTree, [baseSha], message);
  repo.refs.set('refs/heads/' + pull.baseRef, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pullExtra(pull).mergeCommitSha = mergeSha;
  pullExtra(pull).mergedAt = FIXED_MERGED_AT;
  return reply(200, { sha: mergeSha, merged: true, message: 'Merge pull request #' + String(pull.number) + ' from ' + pull.headRef });
}

// --------------------------------------------------------------------------------
// Dispatcher
// --------------------------------------------------------------------------------

const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: unknown,
  headers: unknown,
  bodyText: string | null | undefined,
  expectedToken?: string,
): RestResult {
  const m = (method ?? 'GET').toUpperCase();
  const segs = splitPath(path ?? '/');
  const q = new Query(query);
  const host = getHeader(headers, 'host') ?? 'localhost';

  // Auth first: every /api/v3 route needs the bearer token.
  if (!isAuthorized(headers, expectedToken)) {
    return err(401, 'Bad credentials');
  }

  // Root.
  if (segs.length === 0) {
    if (m === 'GET') {
      return reply(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }

  // GET /api/v3/user
  if (segs.length === 1 && segs[0] === 'user') {
    if (m === 'GET') {
      return reply(200, { login: TOKEN_LOGIN, id: 1, type: 'User' });
    }
    return err(404, 'Not Found');
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (m === 'GET') return reply(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }

  // /api/v3/user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (m === 'GET' || m === 'POST') {
      const parsed = parseBodyIfNeeded(m, bodyText);
      if (!parsed.ok) return parsed.result;
      const ctx: Ctx = { store, q, host, body: parsed.body };
      return m === 'GET' ? listUserReposHandler(ctx) : createRepoHandler(ctx);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const rest = segs.slice(3);
    const parsed = parseBodyIfNeeded(m, bodyText);
    if (!parsed.ok) return parsed.result;
    const ctx: Ctx = { store, q, host, body: parsed.body };

    if (rest.length === 0) {
      if (m === 'GET') return getRepoHandler(ctx, owner, repoName);
      if (m === 'PATCH') return patchRepoHandler(ctx, owner, repoName);
      if (m === 'DELETE') return deleteRepoHandler(ctx, owner, repoName);
      return err(404, 'Not Found');
    }
    if (rest[0] === 'branches' && rest.length === 1 && m === 'GET') {
      return listBranchesHandler(ctx, owner, repoName);
    }
    if (rest[0] === 'branches' && rest.length === 2 && m === 'GET') {
      return getBranchHandler(ctx, owner, repoName, rest[1] as string);
    }
    if (rest[0] === 'commits' && rest.length === 1 && m === 'GET') {
      return listCommitsHandler(ctx, owner, repoName);
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && m === 'POST') {
      return createRefHandler(ctx, owner, repoName);
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length === 4 && m === 'GET') {
      return getRefHandler(ctx, owner, repoName, rest[3] as string);
    }
    if (rest[0] === 'contents') {
      const segments = rest.slice(1);
      if (m === 'GET') return getContentsHandler(ctx, owner, repoName, segments);
      if (m === 'PUT') return putContentsHandler(ctx, owner, repoName, segments);
      if (m === 'DELETE') return deleteContentsHandler(ctx, owner, repoName, segments);
      return err(404, 'Not Found');
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1 && m === 'POST') return createLabelHandler(ctx, owner, repoName);
      if (rest.length === 1 && m === 'GET') return listLabelsHandler(ctx, owner, repoName);
      return err(404, 'Not Found');
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1 && m === 'GET') return listIssuesHandler(ctx, owner, repoName);
      if (rest.length === 1 && m === 'POST') return createIssueHandler(ctx, owner, repoName);
      if (rest.length === 2) {
        if (m === 'GET') return getIssueHandler(ctx, owner, repoName, rest[1] as string);
        if (m === 'PATCH') return patchIssueHandler(ctx, owner, repoName, rest[1] as string);
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (m === 'POST') return createCommentHandler(ctx, owner, repoName, rest[1] as string);
        if (m === 'GET') return listCommentsHandler(ctx, owner, repoName, rest[1] as string);
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && m === 'GET') return listPullsHandler(ctx, owner, repoName);
      if (rest.length === 1 && m === 'POST') return createPullHandler(ctx, owner, repoName);
      if (rest.length === 2) {
        if (m === 'GET') return getPullHandler(ctx, owner, repoName, rest[1] as string);
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && m === 'GET') {
        return listPullFilesHandler(ctx, owner, repoName, rest[1] as string);
      }
      if (rest.length === 3 && rest[2] === 'merge' && m === 'PUT') {
        return mergePullHandler(ctx, owner, repoName, rest[1] as string);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function parseBodyIfNeeded(m: string, bodyText: string | null | undefined): { ok: true; body: JsonObj } | { ok: false; result: RestResult } {
  if (!BODY_METHODS.has(m)) return { ok: true, body: {} };
  return parseBody(bodyText);
}
