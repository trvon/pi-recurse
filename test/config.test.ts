import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configPaths, DEFAULTS, describeConfig, loadConfig, parseModelSpec, resolveConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("configuration edge cases", () => {
  it("keeps the session model by default and preserves slash-containing model IDs", () => {
    expect(DEFAULTS.worker).toBeUndefined();
    expect(DEFAULTS.child).toBeUndefined();
    for (const value of [undefined, null, "", "/model", "provider/"]) expect(parseModelSpec(value)).toBeUndefined();
    expect(parseModelSpec("openrouter/vendor/model")).toEqual({ provider: "openrouter", model: "vendor/model" });
  });

  it("merges global/project model preferences and clears overrides with null", () => {
    const layers = [
      { source: "global", data: { worker: "local/worker", childModel: "local/child" } },
      { source: "project", data: { childModel: null, worker: null } },
    ];
    expect(resolveConfig(layers).config).toEqual(DEFAULTS);
    expect(describeConfig(resolveConfig(layers.slice(0, 1)).config)).toMatchObject({ worker: "local/worker", childModel: "local/child" });
  });

  it("warns about malformed objects, enums, model specs and integer settings", () => {
    const invalid = resolveConfig([
      { source: "null", data: null },
      { source: "scalar", data: 1 },
      { source: "invalid", data: { concurrency: 1.5, childThinking: "fast", childModel: 42, exposure: "hidden", $schema: "ignored" } },
    ]);
    expect(invalid.config).toEqual(DEFAULTS);
    expect(invalid.warnings).toHaveLength(6);
    expect(invalid.warnings.join("\n")).toContain("childThinking must be one of");
    expect(invalid.warnings.join("\n")).toContain("exposure must be");
  });

  it("formats every effective setting, including direct exposure", () => {
    expect(describeConfig({ ...DEFAULTS, exposure: "direct" })).toEqual({
      worker: null, childModel: null, concurrency: 2, maxCalls: 500, maxPromptChars: 200_000,
      maxLoadBytes: 67_108_864, maxLoadFiles: 5000, exposure: "direct", maxDepth: 2,
      childThinking: "low", childTimeoutMs: 600_000, steer: true,
    });
  });

  it("validates the steering switch without changing it on invalid input", () => {
    expect(resolveConfig([{ source: "p", data: { steer: false } }]).config.steer).toBe(false);
    const invalid = resolveConfig([{ source: "p", data: { steer: "no" } }]);
    expect(invalid.config.steer).toBe(true);
    expect(invalid.warnings).toEqual(["p: steer must be true or false; ignored"]);
  });

  it("uses Pi's agent-dir override for discovery (not for setting values)", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom-agent");
    expect(configPaths("/project")).toEqual([join("/custom-agent", "pi-recurse.json"), join("/project", ".pi", "pi-recurse.json")]);
  });

  it("reports a non-object project file and retains global values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recurse-config-"));
    roots.push(root);
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(root, "pi-recurse.json"), '{"worker":"local/worker"}');
    await writeFile(join(cwd, ".pi", "pi-recurse.json"), "false");
    const loaded = loadConfig({ cwd, agentDir: root });
    expect(loaded.config.worker).toEqual({ provider: "local", model: "worker" });
    expect(loaded.warnings).toEqual([`${join(cwd, ".pi", "pi-recurse.json")}: expected a JSON object`]);
  });
});
