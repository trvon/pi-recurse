# pi-recurse usage

## When to use it

Use the RLM tools when the input is larger than what the model should read directly: a whole repository, long logs, many documents, or anything over a few tens of thousands of tokens. For a single file or a short question, plain `read` is simpler and cheaper.

## Patterns

**Map, then reduce.** Load once, split by file or line ranges, ask the same question of each piece with `llm_query_batched`, then aggregate in the script. Return only the aggregate.

**Search first, then read.** `rlm_peek({ handle, grep })` finds candidate locations cheaply; send only the matching files or ranges to `llm_query`.

**Verify.** Ask the worker to quote the lines that support each answer, then check the quotes with `rlm_peek({ grep })` before trusting them.

**Keep state across scripts.** Handles live for the pi process. Codemode's `store(key, value)` / `load(key)` keep JSON (such as handle ids and partial results) between `codemode` calls.

## Limits

- Handles are in memory for the current pi process; reload after a restart.
- Codemode scripts have 256 MB of VM memory: aggregate answers instead of collecting large text.
- `llm_query` refuses prompts over `PI_RECURSE_MAX_PROMPT_CHARS`; split the context.
- `PI_RECURSE_MAX_CALLS` stops runaway loops; the batched tool reports how many calls are left.

## Choosing a worker

Sub-queries are many and small, so prompt processing speed matters more than for chat. A local MoE model with fast prefill is a good worker; the session's own model works too (the default).
