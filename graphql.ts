// graphql.ts — hand-rolled GraphQL v4 executor for github-core-clone-01.
// No GraphQL library: a small tokenizer + recursive-descent parser for the
// fixed schema, executing against the shared Store (same objects REST sees).
// Node 22 type stripping: erasable syntax only. Stdlib only.
//
// Entry point: handleGraphQL(store, body, authOk) -> { status, body }
//   body = parsed JSON request ({ query, variables, operationName }) or an
//   array of such operations (GitHub operation batching -> array of results).
//   authOk = whether the bearer token was valid; unauthenticated -> 401.
//
// Global ids are opaque base64url strings ("Kind:payload"), stable across
// reads, never the bare numeric id. They decode inside this module only.
//
// Comments: the Store contract has no comment storage, so comments live on
// the Repo object itself under `__gqlComments` (a Map<string, Comment[]> keyed
// "Issue:<n>" / "PullRequest:<n>") and are exposed via getIssueComments /
// addIssueComment below, so the REST module (same process, same Repo object)
// can read/write the same comments. Coordinator: have rest.ts import those
// helpers instead of inventing a second comment store.

import { TOKEN_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// --------------------------------------------------------------------------------
// Global ids
// --------------------------------------------------------------------------------

function encId(kind: string, payload: string): string {
  return Buffer.from(kind + ':' + payload, 'utf8').toString('base64url');
}

function decId(id: unknown): { kind: string; payload: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), payload: text.slice(i + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encId('Repository', String(repo.id) + ':' + repo.owner + '/' + repo.name);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encId('Issue', repo.owner + '/' + repo.name + ':' + String(issue.number));
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encId('PullRequest', repo.owner + '/' + repo.name + ':' + String(pull.number));
}

function userGlobalId(login: string): string {
  return encId('User', login);
}

/** "owner/name:number" -> { repo, number } or null. */
function parseOwnerNameNumber(store: Store, payload: string): { repo: Repo; number: number } | null {
  const i = payload.lastIndexOf(':');
  if (i <= 0) return null;
  const key = payload.slice(0, i);
  const number = Number(payload.slice(i + 1));
  if (!Number.isInteger(number) || number <= 0) return null;
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const repo = store.getRepo(key.slice(0, slash), key.slice(slash + 1));
  if (repo === undefined) return null;
  return { repo, number };
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  const dec = decId(id);
  if (dec === null || dec.kind !== 'Repository') return null;
  // payload: "<numericId>:<owner>/<name>"
  const i = dec.payload.indexOf(':');
  if (i < 0) return null;
  const key = dec.payload.slice(i + 1);
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const repo = store.getRepo(key.slice(0, slash), key.slice(slash + 1));
  return repo === undefined ? null : repo;
}

// --------------------------------------------------------------------------------
// Comments (shared with REST via the Repo object — see header)
// --------------------------------------------------------------------------------

export interface GqlComment {
  id: string;
  body: string;
}

function commentsMap(repo: Repo): Map<string, GqlComment[]> {
  const r = repo as unknown as Record<string, unknown>;
  let m = r.__gqlComments as Map<string, GqlComment[]> | undefined;
  if (m === undefined) {
    m = new Map<string, GqlComment[]>();
    r.__gqlComments = m;
  }
  return m;
}

export function getIssueComments(repo: Repo, issueNumber: number): GqlComment[] {
  return commentsMap(repo).get('Issue:' + String(issueNumber)) ?? [];
}

export function addIssueComment(store: Store, repo: Repo, issueNumber: number, body: string): GqlComment {
  store.seq += 1;
  const comment: GqlComment = { id: encId('IssueComment', repo.owner + '/' + repo.name + ':' + String(issueNumber) + ':' + String(store.seq)), body };
  const m = commentsMap(repo);
  const key = 'Issue:' + String(issueNumber);
  const list = m.get(key) ?? [];
  list.push(comment);
  m.set(key, list);
  return comment;
}

function addPullComment(store: Store, repo: Repo, pullNumber: number, body: string): GqlComment {
  store.seq += 1;
  const comment: GqlComment = { id: encId('IssueComment', repo.owner + '/' + repo.name + ':pr:' + String(pullNumber) + ':' + String(store.seq)), body };
  const m = commentsMap(repo);
  const key = 'PullRequest:' + String(pullNumber);
  const list = m.get(key) ?? [];
  list.push(comment);
  m.set(key, list);
  return comment;
}

// --------------------------------------------------------------------------------
// Schema description (introspection)
// --------------------------------------------------------------------------------

interface TypeDef {
  kind: string;
  fields: string[];
  enumValues: string[];
}

const TYPES: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__schema', '__type'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'body'], enumValues: [] },
  User: { kind: 'OBJECT', fields: ['id', 'login'], enumValues: [] },
  Ref: { kind: 'OBJECT', fields: ['name'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'], enumValues: [] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'], enumValues: [] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'], enumValues: [] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'], enumValues: [] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'], enumValues: [] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'], enumValues: [] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'], enumValues: [] },
  Node: { kind: 'INTERFACE', fields: ['id'], enumValues: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

function typeIntrospection(name: string): Record<string, unknown> | null {
  const def = TYPES[name];
  if (def === undefined) return null;
  return {
    name,
    kind: def.kind,
    description: null,
    fields: def.kind === 'ENUM' ? null : def.fields.map((f) => ({ name: f, description: null, args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } })),
    enumValues: def.kind === 'ENUM' ? def.enumValues.map((v) => ({ name: v, description: null })) : null,
    interfaces: null,
    possibleTypes: null,
  };
}

