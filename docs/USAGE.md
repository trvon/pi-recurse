# Usage

Use the RLM tools for inputs too large to read directly: a repository, long logs, or a document set. For a single file or short question, use `read`.

## Map and reduce

Load once. Split the input by file or line range, then ask the worker the same question about each part. Return the combined answers rather than the source text.

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

A child slice uses a temporary handle, dropped when the call ends. Drop other handles with `rlm_handles({ drop: [id] })` when finished.

## Limits

- Codemode has 256 MB of VM memory. Return summaries rather than accumulated source text.
- `maxLoadBytes` limits each load of paths or literal text, not total handle-store memory.
- `maxPromptChars` limits each worker prompt, including the context wrapper. Split larger inputs.
- `maxCalls` counts worker queries across the tree, including queries made by children. It does not count child-agent model turns.
- `concurrency` limits worker queries, not simultaneous child sessions.
- `maxDepth` limits recursion. A child at that depth has no `rlm_query` tool.
- Children load no other extensions, skills, context files or session file. They have no `bash`, `edit` or `write`. They are read-only, not a filesystem sandbox.
- `childTimeoutMs` starts after SDK session creation. Task cancellation and timeouts reject the call rather than return a partial answer.
- `max_chars` clips file/range peeks, not regex match/context strings. A long matching line can produce a large result. JavaScript regexes run synchronously; avoid patterns with excessive backtracking.

## Worker choice

The default is the current session model. Set `worker` in `pi-recurse.json` for a separate model; set `childModel` to choose a different model for recursive children. Per-call `model` overrides both. See the [configuration reference](../README.md#configuration) for precedence and file locations.

Worker queries often use short prompts, so prompt-processing speed matters. A local MoE with fast prefill is one option. Measure your workload before choosing a model or raising concurrency.
