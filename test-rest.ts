// test-rest.ts — harness for rest.ts. Run from a staging dir that also holds
// copies of store.ts and graphql.ts (entry layout: ./store.ts, ./graphql.ts):
//   mkdir -p /tmp/rest-stage && cp entry/store.ts entry/graphql.ts work/rest/rest.ts work/rest/test-rest.ts /tmp/rest-stage/
//   ~/workspace/.node22/bin/node /tmp/rest-stage/test-rest.ts
// Node 22 type stripping; stdlib only. Exits 0 iff every case passes.

import { Store } from './store.ts';
import { addIssueComment } from './graphql.ts';
import { handleRest } from './rest.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token-xyz';
const TOKEN = 'test-token-xyz';
const VIEWER = 'adaiversen';
const STRANGER = 'olgabauer';

const store = new Store();
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    failed += 1;
    failures.push(name);
    console.log('FAIL ' + name + (detail !== undefined ? ' — ' + detail : ''));
  }
}

interface CallOpts {
  query?: Record<string, string | number> | string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  noAuth?: boolean;
  token?: string;
}

function call(method: string, path: string, opts: CallOpts = {}): { status: number; headers: Record<string, string>; body: unknown } {
  let q: unknown = undefined;
  if (typeof opts.query === 'string') q = new URLSearchParams(opts.query);
  else if (opts.query !== undefined) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) p.set(k, String(v));
    q = p;
  }
  const headers: Record<string, string> = { host: '127.0.0.1:4567', ...(opts.headers ?? {}) };
  if (!opts.noAuth) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  const bodyText = opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : '';
  return handleRest(store, method, path, q, headers, bodyText);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasReqId(r: { headers: Record<string, string> }): boolean {
  const v = r.headers['x-github-request-id'];
  return typeof v === 'string' && v.length > 0;
}

function isJson(r: { headers: Record<string, string> }): boolean {
  return (r.headers['content-type'] ?? '').includes('application/json');
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s.replace(/[\r\n ]+/g, ''), 'base64').toString('utf8');

// --- protocol / root / meta -------------------------------------------------
{
  const r = call('GET', '/api/v3/');
  check('root 200 + scopes + req-id + json', r.status === 200 && r.headers['x-oauth-scopes'] === 'repo, read:org' && hasReqId(r) && isJson(r), JSON.stringify(r));
}
{
  const r = call('GET', '/api/v3/meta');
  check('meta 200 + installed_version', r.status === 200 && isObj(r.body) && typeof r.body.installed_version === 'string' && (r.body.installed_version as string).length > 0, JSON.stringify(r.body));
}
{
  const r = call('GET', '/api/v3/', { noAuth: true });
  check('401 no token (root)', r.status === 401 && isObj(r.body) && typeof r.body.message === 'string' && hasReqId(r), JSON.stringify(r));
}
{
  const r = call('GET', '/api/v3/', { token: 'wrong-token' });
  check('401 wrong token', r.status === 401, JSON.stringify(r));
}
{
  const r = call('GET', '/api/v3/no-such-route');
  check('unknown route 404 JSON', r.status === 404 && isObj(r.body) && typeof r.body.message === 'string' && hasReqId(r) && isJson(r), JSON.stringify(r));
}
{
  const r = call('POST', '/api/v3/user/repos', { rawBody: '{"name":' });
  check('malformed JSON 400', r.status === 400 && isObj(r.body) && typeof r.body.message === 'string', JSON.stringify(r));
}
{
  const r = call('GET', '/api/v3/user');
  check('GET /user returns token login', r.status === 200 && isObj(r.body) && r.body.login === 'adaiversen', JSON.stringify(r.body));
}

