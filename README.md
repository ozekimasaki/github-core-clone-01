# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ozekimasaki/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ozekimasaki/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in TypeScript (Node standard library only, no dependencies, no git binary): git smart HTTP (protocol v2 upload-pack with ls-refs and shallow fetch, v0 receive-pack with report-status over side-band-64k), the REST v3 API (repositories, branches, refs, commits, contents, labels, issues, comments, pull requests and squash merges), GraphQL v4 (the documents gh and github-mcp-server send, cursor pagination, Relay node ids, introspection) and an MCP endpoint (initialize, tools/list, tools/call) — all four surfaces over one in-memory SHA-1 git object store, with a deterministic logical clock so replays are byte-identical.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p1qgasbe&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
