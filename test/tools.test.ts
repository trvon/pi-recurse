import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HandleStore } from "../src/handles.js";
import { registerTools } from "../src/tools.js";
import { Worker } from "../src/worker.js";

interface Registered {
  name: string;
  exposure?: string;
  prepareArguments?: (args: unknown) => unknown;
  execute:(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ structuredContent?: unknown; content: { text: string }[] }>;
}

function setup(env: Record<string, string> = { PI_RECURSE_WORKER: "llamacpp/flint" }) {
  const tools = new Map<string, Registered>();
  const pi = { registerTool: (t: Registered) => tools.set(t.name, t) } as unknown as ExtensionAPI;
  const config = loadConfig(env);
  const store = new HandleStore();
  registerTools(pi, store, new Worker(config), config);
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
        return { content: [{ type: "text", text: `len=${p.length}` }] };
      },
    },
  };
  const call = async (name: string, params: unknown) => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    // pi runs prepareArguments before schema validation
    return t.execute("id", t.prepareArguments ? t.prepareArguments(params) : params, undefined, undefined, ctx);
  };
  return { tools, call, prompts, store };
}

describe("registered tools", () => {
  it("registers four codemode-only tools by default", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual(["rlm_load", "rlm_peek", "llm_query", "llm_query_batched"]);
    expect([...tools.values()].every((t) => t.exposure === "codemode")).toBe(true);
    expect(setup({ PI_RECURSE_EXPOSURE: "direct" }).tools.get("rlm_load")?.exposure).toBe("direct");
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

  it("batches queries and reports per-item failures", async () => {
    const { call } = setup();
    const r = (await call("llm_query_batched", { queries: [{ prompt: "a" }, { prompt: "FAIL" }, { prompt: "c", text: "ctx" }] })).structuredContent as {
      results: { text?: string; error?: string }[];
    };
    expect(r.results[0]?.text).toBe("len=1");
    expect(r.results[1]?.error).toMatch(/worker down/);
    expect(r.results[2]?.text).toBeDefined();
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
      expect(r.matches.map((m) => m.file)).toEqual(["src/limiter.ts"]);
    }
    const files = (await call("rlm_peek", { handle: load.handle, pattern: "pi\\.registerTool\\(", files_only: true })).structuredContent as { files: string[] };
    expect(files.files).toEqual(["src/tools.ts"]);
  });
});
