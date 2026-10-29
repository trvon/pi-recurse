import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildRequest, ChildResult } from "./child.js";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import type { ModelRuntime, QueryInput, Worker } from "./worker.js";

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

const QueryOutput = Type.Object({ text: Type.String(), model: Type.String(), input_tokens: Type.Optional(Type.Number()), output_tokens: Type.Optional(Type.Number()) });

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

export function prepareQueryItem(args: unknown): unknown {
  return args && typeof args === "object" ? normalizeHandle({ ...(args as Record<string, unknown>) }) : args;
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
export function prepareQueryArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const a = normalizeHandle({ ...(args as Record<string, unknown>) });
  for (const alias of ["prompt", "question", "query"]) {
    if (a.task === undefined && typeof a[alias] === "string") a.task = a[alias];
    delete a[alias];
  }
  return a;
}

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
      if (params.text === undefined && !params.paths?.length) throw new Error("give paths or text");
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
    prepareArguments: preparePeekArguments,
    async execute(_id, p) {
      const cap = p.max_chars ?? 20000;
      const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)}\n... [${s.length - cap} more chars]` : s);
      const id = store.resolve(p.handle);
      const h = store.get(id);
      const fileList = () => h.files.map((f) => ({ path: f.path, lines: f.lines, chars: f.end - f.start }));
      if (p.pattern !== undefined) {
        const matches = store.grep(id, p.pattern, { flags: p.flags, context: p.context, maxMatches: p.files_only ? Number.MAX_SAFE_INTEGER : p.max_matches });
        if (p.files_only) {
          const files = [...new Set(matches.map((m) => m.file).filter((f): f is string => f !== undefined))];
          return ok({ files }, files.length ? files.join("\n") : "no matching files");
        }
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
      "Ask the worker model one question, optionally about part of a loaded handle (whole handle, one file, a line or character range) or literal text. Returns only the answer. Use it to summarize, extract, or check pieces of large input; aggregate the answers in your script.",
    parameters: QueryParams,
    prepareArguments: prepareQueryItem as (args: unknown) => QueryParamsT,
    outputSchema: QueryOutput,
    async execute(_id, p, signal, _onUpdate, ctx) {
      const r = await worker.query(ctx.modelRegistry as unknown as ModelRuntime, ctx.model, toInput(store, p), signal);
      return ok({ text: r.text, model: r.model, input_tokens: r.inputTokens ?? null, output_tokens: r.outputTokens ?? null }, r.text);
    },
  });

  pi.registerTool({
    name: "llm_query_batched",
    label: "llm_query_batched",
    exposure,
    executionMode: "parallel",
    description:
      "Run many llm_query sub-queries concurrently (bounded by PI_RECURSE_CONCURRENCY) and return the answers in order. Each item takes the same fields as llm_query. Failed items carry an error instead of text.",
    parameters: Type.Object({ queries: Type.Array(QueryParams, { minItems: 1, maxItems: 256 }) }),
    prepareArguments: (args: unknown) => {
      const a = args as { queries?: unknown };
      return (Array.isArray(a?.queries) ? { ...a, queries: a.queries.map(prepareQueryItem) } : args) as { queries: QueryParamsT[] };
    },
    outputSchema: Type.Object({ results: Type.Array(Type.Object({ text: Type.Optional(Type.String()), error: Type.Optional(Type.String()), model: Type.Optional(Type.String()) })) }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const runtime = ctx.modelRegistry as unknown as ModelRuntime;
      const total = p.queries.length;
      let done = 0;
      const results = await Promise.all(
        p.queries.map(async (q): Promise<{ [key: string]: Json }> => {
          let r: { [key: string]: Json };
          try {
            const a = await worker.query(runtime, ctx.model, toInput(store, q), signal);
            r = { text: a.text, model: a.model };
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
    parameters: Type.Object({ drop: Type.Optional(Type.Array(Type.String(), { description: "Handles to forget." })) }),
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
      const sliced = p.text !== undefined || Boolean(p.file || p.lines || p.chars);
      let handle: string | undefined;
      if (sliced) {
        const text = contextFor(store, { prompt: "", ...p }) ?? "";
        handle = store.loadText(text, p.text !== undefined ? "text" : `${store.resolve(p.handle)} slice`, { internal: true }).handle;
      } else {
        // an explicit reference must resolve; with none, give the child the latest handle if any
        handle = p.handle !== undefined ? store.resolve(p.handle) : store.latest();
      }
      const handles = handle ? [summarize(store, handle)] : [];
      const spec = p.model ?? (config.child ? `${config.child.provider}/${config.child.model}` : undefined);
      const { model, name } = worker.resolveModel(ctx.modelRegistry as unknown as ModelRuntime, ctx.model, spec);
      const depth = deps.depth + 1;
      onUpdate?.({ content: [{ type: "text", text: `sub-agent (depth ${depth}, ${name}) working` }], details: { depth } });
      try {
        const r = await deps.runChild({ cwd: ctx.cwd, task: p.task, handles, depth, model, signal });
        return ok({ answer: r.answer, depth, model: name, ...(handle ? { handle } : {}) }, r.answer);
      } finally {
        // a slice made for this call is private to it
        if (sliced && handle) store.drop(handle);
      }
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
