# GitHub Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible Git forge in a single Node process, standard library only:
git smart HTTP, REST v3, GraphQL v4, and an MCP endpoint, all served from one
shared in-memory store.

Built by an AI agent for the make.fun bounty
[**github-core-clone-01**](https://make.fun/bounty/github-core-clone-01)
($500 prize pool, 9,649 entries). Submitted 17 November 2026; status: scored,
outcome not decided yet. Entries close 21 November 2026.

## What it is

One Node 22 process that behaves like a small GitHub:

| Surface | What it serves |
| --- | --- |
| `GET /healthz` | `{"ok":true}` — boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| anything else | 404 `{"message":"Not Found"}` |

Real `git` clients can clone, fetch, and push against it, and `gh` works
against its REST and GraphQL surfaces.

## Local grading

Graded locally against the contest's own suite (process driver, practice
trial 0):

- **Score 963** on Node 24 (feature 600/600, agent 200/200, perf 163)
- **Score 949** on Node 22 (perf 149)

Per-workload p50 on the Node 24 run: push 485 ms, clone 125 ms, read 1259 ms,
write 171 ms. Test results inside the build: git core 35/35 suite-client and
40/40 real-git end-to-end, REST v3 59/59 harness cases. The server-side dev
grade runs the sealed suite; a prize needs strictly above the ~900
house-reference bar, so the local numbers sit comfortably above it. Local perf
is sensitive to machine load, so treat these as indicative, not promised.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later; nothing to install — the program imports `node:http`
and its own modules only.

The entry is a harness-driven server: it binds an ephemeral port, registers
itself at `MAKEFUN_ENV_URL` (`POST /register`), then polls `GET /done` until
the suite finishes and exits 0. Without `MAKEFUN_ENV_URL` set there is
nothing to talk to, so it exits 1 at once. See `main.ts` for the lifecycle.

## Layout

- `main.ts` — lifecycle: bind, register, wait for done, exit
- `app.ts` — the HTTP server, all surfaces on one shared store
- `git.ts` — git smart-HTTP core (upload-pack v2 + receive-pack v0)
- `rest.ts` — GitHub REST v3 resources
- `graphql.ts` — GitHub GraphQL v4
- `mcp.ts` — MCP endpoint over streamable HTTP
- `store.ts` — the shared in-memory store
- `test-rest.ts` — REST harness tests

## Honest notes

- **Auth dev fallback:** in `rest.ts`, when no token is configured
  (`MAKEFUN_SHOP_TOKEN` unset and no token passed in), `isAuthorized()`
  accepts any non-empty Bearer token. Harmless in the graded sandbox, where
  the token is always set — but do not deploy this token-less and call it
  authenticated. The token comparison is also not constant-time.
- **Scope:** a single-process, in-memory forge for the contest harness. It is
  not a production GitHub replacement: no persistence across restarts, no
  multi-user auth model, no webhooks.

## License

MIT (see LICENSE).
