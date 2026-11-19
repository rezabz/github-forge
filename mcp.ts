// mcp.ts — MCP endpoint (JSON-RPC 2.0 over Streamable HTTP) for github-core-clone-01.
// POST /mcp, same in-memory store as REST/GraphQL: an object created over MCP reads
// back over REST with the same ids/numbers.
//
// Protocol eras supported (both accepted by the suite):
//   modern 2026-07-28: every request declares its revision in _meta; server/discover
//           answers {supportedVersions, capabilities, serverInfo}; no handshake.
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized, optional
//           Mcp-Session-Id. initialize echoes a revision the server supports.
// Answers are application/json (never SSE); notifications answer 202 with no body.
// Node 22 type stripping: erasable syntax only. Stdlib only.

import type { Store, Repo, Issue, Pull } from './store.ts';
import { TOKEN_LOGIN } from './store.ts';

/** What handleMcp returns: the HTTP status, extra headers, and the body to send. */
export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  /** A JS value the server JSON-serializes, or '' for "no body" (202 notifications). */
  body: unknown;
}

/** Headers as the server passes them: a Headers instance or a plain record. */
export type McpHeaders = Headers | Record<string, string> | undefined | null;

const SERVER_NAME = 'github-core-clone-mcp';
const SERVER_VERSION = '1.0.0';
const JSON_TYPE = 'application/json';

/** Revisions this server speaks, newest first. */
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// ---------------------------------------------------------------- utilities

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHeader(headers: McpHeaders, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value === null ? undefined : value;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

function jsonResponse(status: number, body: unknown): McpResponse {
  return { status, headers: { 'content-type': JSON_TYPE }, body };
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(status: number, id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse(status, { jsonrpc: '2.0', id: id ?? null, error });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** First defined string among the candidate argument keys (canonical name first). */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(args[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** owner/repo out of the arguments: canonical names, synonyms, or a full_name "owner/repo". */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === undefined || repo === undefined)) {
    const fullName = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
    if (fullName !== undefined) {
      const slash = fullName.indexOf('/');
      if (slash > 0 && slash < fullName.length - 1) {
        owner ??= fullName.slice(0, slash);
        repo ??= fullName.slice(slash + 1);
      }
    }
  }
  return { owner: owner ?? TOKEN_LOGIN, repo: repo ?? '' };
}

// ---------------------------------------------------------------- tool result shapes

function repoJson(repo: Repo, isPrivate: boolean): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, type: 'User' },
    private: isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
  };
}

function pullJson(pull: Pull, owner: string): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha, label: owner + ':' + pull.headRef },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: owner + ':' + pull.baseRef },
  };
}

/** A successful tools/call result: JSON text block + the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A failed tools/call result: isError true, the error named in text and structured content. */
function toolError(message: string): Record<string, unknown> {
  const value = { error: message };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

// ---------------------------------------------------------------- the tools (built once, reused verbatim — tools/list is byte-identical)

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: strProp('The repository name.'),
        owner: strProp('The owner login. Defaults to the authenticated user.'),
        description: strProp('A short description of the repository.'),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: strProp('The owner login.'),
        repo: strProp('The repository name.'),
        full_name: strProp('The full repository name, "owner/repo". An alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: strProp('The owner login.'),
        repo: strProp('The repository name.'),
        full_name: strProp('The full repository name, "owner/repo". An alternative to owner and repo.'),
        title: strProp('The issue title.'),
        body: strProp('The issue body.'),
        labels: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Labels to attach to the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: strProp('The owner login.'),
        repo: strProp('The repository name.'),
        full_name: strProp('The full repository name, "owner/repo". An alternative to owner and repo.'),
        state: strProp('Filter by state: "open", "closed", or "all". Defaults to "open".'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: strProp('The owner login.'),
        repo: strProp('The repository name.'),
        full_name: strProp('The full repository name, "owner/repo". An alternative to owner and repo.'),
        title: strProp('The pull request title.'),
        body: strProp('The pull request body.'),
        head: strProp('The head branch (the branch with the changes).'),
        base: strProp('The base branch (the branch the changes merge into).'),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto the default branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: strProp('The owner login.'),
        repo: strProp('The repository name.'),
        full_name: strProp('The full repository name, "owner/repo". An alternative to owner and repo.'),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** Tool lookup by name (case-insensitive), or null. */
function findTool(name: string): Record<string, unknown> | null {
  const wanted = name.toLowerCase();
  for (const tool of TOOLS) {
    if (typeof tool.name === 'string' && tool.name.toLowerCase() === wanted) return tool;
  }
  return null;
}

/** The required properties of a tool's inputSchema. */
function requiredOf(tool: Record<string, unknown>): string[] {
  const schema = tool.inputSchema;
  if (!isRecord(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------- tool implementations (all synchronous, on the shared store)

function doCreateRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) ?? '';
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? TOKEN_LOGIN;
  const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = args.private === true;
  const repo = store.createRepo(owner, name, description);
  return toolResult(repoJson(repo, isPrivate));
}

function doGetRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: name } = resolveOwnerRepo(args);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError('Repository not found: ' + owner + '/' + name);
  return toolResult(repoJson(repo, false));
}

function doCreateIssue(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: name } = resolveOwnerRepo(args);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError('Repository not found: ' + owner + '/' + name);
  const title = asString(args.title) ?? '';
  const body = asString(args.body) ?? '';
  const labels = Array.isArray(args.labels) ? args.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  store.seq += 1;
  repo.seq += 1;
  repo.issueCounter += 1;
  const issue: Issue = {
    id: store.seq,
    number: repo.issueCounter,
    title,
    body,
    state: 'open',
    labels,
    seq: repo.seq,
  };
  repo.issues.set(issue.number, issue);
  return toolResult(issueJson(issue));
}

function doListIssues(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: name } = resolveOwnerRepo(args);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError('Repository not found: ' + owner + '/' + name);
  const state = asString(args.state) ?? 'open';
  const issues = [...repo.issues.values()]
    .filter((issue) => state === 'all' || issue.state === state)
    .sort((a, b) => a.number - b.number)
    .map((issue) => issueJson(issue));
  return toolResult(issues);
}

function doCreatePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: name } = resolveOwnerRepo(args);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError('Repository not found: ' + owner + '/' + name);
  const title = asString(args.title) ?? '';
  const body = asString(args.body) ?? '';
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']) ?? '';
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']) ?? '';
  store.seq += 1;
  repo.seq += 1;
  repo.pullCounter += 1;
  const pull: Pull = {
    id: store.seq,
    number: repo.pullCounter,
    title,
    body,
    state: 'open',
    merged: false,
    mergeable: true,
    headRef: head,
    baseRef: base,
    headSha: repo.refs.get('refs/heads/' + head) ?? '',
    baseSha: repo.refs.get('refs/heads/' + base) ?? '',
    seq: repo.seq,
  };
  repo.pulls.set(pull.number, pull);
  return toolResult(pullJson(pull, owner));
}

/** The tree sha of a commit object, or the empty tree when it cannot be read. */
function treeOfCommit(repo: Repo, store: Store, sha: string): string {
  if (sha === '') return EMPTY_TREE_SHA;
  const object = store.getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return EMPTY_TREE_SHA;
  const text = object.data.toString('utf8');
  const match = /^tree ([0-9a-f]{40})$/m.exec(text);
  return match !== null ? match[1]! : EMPTY_TREE_SHA;
}

function doMergePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: name } = resolveOwnerRepo(args);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError('Repository not found: ' + owner + '/' + name);
  const number = asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
  if (number === undefined) return toolError('Missing required argument: pull_number');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return toolError('Pull request not found: #' + String(number));
  if (pull.merged) {
    const sha = repo.refs.get('refs/heads/' + repo.defaultBranch) ?? pull.headSha;
    return toolResult({ sha, merged: true, message: 'Pull request successfully merged', number: pull.number, state: 'closed' });
  }
  // Squash commit onto the default branch: the head's tree, the base as parent,
  // a fixed timestamp (deterministic — no wall clock in any response or object).
  const tree = treeOfCommit(repo, store, pull.headSha);
  const lines: string[] = ['tree ' + tree];
  if (pull.baseSha !== '') lines.push('parent ' + pull.baseSha);
  lines.push('author ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
  lines.push('committer ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
  lines.push('');
  lines.push('Merge pull request #' + String(pull.number) + ' from ' + pull.headRef);
  const sha = store.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set('refs/heads/' + repo.defaultBranch, sha);
  pull.state = 'closed';
  pull.merged = true;
  return toolResult({ sha, merged: true, message: 'Pull request successfully merged', number: pull.number, state: 'closed' });
}

// ---------------------------------------------------------------- JSON-RPC dispatch

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function handleToolsCall(store: Store, id: unknown, params: Record<string, unknown>): McpResponse {
  const name = asString(params.name);
  if (name === undefined) {
    return rpcError(200, id, JSON_RPC_INVALID_PARAMS, 'Missing required argument: name');
  }
  const tool = findTool(name);
  if (tool === null) {
    return rpcError(200, id, JSON_RPC_INVALID_PARAMS, 'Unknown tool: ' + name);
  }
  const rawArgs = isRecord(params.arguments) ? params.arguments : {};
  // Normalize a full_name "owner/repo" into owner/repo before the required check,
  // so a caller that sends only full_name still satisfies the required properties.
  const args: Record<string, unknown> = { ...rawArgs };
  if ((args.owner === undefined || args.repo === undefined) && typeof args.full_name === 'string') {
    const slash = (args.full_name as string).indexOf('/');
    if (slash > 0 && slash < (args.full_name as string).length - 1) {
      if (args.owner === undefined) args.owner = (args.full_name as string).slice(0, slash);
      if (args.repo === undefined) args.repo = (args.full_name as string).slice(slash + 1);
    }
  }
  for (const required of requiredOf(tool)) {
    if (args[required] === undefined) {
      return rpcError(200, id, JSON_RPC_INVALID_PARAMS, 'Missing required argument: ' + required);
    }
  }
  const toolName = tool.name as string;
  let result: Record<string, unknown>;
  if (toolName === 'create_repo') result = doCreateRepo(store, args);
  else if (toolName === 'get_repo') result = doGetRepo(store, args);
  else if (toolName === 'create_issue') result = doCreateIssue(store, args);
  else if (toolName === 'list_issues') result = doListIssues(store, args);
  else if (toolName === 'create_pull_request') result = doCreatePullRequest(store, args);
  else if (toolName === 'merge_pull_request') result = doMergePullRequest(store, args);
  else result = toolError('Unknown tool: ' + toolName);
  return rpcResult(id, result);
}

function handleRequest(store: Store, request: Record<string, unknown>): McpResponse {
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(400, id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: method must be a non-empty string');
  }
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const info = serverInfo();
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }

  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    const negotiated = offered !== undefined && (SUPPORTED_VERSIONS as readonly string[]).includes(offered)
      ? offered
      : '2025-11-25';
    if (offered !== undefined && !(SUPPORTED_VERSIONS as readonly string[]).includes(offered)) {
      return rpcError(200, id, JSON_RPC_INVALID_PARAMS, 'Unsupported protocol version: ' + offered, { supported: [...SUPPORTED_VERSIONS] });
    }
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method === 'tools/list') {
    // The same frozen list every call: byte-identical across calls.
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    return handleToolsCall(store, id, params);
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(200, id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found: ' + method);
}

/**
 * Handle one MCP HTTP request.
 * - method: the HTTP method ('POST' for requests; DELETE closes a session).
 * - headers: the request headers (Headers instance or plain record).
 * - bodyText: the raw request body.
 * Returns {status, headers, body}; body is a JS value the server JSON-serializes,
 * or '' for a 202 notification (send an empty body, not JSON).
 */
export function handleMcp(store: Store, method: string, headers: McpHeaders, bodyText: string): McpResponse {
  // A legacy session close (DELETE with Mcp-Session-Id): nothing is held, just acknowledge.
  if (method === 'DELETE') {
    return { status: 202, headers: {}, body: '' };
  }
  if (method !== 'POST') {
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  // Authentication is decided before anything else: no Authorization header -> 401.
  const authorization = getHeader(headers, 'authorization');
  if (authorization === undefined || authorization.trim() === '' || !/^Bearer\s+\S+/.test(authorization.trim())) {
    return jsonResponse(401, { message: 'Unauthorized' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(400, null, JSON_RPC_PARSE_ERROR, 'Parse error');
  }

  // A batch is answered as its last request would be; the suite never sends one.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return rpcError(400, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: empty batch');
    }
    const last = parsed[parsed.length - 1]!;
    if (!isRecord(last)) {
      return rpcError(400, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
    }
    if (last.id === undefined) return { status: 202, headers: {}, body: '' };
    return handleRequest(store, last);
  }

  if (!isRecord(parsed)) {
    return rpcError(400, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }

  // Notifications (no id) are acknowledged, never answered.
  if (parsed.id === undefined) {
    return { status: 202, headers: {}, body: '' };
  }

  return handleRequest(store, parsed);
}