function schemaIntrospection(): Record<string, unknown> {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    subscriptionType: null,
    types: Object.keys(TYPES).map((name) => ({ name, kind: TYPES[name].kind, description: null })),
    directives: [],
  };
}

// --------------------------------------------------------------------------------
// Cursors (offset into a sorted connection, base64url — deterministic)
// --------------------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return Buffer.from('cursor:' + String(offset), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------------
// PR files: diff of the flattened trees of baseSha vs headSha (from store objects)
// --------------------------------------------------------------------------------

function commitTreeSha(repo: Repo, sha: string): string | null {
  if (!sha) return null;
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const firstLine = text.split('\n')[0];
  if (firstLine === undefined || !firstLine.startsWith('tree ')) return null;
  return firstLine.slice(5).trim();
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  const data = obj.data;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) return;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) return;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    const path = prefix === '' ? name : prefix + '/' + name;
    if (mode === '40000') flattenTree(repo, sha, path, out);
    else out.set(path, sha);
    i = nul + 21;
  }
}

function pullRequestFiles(repo: Repo, pull: Pull): string[] {
  const baseTree = commitTreeSha(repo, pull.baseSha);
  const headTree = commitTreeSha(repo, pull.headSha);
  if (baseTree === null && headTree === null) return [];
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  if (baseTree !== null) flattenTree(repo, baseTree, '', base);
  if (headTree !== null) flattenTree(repo, headTree, '', head);
  const changed: string[] = [];
  const all = new Set<string>([...base.keys(), ...head.keys()]);
  for (const p of all) {
    if (base.get(p) !== head.get(p)) changed.push(p);
  }
  changed.sort();
  return changed;
}

// --------------------------------------------------------------------------------
// Tokenizer
// --------------------------------------------------------------------------------

interface Token {
  kind: string;
  value: string;
  line: number;
  col: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;
  function adv(k: number): void {
    for (let j = 0; j < k; j += 1) {
      if (src[i] === '\n') { line += 1; col = 1; } else { col += 1; }
      i += 1;
    }
  }
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',') { adv(1); continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') adv(1);
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...', line: startLine, col: startCol });
      adv(3);
      continue;
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      tokens.push({ kind: c, value: c, line: startLine, col: startCol });
      adv(1);
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw, line: startLine, col: startCol });
        adv(end < 0 ? n - i : end + 3 - i);
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '"') { closed = true; j += 1; break; }
        if (ch === '\\' && j + 1 < n) {
          const e = src[j + 1];
          if (e === 'u' && j + 5 < n) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const esc: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += esc[e] ?? e;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (!closed) throw new Error('Unterminated string at line ' + String(startLine));
      tokens.push({ kind: 'string', value: out, line: startLine, col: startCol });
      adv(j - i);
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < n && /[0-9]/.test(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j), line: startLine, col: startCol });
      adv(j - i);
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j), line: startLine, col: startCol });
      adv(j - i);
      continue;
    }
    throw new Error('Unexpected character ' + JSON.stringify(c) + ' at line ' + String(startLine));
  }
  tokens.push({ kind: 'eof', value: '', line, col });
  return tokens;
}

