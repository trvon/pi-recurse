import type { ToolExposure } from "@earendil-works/pi-coding-agent";

export interface RecurseConfig {
  /** Worker model as "provider/model". Unset: the session's current model. */
  worker: { provider: string; model: string } | undefined;
  /** Sub-queries run at once. Match the worker server's slots (llama-server -np). */
  concurrency: number;
  /** Total llm_query calls allowed per process, as a runaway guard. */
  maxCalls: number;
  /** Largest prompt (context + question) sent in one sub-query, in characters. */
  maxPromptChars: number;
  /** Largest total size one rlm_load may read, in bytes. */
  maxLoadBytes: number;
  /** Most files one rlm_load may read. */
  maxLoadFiles: number;
  /** How the model reaches the tools: only from codemode scripts, or directly too. */
  exposure: ToolExposure;
  /** Deepest rlm_query recursion: a child at this depth gets no rlm_query tool. */
  maxDepth: number;
  /** Model for rlm_query children as "provider/model". Unset: the worker, then the session model. */
  child: { provider: string; model: string } | undefined;
  /** Thinking level for rlm_query children. */
  childThinking: "off" | "minimal" | "low" | "medium" | "high";
  /** Wall-clock limit for one rlm_query child, in milliseconds. */
  childTimeoutMs: number;
}

const THINKING = ["off", "minimal", "low", "medium", "high"] as const;

function int(value: string | undefined, fallback: number, min = 1): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function parseModelSpec(spec: string | undefined): { provider: string; model: string } | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecurseConfig {
  const exposure = env.PI_RECURSE_EXPOSURE === "direct" ? "direct" : "codemode";
  return {
    worker: parseModelSpec(env.PI_RECURSE_WORKER),
    concurrency: int(env.PI_RECURSE_CONCURRENCY, 2),
    maxCalls: int(env.PI_RECURSE_MAX_CALLS, 500),
    maxPromptChars: int(env.PI_RECURSE_MAX_PROMPT_CHARS, 200_000, 1000),
    maxLoadBytes: int(env.PI_RECURSE_MAX_LOAD_BYTES, 64 * 1024 * 1024, 1024),
    maxLoadFiles: int(env.PI_RECURSE_MAX_LOAD_FILES, 5000),
    exposure,
    maxDepth: int(env.PI_RECURSE_MAX_DEPTH, 2, 0),
    child: parseModelSpec(env.PI_RECURSE_CHILD_MODEL),
    childThinking: (THINKING as readonly string[]).includes(env.PI_RECURSE_CHILD_THINKING ?? "")
      ? (env.PI_RECURSE_CHILD_THINKING as RecurseConfig["childThinking"])
      : "low",
    childTimeoutMs: int(env.PI_RECURSE_CHILD_TIMEOUT_MS, 600_000, 1000),
  };
}
