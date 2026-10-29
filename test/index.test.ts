import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piRecurse, { steeringGuideline } from "../src/index.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function load(file?: object) {
  const dir = mkdtempSync(join(tmpdir(), "pi-recurse-agent-"));
  if (file) writeFileSync(join(dir, "pi-recurse.json"), JSON.stringify(file));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
  } as unknown as ExtensionAPI;
  piRecurse(pi);
  return (selectedTools: string[]) => {
    const options = { selectedTools, promptGuidelines: [] as string[] };
    for (const h of handlers.get("before_agent_start") ?? []) h({ systemPromptOptions: options });
    return options.promptGuidelines;
  };
}

describe("steering", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds one guideline while codemode is active", () => {
    const start = load();
    expect(start(["read", "codemode"])).toEqual([steeringGuideline("codemode")]);
    expect(start(["read", "bash"])).toEqual([]);
    expect(steeringGuideline("codemode")).toContain("tools.rlm_load");
  });

  it("follows direct exposure and can be turned off", () => {
    expect(load({ exposure: "direct" })(["rlm_load"])).toEqual([steeringGuideline("direct")]);
    expect(load({ steer: false })(["codemode"])).toEqual([]);
  });
});
