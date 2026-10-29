# pi-recurse development guide

## Purpose

pi-recurse is a Pi extension that adds Recursive Language Model (RLM) tools for Pi's `codemode`: `rlm_load`, `rlm_peek`, `llm_query`, `llm_query_batched`, `rlm_handles`, and the recursive `rlm_query`. Large input is held by handle in the extension; codemode scripts explore it and fan out sub-queries to a worker model.

Stack: strict TypeScript, ES2022, TypeBox, Vitest, and Biome. Targets `@earendil-works/pi-coding-agent` >= 1.4.

## Source map

```text
src/index.ts     extension entry point and public exports
src/config.ts    environment configuration (PI_RECURSE_*)
src/handles.ts   in-memory handle store: load, ranges, grep
src/worker.ts    worker model calls: model resolution, budget, concurrency
src/limiter.ts   FIFO concurrency limiter
src/tools.ts     model-facing tool definitions
src/child.ts     rlm_query sub-agent: in-process SDK session with codemode and the tools one level deeper
```

## Rules

- Tools default to `exposure: "codemode"` and return `structuredContent` matching their `outputSchema`; keep both in sync.
- Never return a whole handle by default: peeks are capped, and sub-query prompts are bounded by `PI_RECURSE_MAX_PROMPT_CHARS`.
- `rlm_query` children share the parent's handle store and worker (budget, concurrency); `runChild` is injected into `registerTools` so tests never start real sessions.
- Children stay read-only (`CHILD_EXCLUDED_TOOLS`) and load no extensions, skills or context files besides codemode and pi-recurse.
- Model calls go through `ctx.modelRegistry` only; no direct HTTP clients or API keys in this package.
- Keep `scripts/package-smoke.mjs` working with both npm <= 11 (array) and npm 12 (object) `npm pack --json` output.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run test:package
```

Commits follow Conventional Commits (release-please builds the changelog).

## Releases

release-please opens a release PR from Conventional Commits on `master`; merging it tags the release and the `npm-publish` job publishes with provenance using the `NPM_TOKEN` repository secret. `release-as: "0.1.0"` in `release-please-config.json` exists only for the first release: remove it once v0.1.0 is out.
