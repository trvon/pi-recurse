# Usage

Use the RLM tools for inputs too large to read directly: a repository, long logs, or a document set. For a single file or short question, use `read`.

## Select before delegating

Use direct reads for a small candidate set. For large input, load once and search with `rlm_peek`. Prefer **one combined `llm_query`** when selected text fits `maxPromptChars`; the number of files alone does not justify fan-out. Build combined context from selected file/range peeks, or query the whole handle if it fits. A regex search can often answer an extraction task without any worker call.

## Map and reduce

Batch genuinely independent shards, or input too large for one prompt. Return combined findings rather than source text, and inspect completion status before treating a result as evidence.

```js
const input = await tools.rlm_load({ paths: ["src"] });
const files = await tools.rlm_peek({ handle: input.handle, list_files: true });
const { results } = await tools.llm_query_batched({
  queries: files.files.map(({ path }) => ({
    handle: input.handle,
    file: path,
    prompt: "List TODO comments. Quote each comment and name its file.",
  })),
});
const incomplete = results.filter(r => r.error || r.truncated || r.empty);
if (incomplete.length) return { incomplete }; // report or revise explicitly; do not silently treat as no matches
store("todo-results", results); // reusable across scripts without another model call
return results;
```

A batch accepts at most 256 queries. Split larger file lists into batches. Worker calls obey the shared `concurrency` and `maxCalls` settings.

## Search before querying

Find candidate files with `rlm_peek({ handle, pattern, files_only: true })`. Send only those files or selected ranges to `llm_query`. Path-only searches stop at the first matching line in each file.

Ask the worker to quote evidence. Check the quotes against the input with `rlm_peek` before relying on an answer.

## Recursion

Use `llm_query` for one model call. Use `rlm_query` when a sub-task needs its own search loop, such as tracing error handling across files. Each child runs an in-process Pi session with codemode and the RLM tools one level deeper.

```js
const repo = await tools.rlm_load({ paths: ["src"] });
const [network, storage] = await Promise.all([
  tools.rlm_query({ task: "How are network errors retried? Cite files.", handle: repo.handle }),
  tools.rlm_query({ task: "How is data persisted? Cite files.", handle: repo.handle }),
]);
return { network: network.answer, storage: storage.answer };
```

Child sessions take more time and model calls than a single worker query. Use them for selected sub-tasks, not a query over every file.

## Handles

Pass the ID from `rlm_load` as `handle`. Tools also accept the load result object or text containing exactly one known handle ID. Omit `handle` to use the most recently loaded user handle. Internal child slices do not replace that default.

Handles last for the Pi process. Codemode's `store(key, value)` and `load(key)` keep JSON values, such as handle IDs and partial results, across scripts. After a restart, reload the input even if an old ID remains in codemode's store.

A child sees only its assigned input and its own allocations. Omitting `handle` inside a child uses its latest explicit load, otherwise its assigned input, never an unrelated parent/sibling handle. Borrowed input cannot be dropped. A slice uses a temporary handle, dropped when the call ends and **not returned** as a reusable ID. Child-created handles are also cleaned up on exit. Drop root handles with `rlm_handles({ drop: [id] })` when finished.

Worker answers can stay in codemode `store`/`load`; for searchable aggregates explicitly use `rlm_load({ text: answer })`. Answers are not automatically stored as handles.

## Limits

- Codemode has 256 MB of VM memory. Return summaries rather than accumulated source text.
- `maxLoadBytes` limits each load of paths or literal text, not total handle-store memory.
- `maxPromptChars` limits each worker prompt, including the context wrapper. Split larger inputs.
- `maxCalls` counts worker queries across the tree, including queries made by children. It does not count child-agent model turns.
- `concurrency` limits worker queries. Queued requests cancelled before provider invocation do not consume `maxCalls`.
- `childConcurrency` limits child sessions per depth (default `1`). Separate depth pools allow parents to await descendants without deadlock.
- `childMaxTurns` limits assistant turns in each child (default `8`).
- `maxDepth` limits recursion. A child at that depth has no `rlm_query` tool.
- Children load no other extensions, skills, context files or session file. They have no `bash`, `edit` or `write`. They are read-only, not a filesystem sandbox.
- `childTimeoutMs` starts when a child acquires its slot, before SDK initialization. Cancellation, turn limits and timeouts reject rather than return a partial answer. Late-created sessions are disposed too.
- `workerMaxTokens` caps output including reasoning (default `512`); per-call `max_tokens` wins. `workerThinking` defaults to `off` and `workerTemperature` to `0`. Pi maps reasoning controls where the selected model/provider supports them. Inspect `stop_reason`, `truncated`, `empty`, usage and `duration_ms` on both single and batch results. Empty length-limited results include `error`. Partial answers are still truncated, not complete. No automatic retries.
- Give only one context selector: `file`, `lines`, `chars`, or `text`. `text` cannot be combined with `handle`. File suffixes must be unique; use exact paths for duplicate basenames.
- `max_chars` clips file/range peeks, not regex match/context strings. A long matching line can produce a large result. JavaScript regexes run synchronously; avoid patterns with excessive backtracking.

## Worker choice

The default is the current session model. Set `worker` in `pi-recurse.json` for a separate model; set `childModel` to choose a different model for recursive children. Per-call `model` overrides both. See the [configuration reference](../README.md#configuration) for precedence and file locations.

Measure both prefill and generation. A short final answer can still consume thousands of hidden reasoning tokens, so shrinking input or increasing concurrency may not reduce latency. Worker defaults favor short extraction; explicitly increase `workerThinking`/`workerMaxTokens` for harder tasks. `duration_ms` includes queue wait. If your model ignores reasoning controls, the token cap still bounds generation and status exposes incomplete results. Disabling reasoning-effort support in a provider entry can prevent `workerThinking` from taking effect. Reasoning-only models may not support an off mode at all. For low-latency extraction, select a worker with a verified non-reasoning mode; raising the token cap alone can merely restore long waits. Ask for `NONE` explicitly for no matches instead of interpreting empty text as success.
