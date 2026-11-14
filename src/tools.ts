import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildRequest, ChildResult } from "./child.js";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import type { JobStore } from "./jobs.js";
import { type ModelRuntime, type QueryInput, type QueryResult, type Worker, workerRuntime } from "./worker.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function ok(value: Json, summary: string) {
  return { content: [{ type: "text" as const, text: summary }], details: value, structuredContent: value };
}

const ContextRef = {
  handle: Type.Optional(Type.String({ description: "Handle from rlm_load whose text becomes the context. With file/lines/chars and no handle: the most recently loaded handle." })),
  file: Type.Optional(Type.String({ description: "Only this loaded file of the handle (exact or path suffix)." })),
  lines: Type.Optional(
    Type.Object({ start: Type.Integer({ minimum: 1 }), count: Type.Integer({ minimum: 1 }) }, { description: "Only these lines of the handle text (1-based)." }),
  ),
  chars: Type.Optional(
    Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, { description: "Only this character range of the handle text." }),
  ),
};

const BACKGROUND_DOC =
  "Start in the background and return { job } at once instead of waiting; collect the answer later with rlm_wait. " +
  "Use when the worker is slow (a local model) and there is other work to do meanwhile.";

const QueryParams = Type.Object({
  prompt: Type.String({ description: "Question or instruction for the worker model." }),
  ...ContextRef,
  text: Type.Optional(Type.String({ description: "Literal context text, instead of a handle." })),
  system: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: 'Override the worker model, "provider/model".' })),
  max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  background: Type.Optional(Type.Boolean({ description: BACKGROUND_DOC })),
});
type QueryParamsT = Static<typeof QueryParams>;

/** What a call with `background: true` returns. */
const JobStarted = Type.Object({ job: Type.String(), status: Type.Literal("running"), model: Type.String() });

const JobViewOutput = Type.Object({
  job: Type.String(), kind: Type.String(), label: Type.String(), status: Type.String(), elapsed_ms: Type.Number(),
  result: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()),
});

const QueryFields = {
  text: Type.String(), model: Type.String(), input_tokens: Type.Optional(Type.Number()), output_tokens: Type.Optional(Type.Number()),
  stop_reason: Type.String(), truncated: Type.Boolean(), empty: Type.Boolean(), duration_ms: Type.Number(), error: Type.Optional(Type.String()),
};
const QueryOutput = Type.Object(QueryFields);

function queryResult(r: QueryResult): { [key: string]: Json } {
  const result: { [key: string]: Json } = {
    text: r.text, model: r.model, stop_reason: r.stopReason, truncated: r.truncated, empty: r.empty, duration_ms: r.durationMs,
  };
  if (r.inputTokens !== undefined) result.input_tokens = r.inputTokens;
  if (r.outputTokens !== undefined) result.output_tokens = r.outputTokens;
  if (r.empty && r.truncated) result.error = "Worker exhausted its output budget without an answer; reduce thinking or explicitly raise max_tokens. No automatic retry.";
  return result;
}

const HandleSummaryOutput = Type.Object({
  handle: Type.String(), label: Type.String(), chars: Type.Number(), bytes: Type.Number(), lines: Type.Number(), files: Type.Number(),
});
const FileOutput = Type.Object({ path: Type.String(), lines: Type.Number(), chars: Type.Number() });
const PeekOutput = Type.Union([
  Type.Object({ files: Type.Array(Type.String()) }),
  Type.Object({ files: Type.Array(FileOutput) }),
  Type.Object({ files: Type.Array(FileOutput), total_files: Type.Number(), chars: Type.Number(), hint: Type.String() }),
  Type.Object({ text: Type.String(), chars: Type.Number() }),
  Type.Object({ matches: Type.Array(Type.Object({ file: Type.Optional(Type.String()), line: Type.Number(), text: Type.String(), before: Type.Array(Type.String()), after: Type.Array(Type.String()) })) }),
]);

