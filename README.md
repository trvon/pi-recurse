# pi-recurse

Recursive Language Model ([RLM](https://arxiv.org/abs/2512.24601)) tools for [Pi](https://pi.dev)'s `codemode`.

Large inputs (a repository, a log, a document set) stay out of the model's context. A codemode script loads them by **handle**, explores them with regex and ranges, and fans out **sub-queries to a worker model**, often a fast local one, then aggregates the answers. Only the script's output reaches the model, which is the core RLM idea, and codemode already provides the REPL.

Other Pi RLM extensions run their own REPL or a separate mode. pi-recurse adds tools that work inside your normal session, next to every other tool, including true recursion: `rlm_query` hands a sub-task to a sub-agent that has codemode and the same tools.

## Install

```bash
pi install npm:@trevonistrevon/pi-recurse
```

Turn on codemode if it isn't already: add `"+codemode"` to `defaultTools` in `~/.pi/agent/settings.json`.

## Tools

By default the tools are exposed **only to codemode scripts** (`exposure: "codemode"`), so they don't add to the model's direct tool list. All return structured values to scripts.

| Tool | What it does |
|---|---|
| `rlm_load({ paths?, text?, exclude? })` | Load files, directories, globs or literal text into memory; returns `{ handle, files, lines, chars, bytes, skipped }`. Skips `node_modules`, `.git`, build output and binary files. |
| `rlm_peek({ handle, pattern? \| file? \| lines? \| chars? \| list_files?, ... })` | Regex search per line (with `context`, or `files_only` for paths), read one file or a range, or list files. With no selector it returns the file list and a hint, never the whole handle. Output is capped (`max_chars`). `grep`, `regex`, `query` and `search` are accepted as aliases for `pattern`. |
| `llm_query({ prompt, handle?, file?, lines?, chars?, text?, system?, model?, max_tokens? })` | One sub-query to the worker model about a slice of a handle (or literal text). Returns `{ text, model }`. |
| `llm_query_batched({ queries: [...] })` | Many sub-queries concurrently, bounded by `concurrency`; returns results in order, with per-item errors, and reports progress. |
| `rlm_query({ task, handle?, file?, lines?, chars?, text?, model? })` | Recursive call: runs `task` in a fresh in-process sub-agent session with codemode and these tools (one level deeper), on the handle or slice. Returns `{ answer, depth, model }`. Sub-agents are read-only (no `bash`, `edit`, `write`). Not registered at `maxDepth`. |
| `rlm_handles({ drop? })` | List loaded handles, or drop ones you no longer need. |


## Configuration

Settings come from JSON files, with defaults that work without any file: sub-queries use the session's model.

- `~/.pi/agent/pi-recurse.json`: your defaults.
- `.pi/pi-recurse.json` in a project: overrides the global file for that project.

Every key is optional. A typical local setup:

```json
{
  "worker": "llamacpp/flint",
  "concurrency": 2
}
```

| Key | Default | Meaning |
|---|---|---|
| `worker` | session model | Worker for sub-queries, `"provider/model"` (for example `"llamacpp/flint"`). |
| `concurrency` | `2` | Sub-queries at once. Keep it below the worker server's slots (`llama-server -np`). |
| `maxCalls` | `500` | Total sub-queries per pi process, including sub-agents. |
| `maxPromptChars` | `200000` | Largest single sub-query (context + prompt). |
| `maxLoadBytes` | `67108864` (64 MiB) | Largest `rlm_load`. |
| `maxLoadFiles` | `5000` | Most files per `rlm_load`. |
| `exposure` | `"codemode"` | `"direct"` also lists the tools to the model directly. |
| `maxDepth` | `2` | Deepest `rlm_query` nesting; `0` turns recursion off. |
| `childModel` | worker, then session model | Model for `rlm_query` sub-agents, `"provider/model"`. |
| `childThinking` | `"low"` | Thinking level for sub-agents (`off`, `minimal`, `low`, `medium`, `high`). |
| `childTimeoutMs` | `600000` | Wall-clock limit per sub-agent. |

Invalid values and unknown keys are skipped with a warning at session start. `/recurse` shows the settings in effect and which files they came from.

With a local `llama-server` worker, give it more slots than `concurrency` (for example `-np 4` with `concurrency: 2`), so sub-queries don't evict your main session's prompt cache. Sub-agents and their sub-queries share the same handle store, call budget and concurrency limit as the top-level session.

See [docs/USAGE.md](docs/USAGE.md) for patterns and limits.

## Compatibility with tool-result rewriters

Extensions that rewrite every tool result's text (for example pi-tscg's result compression) make pi drop the result's `structuredContent`, so a codemode script would get text instead of `{ handle, ... }`. pi-recurse puts the structured value back from `details` in its own `tool_result` hook. That works when its hook runs after the rewriter's, which is the case when pi-recurse is installed after the rewriter. Extensions loaded with `-e` run first, so there the hook can't help. Scripts still mostly work: tools also accept text that contains a handle id, and default to the latest handle. To be safe regardless of order, exclude the RLM tools from the rewriter, for pi-tscg in `~/.pi/tscg.json` (or a project's `.pi/tscg.json`):

```json
{ "resultExcludeTools": ["edit", "write", "notebook_edit", "notebookedit", "rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query"] }
```

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build && npm run test:package
```

## License

MIT