// --------------------------------------------------------------------------------
// Parser (AST)
// --------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode { name: string; value: ValueNode; }
interface DirectiveNode { name: string; args: ArgumentNode[]; }
interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode { kind: 'spread'; name: string; directives: DirectiveNode[]; }
interface InlineFragmentNode { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[]; }
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operationType: string;
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; selectionSet: SelectionNode[]; }
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  expect(kind: string): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new Error('Expected ' + kind + ' but got ' + JSON.stringify(t.value) + ' at line ' + String(t.line));
    return this.next();
  }

  expectName(value?: string): Token {
    const t = this.peek();
    if (t.kind !== 'name') throw new Error('Expected name but got ' + JSON.stringify(t.value) + ' at line ' + String(t.line));
    if (value !== undefined && t.value !== value) throw new Error('Expected ' + value + ' but got ' + t.value + ' at line ' + String(t.line));
    return this.next();
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === '{') {
      return { kind: 'operation', operationType: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const opType = this.next().value;
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const varDefs = this.peek().kind === '(' ? this.parseVariableDefinitions() : [];
      this.parseDirectives();
      return { kind: 'operation', operationType: opType, name, variableDefinitions: varDefs, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName().value;
      this.expectName('on');
      const typeCondition = this.expectName().value;
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error('Unexpected ' + JSON.stringify(t.value) + ' at line ' + String(t.line));
  }

  parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expectName().value;
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  parseType(): void {
    if (this.peek().kind === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const sels: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName().value;
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === ':') {
      this.next();
      alias = first;
      name = this.expectName().value;
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }

  parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expectName().value;
      this.expect(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expect(')');
    return args;
  }

  parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.peek().kind === '@') {
      this.next();
      const name = this.expectName().value;
      const args = this.peek().kind === '(' ? this.parseArguments() : [];
      dirs.push({ name, args });
    }
    return dirs;
  }

  parseValue(isConst: boolean): ValueNode {
    const t = this.peek();
    if (t.kind === '$') {
      if (isConst) throw new Error('Variable in constant value at line ' + String(t.line));
      this.next();
      return { kind: 'variable', name: this.expectName().value };
    }
    if (t.kind === 'int') { this.next(); return { kind: 'int', value: parseInt(t.value, 10) }; }
    if (t.kind === 'float') { this.next(); return { kind: 'float', value: parseFloat(t.value) }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(isConst));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t.kind === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().kind !== '}') {
        const name = this.expectName().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('Unexpected value ' + JSON.stringify(t.value) + ' at line ' + String(t.line));
  }
}

// --------------------------------------------------------------------------------
// Execution
// --------------------------------------------------------------------------------

interface TypedValue {
  __typename: string;
  __value: unknown;
}

function tv(typeName: string, value: unknown): TypedValue {
  return { __typename: typeName, __value: value };
}

function isTyped(v: unknown): v is TypedValue {
  return v !== null && typeof v === 'object' && typeof (v as TypedValue).__typename === 'string' && '__value' in (v as Record<string, unknown>);
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<Record<string, unknown>>;
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name] ?? null;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, ctx);
      return out;
    }
  }
}

function evalArgs(args: ArgumentNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalValue(a.value, ctx);
  return out;
}

function directivesAllow(directives: DirectiveNode[], ctx: Ctx): boolean {
  for (const d of directives) {
    const args = evalArgs(d.args, ctx);
    if (d.name === 'skip' && args.if === true) return false;
    if (d.name === 'include' && args.if === false) return false;
  }
  return true;
}

function argStr(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' ? v : null;
}

