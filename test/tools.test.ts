import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ChildRequest } from "../src/child.js";
import { type RecurseConfigFile, resolveConfig } from "../src/config.js";
import { HandleStore } from "../src/handles.js";
import { registerTools, restoreStructuredResults } from "../src/tools.js";
import { Worker } from "../src/worker.js";

const cfg = (file: RecurseConfigFile) => resolveConfig([{ source: "test", data: file }]).config;

interface Registered {
  name: string;
  exposure?: string;
  prepareArguments?: (args: unknown) => unknown;
  outputSchema?: TSchema;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((u: { details: unknown }) => void) | undefined, ctx: unknown) => Promise<{ structuredContent?: unknown; content: { text: string }[] }>;
}

function setup(env: RecurseConfigFile = { worker: "llamacpp/flint" }, depth = 0, childError?: Error) {
  const tools = new Map<string, Registered>();
  const pi = { registerTool: (t: Registered) => tools.set(t.name, t) } as unknown as ExtensionAPI;
  const config = cfg(env);
  const store = new HandleStore();
  const children: (ChildRequest & { seen: string })[] = [];
  const runChild = async (req: ChildRequest) => {
    // record what the child would see before the parent drops any slice handle
    const seen = req.handles.map((h) => store.get(h.handle).text).join("|");
    children.push({ ...req, seen });
    if (childError) throw childError;
    return { answer: `child@${req.depth}: ${req.task}`, depth: req.depth };
  };
  registerTools(pi, { store, worker: new Worker(config), config, depth, runChild });
  const prompts: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      async complete(_m: unknown, c: { messages: { content: string }[] }) {
        const p = c.messages[0]?.content ?? "";
        prompts.push(p);
        if (p.includes("FAIL")) return { content: [], stopReason: "error", errorMessage: "worker down" };
        if (p === "WITH_USAGE") return { content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 12 } };
        return { content: [{ type: "text", text: `len=${p.length}` }] };
      },
    },
  };
  const updates: unknown[] = [];
  const call = async (name: string, params: unknown) => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    // pi runs prepareArguments before schema validation
    const result = await t.execute("id", t.prepareArguments ? t.prepareArguments(params) : params, undefined, (u) => updates.push(u.details), ctx);
    if (t.outputSchema) expect(Check(t.outputSchema, result.structuredContent)).toBe(true);
    return result;
  };
  return { tools, call, prompts, store, children, updates };
}

