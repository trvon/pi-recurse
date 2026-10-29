import { describe, expect, it, vi } from "vitest";
import { Limiter } from "../src/limiter.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Limiter", () => {
  it("reserves a released slot for the FIFO waiter even when a newcomer arrives between microtasks", async () => {
    const limiter = new Limiter(1);
    const gate = deferred();
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const task = async (name: string, wait: Promise<void> = Promise.resolve()) => {
      order.push(name);
      active++;
      peak = Math.max(peak, active);
      await wait;
      active--;
    };
    const first = limiter.run(() => task("first", gate.promise));
    const second = limiter.run(() => task("second"));
    gate.resolve();
    const third = new Promise<void>((resolve, reject) => queueMicrotask(() => { void limiter.run(() => task("third")).then(resolve, reject); }));
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    expect(peak).toBe(1);
  });

  it("removes aborted queued work immediately without leaking its slot", async () => {
    const limiter = new Limiter(1);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const controller = new AbortController();
    const cancelled = vi.fn(async () => {});
    const second = limiter.run(cancelled, controller.signal);
    const rejected = expect(second).rejects.toThrow("cancel queued");
    controller.abort(new Error("cancel queued"));
    await rejected;
    expect(cancelled).not.toHaveBeenCalled();
    const third = limiter.run(async () => "third");
    gate.resolve();
    await first;
    expect(await third).toBe("third");
    expect(await limiter.run(async () => "next")).toBe("next");
  });

  it("rejects already-aborted calls without invoking tasks", async () => {
    const task = vi.fn(async () => {});
    await expect(new Limiter(1).run(task, AbortSignal.abort(new Error("cancel")))).rejects.toThrow("cancel");
    expect(task).not.toHaveBeenCalled();
  });

  it("releases a slot on task rejection", async () => {
    const limiter = new Limiter(1);
    const first = limiter.run(async () => { throw new Error("failed"); });
    const second = limiter.run(async () => "ok");
    await expect(first).rejects.toThrow("failed");
    expect(await second).toBe("ok");
  });
});
