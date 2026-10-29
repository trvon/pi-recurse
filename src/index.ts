import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { HandleStore } from "./handles.js";
import { registerTools } from "./tools.js";
import { Worker } from "./worker.js";

export { loadConfig, parseModelSpec } from "./config.js";
export { HandleStore } from "./handles.js";
export { Worker } from "./worker.js";

/** Pi extension entry point: registers the RLM tools (codemode-only by default). */
export default function piRecurse(pi: ExtensionAPI): void {
  const config = loadConfig();
  registerTools(pi, new HandleStore(), new Worker(config), config);
}
