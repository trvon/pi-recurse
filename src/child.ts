import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import type { Worker } from "./worker.js";

/** Builtin tools a child must not have: it answers questions, it does not change the workspace. */
export const CHILD_EXCLUDED_TOOLS = ["bash", "edit", "write"];

export const CHILD_SYSTEM_PROMPT = `You are a sub-agent of a Recursive Language Model.
Answer one task about input that is held by handle, not pasted into this conversation.
Work through the codemode tool: in scripts, use tools.rlm_peek to search and read parts of a handle,
tools.llm_query / tools.llm_query_batched to ask a worker model about slices, and tools.rlm_query to
delegate a sub-task to another sub-agent when the task splits naturally. Keep script output small.
Reply with the answer only: no preamble, no description of your process.`;

export interface ChildRequest {
  cwd: string;
  task: string;
  /** Handle summaries the child should work on. */
  handles: { handle: string; label: string; files: number; lines: number; chars: number }[];
  /** Depth of the child: 1 for a child of the top-level session. */
  depth: number;
  model: unknown;
  signal?: AbortSignal;
}

export interface ChildResult {
  answer: string;
  depth: number;
}

/** Everything a child needs to register the same tools against the shared state. */
export interface ChildDeps {
  store: HandleStore;
  worker: Worker;
  config: RecurseConfig;
  register: (pi: ExtensionAPI, depth: number) => void;
}

export function childPrompt(req: Pick<ChildRequest, "task" | "handles">): string {
  const lines = req.handles.map((h) => `- handle "${h.handle}" (${h.label}): ${h.files} files, ${h.lines} lines, ${h.chars} chars`);
  return `${req.handles.length ? `Input:\n${lines.join("\n")}\n\n` : ""}Task: ${req.task}`;
}

/** Run one task in a fresh in-process pi session with codemode and the RLM tools at `depth`. */
export async function runChild(req: ChildRequest, deps: ChildDeps): Promise<ChildResult> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: req.cwd,
    agentDir: sdk.getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: CHILD_SYSTEM_PROMPT,
    extensionFactories: [sdk.createCodemodeExtension({ mode: "on" }), (pi: ExtensionAPI) => deps.register(pi, req.depth)],
  });
  await resourceLoader.reload();

  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

  const { session } = await sdk.createAgentSession({
    cwd: req.cwd,
    model: req.model as never,
    thinkingLevel: deps.config.childThinking,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(req.cwd),
    excludeTools: CHILD_EXCLUDED_TOOLS,
  });

  const abort = () => void session.abort();
  req.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deps.config.childTimeoutMs);
  try {
    await session.bindExtensions({});
    await session.prompt(childPrompt(req));
    if (req.signal?.aborted) throw new Error("rlm_query aborted");
    const answer = session.getLastAssistantText()?.trim();
    if (!answer) throw new Error("child finished without an answer (timeout or error)");
    return { answer, depth: req.depth };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}
