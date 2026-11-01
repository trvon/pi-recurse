import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecurseConfig } from "./config.js";
import type { HandleStore } from "./handles.js";
import type { Worker } from "./worker.js";

/** Builtin tools a child must not have: it answers questions, it does not change the workspace. */
export const CHILD_EXCLUDED_TOOLS = ["bash", "edit", "write"];

export const CHILD_SYSTEM_PROMPT = `You are a sub-agent of a Recursive Language Model.
Answer one task about input held by handle, not pasted into this conversation.
Use tools.rlm_peek to search/select relevant slices. Prefer one combined tools.llm_query when it fits.
Batch only independent shards. Reserve tools.rlm_query for branches needing their own search loop.
Check error/truncated/empty before using worker answers. Keep script output small and retain intermediate
JSON with codemode store/load. Your default handle is the assigned input; other sessions' handles are unavailable.
Reply with the answer only: no preamble, no description of your process.`;

export interface ChildRequest {
  cwd: string;
  task: string;
  /** Scoped view: only assigned input and this child's own allocations. */
  store: HandleStore;
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

export interface ChildDeps {
  store: HandleStore;
  worker: Worker;
  config: RecurseConfig;
  register: (pi: ExtensionAPI, depth: number, store: HandleStore) => void;
}

export function childPrompt(req: Pick<ChildRequest, "task" | "handles">): string {
  const lines = req.handles.map((h) => `- handle "${h.handle}" (${h.label}): ${h.files} files, ${h.lines} lines, ${h.chars} chars`);
  return `${req.handles.length ? `Input:\n${lines.join("\n")}\n\n` : ""}Task: ${req.task}`;
}

/** Run one bounded, read-only session; the deadline also covers SDK/resource initialization. */
export async function runChild(req: ChildRequest, deps: ChildDeps): Promise<ChildResult> {
  req.signal?.throwIfAborted();
  let session: AgentSession | undefined;
  let stopped: Error | undefined;
  let stop = (_message: string) => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = (message) => {
      if (stopped) return;
      stopped = new Error(message);
      reject(stopped);
      // Abort failure cannot mask the original cancellation.
      if (session) void session.abort().catch(() => {});
    };
  });
  const abort = () => stop("rlm_query aborted");
  req.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(`rlm_query timed out after ${deps.config.childTimeoutMs}ms`), deps.config.childTimeoutMs);
  let unsubscribe: (() => void) | undefined;
  const work = async (): Promise<ChildResult> => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    if (stopped) throw stopped;
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: req.cwd,
      agentDir: sdk.getAgentDir(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: CHILD_SYSTEM_PROMPT,
      extensionFactories: [sdk.createCodemodeExtension({ mode: "on" }), (pi: ExtensionAPI) => deps.register(pi, req.depth, req.store)],
    });
    await resourceLoader.reload();
    if (stopped) throw stopped;
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
    settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
    const created = await sdk.createAgentSession({
      cwd: req.cwd, model: req.model as never, thinkingLevel: deps.config.childThinking,
      resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory(req.cwd),
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });
    // A factory may finish after the caller's timeout. Dispose its late session too.
    if (stopped) {
      created.session.dispose();
      throw stopped;
    }
    session = created.session;
    let turns = 0;
    unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start" && ++turns > deps.config.childMaxTurns) stop(`rlm_query exceeded childMaxTurns (${deps.config.childMaxTurns})`);
    });
    await session.bindExtensions({});
    if (stopped) throw stopped;
    await session.prompt(childPrompt(req));
    if (stopped) throw stopped;
    const answer = session.getLastAssistantText()?.trim();
    if (!answer) throw new Error("child finished without an answer (timeout or error)");
    return { answer, depth: req.depth };
  };
  try {
    if (req.signal?.aborted) abort();
    return await Promise.race([work(), cancelled]);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    session?.dispose();
  }
}
