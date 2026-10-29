import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { type ModelRuntime, Worker } from "../src/worker.js";

const model = { provider: "p", id: "m" };
const runtime = (): ModelRuntime => ({ find: () => model, complete: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) });

describe("worker failure and budget edges", () => {
  it("rejects malformed overrides and reports missing model metadata", () => {
    const worker = new Worker(DEFAULTS);
    expect(() => worker.resolveModel(runtime(), model, "invalid")).toThrow(/provider\/model/);
    expect(worker.resolveModel(runtime(), {}).name).toBe("?/?");
  });

  it("reserves the shared call budget before concurrent work starts", async () => {
    const worker = new Worker({ ...DEFAULTS, maxCalls: 2 });
    const rt = runtime();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => worker.query(rt, model, { prompt: "q" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(worker.callsUsed).toBe(2);
    expect(worker.callsLeft).toBe(0);
    expect(rt.complete).toHaveBeenCalledTimes(2);
  });

  it("does not spend budget for pre-aborted requests", async () => {
    const worker = new Worker(DEFAULTS);
    const rt = runtime();
    await expect(worker.query(rt, model, { prompt: "q" }, AbortSignal.abort(new Error("cancel")))).rejects.toThrow("cancel");
    expect(worker.callsUsed).toBe(0);
    expect(rt.complete).not.toHaveBeenCalled();
  });

  it("never sends an aborted queued query to the model", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rt = runtime();
    rt.complete = vi.fn(async () => { await gate; return { content: [] }; });
    const worker = new Worker({ ...DEFAULTS, concurrency: 1 });
    const first = worker.query(rt, model, { prompt: "first" });
    const controller = new AbortController();
    const queued = worker.query(rt, model, { prompt: "queued" }, controller.signal);
    const rejected = expect(queued).rejects.toThrow("cancel queued");
    controller.abort(new Error("cancel queued"));
    await rejected;
    release();
    await first;
    expect(rt.complete).toHaveBeenCalledOnce();
  });

  it("forwards max_tokens and signal, handles absent usage/text and aborted replies", async () => {
    const rt = runtime();
    rt.complete = vi.fn(async () => ({ content: [{ type: "text" }, { type: "thinking", text: "hidden" }] }));
    const worker = new Worker(DEFAULTS);
    const controller = new AbortController();
    expect(await worker.query(rt, model, { prompt: "q", maxTokens: 17 }, controller.signal)).toMatchObject({ text: "", model: "p/m" });
    expect(rt.complete).toHaveBeenCalledWith(model, expect.anything(), { signal: controller.signal, maxTokens: 17 });
    rt.complete = async () => ({ content: [], stopReason: "aborted" });
    await expect(worker.query(rt, model, { prompt: "q" })).rejects.toThrow(/failed: aborted/);
  });
});