function argInt(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function argObj(args: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const v = args[name];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// --- resolvers: (parent, args, ctx) -> scalar | TypedValue | TypedValue[] | null ---

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: Ctx) => unknown;

function issueState(s: string): string {
  return s === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(p: Pull): string {
  if (p.merged) return 'MERGED';
  return p.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueTv(repo: Repo, issue: Issue): TypedValue {
  return tv('Issue', { repo, issue });
}

function pullTv(repo: Repo, pull: Pull): TypedValue {
  return tv('PullRequest', { repo, pull });
}

function repoTv(repo: Repo): TypedValue {
  return tv('Repository', repo);
}

function sortIssues(issues: Issue[], orderBy: Record<string, unknown> | null): Issue[] {
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  const sorted = [...issues];
  if (field === 'CREATED_AT' || field === 'UPDATED_AT' || field === 'COMMENTS') {
    sorted.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
  } else {
    sorted.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
  }
  return sorted;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s)));
    list = list.filter((i) => want.has(issueState(i.state)));
  }
  list = sortIssues(list, argObj(args, 'orderBy'));
  const total = list.length;
  const after = decodeCursor(args.after);
  const first = argInt(args, 'first');
  const page = first === null ? list.slice(after) : list.slice(after, after + first);
  const endOffset = after + page.length;
  const pageInfo = tv('PageInfo', { hasNextPage: endOffset < total, endCursor: encodeCursor(endOffset) });
  return tv('IssueConnection', {
    nodes: page.map((i) => issueTv(repo, i)),
    totalCount: total,
    pageInfo,
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s)));
    list = list.filter((p) => want.has(pullState(p)));
  } else {
    // GitHub's pullRequests defaults to open.
    list = list.filter((p) => pullState(p) === 'OPEN');
  }
  list.sort((a, b) => (a.seq - b.seq) * -1 || (a.number - b.number) * -1);
  const total = list.length;
  const after = decodeCursor(args.after);
  const first = argInt(args, 'first');
  const page = first === null ? list.slice(after) : list.slice(after, first === null ? undefined : after + first);
  const endOffset = after + page.length;
  const pageInfo = tv('PageInfo', { hasNextPage: endOffset < total, endCursor: encodeCursor(endOffset) });
  return tv('PullRequestConnection', {
    nodes: page.map((p) => pullTv(repo, p)),
    totalCount: total,
    pageInfo,
  });
}

