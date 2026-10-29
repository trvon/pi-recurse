# pi-recurse usage

## When to use it

Use the RLM tools when the input is larger than what the model should read directly: a whole repository, long logs, many documents, or anything over a few tens of thousands of tokens. For a single file or a short question, plain `read` is simpler and cheaper.

## Patterns

**Map, then reduce.** Load once, split by file or line ranges, ask the same question of each piece with `llm_query_batched`, then aggregate in the script. Return only the aggregate.

**Search first, then read.** `rlm_peek({ handle, pattern, files_only: true })` finds candidate locations cheaply; send only the matching files or ranges to `llm_query`.

**Verify.** Ask the worker to quote the lines that support each answer, then check the quotes with `rlm_peek({ handle, pattern })` before trusting them.

**Recurse when a piece needs its own loop.** `llm_query` is one question, one answer. When a part of the problem needs searching and several steps (for example "trace how this subsystem handles errors"), give it to `rlm_query` with that part's handle or slice. The sub-agent explores with the same tools and returns only its answer. It is far slower than `llm_query`, so use it for a few sub-tasks, not for a map over every file.

```js
const repo = await tools.rlm_load({ paths: ["src"] });
const [net, store] = await Promise.all([
  tools.rlm_query({ task: "How are network errors retried? Cite files.", handle: repo.handle }),
  tools.rlm_query({ task: "How is data persisted? Cite files.", handle: repo.handle }),
]);
return { net: net.answer, store: store.answer };
```

**Keep state across scripts.** Handles live for the pi process. Codemode's `store(key, value)` / `load(key)` keep JSON (such as handle ids and partial results) between `codemode` calls.

## Handles

Tools take `handle` as the id string from `rlm_load`. They also accept the whole `rlm_load` result, or text that contains the id. Leave `handle` out to use the most recently loaded handle. Internal slices made for `rlm_query` never become the default.

## Limits

- Handles are in memory for the current pi process; reload after a restart.
- Codemode scripts have 256 MB of VM memory: aggregate answers instead of collecting large text.
- `llm_query` refuses prompts over `maxPromptChars`; split the context.
- `maxCalls` stops runaway loops; the batched tool reports how many calls are left. The budget covers sub-agents too.
- Sub-agents run in-process with no extensions, skills, context files or session file, and without `bash`, `edit` and `write`. Each is stopped after `childTimeoutMs`.
- A slice passed to `rlm_query` becomes a temporary handle that is dropped when the call returns. Drop your own large handles with `rlm_handles({ drop })`.

## Choosing a worker

Sub-queries are many and small, so prompt processing speed matters more than for chat. A local MoE model with fast prefill is a good worker; the session's own model works too (the default).
