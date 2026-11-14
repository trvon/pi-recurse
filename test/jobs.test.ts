import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { JobStore, MAX_JOBS } from "../src/jobs.js";
import { registerJobReminder } from "../src/tools.js";

/** A promise with its resolve/reject exposed, to finish a job from the test. */
function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("JobStore", () => {
  it("returns finished jobs once with their result and keeps the rest pending", async () => {
    const jobs = new JobStore();
    const a = gate<string>();
    const ida = jobs.start("llm_query", "a", () => a.promise);
    const idb = jobs.start("llm_query", "b", async () => "b done");
    await Promise.resolve();
    const first = await jobs.wait(undefined, { timeoutMs: 0 });
    expect(first.done.map((d) => [d.job, d.status, d.result])).toEqual([[idb, "done", "b done"]]);
    expect(first.pending.map((d) => d.job)).toEqual([ida]);
    expect(jobs.size).toBe(1);
    a.resolve("a done");
    const second = await jobs.wait([ida], { timeoutMs: 1000 });
    expect(second.done[0]).toMatchObject({ job: ida, status: "done", result: "a done" });
    await expect(jobs.wait([ida], { timeoutMs: 0 })).rejects.toThrow("already collected");
  });

  it("waits for all by default, or the first with any, bounded by the timeout", async () => {
    const jobs = new JobStore();
    const slow = gate<string>();
    const fast = gate<string>();
    const ids = [jobs.start("llm_query", "slow", () => slow.promise), jobs.start("llm_query", "fast", () => fast.promise)];
    setTimeout(() => fast.resolve("fast"), 5);
    const any = await jobs.wait(ids, { timeoutMs: 1000, any: true });
    expect(any.done.map((d) => d.label)).toEqual(["fast"]);
    const timedOut = await jobs.wait([ids[0] as string], { timeoutMs: 10 });
    expect(timedOut.pending.map((d) => d.label)).toEqual(["slow"]);
    slow.resolve("slow");
  });

  it("reports failures, cancels by id and on dispose, and refuses new jobs afterwards", async () => {
    const jobs = new JobStore();
    const failing = jobs.start("rlm_query", "bad", async () => {
      throw new Error("worker down");
    });
    let aborted = false;
    const hanging = jobs.start("llm_query", "hang", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        rej(new Error("aborted"));
      });
    }));
    expect(jobs.cancel([hanging, "nope"])).toEqual([hanging]);
    expect(aborted).toBe(true);
    const r = await jobs.wait(undefined, { timeoutMs: 1000 });
    expect(r.done.map((d) => [d.job, d.status, d.error])).toEqual([[failing, "failed", "worker down"], [hanging, "cancelled", "cancelled"]]);

    const left = jobs.start("llm_query", "left", () => new Promise(() => {}));
    jobs.dispose();
    expect(jobs.size).toBe(0);
    expect(left).toBeTruthy();
    expect(() => jobs.start("llm_query", "late", async () => 1)).toThrow("session ended");
  });

  it("caps the number of held jobs", () => {
    const jobs = new JobStore();
    for (let i = 0; i < MAX_JOBS; i++) jobs.start("llm_query", `${i}`, () => new Promise(() => {}));
    expect(() => jobs.start("llm_query", "one more", async () => 1)).toThrow(`${MAX_JOBS} background jobs`);
    jobs.dispose();
  });

  it("does not cancel jobs when only the wait is aborted", async () => {
    const jobs = new JobStore();
    const g = gate<string>();
    const id = jobs.start("llm_query", "x", () => g.promise);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const r = await jobs.wait([id], { timeoutMs: 10_000, signal: controller.signal });
    expect(r.pending.map((p) => p.status)).toEqual(["running"]);
    g.resolve("later");
    expect((await jobs.wait([id], { timeoutMs: 1000 })).done[0]?.result).toBe("later");
  });
});

describe("job reminder", () => {
  it("asks the agent once per run to collect uncollected jobs before it settles", async () => {
    const handlers = new Map<string, (event?: unknown) => unknown>();
    const pi = { on: (name: string, h: (event?: unknown) => unknown) => handlers.set(name, h) } as unknown as ExtensionAPI;
    const jobs = new JobStore();
    registerJobReminder(pi, jobs);
    const settle = handlers.get("agent_before_settle") as () => { entries: { content: string }[]; continue: boolean } | undefined;
    expect(settle()).toBeUndefined();
    jobs.start("llm_query_batched", "4 queries: find TODOs", () => new Promise(() => {}));
    const first = settle();
    expect(first?.continue).toBe(true);
    expect(first?.entries[0]?.content).toContain("4 queries: find TODOs");
    expect(first?.entries[0]?.content).toContain("tools.rlm_wait");
    expect(settle()).toBeUndefined();
    handlers.get("agent_start")?.();
    expect(settle()?.continue).toBe(true);
    jobs.dispose();
  });
});