function createSquashCommit(store: Store, repo: Repo, pull: Pull): void {
  try {
    if (!pull.headSha) return;
    const headTree = commitTreeSha(repo, pull.headSha);
    if (headTree === null) return;
    const lines: string[] = ['tree ' + headTree];
    if (pull.baseSha) lines.push('parent ' + pull.baseSha);
    lines.push('author ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
    lines.push('committer ' + TOKEN_LOGIN + ' <' + TOKEN_LOGIN + '@example.com> 0 +0000');
    lines.push('');
    lines.push('Merge pull request #' + String(pull.number) + ' from ' + pull.headRef);
    lines.push('');
    lines.push(pull.title);
    const sha = store.putObject(repo, 'commit', Buffer.from(lines.join('\n') + '\n', 'utf8'));
    repo.refs.set('refs/heads/' + pull.baseRef, sha);
  } catch {
    // A merge must never fail on the squash commit; merged/state are already set.
  }
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => tv('User', { login: TOKEN_LOGIN }),
    repository: ( _p, args, ctx) => {
      const owner = argStr(args, 'owner');
      const name = argStr(args, 'name');
      if (owner === null || name === null) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoTv(repo);
    },
    node: (_p, args, ctx) => {
      const dec = decId(args.id);
      if (dec === null) return null;
      if (dec.kind === 'Repository') {
        const repo = repoFromGlobalId(ctx.store, args.id);
        return repo === null ? null : repoTv(repo);
      }
      if (dec.kind === 'Issue') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed === null) return null;
        const issue = parsed.repo.issues.get(parsed.number);
        return issue === undefined ? null : issueTv(parsed.repo, issue);
      }
      if (dec.kind === 'PullRequest') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed === null) return null;
        const pull = parsed.repo.pulls.get(parsed.number);
        return pull === undefined ? null : pullTv(parsed.repo, pull);
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = argObj(args, 'input') ?? {};
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) return tv('CreateIssuePayload', { issue: null });
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      ctx.store.seq += 1;
      repo.issueCounter += 1;
      const issue: Issue = { id: ctx.store.seq, number: repo.issueCounter, title, body, state: 'open', labels: [], seq: ctx.store.seq };
      repo.issues.set(issue.number, issue);
      return tv('CreateIssuePayload', { issue: issueTv(repo, issue) });
    },
    closeIssue: (_p, args, ctx) => {
      const input = argObj(args, 'input') ?? {};
      const dec = decId(input.issueId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (dec !== null && dec.kind === 'Issue') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed !== null) {
          const issue = parsed.repo.issues.get(parsed.number);
          if (issue !== undefined) found = { repo: parsed.repo, issue };
        }
      }
      if (found === null) return tv('CloseIssuePayload', { issue: null });
      found.issue.state = 'closed';
      return tv('CloseIssuePayload', { issue: issueTv(found.repo, found.issue) });
    },
    createPullRequest: (_p, args, ctx) => {
      const input = argObj(args, 'input') ?? {};
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) return tv('CreatePullRequestPayload', { pullRequest: null });
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
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
        headSha: repo.refs.get('refs/heads/' + headRef) ?? '',
        baseSha: repo.refs.get('refs/heads/' + baseRef) ?? '',
        seq: ctx.store.seq,
      };
      repo.pulls.set(pull.number, pull);
      return tv('CreatePullRequestPayload', { pullRequest: pullTv(repo, pull) });
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = argObj(args, 'input') ?? {};
      const dec = decId(input.pullRequestId);
      let found: { repo: Repo; pull: Pull } | null = null;
      if (dec !== null && dec.kind === 'PullRequest') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed !== null) {
          const pull = parsed.repo.pulls.get(parsed.number);
          if (pull !== undefined) found = { repo: parsed.repo, pull };
        }
      }
      if (found === null) return tv('MergePullRequestPayload', { pullRequest: null });
      found.pull.merged = true;
      found.pull.state = 'closed';
      createSquashCommit(ctx.store, found.repo, found.pull);
      return tv('MergePullRequestPayload', { pullRequest: pullTv(found.repo, found.pull) });
    },
    addComment: (_p, args, ctx) => {
      const input = argObj(args, 'input') ?? {};
      const body = typeof input.body === 'string' ? input.body : '';
      const dec = decId(input.subjectId);
      let comment: GqlComment | null = null;
      if (dec !== null && dec.kind === 'Issue') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed !== null && parsed.repo.issues.has(parsed.number)) {
          comment = addIssueComment(ctx.store, parsed.repo, parsed.number, body);
        }
      } else if (dec !== null && dec.kind === 'PullRequest') {
        const parsed = parseOwnerNameNumber(ctx.store, dec.payload);
        if (parsed !== null && parsed.repo.pulls.has(parsed.number)) {
          comment = addPullComment(ctx.store, parsed.repo, parsed.number, body);
        }
      }
      if (comment === null) return tv('AddCommentPayload', { commentEdge: null });
      return tv('AddCommentPayload', { commentEdge: tv('IssueCommentEdge', { node: tv('IssueComment', comment) }) });
    },
  },
  Repository: {
    id: (p) => repoGlobalId(p as Repo),
    databaseId: (p) => (p as Repo).id,
    name: (p) => (p as Repo).name,
    nameWithOwner: (p) => (p as Repo).owner + '/' + (p as Repo).name,
    description: (p) => (p as Repo).description,
    owner: (p) => tv('User', { login: (p as Repo).owner }),
    defaultBranchRef: (p) => tv('Ref', { name: (p as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (p, args) => {
      const repo = p as Repo;
      const n = argInt(args, 'number');
      if (n === null) return null;
      const issue = repo.issues.get(n);
      return issue === undefined ? null : issueTv(repo, issue);
    },
    issues: (p, args) => issuesConnection(p as Repo, args),
    pullRequests: (p, args) => pullsConnection(p as Repo, args),
    pullRequest: (p, args) => {
      const repo = p as Repo;
      const n = argInt(args, 'number');
      if (n === null) return null;
      const pull = repo.pulls.get(n);
      return pull === undefined ? null : pullTv(repo, pull);
    },
  },
  Issue: {
    id: (p) => issueGlobalId((p as { repo: Repo; issue: Issue }).repo, (p as { repo: Repo; issue: Issue }).issue),
    number: (p) => (p as { issue: Issue }).issue.number,
    title: (p) => (p as { issue: Issue }).issue.title,
    state: (p) => issueState((p as { issue: Issue }).issue.state),
    body: (p) => (p as { issue: Issue }).issue.body,
  },
  PullRequest: {
    id: (p) => pullGlobalId((p as { repo: Repo; pull: Pull }).repo, (p as { repo: Repo; pull: Pull }).pull),
    number: (p) => (p as { pull: Pull }).pull.number,
    title: (p) => (p as { pull: Pull }).pull.title,
    state: (p) => pullState((p as { pull: Pull }).pull),
    headRefName: (p) => (p as { pull: Pull }).pull.headRef,
    baseRefName: (p) => (p as { pull: Pull }).pull.baseRef,
    mergeable: (p) => ((p as { pull: Pull }).pull.mergeable ? 'MERGEABLE' : 'CONFLICTING'),
    merged: (p) => (p as { pull: Pull }).pull.merged,
    body: (p) => (p as { pull: Pull }).pull.body,
    files: (p, args) => {
      const { repo, pull } = p as { repo: Repo; pull: Pull };
      const paths = pullRequestFiles(repo, pull);
      const first = argInt(args, 'first');
      const sliced = first === null ? paths : paths.slice(0, first);
      return tv('PullRequestConnection', {
        nodes: sliced.map((path) => tv('PullRequestChangedFile', { path })),
        totalCount: paths.length,
        pageInfo: tv('PageInfo', { hasNextPage: false, endCursor: '' }),
      });
    },
  },
  User: {
    id: (p) => userGlobalId((p as { login: string }).login),
    login: (p) => (p as { login: string }).login,
  },
  Ref: {
    name: (p) => (p as { name: string }).name,
  },
  IssueConnection: {
    nodes: (p) => (p as { nodes: TypedValue[] }).nodes,
    totalCount: (p) => (p as { totalCount: number }).totalCount,
    pageInfo: (p) => (p as { pageInfo: TypedValue }).pageInfo,
  },
  PullRequestConnection: {
    nodes: (p) => (p as { nodes: TypedValue[] }).nodes,
    totalCount: (p) => (p as { totalCount: number }).totalCount,
    pageInfo: (p) => (p as { pageInfo: TypedValue }).pageInfo,
  },
  PageInfo: {
    hasNextPage: (p) => (p as { hasNextPage: boolean }).hasNextPage,
    endCursor: (p) => (p as { endCursor: string }).endCursor,
  },
  PullRequestChangedFile: {
    path: (p) => (p as { path: string }).path,
  },
  IssueComment: {
    id: (p) => (p as GqlComment).id,
    body: (p) => (p as GqlComment).body,
  },
  IssueCommentEdge: {
    node: (p) => (p as { node: TypedValue }).node,
  },
  AddCommentPayload: {
    commentEdge: (p) => (p as { commentEdge: TypedValue | null }).commentEdge,
  },
  CreateIssuePayload: {
    issue: (p) => (p as { issue: TypedValue | null }).issue,
  },
  CloseIssuePayload: {
    issue: (p) => (p as { issue: TypedValue | null }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (p) => (p as { pullRequest: TypedValue | null }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (p) => (p as { pullRequest: TypedValue | null }).pullRequest,
  },
};

function typeMatches(condition: string | null, typeName: string): boolean {
  if (condition === null) return true;
  if (condition === typeName) return true;
  // The Node interface matches every node type.
  if (condition === 'Node' && (typeName === 'Repository' || typeName === 'Issue' || typeName === 'PullRequest' || typeName === 'User')) return true;
  return false;
}

function executeSelectionSet(typeName: string, parent: unknown, selections: SelectionNode[], ctx: Ctx, path: Array<string | number>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 50) return out;
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (!directivesAllow(sel.directives, ctx)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: 'Unknown fragment "' + sel.name + '".' });
        continue;
      }
      if (!typeMatches(frag.typeCondition, typeName)) continue;
      const sub = executeSelectionSet(typeName, parent, frag.selectionSet, ctx, path, depth + 1);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (!directivesAllow(sel.directives, ctx)) continue;
      if (!typeMatches(sel.typeCondition, typeName)) continue;
      const sub = executeSelectionSet(typeName, parent, sel.selectionSet, ctx, path, depth + 1);
      Object.assign(out, sub);
      continue;
    }
    // field
    if (!directivesAllow(sel.directives, ctx)) continue;
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    if (sel.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (typeName === 'Query' && sel.name === '__schema') {
      out[responseKey] = completeValue(tv('__Schema', schemaIntrospection()), sel.selectionSet, ctx, fieldPath, depth);
      continue;
    }
    if (typeName === 'Query' && sel.name === '__type') {
      const args = evalArgs(sel.args, ctx);
      const name = argStr(args, 'name');
      const info = name === null ? null : typeIntrospection(name);
      out[responseKey] = info === null ? null : completeValue(tv('__Type', info), sel.selectionSet, ctx, fieldPath, depth);
      continue;
    }
    const fields = RESOLVERS[typeName];
    const resolver = fields?.[sel.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: 'Cannot query field "' + sel.name + '" on type "' + typeName + '".', path: fieldPath });
      continue;
    }
    let raw: unknown;
    try {
      raw = resolver(parent, evalArgs(sel.args, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(raw, sel.selectionSet, ctx, fieldPath, depth);
  }
  return out;
}

function completeValue(raw: unknown, selectionSet: SelectionNode[] | null, ctx: Ctx, path: Array<string | number>, depth: number): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((v, i) => completeValue(v, selectionSet, ctx, [...path, i], depth));
  if (isTyped(raw)) {
    if (selectionSet === null) return {};
    // __Type / __Schema pseudo-types: their value is a plain record; resolve
    // subfields by direct property lookup instead of the resolver table.
    if (raw.__typename === '__Type' || raw.__typename === '__Schema') {
      return completeIntrospection(raw.__value as Record<string, unknown>, selectionSet, ctx, path, depth);
    }
    return executeSelectionSet(raw.__typename, raw.__value, selectionSet, ctx, path, depth + 1);
  }
  return raw;
}