function exclusiveSelectors(p: Record<string, unknown>, keys: string[]): void {
  if (keys.filter((key) => p[key] !== undefined && p[key] !== false).length > 1) throw new Error(`give only one of: ${keys.join(", ")}`);
}

function validateContext(p: { text?: string; handle?: string; file?: string; lines?: unknown; chars?: unknown }): void {
  exclusiveSelectors(p, ["text", "file", "lines", "chars"]);
  if (p.text !== undefined && p.handle !== undefined) throw new Error("text cannot be combined with handle");
}

const HANDLE_DOC = "Handle from rlm_load. Defaults to the most recently loaded handle.";

const PeekParams = Type.Object({
  handle: Type.Optional(Type.String({ description: HANDLE_DOC })),
  pattern: Type.Optional(Type.String({ description: "JavaScript regular expression, matched per line. Aliases: grep, regex, query." })),
  files_only: Type.Optional(Type.Boolean({ description: "With pattern: return only the distinct matching file paths." })),
  flags: Type.Optional(Type.String({ description: "Regex flags such as i." })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Lines of context around each match." })),
  max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  file: Type.Optional(Type.String({ description: "Read one loaded file (exact path or path suffix)." })),
  lines: Type.Optional(Type.Object({ start: Type.Integer({ minimum: 1 }), count: Type.Integer({ minimum: 1 }) })),
  chars: Type.Optional(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) })),
  list_files: Type.Optional(Type.Boolean()),
  max_chars: Type.Optional(Type.Integer({ minimum: 100, description: "Cap on returned text (default 20000)." })),
});

/** Scripts sometimes pass a whole rlm_load result as `handle`: keep only its id. */
function normalizeHandle(a: Record<string, unknown>): Record<string, unknown> {
  const h = a.handle;
  if (h && typeof h === "object" && typeof (h as { handle?: unknown }).handle === "string") a.handle = (h as { handle: string }).handle;
  return a;
}

/** Argument preparation precedes Pi's schema validation; invalid inputs must remain invalid. */
export function prepareQueryItem(args: unknown): Record<string, unknown> {
  return (args && typeof args === "object" ? normalizeHandle({ ...(args as Record<string, unknown>) }) : args) as Record<string, unknown>;
}

/** Map the names models tend to use for the search pattern onto `pattern`. */
export function preparePeekArguments(args: unknown): Static<typeof PeekParams> {
  if (!args || typeof args !== "object") return args as Static<typeof PeekParams>;
  const a = normalizeHandle({ ...(args as Record<string, unknown>) });
  for (const alias of ["grep", "regex", "query", "search"]) {
    if (a.pattern === undefined && typeof a[alias] === "string") a.pattern = a[alias];
    delete a[alias];
  }
  return a as Static<typeof PeekParams>;
}

/** rlm_query takes `task`; models often pass `prompt` (as for llm_query) or `question`. */
export function prepareQueryArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return args as Record<string, unknown>;
  const a = normalizeHandle({ ...(args as Record<string, unknown>) });
  for (const alias of ["prompt", "question", "query"]) {
    if (a.task === undefined && typeof a[alias] === "string") a.task = a[alias];
    delete a[alias];
  }
  return a;
}

/** Main system prompt guideline, by how the tools are reached. */
export function steeringGuideline(exposure: "codemode" | "direct"): string {
  const t = exposure === "codemode" ? "tools." : "";
  const via = exposure === "codemode" ? "write a codemode script that uses " : "use ";
  return (
    "For one known file, a small candidate set or a quick grep, use read or grep directly. For large input, " +
    `${via}${t}rlm_load to hold text by handle and ${t}rlm_peek to select relevant slices. Prefer one combined ${t}llm_query ` +
    `when the selected text fits the prompt budget; use ${t}llm_query_batched only for genuinely independent shards or oversized input, ` +
    `not automatically per file. Reserve ${t}rlm_query for a branch needing its own multi-step search loop. ` +
    "Check truncated/empty/error fields before using answers. Return only aggregated findings with file paths."
  );
}

