import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildRequest, ChildResult } from "./child.js";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import { type QueryInput, type QueryResult, type Worker, workerRuntime } from "./worker.js";

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

const QueryParams = Type.Object({
  prompt: Type.String({ description: "Question or instruction for the worker model." }),
  ...ContextRef,
  text: Type.Optional(Type.String({ description: "Literal context text, instead of a handle." })),
  system: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: 'Override the worker model, "provider/model".' })),
  max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
type QueryParamsT = Static<typeof QueryParams>;

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
export const TOOL_NAMES = new Set(["rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query"]);

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
  config: RecurseConfig;
  /** Recursion depth of the session these tools belong to: 0 for the top-level session. */
  depth: number;
  /** Runs an rlm_query child; injected so tests do not start real sessions. */
  runChild: (req: ChildRequest) => Promise<ChildResult>;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  const { store, worker, config } = deps;
  const exposure = config.exposure;

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
      "Ask the worker model one question, optionally about part of a loaded handle (whole handle, one file, a line or character range) or literal text. Returns text plus stop_reason, truncated, empty, duration_ms and usage. Check status before aggregating; an empty truncated result carries error, not a usable answer. Ask for NONE explicitly for no matches. No automatic retries.",
    parameters: QueryParams,
    prepareArguments: prepareQueryItem as (args: unknown) => QueryParamsT,
    outputSchema: QueryOutput,
    async execute(_id, p, signal, _onUpdate, ctx) {
      const r = await worker.query(workerRuntime(ctx.modelRegistry), ctx.model, toInput(store, p), signal);
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
      "Run many llm_query sub-queries concurrently (bounded by the configured concurrency) and return the answers in order. Each item takes the same fields as llm_query. Provider failures carry error instead of text; empty truncated completions carry error plus status and usage. Inspect truncated/empty on every item.",
    parameters: Type.Object({ queries: Type.Array(QueryParams, { minItems: 1, maxItems: 256 }) }),
    prepareArguments: (args: unknown) => {
      const a = args as { queries?: unknown };
      return (Array.isArray(a?.queries) ? { ...a, queries: a.queries.map(prepareQueryItem) } : args) as { queries: QueryParamsT[] };
    },
    outputSchema: Type.Object({ results: Type.Array(Type.Union([QueryOutput, Type.Object({ error: Type.String() })])) }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const runtime = workerRuntime(ctx.modelRegistry);
      const total = p.queries.length;
      let done = 0;
      const results = await Promise.all(
        p.queries.map(async (q): Promise<{ [key: string]: Json }> => {
          let r: { [key: string]: Json };
          try {
            const a = await worker.query(runtime, ctx.model, toInput(store, q), signal);
            r = queryResult(a);
          } catch (e) {
            r = { error: errorText(e) };
          }
          done++;
          onUpdate?.({ content: [{ type: "text", text: `${done}/${total} sub-queries done` }], details: { done, total } });
          return r;
        }),
      );
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

  if (deps.depth >= config.maxDepth) return;

  pi.registerTool({
    name: "rlm_query",
    label: "rlm_query",
    exposure,
    executionMode: "parallel",
    description:
      "Delegate a sub-task to a recursive sub-agent: a fresh session with codemode and these same tools, working on a handle (or a slice of it, or literal text). Use it when a part of the problem needs its own search-and-reason loop, not just one llm_query answer. Returns the sub-agent's final answer. Slower and costlier than llm_query.",
    parameters: Type.Object({
      task: Type.String({ description: "What the sub-agent must find out or produce." }),
      ...ContextRef,
      text: Type.Optional(Type.String({ description: "Literal input text, instead of a handle." })),
      model: Type.Optional(Type.String({ description: 'Override the sub-agent model, "provider/model".' })),
    }),
    prepareArguments: prepareQueryArguments as (args: unknown) => never,
    outputSchema: Type.Object({ answer: Type.String(), depth: Type.Number(), model: Type.String(), handle: Type.Optional(Type.String()) }),
    async execute(_id, p, signal, onUpdate, ctx) {
      validateContext(p);
      // Validate model selection before allocating a private slice.
      const spec = p.model ?? (config.child ? `${config.child.provider}/${config.child.model}` : undefined);
      const { model, name } = worker.resolveModel(workerRuntime(ctx.modelRegistry), ctx.model, spec);
      return worker.runChild(deps.depth + 1, async () => {
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
        onUpdate?.({ content: [{ type: "text", text: `sub-agent (depth ${depth}, ${name}) working` }], details: { depth } });
        const r = await deps.runChild({ cwd: ctx.cwd, task: p.task, handles, store: childStore, depth, model, signal });
        return ok({ answer: r.answer, depth, model: name, ...(!sliced && handle ? { handle } : {}) }, r.answer);
      } finally {
        // a slice made for this call is private to it
        childStore.dispose();
        if (sliced && handle) store.drop(handle);
      }
      }, signal);
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