function completeIntrospection(value: Record<string, unknown>, selections: SelectionNode[], ctx: Ctx, path: Array<string | number>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread' || sel.kind === 'inline') {
      const inner = sel.kind === 'spread' ? ctx.fragments.get(sel.name)?.selectionSet : sel.selectionSet;
      if (inner === undefined) continue;
      if (sel.kind === 'inline' && !typeMatches(sel.typeCondition, '__Type')) continue;
      Object.assign(out, completeIntrospection(value, inner, ctx, path, depth + 1));
      continue;
    }
    if (!directivesAllow(sel.directives, ctx)) continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = '__Type';
      continue;
    }
    const raw = value[sel.name];
    if (raw === undefined) {
      ctx.errors.push({ message: 'Cannot query field "' + sel.name + '" on type "__Type".', path: [...path, key] });
      continue;
    }
    if (sel.selectionSet === null || raw === null || typeof raw !== 'object') {
      out[key] = raw ?? null;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((entry) => {
        if (entry !== null && typeof entry === 'object') return completeIntrospection(entry as Record<string, unknown>, sel.selectionSet as SelectionNode[], ctx, [...path, key], depth + 1);
        return entry;
      });
      continue;
    }
    out[key] = completeIntrospection(raw as Record<string, unknown>, sel.selectionSet, ctx, [...path, key], depth + 1);
  }
  return out;
}

