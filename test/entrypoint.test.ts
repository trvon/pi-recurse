import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type LoadedConfig } from "../src/config.js";
import piRecurse from "../src/index.js";

const config = vi.hoisted(() => ({ load: vi.fn<() => LoadedConfig>() }));
vi.mock("../src/config.js", async (original) => ({ ...await original<typeof import("../src/config.js")>(), loadConfig: config.load }));

function setup(loaded: LoadedConfig) {
  config.load.mockReturnValue(loaded);
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools: string[] = [];
  // SAFETY: the fake implements the three registration APIs used by the extension entry point.
  piRecurse({
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  return { events, commands, tools };
}

beforeEach(() => vi.clearAllMocks());

describe("extension entry point", () => {
  it("registers tools/hooks and displays defaults without config files", async () => {
    const { tools, events, commands } = setup({ config: DEFAULTS, sources: [], warnings: [] });
    expect(tools).toHaveLength(6);
    expect(events.has("tool_result")).toBe(true);
    const notify = vi.fn();
    events.get("session_start")?.({}, { ui: { notify } });
    expect(notify).not.toHaveBeenCalled();
    await commands.get("recurse")?.handler("", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("(none: built-in defaults)"), "info");
    expect(notify.mock.calls[0]?.[0]).toContain('"worker": null');
  });

  it("shows sources and warnings and only notifies once", async () => {
    const { events, commands } = setup({ config: DEFAULTS, sources: ["global.json", "project.json"], warnings: ["bad setting"] });
    const notify = vi.fn();
    events.get("session_start")?.({}, { ui: { notify } });
    events.get("session_start")?.({}, { ui: { notify } });
    expect(notify).toHaveBeenCalledExactlyOnceWith("pi-recurse config:\nbad setting", "warning");
    await commands.get("recurse")?.handler("", { ui: { notify } });
    expect(notify.mock.calls[1]?.[0]).toContain("global.json\nproject.json");
    expect(notify.mock.calls[1]?.[0]).toContain("warnings:\nbad setting");
  });

  it("tolerates a missing UI in print mode", () => {
    const { events } = setup({ config: DEFAULTS, sources: [], warnings: ["bad setting"] });
    expect(() => events.get("session_start")?.({}, {})).not.toThrow();
  });
});