/** Script-side recipe, shown with rlm_load in codemode's tool listing. */
export const LOAD_GUIDELINES = [
  'Typical flow: const h = await tools.rlm_load({ paths: ["src"] }); const { files } = await tools.rlm_peek({ handle: h.handle, pattern, files_only: true }); ' +
    "select relevant text and prefer one combined llm_query if it fits. Only for independent shards or oversized input: " +
    "await tools.llm_query_batched({ queries: files.map(file => ({ prompt, handle: h.handle, file })) }); check error/truncated/empty before aggregating.",
  "Keep script output small. Use codemode store/load to retain JSON results across scripts; optionally rlm_load({ text: answer }) for searchable answer handles. Do not re-query already computed answers.",
];

/** Names of the tools this package registers; used to restore their structured results. */
export const TOOL_NAMES = new Set(["rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query", "rlm_wait", "rlm_jobs"]);

/**
 * Tool-result rewriters (for example pi-tscg's result compression) replace the text content of
 * every result. Pi then drops `structuredContent`, so codemode scripts would receive the text
 * instead of the value. Every result here also carries the value in `details`, which rewriters
 * leave alone: put it back. This runs for hooks registered before this one.
 */
export function restoreStructuredResults(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (!TOOL_NAMES.has(event.toolName) || event.isError) return undefined;
    const e = event as typeof event & { structuredContent?: unknown };
    if (e.structuredContent !== undefined || e.details === undefined || e.details === null) return undefined;
    return { structuredContent: e.details as Json };
  });
}

export function contextFor(store: HandleStore, p: QueryParamsT): string | undefined {
  validateContext(p);
  if (p.text !== undefined) return p.text;
  if (!p.handle && !p.file && !p.lines && !p.chars) return undefined;
  const id = store.resolve(p.handle);
  if (p.file) return store.fileText(id, p.file).text;
  if (p.lines) return store.lineRange(id, p.lines.start, p.lines.count);
  if (p.chars) return store.charRange(id, p.chars.start, p.chars.end);
  return store.get(id).text;
}

function toInput(store: HandleStore, p: QueryParamsT): QueryInput {
  return { prompt: p.prompt, context: contextFor(store, p), system: p.system, model: p.model, maxTokens: p.max_tokens };
}

export interface ToolDeps {
  store: HandleStore;
  worker: Worker;
  /** Background jobs of the session these tools belong to. */
  jobs: JobStore;
  config: RecurseConfig;
  /** Recursion depth of the session these tools belong to: 0 for the top-level session. */
  depth: number;
  /** Runs an rlm_query child; injected so tests do not start real sessions. */
  runChild: (req: ChildRequest) => Promise<ChildResult>;
}

