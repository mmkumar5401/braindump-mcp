# braindump

Persistent memory for AI coding agents, served over [MCP](https://modelcontextprotocol.io).

Agents forget what they learned about a codebase when a session ends. braindump gives them a
place to write it down — free-form notes, the code symbols they've looked at, and typed links
between the two — in a local graph database that survives across sessions, repos and agents.
Nothing is pre-indexed: the graph grows as agents work.

## Features

- **Graph memory** — `Note`s (learnings, gotchas, decisions, …), code `Entity`s
  (function/class/module, …) and free-form typed `Link`s between any two nodes
  (`CALLS`, `documents`, `caused-by`, …), stored in an embedded Ladybug graph DB.
- **Hybrid search** — BM25 (camelCase-aware) + substring + local semantic embeddings
  (`bge-small-en-v1.5`), fused with reciprocal rank fusion and re-ranked by a cross-encoder
  (`mxbai-rerank-xsmall-v1`). Runs fully offline on CPU; falls back to keyword search if the
  models are unavailable.
- **Staleness checks** — every entity is tagged with the git commit it was described at;
  `check_stale` flags descriptions whose file has changed or been deleted since.
- **Graph traversal** — walk 1–3 hops from any node to answer "what calls X" or "what documents X".
- **Safe under concurrency** — per-project write queue, lock-wait retries across processes, and
  all-or-nothing multi-statement writes and imports.
- **Export / import** — the whole graph as JSON for backup or transfer.

## Install

Developed on Node.js 22.

```bash
git clone https://github.com/mmkumar5401/braindump-mcp.git
cd braindump-mcp
npm install
npm link        # puts `braindump` on your PATH
```

The embedding and re-ranking models (~80 MB) download on first search and are cached in
`~/.agents/braindump/.models`.

## Use with an MCP client

Register the stdio server, e.g. in Claude Code:

```bash
claude mcp add braindump -- braindump mcp
```

Or in any client's JSON config:

```json
{
  "mcpServers": {
    "braindump": { "command": "braindump", "args": ["mcp"] }
  }
}
```

The project is auto-detected from the working directory (the git repo root's folder name);
every tool also accepts an explicit `project`.

### Tools

| Tool | Purpose |
|---|---|
| `init` | Create the project's database (idempotent) |
| `add_note`, `modify_note`, `delete_note` | Manage free-form notes |
| `add_entity`, `modify_entity`, `delete_entity` | Manage code entities (upserted by `file::name`) |
| `add_link`, `modify_link`, `delete_link` | Manage typed links between notes and entities |
| `search` | Hybrid / keyword / semantic search |
| `grep` | Regex search over node fields |
| `neighbors` | Walk the graph around a node |
| `list` | Page through nodes with filters |
| `check_stale` | Find entities whose file changed since they were described |
| `export`, `import` | JSON backup and merge |

## CLI

Every MCP tool has a CLI equivalent:

```bash
braindump add "Ladybug rejects CONTAINS with an empty string" --kind gotcha --tags ladybug,search
braindump entity add --name openBraindump --file src/db.js --kind function \
  --description "Opens the per-project graph DB, waiting on another process's lock"
braindump search "database lock"
braindump neighbors "src/db.js::openBraindump" --depth 2
braindump stale
braindump export
```

Run `braindump --help` or `braindump <command> --help` for all options.

## Storage

One database per project at `~/.agents/braindump/<project>/graph.lbdb`.
Set `BRAINDUMP_MODELS=off` to skip the models entirely (keyword search only).

## Development

```bash
npm test                          # vitest
BRAINDUMP_MODELS=off npm test     # skip model downloads
```

## License

MIT
