import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

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
  childThinking: ThinkingLevel;
  /** Wall-clock limit for one rlm_query child, in milliseconds. */
  childTimeoutMs: number;
  /** Add a system prompt guideline that points the model at the RLM tools for large inputs. */
  steer: boolean;
}

/** The JSON file format: every key optional, models as "provider/model" strings. */
export interface RecurseConfigFile {
  worker?: string | null;
  concurrency?: number;
  maxCalls?: number;
  maxPromptChars?: number;
  maxLoadBytes?: number;
  maxLoadFiles?: number;
  exposure?: "codemode" | "direct";
  maxDepth?: number;
  childModel?: string | null;
  childThinking?: ThinkingLevel;
  childTimeoutMs?: number;
  steer?: boolean;
}

export const CONFIG_FILE = "pi-recurse.json";

export const DEFAULTS: RecurseConfig = {
  worker: undefined,
  concurrency: 2,
  maxCalls: 500,
  maxPromptChars: 200_000,
  maxLoadBytes: 64 * 1024 * 1024,
  maxLoadFiles: 5000,
  exposure: "codemode",
  maxDepth: 2,
  child: undefined,
  childThinking: "low",
  childTimeoutMs: 600_000,
  steer: true,
};

const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Integer keys with their minimum allowed value. */
const INTEGERS = {
  concurrency: 1,
  maxCalls: 1,
  maxPromptChars: 1000,
  maxLoadBytes: 1024,
  maxLoadFiles: 1,
  maxDepth: 0,
  childTimeoutMs: 1000,
} as const satisfies Partial<Record<keyof RecurseConfigFile, number>>;

export function parseModelSpec(spec: string | undefined | null): { provider: string; model: string } | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

export interface LoadedConfig {
  config: RecurseConfig;
  /** Files that were read, lowest precedence first. */
  sources: string[];
  /** Problems found; the affected keys keep their earlier value. */
  warnings: string[];
}

/**
 * Merge config layers over the defaults, later layers winning. Invalid values are reported
 * and skipped, so a typo never turns into a surprising setting.
 */
export function resolveConfig(layers: { source: string; data: unknown }[]): LoadedConfig {
  const config: RecurseConfig = { ...DEFAULTS };
  const warnings: string[] = [];
  for (const { source, data } of layers) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      warnings.push(`${source}: expected a JSON object`);
      continue;
    }
    const raw = data as Record<string, unknown>;
    const bad = (key: string, why: string) => warnings.push(`${source}: ${key} ${why}; ignored`);
    for (const key of Object.keys(raw)) {
      const value = raw[key];
      if (key in INTEGERS) {
        const min = INTEGERS[key as keyof typeof INTEGERS];
        if (typeof value === "number" && Number.isInteger(value) && value >= min) config[key as keyof typeof INTEGERS] = value;
        else bad(key, `must be an integer >= ${min}`);
      } else if (key === "worker" || key === "childModel") {
        const target = key === "worker" ? "worker" : "child";
        if (value === null) config[target] = undefined;
        else if (typeof value === "string" && parseModelSpec(value)) config[target] = parseModelSpec(value);
        else bad(key, 'must look like "provider/model" (or null for the session model)');
      } else if (key === "exposure") {
        if (value === "codemode" || value === "direct") config.exposure = value;
        else bad(key, 'must be "codemode" or "direct"');
      } else if (key === "steer") {
        if (typeof value === "boolean") config.steer = value;
        else bad(key, "must be true or false");
      } else if (key === "childThinking") {
        if (typeof value === "string" && (THINKING as readonly string[]).includes(value)) config.childThinking = value as ThinkingLevel;
        else bad(key, `must be one of ${THINKING.join(", ")}`);
      } else if (key !== "$schema") {
        warnings.push(`${source}: unknown key "${key}"; ignored`);
      }
    }
  }
  return { config, sources: layers.map((l) => l.source), warnings };
}

/** Global file in the pi agent dir, then the project's `.pi/` file (which wins). */
export function configPaths(cwd: string, agentDir = defaultAgentDir()): string[] {
  return [join(agentDir, CONFIG_FILE), join(cwd, ".pi", CONFIG_FILE)];
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function loadConfig(options: { cwd?: string; agentDir?: string } = {}): LoadedConfig {
  const layers: { source: string; data: unknown }[] = [];
  const warnings: string[] = [];
  for (const path of configPaths(options.cwd ?? process.cwd(), options.agentDir)) {
    if (!existsSync(path)) continue;
    try {
      layers.push({ source: path, data: JSON.parse(readFileSync(path, "utf8")) });
    } catch (e) {
      warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}; file ignored`);
    }
  }
  const loaded = resolveConfig(layers);
  return { ...loaded, warnings: [...warnings, ...loaded.warnings] };
}

/** The effective settings in file format, for display. */
export function describeConfig(config: RecurseConfig): RecurseConfigFile {
  const spec = (m: RecurseConfig["worker"]) => (m ? `${m.provider}/${m.model}` : null);
  return {
    worker: spec(config.worker),
    concurrency: config.concurrency,
    maxCalls: config.maxCalls,
    maxPromptChars: config.maxPromptChars,
    maxLoadBytes: config.maxLoadBytes,
    maxLoadFiles: config.maxLoadFiles,
    exposure: config.exposure === "direct" ? "direct" : "codemode",
    maxDepth: config.maxDepth,
    childModel: spec(config.child),
    childThinking: config.childThinking,
    childTimeoutMs: config.childTimeoutMs,
    steer: config.steer,
  };
}