// --------------------------------------------------------------------------------
// One operation
// --------------------------------------------------------------------------------

function runOperation(store: Store, op: unknown): Record<string, unknown> {
  if (op === null || typeof op !== 'object' || typeof (op as Record<string, unknown>).query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string.' }] };
  }
  const record = op as Record<string, unknown>;
  const query = record.query as string;
  const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
    ? (record.variables as Record<string, unknown>)
    : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;

  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = operations.find((o) => o.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'Unknown operation named "' + operationName + '".' }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }

  const ctx: Ctx = { store, variables: { ...variables }, fragments, errors: [] };
  // Variable defaults.
  for (const vd of operation.variableDefinitions) {
    if (!(vd.name in ctx.variables) || ctx.variables[vd.name] === undefined) {
      if (vd.defaultValue !== null) ctx.variables[vd.name] = evalValue(vd.defaultValue, ctx);
    }
  }
  const rootType = operation.operationType === 'mutation' ? 'Mutation' : 'Query';
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(rootType, null, operation.selectionSet, ctx, [], 0);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// --------------------------------------------------------------------------------
// HTTP entry point
// --------------------------------------------------------------------------------

export function handleGraphQL(store: Store, body: unknown, authOk: boolean): { status: number; body: unknown } {
  if (!authOk) return { status: 401, body: { message: 'Unauthorized' } };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((op) => runOperation(store, op)) };
  }
  const result = runOperation(store, body);
  // A document that fails to parse at all is a client error; validation
  // failures (unknown field) are 200 with errors, per the wire contract.
  if (result.data === null && Array.isArray(result.errors) && result.errors.length > 0) {
    const msg = String((result.errors[0] as Record<string, unknown>).message ?? '');
    if (msg.startsWith('Expected ') || msg.startsWith('Unexpected ') || msg.startsWith('Unterminated') || msg.startsWith('No operation') || msg.startsWith('Must provide') || msg.startsWith('Unknown operation') || msg.startsWith('GraphQL request')) {
      return { status: 400, body: result };
    }
  }
  return { status: 200, body: result };
}
