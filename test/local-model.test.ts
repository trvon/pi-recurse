import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { isLocalModel, type ModelRuntime, Worker } from "../src/worker.js";

describe("worker model policy", () => {
  const known = (provider: string, id: string) => ({ provider, id });
  const rt: ModelRuntime = { find: known, completeSimple: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  const local = { provider: "llamacpp", id: "qwen3.6-35b", baseUrl: "http://127.0.0.1:8080/v1" };
  const remote = { provider: "server", id: "qwen3-8-27b", baseUrl: "https://api.example.com/v1" };
  const cfg = (data: object) => resolveConfig([{ source: "t", data }]).config;

  it("recognizes local and LAN base URLs", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8080", "http://[::1]:1234", "http://192.168.1.20:8000/v1", "http://10.0.0.5", "http://172.20.0.2:8080", "http://box.local:8080", "http://[fd12::1]:80"]) {
      expect(isLocalModel({ baseUrl: url })).toBe(true);
    }
    for (const url of ["https://api.example.com/v1", "http://172.32.0.1", "http://8.8.8.8", "not a url", ""]) {
      expect(isLocalModel({ baseUrl: url })).toBe(false);
    }
    expect(isLocalModel(undefined)).toBe(false);
    expect(isLocalModel({ provider: "x" })).toBe(false);
  });

  it("uses a local session model over the configured worker, but never over a per-call model", () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint" }));
    expect(w.resolveModel(rt, local).name).toBe("llamacpp/qwen3.6-35b");
    expect(w.resolveModel(rt, remote).name).toBe("llamacpp/flint");
    expect(w.resolveModel(rt, local, "llamacpp/gemma4-12b").name).toBe("llamacpp/gemma4-12b");
    expect(w.resolveModel(rt, undefined).name).toBe("llamacpp/flint");
    // the child model is a configured default too
    expect(w.resolveModel(rt, local, undefined, { provider: "llamacpp", model: "kev-4b" }).name).toBe("llamacpp/qwen3.6-35b");
    expect(w.resolveModel(rt, remote, undefined, { provider: "llamacpp", model: "kev-4b" }).name).toBe("llamacpp/kev-4b");
  });

  it("keeps the configured worker when the preference is off", () => {
    const w = new Worker(cfg({ worker: "llamacpp/flint", preferLocalSessionModel: false }));
    expect(w.resolveModel(rt, local).name).toBe("llamacpp/flint");
    expect(resolveConfig([{ source: "t", data: { preferLocalSessionModel: "yes" } }]).warnings).toEqual(["t: preferLocalSessionModel must be true or false; ignored"]);
  });
});