describe("registered tools", () => {
  it("registers codemode-only tools by default, and rlm_query only below max depth", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual(["rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query"]);
    expect(setup(undefined, 2).tools.has("rlm_query")).toBe(false);
    expect(setup({ maxDepth: 0 }).tools.has("rlm_query")).toBe(false);
    expect([...tools.values()].every((t) => t.exposure === "codemode")).toBe(true);
    expect(setup({ exposure: "direct" }).tools.get("rlm_load")?.exposure).toBe("direct");
  });

  it("loads, peeks and queries with structured results", async () => {
    const { call, prompts } = setup();
    const load = (await call("rlm_load", { text: "alpha\nbeta\ngamma" })).structuredContent as { handle: string; lines: number };
    expect(load.lines).toBe(3);

    const peek = (await call("rlm_peek", { handle: load.handle, lines: { start: 2, count: 1 } })).structuredContent as { text: string };
    expect(peek.text).toBe("beta");

    const grep = (await call("rlm_peek", { handle: load.handle, grep: "^g" })).structuredContent as { matches: { text: string }[] };
    expect(grep.matches.map((m) => m.text)).toEqual(["gamma"]);

    const q = (await call("llm_query", { prompt: "count", handle: load.handle, lines: { start: 1, count: 1 } })).structuredContent as { text: string; model: string };
    expect(q.model).toBe("llamacpp/flint");
    expect(prompts[0]).toBe("<context>\nalpha\n</context>\n\ncount");
  });

  it("batches queries, reports per-item failures and progress", async () => {
    const { call, updates } = setup();
    const r = (await call("llm_query_batched", { queries: [{ prompt: "a" }, { prompt: "FAIL" }, { prompt: "c", text: "ctx" }] })).structuredContent as {
      results: { text?: string; error?: string }[];
    };
    expect(r.results[0]?.text).toBe("len=1");
    expect(r.results[1]?.error).toMatch(/worker down/);
    expect(r.results[2]?.text).toBeDefined();
    expect(updates).toContainEqual({ done: 3, total: 3 });
  });

  it("clips large peeks", async () => {
    const { call } = setup();
    const load = (await call("rlm_load", { text: "x".repeat(5000) })).structuredContent as { handle: string };
    const peek = (await call("rlm_peek", { handle: load.handle, chars: { start: 0, end: 5000 }, max_chars: 100 })).structuredContent as { text: string; chars: number };
    expect(peek.chars).toBe(5000);
    expect(peek.text).toContain("4900 more chars");
  });

  it("never dumps a whole handle when no selector is given", async () => {
    const { call } = setup();
    const load = (await call("rlm_load", { text: "secret ".repeat(1000) })).structuredContent as { handle: string };
    const peek = (await call("rlm_peek", { handle: load.handle })).structuredContent as { hint: string; chars: number; text?: string };
    expect(peek.text).toBeUndefined();
    expect(peek.chars).toBe(7000);
    expect(peek.hint).toMatch(/pattern/);
  });

  it("accepts regex/grep/query as aliases for pattern, and returns matching files", async () => {
    const { call } = setup();
    const load = (await call("rlm_load", { paths: ["src/*.ts"] })).structuredContent as { handle: string };
    for (const alias of ["regex", "grep", "query"]) {
      const r = (await call("rlm_peek", { handle: load.handle, [alias]: "class Limiter" })).structuredContent as { matches: { file: string }[] };
      expect(r.matches.map((m) => m.file)).toEqual([join("src", "limiter.ts")]);
    }
    const files = (await call("rlm_peek", { handle: load.handle, pattern: "pi\\.registerTool\\(", files_only: true })).structuredContent as { files: string[] };
    expect(files.files).toEqual([join("src", "tools.ts")]);
  });

  it("rlm_query passes a handle to a child one level deeper", async () => {
    const { call, children } = setup();
    const load = (await call("rlm_load", { text: "a\nb\nc" })).structuredContent as { handle: string };
    const r = (await call("rlm_query", { task: "find b", handle: load.handle })).structuredContent as { answer: string; depth: number; model: string };
    expect(r).toMatchObject({ answer: "child@1: find b", depth: 1, model: "llamacpp/flint" });
    expect(children[0]?.handles[0]?.handle).toBe(load.handle);
    expect(children[0]?.seen).toBe("a\nb\nc");
  });

  it("rlm_query turns a slice into a private handle and drops it afterwards", async () => {
    const { call, children, store } = setup({ worker: "llamacpp/flint", childModel: "local/small" });
    const load = (await call("rlm_load", { text: "a\nb\nc" })).structuredContent as { handle: string };
    const r = (await call("rlm_query", { task: "t", handle: load.handle, lines: { start: 2, count: 2 } })).structuredContent as { model: string; handle: string };
    expect(r.model).toBe("local/small");
    expect(children[0]?.seen).toBe("b\nc");
    expect(r.handle).not.toBe(load.handle);
    expect(store.list().map((h) => h.handle)).toEqual([load.handle]);
    await call("rlm_query", { task: "plain", text: "literal" });
    expect(children[1]?.seen).toBe("literal");
  });

  it("rlm_handles lists and drops handles", async () => {
    const { call } = setup();
    const a = (await call("rlm_load", { text: "one" })).structuredContent as { handle: string };
    const b = (await call("rlm_load", { text: "two" })).structuredContent as { handle: string };
    const r = (await call("rlm_handles", { drop: [a.handle, "nope"] })).structuredContent as { handles: { handle: string }[]; dropped: string[] };
    expect(r.dropped).toEqual([a.handle]);
    expect(r.handles.map((h) => h.handle)).toEqual([b.handle]);
  });

  it("defaults to the latest handle and accepts result objects or rewritten text as handles", async () => {
    const { call, prompts, children } = setup();
    const load = (await call("rlm_load", { text: "one\ntwo" })).structuredContent as { handle: string };
    const peek = (await call("rlm_peek", { lines: { start: 2, count: 1 } })).structuredContent as { text: string };
    expect(peek.text).toBe("two");
    const obj = (await call("rlm_peek", { handle: load, pattern: "one" })).structuredContent as { matches: unknown[] };
    expect(obj.matches).toHaveLength(1);
    const txt = (await call("rlm_peek", { handle: `Handle ${load.handle}: 0 files`, lines: { start: 1, count: 1 } })).structuredContent as { text: string };
    expect(txt.text).toBe("one");
    await call("llm_query", { prompt: "q", lines: { start: 1, count: 1 } });
    expect(prompts.at(-1)).toContain("<context>\none\n</context>");
    await call("llm_query_batched", { queries: [{ prompt: "q", handle: load, lines: { start: 2, count: 1 } }] });
    expect(prompts.at(-1)).toContain("<context>\ntwo\n</context>");
    await call("rlm_query", { task: "t" });
    expect(children[0]?.handles[0]?.handle).toBe(load.handle);
  });

  it("rejects oversized literal loads by UTF-8 bytes", async () => {
    const { call, store } = setup({ maxLoadBytes: 1024 });
    await expect(call("rlm_load", { text: "😀".repeat(257) })).rejects.toThrow(/exceeds 1024 bytes/);
    expect(store.list()).toHaveLength(0);
    await expect(call("rlm_load", {})).rejects.toThrow(/give paths or text/);
  });

  it("omits absent usage fields and emits numeric usage when supplied", async () => {
    const { call } = setup();
    const missing = (await call("llm_query", { prompt: "q" })).structuredContent;
    expect(missing).not.toHaveProperty("input_tokens");
    expect(missing).not.toHaveProperty("output_tokens");
    expect((await call("llm_query", { prompt: "WITH_USAGE" })).structuredContent).toMatchObject({ input_tokens: 0, output_tokens: 12 });
  });

  it("does not leak private slices when model selection or a child fails", async () => {
    const { call, store } = setup(undefined, 0, new Error("child failed"));
    await expect(call("rlm_query", { task: "q", text: "private", model: "invalid" })).rejects.toThrow(/provider\/model/);
    expect(store.list()).toHaveLength(0);
    await expect(call("rlm_query", { task: "q", text: "private" })).rejects.toThrow("child failed");
    expect(store.list()).toHaveLength(0);
  });

  it("supports file/char context, listing, and missing matching paths", async () => {
    const { call, prompts } = setup();
    await call("rlm_load", { paths: ["src/limiter.ts"] });
    expect((await call("rlm_peek", { list_files: true })).structuredContent).toMatchObject({ files: [{ path: join("src", "limiter.ts") }] });
    const file = (await call("rlm_peek", { file: "limiter.ts" })).structuredContent as { text: string };
    await call("llm_query", { prompt: "q", file: "limiter.ts" });
    expect(prompts.at(-1)).toContain(file.text);
    await call("llm_query", { prompt: "q", chars: { start: 0, end: 3 } });
    expect(prompts.at(-1)).toContain("<context>\n===\n</context>");
    expect((await call("rlm_peek", { pattern: "IMPOSSIBLE_PATTERN", files_only: true })).structuredContent).toEqual({ files: [] });
    const noHandle = setup();
    await noHandle.call("rlm_query", { task: "q" });
    expect(noHandle.children[0]?.handles).toEqual([]);
  });

  it("rlm_query accepts prompt or question as aliases for task", async () => {
    const { call, children } = setup();
    await call("rlm_query", { prompt: "via prompt", text: "x" });
    await call("rlm_query", { question: "via question", text: "y" });
    expect(children.map((c) => c.task)).toEqual(["via prompt", "via question"]);
  });
});

describe("restoreStructuredResults", () => {
  type Handler = (e: Record<string, unknown>) => unknown;
  const hook = () => {
    let handler: Handler | undefined;
    restoreStructuredResults({ on: (_: string, h: Handler) => (handler = h) } as unknown as ExtensionAPI);
    if (!handler) throw new Error("no handler");
    return handler;
  };

  it("puts back structured content that a result rewriter dropped", () => {
    const h = hook();
    // what pi passes on after a hook such as pi-tscg replaced the text content
    expect(h({ toolName: "rlm_load", isError: false, content: [{ type: "text", text: "Handle ab12" }], details: { handle: "ab12" } })).toEqual({
      structuredContent: { handle: "ab12" },
    });
  });

  it("leaves intact results, errors and other tools alone", () => {
    const h = hook();
    expect(h({ toolName: "rlm_load", isError: false, details: { handle: "a" }, structuredContent: { handle: "a" } })).toBeUndefined();
    expect(h({ toolName: "rlm_load", isError: true, details: { handle: "a" } })).toBeUndefined();
    expect(h({ toolName: "bash", isError: false, details: { x: 1 } })).toBeUndefined();
  });
});
