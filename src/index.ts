import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild } from "./child.js";
import { loadConfig } from "./config.js";
import { HandleStore } from "./handles.js";
import { registerTools, restoreStructuredResults } from "./tools.js";
import { Worker } from "./worker.js";

export { CHILD_EXCLUDED_TOOLS, childPrompt, runChild } from "./child.js";
export { loadConfig, parseModelSpec } from "./config.js";
export { HandleStore } from "./handles.js";
export { registerTools, restoreStructuredResults } from "./tools.js";
export { Worker } from "./worker.js";

/**
 * Pi extension entry point: registers the RLM tools (codemode-only by default).
 * rlm_query children register the same tools one level deeper, sharing the handle
 * store and the worker (so the call budget and concurrency limit cover the whole tree).
 */
export default function piRecurse(pi: ExtensionAPI): void {
  const config = loadConfig();
  const store = new HandleStore();
  const worker = new Worker(config);
  const register = (api: ExtensionAPI, depth: number): void =>
    registerTools(api, { store, worker, config, depth, runChild: (req) => runChild(req, { store, worker, config, register }) });
  register(pi, 0);
  restoreStructuredResults(pi);
}