// --- repos ------------------------------------------------------------------
const repoName = 'amber-thistle';
{
  const r = call('POST', '/api/v3/user/repos', { body: { name: repoName, private: true, description: 'seeded repo' } });
  check('POST /user/repos 201', r.status === 201 && isObj(r.body) && r.body.name === repoName && r.body.private === true && r.body.default_branch === 'main', JSON.stringify(r.body));
}
{
  const r = call('GET', `/api/v3/repos/${VIEWER}/${repoName}`);
  check('GET repo under viewer owner 200', r.status === 200 && isObj(r.body) && r.body.name === repoName && r.body.private === true, JSON.stringify(r.body));
}
{
  const r = call('GET', `/api/v3/repos/${STRANGER}/${repoName}`);
  check('GET same repo under stranger 404', r.status === 404 && isObj(r.body) && typeof r.body.message === 'string', JSON.stringify(r.body));
}
{
  const r = call('GET', `/api/v3/repos/${VIEWER}/never-created`);
  check('GET missing repo 404', r.status === 404, JSON.stringify(r.body));
}
{
  const r = call('PATCH', `/api/v3/repos/${VIEWER}/${repoName}`, { body: { description: 'seeded repo (updated)' } });
  check('PATCH repo description 200', r.status === 200 && isObj(r.body) && r.body.description === 'seeded repo (updated)', JSON.stringify(r.body));
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}`);
  check('PATCH persists on GET', isObj(g.body) && g.body.description === 'seeded repo (updated)', JSON.stringify(g.body));
}

// --- pagination -------------------------------------------------------------
{
  for (let i = 0; i < 30; i += 1) {
    const r = call('POST', '/api/v3/user/repos', { body: { name: `page-repo-${i}`, private: true, description: 'p' } });
    if (r.status !== 201) check(`pagination setup repo ${i}`, false, JSON.stringify(r));
  }
  const seen: string[] = [];
  let next: string | null = null;
  let pageCount = 0;
  let first = call('GET', '/api/v3/user/repos', { query: { per_page: 10 } });
  let ok = first.status === 200 && Array.isArray(first.body) && first.body.length === 10;
  if (Array.isArray(first.body)) for (const item of first.body) if (isObj(item)) seen.push(String(item.name));
  const link = first.headers.link ?? '';
  const m = /<([^>]*)>;\s*rel="next"/.exec(link);
  next = m !== null ? (m[1] as string) : null;
  while (next !== null && pageCount < 10) {
    pageCount += 1;
    const u = new URL(next);
    const res = call('GET', u.pathname, { query: u.search.slice(1) });
    if (res.status !== 200 || !Array.isArray(res.body)) { ok = false; break; }
    for (const item of res.body) if (isObj(item)) seen.push(String(item.name));
    const lm = /<([^>]*)>;\s*rel="next"/.exec(res.headers.link ?? '');
    next = lm !== null ? (lm[1] as string) : null;
  }
  const uniq = new Set(seen);
  const hasAll = Array.from({ length: 30 }, (_, i) => `page-repo-${i}`).every((n) => uniq.has(n));
  check('pagination: 30 repos via Link next, no repeats', ok && uniq.size === seen.length && hasAll && seen.length >= 30, `seen=${seen.length} uniq=${uniq.size} hasAll=${hasAll} pages=${pageCount}`);
  check('pagination: Link stays same-origin', (first.headers.link ?? '').includes('http://127.0.0.1:4567/api/v3/user/repos'), first.headers.link ?? '');
}

// --- contents ---------------------------------------------------------------
const filePath = 'docs/readme.md';
const fileContent = 'hello forge\nsecond line\n';
const fileContentAlt = 'hello forge v2\nsecond line\nthird line\n';
let initialSha = '';
let contentSha = '';
{
  const r = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/${filePath}`, { body: { message: 'seeded commit', content: b64(fileContent) } });
  check('PUT contents create 201', r.status === 201 && isObj(r.body) && isObj(r.body.content) && /^[0-9a-f]{40}$/.test(String(r.body.content.sha)) && (r.body.content as Record<string, unknown>).encoding === 'base64' && isObj(r.body.commit) && /^[0-9a-f]{40}$/.test(String((r.body.commit as Record<string, unknown>).sha)), JSON.stringify(r.body));
  if (isObj(r.body) && isObj(r.body.commit)) initialSha = String(r.body.commit.sha);
  if (isObj(r.body) && isObj(r.body.content)) contentSha = String(r.body.content.sha);
}
{
  const r = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/contents/${filePath}`);
  check('GET contents file base64+sha+size', r.status === 200 && isObj(r.body) && r.body.encoding === 'base64' && unb64(String(r.body.content)) === fileContent && r.body.sha === contentSha && r.body.size === Buffer.byteLength(fileContent), JSON.stringify(r.body));
}
{
  const r = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/${filePath}`, { body: { message: 'update', content: b64(fileContentAlt), sha: contentSha } });
  check('PUT contents update 200', r.status === 200 && isObj(r.body) && isObj(r.body.commit) && /^[0-9a-f]{40}$/.test(String((r.body.commit as Record<string, unknown>).sha)), JSON.stringify(r.body));
  if (isObj(r.body) && isObj(r.body.content)) contentSha = String(r.body.content.sha);
}
{
  const r = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/${filePath}`, { body: { message: 'stale', content: b64(fileContent), sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  check('PUT contents stale sha 409', r.status === 409 && isObj(r.body) && typeof r.body.message === 'string', JSON.stringify(r.body));
}
{
  call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/one.txt`, { body: { message: 'one', content: b64('one') } });
  call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/two.txt`, { body: { message: 'two', content: b64('two') } });
  const r = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs`);
  const names = Array.isArray(r.body) ? r.body.map((e) => (isObj(e) ? String(e.name) : '')) : [];
  check('GET contents directory listing', r.status === 200 && Array.isArray(r.body) && names.includes('readme.md') && names.includes('one.txt') && names.includes('two.txt'), JSON.stringify(r.body));
}
{
  const cur = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/two.txt`);
  const curSha = isObj(cur.body) ? String(cur.body.sha) : '';
  const r = call('DELETE', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/two.txt`, { body: { message: 'rm', sha: curSha } });
  check('DELETE contents 200 {commit:{sha}}', r.status === 200 && isObj(r.body) && isObj(r.body.commit) && /^[0-9a-f]{40}$/.test(String((r.body.commit as Record<string, unknown>).sha)), JSON.stringify(r.body));
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/two.txt`);
  check('GET deleted contents 404', g.status === 404, JSON.stringify(g.body));
}

// --- branches / commits / refs ----------------------------------------------
{
  const br = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/git/refs`, { body: { ref: 'refs/heads/feature', sha: initialSha } });
  check('POST git/refs branch 201', br.status === 201 && isObj(br.body) && br.body.ref === 'refs/heads/feature' && isObj(br.body.object) && (br.body.object as Record<string, unknown>).sha === initialSha, JSON.stringify(br.body));
  const list = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/branches`);
  const names = Array.isArray(list.body) ? list.body.map((e) => (isObj(e) ? String(e.name) : '')) : [];
  check('GET branches lists main + feature', list.status === 200 && names.includes('main') && names.includes('feature'), JSON.stringify(list.body));
  const one = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/branches/feature`);
  check('GET branches/feature 200', one.status === 200 && isObj(one.body) && isObj(one.body.commit) && (one.body.commit as Record<string, unknown>).sha === initialSha, JSON.stringify(one.body));
  const ref = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/git/refs/heads/feature`);
  check('GET git/refs/heads/feature 200', ref.status === 200 && isObj(ref.body) && ref.body.ref === 'refs/heads/feature', JSON.stringify(ref.body));
}
let branchTip = '';
{
  const c = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/readme-branch.md`, { body: { message: 'branch commit', content: b64('branch file\n'), branch: 'feature' } });
  check('PUT contents on branch 201', c.status === 201 && isObj(c.body) && isObj(c.body.commit), JSON.stringify(c.body));
  if (isObj(c.body) && isObj(c.body.commit)) branchTip = String(c.body.commit.sha);
  const commits = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/commits`, { query: { sha: 'feature' } });
  const shas = Array.isArray(commits.body) ? commits.body.map((e) => (isObj(e) ? String(e.sha) : '')) : [];
  const msgs = Array.isArray(commits.body) ? commits.body.map((e) => (isObj(e) && isObj(e.commit) ? String(e.commit.message) : '')) : [];
  check('GET commits?sha=feature lists branch commit', commits.status === 200 && shas.includes(branchTip) && msgs.includes('branch commit'), JSON.stringify(commits.body));
  const base = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/commits`);
  const baseShas = Array.isArray(base.body) ? base.body.map((e) => (isObj(e) ? String(e.sha) : '')) : [];
  check('GET commits (default) omits branch-only commit', base.status === 200 && !baseShas.includes(branchTip), JSON.stringify(base.body));
}

