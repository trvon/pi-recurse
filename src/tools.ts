import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import type { ModelRuntime, QueryInput, Worker } from "./worker.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function ok(value: Json, summary: string) {
  return { content: [{ type: "text" as const, text: summary }], details: value, structuredContent: value };
}

const ContextRef = {
  handle: Type.Optional(Type.String({ description: "Handle from rlm_load whose text becomes the sub-query's context." })),
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

const PeekParams = Type.Object({
  handle: Type.String(),
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

/** Map the names models tend to use for the search pattern onto `pattern`. */
export function preparePeekArguments(args: unknown): Static<typeof PeekParams> {
  if (!args || typeof args !== "object") return args as Static<typeof PeekParams>;
  const a = { ...(args as Record<string, unknown>) };
  for (const alias of ["grep", "regex", "query", "search"]) {
    if (a.pattern === undefined && typeof a[alias] === "string") a.pattern = a[alias];
    delete a[alias];
  }
  return a as Static<typeof PeekParams>;
}

export function contextFor(store: HandleStore, p: QueryParamsT): string | undefined {
  if (p.text !== undefined) return p.text;
  if (!p.handle) return undefined;
  if (p.file) return store.fileText(p.handle, p.file).text;
  if (p.lines) return store.lineRange(p.handle, p.lines.start, p.lines.count);
  if (p.chars) return store.charRange(p.handle, p.chars.start, p.chars.end);
  return store.get(p.handle).text;
}

function toInput(store: HandleStore, p: QueryParamsT): QueryInput {
  return { prompt: p.prompt, context: contextFor(store, p), system: p.system, model: p.model, maxTokens: p.max_tokens };
}

export function registerTools(pi: ExtensionAPI, store: HandleStore, worker: Worker, config: RecurseConfig): void {
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
      "Look at part of a loaded handle without reading all of it. Give exactly one of: `pattern` (regex search, per line; add `files_only: true` for just the matching file paths), `file` (one loaded file), `lines`, `chars`, or `list_files: true`. With none, returns the file list and these options. Keep results small; summarize big parts with llm_query.",
    parameters: PeekParams,
    prepareArguments: preparePeekArguments,
    async execute(_id, p) {
      const cap = p.max_chars ?? 20000;
      const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)}\n... [${s.length - cap} more chars]` : s);
      const h = store.get(p.handle);
      const fileList = () => h.files.map((f) => ({ path: f.path, lines: f.lines, chars: f.end - f.start }));
      if (p.pattern !== undefined) {
        const matches = store.grep(p.handle, p.pattern, { flags: p.flags, context: p.context, maxMatches: p.files_only ? Number.MAX_SAFE_INTEGER : p.max_matches });
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
      if (p.file) text = store.fileText(p.handle, p.file).text;
      else if (p.lines) text = store.lineRange(p.handle, p.lines.start, p.lines.count);
      else if (p.chars) text = store.charRange(p.handle, p.chars.start, p.chars.end);
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
    outputSchema: Type.Object({ results: Type.Array(Type.Object({ text: Type.Optional(Type.String()), error: Type.Optional(Type.String()), model: Type.Optional(Type.String()) })) }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const runtime = ctx.modelRegistry as unknown as ModelRuntime;
      const results = await Promise.all(
        p.queries.map(async (q): Promise<{ [key: string]: Json }> => {
          try {
            const r = await worker.query(runtime, ctx.model, toInput(store, q), signal);
            return { text: r.text, model: r.model };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      const failed = results.filter((r) => "error" in r).length;
      return ok({ results }, `${results.length - failed}/${results.length} answered${failed ? `, ${failed} failed` : ""}; ${worker.callsLeft} calls left`);
    },
  });
}
