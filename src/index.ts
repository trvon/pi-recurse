import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild } from "./child.js";
import { describeConfig, loadConfig } from "./config.js";
import { HandleStore } from "./handles.js";
import { registerTools, restoreStructuredResults } from "./tools.js";
import { Worker } from "./worker.js";

export { CHILD_EXCLUDED_TOOLS, childPrompt, runChild } from "./child.js";
export { CONFIG_FILE, configPaths, DEFAULTS, describeConfig, loadConfig, parseModelSpec, resolveConfig } from "./config.js";
export { HandleStore } from "./handles.js";
export { registerTools, restoreStructuredResults } from "./tools.js";
export { Worker } from "./worker.js";

/**
 * Pi extension entry point: registers the RLM tools (codemode-only by default).
 * rlm_query children register the same tools one level deeper, sharing the handle
 * store and the worker (so the call budget and concurrency limit cover the whole tree).
 */
export default function piRecurse(pi: ExtensionAPI): void {
  const { config, sources, warnings } = loadConfig();
  const store = new HandleStore();
  const worker = new Worker(config);
  const register = (api: ExtensionAPI, depth: number): void =>
    registerTools(api, { store, worker, config, depth, runChild: (req) => runChild(req, { store, worker, config, register }) });
  register(pi, 0);
  restoreStructuredResults(pi);

  let warned = false;
  pi.on("session_start", (_event, ctx) => {
    if (warned || warnings.length === 0) return;
    warned = true;
    try {
      ctx.ui.notify(`pi-recurse config:\n${warnings.join("\n")}`, "warning");
    } catch {
      // no UI (print mode)
    }
  });

  pi.registerCommand("recurse", {
    description: "Show pi-recurse settings and the config files they came from",
    handler: async (_args, ctx) => {
      const files = sources.length ? sources.join("\n") : "(none: built-in defaults)";
      const text = [`files:\n${files}`, JSON.stringify(describeConfig(config), null, 2), ...(warnings.length ? [`warnings:\n${warnings.join("\n")}`] : [])].join("\n\n");
      ctx.ui.notify(text, "info");
    },
  });
}
