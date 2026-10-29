# pi-recurse

Recursive Language Model ([RLM](https://arxiv.org/abs/2512.24601)) tools for [Pi](https://pi.dev)'s `codemode`. Load large inputs by handle, search them, and ask a worker model about selected parts.

## Install

```bash
pi install npm:@trevonistrevon/pi-recurse
```

Enable codemode: add `"+codemode"` to `defaultTools` in `~/.pi/agent/settings.json`.

## Usage

Run in codemode:

```js
const repo = await tools.rlm_load({ paths: ["src"] });
const files = await tools.rlm_peek({ handle: repo.handle, pattern: "TODO", files_only: true });
return files;
```

The input stays in memory, outside the model's context. Scripts read ranges or files, send selected text to a worker model, and combine the answers. Only script output reaches the main model. The worker can be local or use the session's provider.

pi-recurse uses Pi's existing codemode, with no separate REPL or mode. For tasks that need their own search loop, `rlm_query` starts a read-only child session with codemode and the same RLM tools.

See [docs/USAGE.md](docs/USAGE.md) for examples and limits.

## Tools

Tools are codemode-only by default (`exposure: "codemode"`). They return structured values and do not appear in the model's direct tool list.

| Tool | Result |
|---|---|
| `rlm_load({ paths?, text?, exclude? })` | Load paths, globs or literal text. Return `{ handle, files, lines, chars, bytes, skipped }`. Skip dependency directories, build output and binary files when scanning directories. |
| `rlm_peek({ handle?, pattern? \| file? \| lines? \| chars? \| list_files?, ... })` | Search lines, read a file or range, or list files. No selector returns a file list and hint, not the whole input. `max_chars` clips file/range text, not regex matches. `grep`, `regex`, `query` and `search` alias `pattern`. |
| `llm_query({ prompt, handle?, file?, lines?, chars?, text?, system?, model?, max_tokens? })` | Ask the worker about selected text. Return `{ text, model, input_tokens?, output_tokens? }`. |
| `llm_query_batched({ queries: [...] })` | Run worker queries up to `concurrency`. Return ordered results with per-item errors; report progress. |
| `rlm_query({ task, handle?, file?, lines?, chars?, text?, model? })` | Run a child session one level deeper. Return `{ answer, depth, model, handle? }`. Children have no `bash`, `edit` or `write`. Unavailable at `maxDepth`. |
| `rlm_handles({ drop? })` | List handles or drop them to free memory. |

## Configuration

No file is required. Worker queries use the current session model unless overridden.

Files, in load order:

1. `~/.pi/agent/pi-recurse.json`
2. `.pi/pi-recurse.json` in the project, overriding global settings

For a local worker:

```json
{
  "worker": "llamacpp/flint",
  "concurrency": 2
}
```

Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `worker` | session model | Worker as `"provider/model"`. |
| `concurrency` | `2` | Concurrent worker queries across the recursion tree; not child sessions. |
| `maxCalls` | `500` | Worker-query budget per Pi process, including queries made by children; not child-agent model turns. |
| `maxPromptChars` | `200000` | Maximum sub-query length: context, wrapper and prompt. |
| `maxLoadBytes` | `67108864` (64 MiB) | Maximum input bytes per load. |
| `maxLoadFiles` | `5000` | Maximum paths per file load. |
| `exposure` | `"codemode"` | Set `"direct"` to list tools directly to the model too. |
| `steer` | `true` | Add an RLM-use guideline when codemode or the direct RLM tools are active. |
| `maxDepth` | `2` | Maximum recursion depth; `0` disables `rlm_query`. |
| `childModel` | worker, then session model | Child model as `"provider/model"`. |
| `childThinking` | `"low"` | Child thinking level: `off`, `minimal`, `low`, `medium`, `high`. |
| `childTimeoutMs` | `600000` | Child task timeout; starts after SDK session creation. |

Model selection order:

- Worker: per-call `model` → `worker` → current session model.
- Child: per-call `model` → `childModel` → `worker` → current session model.

Models must exist in Pi's registry: built-in providers, `models.json`, or provider extensions. pi-recurse does not download models. Model IDs can contain slashes, such as `openrouter/vendor/model`. Set `worker` or `childModel` to `null` to clear that setting and restore its fallback chain.

Settings come from JSON, not environment variables. `PI_CODING_AGENT_DIR` changes the global file's directory. Invalid values and unknown keys produce a warning and leave the earlier value in place. Run `/recurse` to see effective settings and source files.

Children share the parent's handle store and worker budget. They do not share a child-session concurrency limit. If the worker and main session use one `llama-server`, leave spare slots to reduce contention, for example `-np 4` with `concurrency: 2`.

## Tool-result rewriters

Extensions such as pi-tscg can replace tool-result text and cause Pi to drop `structuredContent`. Scripts then receive text instead of an object. pi-recurse restores the object from `details` in its `tool_result` hook if that hook runs after the rewriter. Install pi-recurse after the rewriter for that order. Extensions loaded with `-e` run first.

Tools also accept text containing a known handle ID and default to the latest handle. To avoid depending on hook order, exclude RLM tools from result rewriting. For pi-tscg, set this in `~/.pi/tscg.json` or `.pi/tscg.json`:

```json
{ "resultExcludeTools": ["edit", "write", "notebook_edit", "notebookedit", "rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query"] }
```

## Development

```bash
npm ci
npm run audit:all && npm run lint && npm run typecheck && npm run test:coverage && npm run build && npm run test:package
npm run bench
```

After building, install a local checkout with `pi install /absolute/path/to/pi-recurse`.

Coverage includes all `src/**/*.ts`. CI requires 95% statements, 90% branches, 95% functions and 95% lines. HTML, JSON and LCOV reports are in `coverage/`. Child lifecycle tests use a mocked SDK; tests make no model requests.

`npm run bench` measures local handle operations. To collect a CPU profile after building:

```bash
node --cpu-prof scripts/benchmark.mjs
```

## License

MIT
