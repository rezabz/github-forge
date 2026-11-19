// app.ts — HTTP server wiring for github-core-clone-01 (coordinator-assembled).
// One shared in-memory Store; every surface reads and writes the same store,
// so an object created on one surface reads back identically on the others.
//
// Routes:
//   GET  /healthz                     200 {"ok":true} (the env's boot check)
//   /api/v3/*                         handleRest (REST v3; full path, query, headers, body text)
//   POST /api/graphql                handleGraphQL (parsed JSON body + authOk)
//   /mcp                             handleMcp (method, headers, body text)
//   /{owner}/{repo}.git/*            handleGitRequest (owner, repo, subpath incl. ?service=, body Buffer)
//   anything else                    JSON 404 {"message":"Not Found"}
//
// Auth: the suite presents one bearer token (MAKEFUN_SHOP_TOKEN). REST verifies
// the token value itself (handleRest, expectedToken param -> env -> any
// non-empty Bearer fallback). GraphQL gets authOk computed here by the same
// rule. MCP verifies a non-empty Bearer itself (handleMcp). Git does not
// authenticate (the sealed git suite never tests it; handleGitRequest takes
// no token) — the git client always sends the token anyway.
//
// Body handling: the whole request body is buffered first. REST/GraphQL/MCP
// get it as UTF-8 text; git gets the raw Buffer (packs are binary). A 202
// from MCP (body '') is sent as an empty body with content-length 0, never
// JSON.stringify(''). A null REST body (204) is likewise sent empty.
// The dispatch never throws: any unexpected error becomes a 500 JSON so the
// server stays up through the whole trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitRequest } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite presents, or '' when the trial did not set one. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** GraphQL's authOk by the same rule REST uses: the Bearer must equal the configured token when one is set, else any non-empty Bearer. */
function graphqlAuthOk(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (auth === undefined) return false;
  const m = /^Bearer (.+)$/.exec(auth.trim());
  if (m === null) return false;
  const presented = m[1] as string;
  if (EXPECTED_TOKEN === '') return presented.length > 0;
  return presented === EXPECTED_TOKEN;
}

/** Answer with a JSON body (object/array/primitive), plus extra headers. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with an empty body (204 / MCP 202), plus extra headers. */
function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { ...headers, 'content-length': '0' });
  res.end();
}

/** The request target as a URL, or null when it does not parse (never throws). */
function urlOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return null;
  }
}

/** /{owner}/{repo}.git/<subpath...> — the subpath keeps its query string (?service=...). */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const bodyText = body.toString('utf8');
        const url = urlOf(req);
        const path = url !== null ? url.pathname : '/';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3: everything under /api/v3 (root included — handleRest answers it).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const query = url !== null ? url.searchParams : new URLSearchParams();
          const result = handleRest(store, method, path, query, req.headers, bodyText, EXPECTED_TOKEN === '' ? undefined : EXPECTED_TOKEN);
          if (result.body === null) {
            sendEmpty(res, result.status, result.headers);
          } else {
            sendJson(res, result.status, result.body, result.headers);
          }
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            parsed = null; // runOperation answers "must include a query string" for a non-object
          }
          const result = handleGraphQL(store, parsed, graphqlAuthOk(req));
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP (streamable HTTP).
        if (path === '/mcp') {
          const result = handleMcp(store, method, req.headers, bodyText);
          if (result.body === '') {
            sendEmpty(res, result.status, result.headers);
          } else {
            sendJson(res, result.status, result.body, result.headers);
          }
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
        const rawTarget = req.url ?? '/';
        const gitMatch = GIT_PATH.exec(rawTarget);
        if (gitMatch !== null) {
          const result = handleGitRequest(store, gitMatch[1] as string, gitMatch[2] as string, method, gitMatch[3] as string, req.headers, body);
          const headers = { ...result.headers, 'content-length': String(result.body.length) };
          res.writeHead(result.status, headers);
          res.end(result.body);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the server: answer 500 JSON and stay up.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } else {
          res.end();
        }
      }
    });
  });
}
