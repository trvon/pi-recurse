# pi-recurse

Recursive Language Model ([RLM](https://arxiv.org/abs/2512.24601)) tools for [Pi](https://pi.dev)'s `codemode`.

Large inputs (a repository, a log, a document set) stay out of the model's context. A codemode script loads them by **handle**, explores them with regex and ranges, and fans out **sub-queries to a worker model**, often a fast local one, then aggregates the answers. Only the script's output reaches the model, which is the core RLM idea, and codemode already provides the REPL.

Other Pi RLM extensions run their own REPL or a separate mode. pi-recurse adds four tools that work inside your normal session, next to every other tool.

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
| `rlm_peek({ handle, list_files? \| file? \| lines? \| chars? \| grep?, ... })` | List files, read one file or a range, or grep with context lines. Output is capped (`max_chars`). |
| `llm_query({ prompt, handle?, file?, lines?, chars?, text?, system?, model?, max_tokens? })` | One sub-query to the worker model about a slice of a handle (or literal text). Returns `{ text, model }`. |
| `llm_query_batched({ queries: [...] })` | Many sub-queries concurrently, bounded by `PI_RECURSE_CONCURRENCY`; returns results in order, with per-item errors. |

A script in the RLM style:

```js
const repo = await tools.rlm_load({ paths: ["src"] });
const { files } = await tools.rlm_peek({ handle: repo.handle, list_files: true });
const answers = await tools.llm_query_batched({
  queries: files.map((f) => ({ prompt: "List every network call in this file, one per line, or NONE.", handle: repo.handle, file: f.path })),
});
return files
  .map((f, i) => [f.path, answers.results[i].text ?? answers.results[i].error])
  .filter(([, a]) => a && !a.includes("NONE"));
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_RECURSE_WORKER` | session model | Worker for sub-queries, `provider/model` (for example `llamacpp/flint`). |
| `PI_RECURSE_CONCURRENCY` | `2` | Sub-queries at once. Match the worker server's slots (`llama-server -np`). |
| `PI_RECURSE_MAX_CALLS` | `500` | Total sub-queries per pi process. |
| `PI_RECURSE_MAX_PROMPT_CHARS` | `200000` | Largest single sub-query (context + prompt). |
| `PI_RECURSE_MAX_LOAD_BYTES` | `64 MiB` | Largest `rlm_load`. |
| `PI_RECURSE_MAX_LOAD_FILES` | `5000` | Most files per `rlm_load`. |
| `PI_RECURSE_EXPOSURE` | `codemode` | `direct` also lists the tools to the model directly. |

With a local `llama-server` worker, run it with at least as many slots as `PI_RECURSE_CONCURRENCY` (`-np 2`), so sub-queries don't evict your main session's prompt cache.

See [docs/USAGE.md](docs/USAGE.md) for patterns and limits.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build && npm run test:package
```

## License

MIT
