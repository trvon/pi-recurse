import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, parseModelSpec, type RecurseConfigFile, resolveConfig } from "../src/config.js";
import { type ModelRuntime, Worker, type WorkerMessage } from "../src/worker.js";

const cfg = (file: RecurseConfigFile) => resolveConfig([{ source: "test", data: file }]).config;

function runtime(reply: (prompt: string) => WorkerMessage | Promise<WorkerMessage>, known = ["llamacpp/flint"]) {
  const seen: { model: unknown; prompt: string; system?: string }[] = [];
  const rt: ModelRuntime = {
    find: (provider, id) => (known.includes(`${provider}/${id}`) ? { provider, id } : undefined),
    async complete(model, context) {
      const c = context as { systemPrompt?: string; messages: { content: string }[] };
      const prompt = c.messages[0]?.content ?? "";
      seen.push({ model, prompt, system: c.systemPrompt });
      return reply(prompt);
    },
  };
  return { rt, seen };
}

const text = (t: string): WorkerMessage => ({ content: [{ type: "thinking", text: "hmm" }, { type: "text", text: t }], usage: { input: 10, output: 2 } });

describe("config", () => {
  it("parses model specs", () => {
    expect(parseModelSpec("llamacpp/flint")).toEqual({ provider: "llamacpp", model: "flint" });
    expect(parseModelSpec("openrouter/google/gemma")).toEqual({ provider: "openrouter", model: "google/gemma" });
    expect(parseModelSpec("flint")).toBeUndefined();
    expect(parseModelSpec("/x")).toBeUndefined();
  });

  it("layers files over defaults and skips invalid values with warnings", () => {
    const r = resolveConfig([
      { source: "global", data: { worker: "llamacpp/flint", concurrency: 4, childThinking: "medium" } },
      { source: "project", data: { concurrency: 0, exposure: "direct", worker: "nope", colour: "blue" } },
    ]);
    expect(r.config.worker).toEqual({ provider: "llamacpp", model: "flint" });
    expect(r.config.concurrency).toBe(4);
    expect(r.config.exposure).toBe("direct");
    expect(r.config.childThinking).toBe("medium");
    expect(r.config.maxDepth).toBe(2);
    expect(r.warnings).toEqual([
      "project: concurrency must be an integer >= 1; ignored",
      'project: worker must look like "provider/model" (or null for the session model); ignored',
      'project: unknown key "colour"; ignored',
    ]);
    expect(resolveConfig([{ source: "p", data: { worker: null } }]).config.worker).toBeUndefined();
    expect(resolveConfig([{ source: "p", data: [] }]).warnings).toEqual(["p: expected a JSON object"]);
  });

  it("reads the global file then the project file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recurse-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "proj");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "pi-recurse.json"), JSON.stringify({ worker: "llamacpp/flint", concurrency: 3 }));
    writeFileSync(join(cwd, ".pi", "pi-recurse.json"), "{ not json");
    const r = loadConfig({ cwd, agentDir });
    expect(r.config.concurrency).toBe(3);
    expect(r.sources).toEqual([join(agentDir, "pi-recurse.json")]);
    expect(r.warnings[0]).toMatch(/pi-recurse\.json: .*file ignored/);
    writeFileSync(join(cwd, ".pi", "pi-recurse.json"), JSON.stringify({ concurrency: 1 }));
    expect(loadConfig({ cwd, agentDir }).config.concurrency).toBe(1);
    expect(loadConfig({ cwd: root, agentDir: root }).config).toEqual(DEFAULTS);
  });
});

describe("Worker", () => {
  it("uses the configured worker, returns only text, and wraps context", async () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint" }));
    const { rt, seen } = runtime(() => text("42"));
    const r = await w.query(rt, { provider: "x", id: "session" }, { prompt: "answer?", context: "data", system: "be brief" });
    expect(r).toEqual({ text: "42", model: "llamacpp/flint", inputTokens: 10, outputTokens: 2 });
    expect(seen[0]?.prompt).toBe("<context>\ndata\n</context>\n\nanswer?");
    expect(seen[0]?.system).toBe("be brief");
    expect(w.callsUsed).toBe(1);
  });

  it("falls back to the session model, and honours per-call overrides", async () => {
    const w = new Worker(cfg({}));
    const { rt, seen } = runtime(() => text("ok"), ["llamacpp/flint", "local/small"]);
    expect((await w.query(rt, { provider: "p", id: "m" }, { prompt: "a" })).model).toBe("p/m");
    expect((await w.query(rt, undefined, { prompt: "a", model: "local/small" })).model).toBe("local/small");
    expect(seen[1]?.model).toEqual({ provider: "local", id: "small" });
    await expect(w.query(rt, undefined, { prompt: "a" })).rejects.toThrow(/no worker model/);
    await expect(w.query(rt, undefined, { prompt: "a", model: "missing/m" })).rejects.toThrow(/not configured/);
  });

  it("rejects oversized prompts and enforces the call budget", async () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint", maxPromptChars: 1000, maxCalls: 1 }));
    const { rt } = runtime(() => text("ok"));
    await expect(w.query(rt, undefined, { prompt: "x".repeat(2000) })).rejects.toThrow(/limit is 1000/);
    await w.query(rt, undefined, { prompt: "a" });
    await expect(w.query(rt, undefined, { prompt: "a" })).rejects.toThrow(/budget/);
    expect(w.callsLeft).toBe(0);
  });

  it("surfaces worker errors", async () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint" }));
    const { rt } = runtime(() => ({ content: [], stopReason: "error", errorMessage: "boom" }));
    await expect(w.query(rt, undefined, { prompt: "a" })).rejects.toThrow(/boom/);
  });

  it("limits concurrency", async () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint", concurrency: 2 }));
    let active = 0;
    let peak = 0;
    const { rt } = runtime(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return text("ok");
    });
    await Promise.all(Array.from({ length: 6 }, () => w.query(rt, undefined, { prompt: "a" })));
    expect(peak).toBe(2);
  });
});