// --- labels / issues / comments ---------------------------------------------
{
  const l = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/labels`, { body: { name: 'bug', color: 'ededed' } });
  check('POST labels 201', l.status === 201 && isObj(l.body) && l.body.name === 'bug' && l.body.color === 'ededed', JSON.stringify(l.body));
}
let issue1 = 0;
let issue2 = 0;
{
  const bad = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { body: { title: 'bad label', body: 'b', labels: ['no-such-label'] } });
  check('POST issue unknown label 422', bad.status === 422 && isObj(bad.body) && typeof bad.body.message === 'string', JSON.stringify(bad.body));
  const r = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { body: { title: 'first issue', body: 'issue body', labels: ['bug'] } });
  check('POST issue 201 open + label', r.status === 201 && isObj(r.body) && r.body.state === 'open' && r.body.title === 'first issue' && r.body.body === 'issue body' && Array.isArray(r.body.labels) && (r.body.labels as unknown[]).some((x) => isObj(x) && x.name === 'bug'), JSON.stringify(r.body));
  if (isObj(r.body)) issue1 = Number(r.body.number);
  const r2 = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { body: { title: 'second issue', body: 'b2' } });
  if (isObj(r2.body)) issue2 = Number(r2.body.number);
  check('issue numbers increment by 1', issue2 === issue1 + 1, `${issue1} -> ${issue2}`);
}
{
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue1}`);
  check('GET issue hot path 200', g.status === 200 && isObj(g.body) && g.body.number === issue1 && g.body.title === 'first issue', JSON.stringify(g.body));
  const missing = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues/999999`);
  check('GET missing issue 404', missing.status === 404, JSON.stringify(missing.body));
}
{
  const p = call('PATCH', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue2}`, { body: { state: 'closed' } });
  check('PATCH issue close 200', p.status === 200 && isObj(p.body) && p.body.state === 'closed', JSON.stringify(p.body));
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue2}`);
  check('close persists on GET', isObj(g.body) && g.body.state === 'closed', JSON.stringify(g.body));
  const open = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { query: { state: 'open', per_page: 100 } });
  const openNums = Array.isArray(open.body) ? open.body.map((e) => (isObj(e) ? Number(e.number) : -1)) : [];
  check('list state=open omits closed', open.status === 200 && openNums.includes(issue1) && !openNums.includes(issue2), JSON.stringify(openNums));
  const asc = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { query: { state: 'all', sort: 'created', direction: 'asc', per_page: 100 } });
  const ascNums = Array.isArray(asc.body) ? asc.body.map((e) => (isObj(e) ? Number(e.number) : -1)) : [];
  check('list sort asc = creation order', ascNums.indexOf(issue1) !== -1 && ascNums.indexOf(issue1) < ascNums.indexOf(issue2), JSON.stringify(ascNums));
  const desc = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues`, { query: { state: 'all', sort: 'created', direction: 'desc', per_page: 100 } });
  const descNums = Array.isArray(desc.body) ? desc.body.map((e) => (isObj(e) ? Number(e.number) : -1)) : [];
  check('list sort desc = newest first', descNums.indexOf(issue2) !== -1 && descNums.indexOf(issue2) < descNums.indexOf(issue1), JSON.stringify(descNums));
}
{
  const c = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue1}/comments`, { body: { body: 'a comment' } });
  check('POST issue comment 201 numeric id', c.status === 201 && isObj(c.body) && Number.isInteger(c.body.id) && (c.body.id as number) >= 1 && c.body.body === 'a comment', JSON.stringify(c.body));
  const commentId = isObj(c.body) ? Number(c.body.id) : -1;
  const list = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue1}/comments`);
  const found = Array.isArray(list.body) && list.body.some((e) => isObj(e) && Number(e.id) === commentId && e.body === 'a comment');
  check('GET issue comments lists it', list.status === 200 && found, JSON.stringify(list.body));
  // Cross-surface: a comment added via GraphQL's helper must read back over REST.
  const repo = store.getRepo(VIEWER, repoName) as unknown as Parameters<typeof addIssueComment>[1];
  addIssueComment(store, repo, issue1, 'gql comment');
  const list2 = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/issues/${issue1}/comments`);
  const found2 = Array.isArray(list2.body) && list2.body.some((e) => isObj(e) && e.body === 'gql comment');
  check('GraphQL-added comment reads back over REST', list2.status === 200 && found2, JSON.stringify(list2.body));
}

// --- pulls / merge ------------------------------------------------------------
let prNumber = 0;
let headSha = '';
{
  const pr = call('POST', `/api/v3/repos/${VIEWER}/${repoName}/pulls`, { body: { title: 'add branch file', body: 'pr body', head: 'feature', base: 'main' } });
  check('POST pulls 201 open + head/base', pr.status === 201 && isObj(pr.body) && pr.body.state === 'open' && isObj(pr.body.head) && (pr.body.head as Record<string, unknown>).ref === 'feature' && isObj(pr.body.base) && (pr.body.base as Record<string, unknown>).ref === 'main', JSON.stringify(pr.body));
  if (isObj(pr.body)) {
    prNumber = Number(pr.body.number);
    headSha = String((pr.body.head as Record<string, unknown>).sha);
  }
  check('PR head.sha is branch tip', headSha === branchTip, `${headSha} vs ${branchTip}`);
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/pulls/${prNumber}`);
  check('GET pull 200', g.status === 200 && isObj(g.body) && g.body.number === prNumber && g.body.title === 'add branch file', JSON.stringify(g.body));
  const missing = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/pulls/999999999`);
  check('GET unknown pull 404', missing.status === 404, JSON.stringify(missing.body));
  const files = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/pulls/${prNumber}/files`);
  const file = Array.isArray(files.body) ? files.body.find((e) => isObj(e) && e.filename === 'docs/readme-branch.md') : undefined;
  check('GET pull files lists changed path + additions', files.status === 200 && file !== undefined && isObj(file) && (file.status === 'added' || file.status === 'modified') && Number(file.additions) >= 1 && Number.isInteger(file.deletions) && Number.isInteger(file.changes), JSON.stringify(files.body));
}
{
  const m = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/pulls/${prNumber}/merge`, { body: { merge_method: 'squash' } });
  check('PUT merge 200 {sha, merged:true, message}', m.status === 200 && isObj(m.body) && m.body.merged === true && /^[0-9a-f]{40}$/.test(String(m.body.sha)) && typeof m.body.message === 'string', JSON.stringify(m.body));
  const mergeSha = isObj(m.body) ? String(m.body.sha) : '';
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/pulls/${prNumber}`);
  check('merged PR closed + merged + merged_at + merge_commit_sha', isObj(g.body) && g.body.state === 'closed' && g.body.merged === true && typeof g.body.merged_at === 'string' && (g.body.merged_at as string).length > 0 && g.body.merge_commit_sha === mergeSha, JSON.stringify(g.body));
  const commits = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/commits`, { query: { sha: 'main' } });
  const shas = Array.isArray(commits.body) ? commits.body.map((e) => (isObj(e) ? String(e.sha) : '')) : [];
  check('merge commit on default branch', commits.status === 200 && shas.includes(mergeSha), JSON.stringify(shas));
  const content = call('GET', `/api/v3/repos/${VIEWER}/${repoName}/contents/docs/readme-branch.md`, { query: { ref: 'main' } });
  check('squash content on default branch', content.status === 200 && isObj(content.body) && unb64(String(content.body.content)) === 'branch file\n', JSON.stringify(content.body));
  const again = call('PUT', `/api/v3/repos/${VIEWER}/${repoName}/pulls/999999999/merge`, { body: { merge_method: 'squash' } });
  check('merge unknown PR 404', again.status === 404, JSON.stringify(again.body));
}
// conflict: two branches change the same file differently; merge A, then B -> 405
{
  const repo2 = 'conflict-repo';
  call('POST', '/api/v3/user/repos', { body: { name: repo2, private: true, description: 'c' } });
  call('PUT', `/api/v3/repos/${VIEWER}/${repo2}/contents/${filePath}`, { body: { message: 'seed', content: b64(fileContent) } });
  const base = call('GET', `/api/v3/repos/${VIEWER}/${repo2}/commits`);
  const baseSha = Array.isArray(base.body) && base.body.length > 0 && isObj(base.body[0]) ? String(base.body[0].sha) : '';
  call('POST', `/api/v3/repos/${VIEWER}/${repo2}/git/refs`, { body: { ref: 'refs/heads/conflict-a', sha: baseSha } });
  call('POST', `/api/v3/repos/${VIEWER}/${repo2}/git/refs`, { body: { ref: 'refs/heads/conflict-b', sha: baseSha } });
  const cur = call('GET', `/api/v3/repos/${VIEWER}/${repo2}/contents/${filePath}`);
  const curSha = isObj(cur.body) ? String(cur.body.sha) : '';
  call('PUT', `/api/v3/repos/${VIEWER}/${repo2}/contents/${filePath}`, { body: { message: 'a', content: b64(fileContentAlt + ' (a)'), branch: 'conflict-a', sha: curSha } });
  call('PUT', `/api/v3/repos/${VIEWER}/${repo2}/contents/${filePath}`, { body: { message: 'b', content: b64(fileContentAlt + ' (b)'), branch: 'conflict-b', sha: curSha } });
  const pa = call('POST', `/api/v3/repos/${VIEWER}/${repo2}/pulls`, { body: { title: 'pa', body: '', head: 'conflict-a', base: 'main' } });
  const pb = call('POST', `/api/v3/repos/${VIEWER}/${repo2}/pulls`, { body: { title: 'pb', body: '', head: 'conflict-b', base: 'main' } });
  const na = isObj(pa.body) ? Number(pa.body.number) : -1;
  const nb = isObj(pb.body) ? Number(pb.body.number) : -1;
  const ma = call('PUT', `/api/v3/repos/${VIEWER}/${repo2}/pulls/${na}/merge`, { body: { merge_method: 'squash' } });
  check('conflict scenario: first merge 200', ma.status === 200, JSON.stringify(ma.body));
  const mb = call('PUT', `/api/v3/repos/${VIEWER}/${repo2}/pulls/${nb}/merge`, { body: { merge_method: 'squash' } });
  check('conflict scenario: second merge 405', mb.status === 405 && isObj(mb.body) && typeof mb.body.message === 'string', JSON.stringify(mb.body));
  const listAll = call('GET', `/api/v3/repos/${VIEWER}/${repo2}/pulls`, { query: { state: 'all', per_page: 100 } });
  const numsAll = Array.isArray(listAll.body) ? listAll.body.map((e) => (isObj(e) ? Number(e.number) : -1)) : [];
  check('pulls?state=all lists open + merged', numsAll.includes(na) && numsAll.includes(nb), JSON.stringify(numsAll));
  const listOpen = call('GET', `/api/v3/repos/${VIEWER}/${repo2}/pulls`, { query: { per_page: 100 } });
  const numsOpen = Array.isArray(listOpen.body) ? listOpen.body.map((e) => (isObj(e) ? Number(e.number) : -1)) : [];
  check('pulls default lists open only', !numsOpen.includes(na) && numsOpen.includes(nb), JSON.stringify(numsOpen));
}

// --- delete repo --------------------------------------------------------------
{
  const d = call('DELETE', `/api/v3/repos/${VIEWER}/${repoName}`);
  check('DELETE repo 204', d.status === 204 && d.body === null, JSON.stringify(d));
  const g = call('GET', `/api/v3/repos/${VIEWER}/${repoName}`);
  check('GET after DELETE 404', g.status === 404, JSON.stringify(g.body));
}

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' — ' + failures.join(', ') : ''}`);
process.exit(failed === 0 ? 0 : 1);
