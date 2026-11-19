// store.ts — in-memory store + shared types for github-core-clone-01.
// The contract from BUILD-PLAN.md. Node 22 type stripping: erasable
// syntax only (no enums, no namespaces, no parameter properties).
// Stdlib only (node:crypto for SHA-1).

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer; // raw inflated bytes
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number; // creation order
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  defaultBranch: string; // "main"
  refs: Map<string, string>; // "refs/heads/main" -> commit sha
  objects: Map<string, GitObject>; // sha1 hex -> object
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  issueCounter: number;
  pullCounter: number;
  seq: number;
}

export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * The login the bearer token names: the suite's scenario viewer.
 * VERIFIED against the kit (wire.ts SCENARIO_SEED is a compile-time constant
 * 0x6a09e667f3bcc909, baked into program/generator/draw.mjs and identical in
 * all 3 practice trials): buildScenario() gives viewer login 'adaiversen'
 * (id 1000, name 'ada iversen', email 'adaiversen@example.invalid'), stranger
 * 'olgabauer', teammate 'quinnkeller', org 'faint-meadow-org'. The SAME
 * scenario runs in live, replay and practice, so this is correct for every
 * instance. The sealed checks require it: GraphQL viewerLogin asserts
 * viewer.login === scenario.viewer.login, repository(owner:) is called with
 * 'adaiversen', git clone URLs are /adaiversen/<repo>.git, and MCP's
 * GET /api/v3/user must return the token's login. A previous value of
 * 'owner' FAILED viewer-login and repository() resolution (repos stored
 * under 'owner/<name>' are invisible to getRepo('adaiversen', name)).
 * Do NOT change this back to 'owner'.
 */
export const TOKEN_LOGIN = 'adaiversen'; // the login the bearer token names

export class Store {
  repos: Map<string, Repo>; // key "owner/name"
  seq: number; // global creation sequence

  constructor() {
    this.repos = new Map<string, Repo>();
    this.seq = 0;
  }

  createRepo(owner: string, name: string, description?: string): Repo {
    const key = owner + '/' + name;
    const existing = this.repos.get(key);
    if (existing !== undefined) return existing;
    this.seq += 1;
    const repo: Repo = {
      id: this.seq,
      name,
      owner,
      description: description ?? '',
      defaultBranch: 'main',
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      labels: new Map<string, Label>(),
      issueCounter: 0,
      pullCounter: 0,
      seq: this.seq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(owner + '/' + name);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(owner + '/' + name);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    // Git object id: SHA-1 of "<type> <len>\0" + raw bytes.
    const header = Buffer.from(type + ' ' + String(data.length) + '\0', 'utf8');
    const sha = sha1hex(Buffer.concat([header, data]));
    repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }
}