/** A short job label from a prompt or task. */
function labelOf(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

async function runBatch(
  worker: Worker, runtime: ModelRuntime, sessionModel: unknown, store: HandleStore, queries: QueryParamsT[], signal: AbortSignal | undefined,
  progress: (done: number, total: number) => void,
): Promise<{ [key: string]: Json }[]> {
  let done = 0;
  return Promise.all(
    queries.map(async (q): Promise<{ [key: string]: Json }> => {
      let r: { [key: string]: Json };
      try {
        r = queryResult(await worker.query(runtime, sessionModel, toInput(store, q), signal));
      } catch (e) {
        r = { error: errorText(e) };
      }
      progress(++done, queries.length);
      return r;
    }),
  );
}

/**
 * Before the agent finishes a run, remind it once of background jobs it has not collected:
 * their answers would otherwise be lost (and running ones keep using the worker).
 */
export function registerJobReminder(pi: ExtensionAPI, jobs: JobStore, wait = "tools.rlm_wait"): void {
  let reminded = false;
  pi.on("agent_start", () => {
    reminded = false;
  });
  pi.on("agent_before_settle", () => {
    if (reminded || jobs.size === 0) return undefined;
    reminded = true;
    const views = jobs.list();
    const running = views.filter((v) => v.status === "running").length;
    const list = views.map((v) => `${v.job} (${v.kind}, ${v.status}): ${v.label}`).join("\n");
    return {
      entries: [{
        type: "custom_message" as const, customType: "pi-recurse-jobs", display: false,
        content: `pi-recurse: ${views.length} background job${views.length > 1 ? "s are" : " is"} not collected (${running} still running):\n${list}\n` +
          `Collect them with ${wait} before answering, or cancel the ones you no longer need with rlm_jobs({ cancel: [...] }).`,
      }],
      continue: true,
    };
  });
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  const { store, worker, config, jobs } = deps;
  const exposure = config.exposure;
  const started = (job: string, model: string) => ok({ job, status: "running", model }, `started background job ${job} (${model}); collect it with rlm_wait`);

  pi.registerTool({
    name: "rlm_load",
    label: "rlm_load",
    exposure,
    promptGuidelines: LOAD_GUIDELINES,
    description:
      "Load large input (files, directories, globs, or literal text) into memory and return a handle plus size stats. The content is not returned: explore it with rlm_peek and hand slices to llm_query. Use for inputs too large to read directly.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { description: "Files, directories or glob patterns, relative to the working directory." })),
      text: Type.Optional(Type.String({ description: "Literal text to load instead of files." })),
      exclude: Type.Optional(Type.Array(Type.String(), { description: "Extra glob patterns to skip." })),
    }),
    outputSchema: Type.Object({
      handle: Type.String(),
      label: Type.String(),
      chars: Type.Number(),
      bytes: Type.Number(),
      lines: Type.Number(),
      files: Type.Number(),
      skipped: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      exclusiveSelectors(params, ["text", "paths"]);
      if (params.text === undefined && !params.paths?.length) throw new Error("give paths or text");
      if (params.text !== undefined && Buffer.byteLength(params.text) > config.maxLoadBytes) {
        throw new Error(`input exceeds ${config.maxLoadBytes} bytes. Raise maxLoadBytes in pi-recurse.json.`);
      }
      const s =
        params.text !== undefined
          ? store.loadText(params.text)
          : await store.loadFiles(params.paths ?? [], { cwd: ctx.cwd, maxBytes: config.maxLoadBytes, maxFiles: config.maxLoadFiles, exclude: params.exclude });
      return ok({ ...s }, `handle ${s.handle}: ${s.files} files, ${s.lines} lines, ${s.chars} chars${s.skipped.length ? `, ${s.skipped.length} binary skipped` : ""}`);
    },
  });

  pi.registerTool({
    name: "rlm_peek",
    label: "rlm_peek",
    exposure,
    description:
      "Look at part of a loaded handle without reading all of it. Give exactly one of: `pattern` (regex search, per line; add `files_only: true` for just the matching file paths), `file` (one loaded file), `lines`, `chars`, or `list_files: true`. With none, returns the file list and these options. `handle` defaults to the most recently loaded one. Keep results small; summarize big parts with llm_query.",
    parameters: PeekParams,
    outputSchema: PeekOutput,
    prepareArguments: preparePeekArguments,
    async execute(_id, p) {
      exclusiveSelectors(p, ["pattern", "file", "lines", "chars", "list_files"]);
      if (p.files_only && p.pattern === undefined) throw new Error("files_only requires pattern");
      const cap = p.max_chars ?? 20000;
      const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)}\n... [${s.length - cap} more chars]` : s);
      const id = store.resolve(p.handle);
      const h = store.get(id);
      const fileList = () => h.files.map((f) => ({ path: f.path, lines: f.lines, chars: f.end - f.start }));
      if (p.pattern !== undefined) {
        if (p.files_only) {
          const files = store.matchingFiles(id, p.pattern, p.flags);
          return ok({ files }, files.length ? files.join("\n") : "no matching files");
        }
        const matches = store.grep(id, p.pattern, { flags: p.flags, context: p.context, maxMatches: p.max_matches });
        // SAFETY: grep matches contain only JSON fields; optional file is omitted for literal text.
        return ok({ matches: matches as unknown as Json }, `${matches.length} matches`);
      }
      if (p.list_files) {
        const files = fileList();
        return ok({ files }, `${files.length} files`);
      }
      let text: string | undefined;
      if (p.file) text = store.fileText(id, p.file).text;
      else if (p.lines) text = store.lineRange(id, p.lines.start, p.lines.count);
      else if (p.chars) text = store.charRange(id, p.chars.start, p.chars.end);
      if (text === undefined) {
        // never dump a whole handle: answer with what is available instead
        const files = fileList();
        const hint = "Pass one of: pattern (regex; files_only for paths), file, lines {start,count}, chars {start,end}, list_files.";
        return ok({ files: files.slice(0, 200), total_files: files.length, chars: h.text.length, hint }, `${files.length} files, ${h.text.length} chars. ${hint}`);
      }
      return ok({ text: clip(text), chars: text.length }, clip(text));
    },
  });

  pi.registerTool({
    name: "llm_query",
    label: "llm_query",
    exposure,
    executionMode: "parallel",
    description:
      "Ask the worker model one question, optionally about part of a loaded handle (whole handle, one file, a line or character range) or literal text. Returns text plus stop_reason, truncated, empty, duration_ms and usage. Check status before aggregating; an empty truncated result carries error, not a usable answer. Ask for NONE explicitly for no matches. No automatic retries. With background: true, returns { job } at once (collect with rlm_wait).",
    parameters: QueryParams,
    prepareArguments: prepareQueryItem as (args: unknown) => QueryParamsT,
    outputSchema: Type.Union([QueryOutput, JobStarted]),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const runtime = workerRuntime(ctx.modelRegistry);
      const input = toInput(store, p);
      if (p.background) {
        const { name } = worker.resolveModel(runtime, ctx.model, p.model);
        const sessionModel = ctx.model;
        return started(jobs.start("llm_query", labelOf(p.prompt), async (s) => queryResult(await worker.query(runtime, sessionModel, input, s))), name);
      }
      const r = await worker.query(runtime, ctx.model, input, signal);
      const result = queryResult(r);
      return ok(result, result.error ? String(result.error) : r.truncated ? `[truncated] ${r.text}` : r.empty ? "[empty completion]" : r.text);
    },
  });

  pi.registerTool({
    name: "llm_query_batched",
    label: "llm_query_batched",
    exposure,
    executionMode: "parallel",
    description:
      "Run many llm_query sub-queries concurrently (bounded by the configured concurrency) and return the answers in order. Each item takes the same fields as llm_query (an item's own background flag is ignored). Provider failures carry error instead of text; empty truncated completions carry error plus status and usage. Inspect truncated/empty on every item. With background: true, returns { job } at once; rlm_wait then gives { results } as the result.",
    parameters: Type.Object({
      queries: Type.Array(QueryParams, { minItems: 1, maxItems: 256 }),
      background: Type.Optional(Type.Boolean({ description: BACKGROUND_DOC })),
    }),
    prepareArguments: (args: unknown) => {
      const a = args as { queries?: unknown };
      return (Array.isArray(a?.queries) ? { ...a, queries: a.queries.map(prepareQueryItem) } : args) as { queries: QueryParamsT[]; background?: boolean };
    },
    outputSchema: Type.Union([Type.Object({ results: Type.Array(Type.Union([QueryOutput, Type.Object({ error: Type.String() })])) }), JobStarted]),
    async execute(_id, p, signal, onUpdate, ctx) {
      const runtime = workerRuntime(ctx.modelRegistry);
      if (p.background) {
        const { name } = worker.resolveModel(runtime, ctx.model, p.queries[0]?.model);
        const sessionModel = ctx.model;
        const label = `${p.queries.length} queries: ${labelOf(p.queries[0]?.prompt ?? "")}`;
        return started(jobs.start("llm_query_batched", label, async (s) => ({ results: await runBatch(worker, runtime, sessionModel, store, p.queries, s, () => {}) })), name);
      }
      const results = await runBatch(worker, runtime, ctx.model, store, p.queries, signal, (done, total) =>
        onUpdate?.({ content: [{ type: "text", text: `${done}/${total} sub-queries done` }], details: { done, total } }));
      const failed = results.filter((r) => "error" in r).length;
      return ok({ results }, `${results.length - failed}/${results.length} answered${failed ? `, ${failed} failed` : ""}; ${worker.callsLeft} calls left`);
    },
  });

  pi.registerTool({
    name: "rlm_handles",
    label: "rlm_handles",
    exposure,
    description: "List loaded handles with their sizes, or drop handles you no longer need to free memory.",
    parameters: Type.Object({ drop: Type.Optional(Type.Array(Type.String(), { description: "Owned handles to forget; a child cannot drop borrowed input." })) }),
    outputSchema: Type.Object({ handles: Type.Array(HandleSummaryOutput), dropped: Type.Array(Type.String()) }),
    async execute(_id, p) {
      const dropped = (p.drop ?? []).filter((h) => store.drop(h));
      const handles = store.list().map(({ skipped: _s, ...h }) => h);
      return ok({ handles, dropped }, `${handles.length} handles${dropped.length ? `, dropped ${dropped.join(", ")}` : ""}`);
    },
  });

  pi.registerTool({
    name: "rlm_wait",
    label: "rlm_wait",
    exposure,
    executionMode: "parallel",
    description:
      "Collect background jobs started with background: true. Waits until the given jobs (default: all) finish, or the first one with any: true, or timeout_ms (default 300000). Finished jobs come back in done with result = what the call would have returned, and are forgotten; the rest are listed in pending and keep running. A failed job carries error.",
    parameters: Type.Object({
      jobs: Type.Optional(Type.Array(Type.String(), { description: "Job ids; default all uncollected jobs." })),
      any: Type.Optional(Type.Boolean({ description: "Return as soon as one of them has finished." })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000, description: "Longest wait; 0 just checks." })),
    }),
    prepareArguments: (args: unknown) => {
      const a = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : args;
      // scripts pass the start result itself, a bare id, or a list of either
      const id = (v: unknown) => (v && typeof v === "object" && typeof (v as { job?: unknown }).job === "string" ? (v as { job: string }).job : v);
      if (a && typeof a === "object") {
        const r = a as Record<string, unknown>;
        if (r.jobs === undefined && r.job !== undefined) r.jobs = r.job;
        delete r.job;
        if (r.jobs !== undefined && !Array.isArray(r.jobs)) r.jobs = [r.jobs];
        if (Array.isArray(r.jobs)) r.jobs = r.jobs.map(id);
      }
      return a as { jobs?: string[]; any?: boolean; timeout_ms?: number };
    },
    outputSchema: Type.Object({ done: Type.Array(JobViewOutput), pending: Type.Array(JobViewOutput) }),
    async execute(_id, p, signal) {
      const r = await jobs.wait(p.jobs, { timeoutMs: p.timeout_ms ?? 300_000, any: p.any, signal });
      // SAFETY: job views contain only JSON fields.
      const value = r as unknown as Json;
      const failed = r.done.filter((d) => d.error !== undefined).length;
      return ok(value, `${r.done.length} done${failed ? ` (${failed} failed)` : ""}, ${r.pending.length} pending`);
    },
  });

  pi.registerTool({
    name: "rlm_jobs",
    label: "rlm_jobs",
    exposure,
    description: "List background jobs (running, or finished and not yet collected) without collecting them, or cancel running ones.",
    parameters: Type.Object({ cancel: Type.Optional(Type.Array(Type.String(), { description: "Running job ids to cancel." })) }),
    outputSchema: Type.Object({ jobs: Type.Array(JobViewOutput), cancelled: Type.Array(Type.String()) }),
    async execute(_id, p) {
      const cancelled = jobs.cancel(p.cancel ?? []);
      // SAFETY: job views contain only JSON fields.
      const list = jobs.list() as unknown as Json;
      return ok({ jobs: list, cancelled }, `${jobs.size} jobs (${jobs.running} running)${cancelled.length ? `, cancelled ${cancelled.join(", ")}` : ""}`);
    },
  });

  if (deps.depth >= config.maxDepth) return;

  pi.registerTool({
    name: "rlm_query",
    label: "rlm_query",
    exposure,
    executionMode: "parallel",
    description:
      "Delegate a sub-task to a recursive sub-agent: a fresh session with codemode and these same tools, working on a handle (or a slice of it, or literal text). Use it when a part of the problem needs its own search-and-reason loop, not just one llm_query answer. Returns the sub-agent's final answer. Slower and costlier than llm_query; with background: true, returns { job } at once (collect with rlm_wait).",
    parameters: Type.Object({
      task: Type.String({ description: "What the sub-agent must find out or produce." }),
      ...ContextRef,
      text: Type.Optional(Type.String({ description: "Literal input text, instead of a handle." })),
      model: Type.Optional(Type.String({ description: 'Override the sub-agent model, "provider/model".' })),
      background: Type.Optional(Type.Boolean({ description: BACKGROUND_DOC })),
    }),
    prepareArguments: prepareQueryArguments as (args: unknown) => never,
    outputSchema: Type.Union([Type.Object({ answer: Type.String(), depth: Type.Number(), model: Type.String(), handle: Type.Optional(Type.String()) }), JobStarted]),
    async execute(_id, p, signal, onUpdate, ctx) {
      validateContext(p);
      // Validate model selection before allocating a private slice: the call's model, else the
      // child model, else the worker (a local session model wins over both, see resolveModel).
      const { model, name } = worker.resolveModel(workerRuntime(ctx.modelRegistry), ctx.model, p.model, config.child ?? config.worker);
      // a background run outlives this tool call, so it reports no progress through onUpdate
      const run = (signal: AbortSignal | undefined, update: typeof onUpdate) => worker.runChild(deps.depth + 1, async () => {
      const sliced = p.text !== undefined || Boolean(p.file || p.lines || p.chars);
      let handle: string | undefined;
      if (sliced) {
        const text = contextFor(store, { prompt: "", ...p }) ?? "";
        handle = store.loadText(text, p.text !== undefined ? "text" : `${store.resolve(p.handle)} slice`, { internal: true }).handle;
      } else {
        // an explicit reference must resolve; with none, give the child the latest handle if any
        handle = p.handle !== undefined ? store.resolve(p.handle) : store.latest();
      }
      const depth = deps.depth + 1;
      const childStore = store.scope(handle ? [handle] : []);
      try {
        const handles = handle ? [summarize(store, handle)] : [];
        update?.({ content: [{ type: "text", text: `sub-agent (depth ${depth}, ${name}) working` }], details: { depth } });
        const r = await deps.runChild({ cwd: ctx.cwd, task: p.task, handles, store: childStore, depth, model, signal });
        return ok({ answer: r.answer, depth, model: name, ...(!sliced && handle ? { handle } : {}) }, r.answer);
      } finally {
        // a slice made for this call is private to it
        childStore.dispose();
        if (sliced && handle) store.drop(handle);
      }
      }, signal);
      if (p.background) return started(jobs.start("rlm_query", labelOf(p.task), async (s) => (await run(s, undefined)).structuredContent), name);
      return run(signal, onUpdate);
    },
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function summarize(store: HandleStore, id: string): ChildRequest["handles"][number] {
  const h = store.get(id);
  return { handle: h.id, label: h.label, files: h.files.length, lines: h.lines, chars: h.text.length };
}
