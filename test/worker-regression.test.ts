import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { type ModelRuntime, Worker } from "../src/worker.js";

const model = { provider: "p", id: "m" };
const runtime = (): ModelRuntime => ({ find: () => model, completeSimple: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) });

describe("worker failure and budget edges", () => {
  it("forwards bounded defaults and configured reasoning/temperature", async () => {
    const rt = runtime();
    await new Worker(DEFAULTS).query(rt, model, { prompt: "q" });
    expect(rt.completeSimple).toHaveBeenLastCalledWith(model, expect.anything(), expect.objectContaining({ maxTokens: 512, reasoning: undefined, temperature: 0 }));
    await new Worker({ ...DEFAULTS, workerThinking: "low", workerMaxTokens: 2048, workerTemperature: 0.3 }).query(rt, model, { prompt: "q" });
    expect(rt.completeSimple).toHaveBeenLastCalledWith(model, expect.anything(), expect.objectContaining({ maxTokens: 2048, reasoning: "low", temperature: 0.3 }));
  });

  it("exposes length stops, empty answers, and timing without retrying", async () => {
    const rt = runtime();
    rt.completeSimple = vi.fn(async () => ({ content: [], stopReason: "length", usage: { input: 4, output: 512 } }));
    const worker = new Worker(DEFAULTS);
    expect(await worker.query(rt, model, { prompt: "q" })).toMatchObject({ text: "", empty: true, truncated: true, stopReason: "length", outputTokens: 512, durationMs: expect.any(Number) });
    rt.completeSimple = vi.fn(async () => ({ content: [{ type: "text", text: "partial" }], stopReason: "length" }));
    expect(await worker.query(rt, model, { prompt: "q" })).toMatchObject({ empty: false, truncated: true });
    expect(rt.completeSimple).toHaveBeenCalledOnce();
  });

  it("charges attempted provider failures but not invalid prompts", async () => {
    const rt = runtime();
    rt.completeSimple = vi.fn(async () => { throw new Error("provider failed"); });
    const worker = new Worker(DEFAULTS);
    await expect(worker.query(rt, model, { prompt: "q" })).rejects.toThrow("provider failed");
    expect(worker.callsUsed).toBe(1);
  });

  it("limits sibling children while permitting recursive descent and cancelling queued children", async () => {
    const worker = new Worker({ ...DEFAULTS, childConcurrency: 1 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: number[] = [];
    const first = worker.runChild(1, async () => {
      calls.push(1);
      await worker.runChild(2, async () => { calls.push(2); });
      await gate;
    });
    const controller = new AbortController();
    const cancelled = expect(worker.runChild(1, async () => { calls.push(99); }, controller.signal)).rejects.toThrow("cancel");
    const second = worker.runChild(1, async () => { calls.push(3); });
    controller.abort(new Error("cancel"));
    await cancelled;
    expect(calls).toEqual([1, 2]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([1, 2, 3]);
  });
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
    expect(rt.completeSimple).toHaveBeenCalledTimes(2);
  });

  it("does not spend budget for pre-aborted requests", async () => {
    const worker = new Worker(DEFAULTS);
    const rt = runtime();
    await expect(worker.query(rt, model, { prompt: "q" }, AbortSignal.abort(new Error("cancel")))).rejects.toThrow("cancel");
    expect(worker.callsUsed).toBe(0);
    expect(rt.completeSimple).not.toHaveBeenCalled();
  });

  it("never sends an aborted queued query to the model", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rt = runtime();
    rt.completeSimple = vi.fn(async () => { await gate; return { content: [] }; });
    const worker = new Worker({ ...DEFAULTS, concurrency: 1 });
    const first = worker.query(rt, model, { prompt: "first" });
    const controller = new AbortController();
    const queued = worker.query(rt, model, { prompt: "queued" }, controller.signal);
    const rejected = expect(queued).rejects.toThrow("cancel queued");
    controller.abort(new Error("cancel queued"));
    await rejected;
    release();
    await first;
    expect(rt.completeSimple).toHaveBeenCalledOnce();
    expect(worker.callsUsed).toBe(1);
    expect(worker.callsLeft).toBe(DEFAULTS.maxCalls - 1);
  });

  it("forwards max_tokens and signal, handles absent usage/text and aborted replies", async () => {
    const rt = runtime();
    rt.completeSimple = vi.fn(async () => ({ content: [{ type: "text" }, { type: "thinking", text: "hidden" }] }));
    const worker = new Worker(DEFAULTS);
    const controller = new AbortController();
    expect(await worker.query(rt, model, { prompt: "q", maxTokens: 17 }, controller.signal)).toMatchObject({ text: "", model: "p/m" });
    expect(rt.completeSimple).toHaveBeenCalledWith(model, expect.anything(), { signal: controller.signal, maxTokens: 17, reasoning: undefined, temperature: 0 });
    rt.completeSimple = async () => ({ content: [], stopReason: "aborted" });
    await expect(worker.query(rt, model, { prompt: "q" })).rejects.toThrow(/failed: aborted/);
  });
});
