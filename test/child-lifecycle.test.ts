import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChildDeps, type ChildRequest, runChild } from "../src/child.js";
import { DEFAULTS } from "../src/config.js";
import { HandleStore } from "../src/handles.js";
import { Worker } from "../src/worker.js";

const sdk = vi.hoisted(() => {
  const session = {
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async (_text: string) => {}),
    getLastAssistantText: vi.fn((): string | undefined => "  answer  "),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn((_listener: (event: { type: string }) => void) => vi.fn()),
  };
  return {
    session,
    create: vi.fn(async (_options: unknown) => ({ session })),
    loader: vi.fn(),
    reload: vi.fn(async () => {}),
    overrides: vi.fn(),
    settings: vi.fn(),
    codemode: vi.fn(),
    memory: vi.fn(),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: class {
    constructor(options: unknown) { sdk.loader(options); }
    reload = sdk.reload;
  },
  getAgentDir: () => "/agent",
  createCodemodeExtension: () => sdk.codemode,
  SettingsManager: { inMemory: (settings: unknown) => { sdk.settings(settings); return { applyOverrides: sdk.overrides }; } },
  SessionManager: { inMemory: sdk.memory },
  createAgentSession: sdk.create,
}));

const request = (): ChildRequest => ({ cwd: process.cwd(), task: "question", store: new HandleStore().scope([]), handles: [], depth: 1, model: { provider: "p", id: "m" } });
const deps = (): ChildDeps => ({ store: new HandleStore(), worker: new Worker(DEFAULTS), config: { ...DEFAULTS, childTimeoutMs: 1000 }, register: vi.fn() });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("runChild lifecycle (mock SDK, no model requests)", () => {
  it("limits assistant turns and unsubscribes", async () => {
    const d = deps();
    d.config.childMaxTurns = 2;
    const unsubscribe = vi.fn();
    sdk.session.subscribe.mockReturnValueOnce(unsubscribe);
    sdk.session.prompt.mockImplementationOnce(async () => {
      const listener = sdk.session.subscribe.mock.calls[0]?.[0];
      for (let i = 0; i < 3; i++) listener?.({ type: "turn_start" });
      listener?.({ type: "message_end" });
    });
    await expect(runChild(request(), d)).rejects.toThrow(/childMaxTurns/);
    expect(sdk.session.abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(sdk.session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("includes resource initialization in the deadline", async () => {
    vi.useFakeTimers();
    let loaded = () => {};
    sdk.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { loaded = resolve; }));
    const rejected = expect(runChild(request(), deps())).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(sdk.reload).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    loaded();
    await Promise.resolve();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("disposes a session that finishes initialization after timeout", async () => {
    vi.useFakeTimers();
    let created = () => {};
    sdk.create.mockImplementationOnce(() => new Promise((resolve) => { created = () => resolve({ session: sdk.session }); }));
    const rejected = expect(runChild(request(), deps())).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(sdk.session.dispose).not.toHaveBeenCalled();
    created();
    await Promise.resolve();
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
    expect(sdk.session.prompt).not.toHaveBeenCalled();
  });
  it("uses only explicit resources and disposes the completed session", async () => {
    const d = deps();
    const req = request();
    expect(await runChild(req, d)).toEqual({ answer: "answer", depth: 1 });
    expect(sdk.loader).toHaveBeenCalledWith(expect.objectContaining({
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    }));
    const options = sdk.loader.mock.calls[0]?.[0] as { extensionFactories: ((pi: ExtensionAPI) => void)[] };
    const pi = {} as ExtensionAPI;
    options.extensionFactories[1]?.(pi);
    expect(d.register).toHaveBeenCalledWith(pi, 1, req.store);
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ model: request().model, thinkingLevel: "low", excludeTools: ["bash", "edit", "write"] }));
    expect(sdk.overrides).toHaveBeenCalledWith({ defaultTools: ["+codemode"] });
    expect(sdk.settings).toHaveBeenCalledWith({ compaction: { enabled: false } });
    expect(sdk.session.prompt).toHaveBeenCalledWith("Task: question");
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
  });

  it("rejects missing answers and always disposes", async () => {
    sdk.session.getLastAssistantText.mockReturnValueOnce(undefined);
    await expect(runChild(request(), deps())).rejects.toThrow(/without an answer/);
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
  });

  it("disposes when binding or prompting fails", async () => {
    sdk.session.bindExtensions.mockRejectedValueOnce(new Error("bind failed"));
    await expect(runChild(request(), deps())).rejects.toThrow("bind failed");
    sdk.session.prompt.mockRejectedValueOnce(new Error("prompt failed"));
    await expect(runChild(request(), deps())).rejects.toThrow("prompt failed");
    expect(sdk.session.dispose).toHaveBeenCalledTimes(2);
  });

  it("does not create a session for an already-aborted request", async () => {
    await expect(runChild({ ...request(), signal: AbortSignal.abort(new Error("cancelled")) }, deps())).rejects.toThrow("cancelled");
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("catches cancellation during SDK initialization", async () => {
    const controller = new AbortController();
    sdk.create.mockImplementationOnce(async () => { controller.abort(); return { session: sdk.session }; });
    await expect(runChild({ ...request(), signal: controller.signal }, deps())).rejects.toThrow(/aborted/);
    expect(sdk.session.prompt).not.toHaveBeenCalled();
    expect(sdk.session.abort).not.toHaveBeenCalled();
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a timed-out partial answer even if prompt ignores abort", async () => {
    vi.useFakeTimers();
    sdk.session.prompt.mockImplementationOnce(() => new Promise(() => {}));
    sdk.session.getLastAssistantText.mockReturnValueOnce("partial");
    const result = runChild(request(), deps());
    const rejected = expect(result).rejects.toThrow(/timed out after 1000ms/);
    await vi.waitFor(() => expect(sdk.session.prompt).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(sdk.session.abort).toHaveBeenCalledOnce();
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels active work and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    sdk.session.prompt.mockImplementationOnce(() => new Promise(() => {}));
    sdk.session.abort.mockRejectedValueOnce(new Error("already disposed"));
    const result = runChild({ ...request(), signal: controller.signal }, deps());
    const rejected = expect(result).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(sdk.session.prompt).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(sdk.session.dispose).toHaveBeenCalledOnce();
  });

  it("does not start prompting when a binding times out", async () => {
    vi.useFakeTimers();
    let bound = () => {};
    sdk.session.bindExtensions.mockImplementationOnce(() => new Promise<void>((resolve) => { bound = resolve; }));
    const rejected = expect(runChild(request(), deps())).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(sdk.session.bindExtensions).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    bound();
    await Promise.resolve();
    expect(sdk.session.prompt).not.toHaveBeenCalled();
  });
});
