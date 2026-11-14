import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RecurseConfig, ThinkingLevel } from "./config.js";
import { parseModelSpec } from "./config.js";
import { Limiter } from "./limiter.js";

/** The parts of pi's model registry this extension uses. */
export interface ModelRuntime {
  find(provider: string, modelId: string): unknown | undefined;
  completeSimple(model: unknown, context: unknown, options?: { signal?: AbortSignal; maxTokens?: number; reasoning?: Exclude<ThinkingLevel, "off">; temperature?: number }): Promise<WorkerMessage>;
}

/** Adapt Pi's extension facade, which exposes streamSimple but not completeSimple. */
export function workerRuntime(registry: Pick<ModelRegistry, "find" | "streamSimple">): ModelRuntime {
  return {
    find: (provider, id) => registry.find(provider, id),
    completeSimple: (model, context, options) => registry.streamSimple(
      // Models come from this registry; Worker builds a single-user-message Context.
      model as Parameters<ModelRegistry["streamSimple"]>[0],
      context as Parameters<ModelRegistry["streamSimple"]>[1],
      options,
    ).result(),
  };
}

/** The parts of an assistant message this extension reads. */
export interface WorkerMessage {
  content: { type: string; text?: string }[];
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
}

export interface QueryInput {
  prompt: string;
  /** Text inserted before the prompt as context. */
  context?: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface QueryResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason: string;
  truncated: boolean;
  empty: boolean;
  /** Wall time including limiter queueing. */
  durationMs: number;
}

/**
 * Whether a model is served from this machine or the local network, judged by its base URL:
 * loopback, private IPv4 ranges, link-local, IPv6 unique-local, and `.local` / `.localhost` names.
 */
export function isLocalModel(model: unknown): boolean {
  const baseUrl = (model as { baseUrl?: unknown } | undefined)?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export class Worker {
  private calls = 0;
  private readonly limiter: Limiter;
  private readonly childLimiters = new Map<number, Limiter>();

  constructor(private readonly config: RecurseConfig) {
    this.limiter = new Limiter(config.concurrency);
  }

  /** Limit active children per depth, not globally: a parent must be able to await a descendant. */
  runChild<T>(depth: number, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let limiter = this.childLimiters.get(depth);
    if (!limiter) {
      limiter = new Limiter(this.config.childConcurrency);
      this.childLimiters.set(depth, limiter);
    }
    return limiter.run(task, signal);
  }

  get callsUsed(): number {
    return this.calls;
  }

  get callsLeft(): number {
    return Math.max(0, this.config.maxCalls - this.calls);
  }

  /**
   * Model to use: the per-call override; else the session model when it is local and
   * `preferLocalSessionModel` is on (it is already loaded); else `configured` (the worker, or the
   * child model for rlm_query); else the session model.
   */
  resolveModel(
    runtime: ModelRuntime, sessionModel: unknown, override?: string, configured: RecurseConfig["worker"] = this.config.worker,
  ): { model: unknown; name: string } {
    const parsed = override ? parseModelSpec(override) : undefined;
    if (override && !parsed) throw new Error(`model "${override}" must look like "provider/model"`);
    const preferSession = !parsed && this.config.preferLocalSessionModel && sessionModel !== undefined && isLocalModel(sessionModel);
    const spec = parsed ?? (preferSession ? undefined : configured);
    if (spec) {
      const model = runtime.find(spec.provider, spec.model);
      if (!model) throw new Error(`model ${spec.provider}/${spec.model} is not configured in pi`);
      return { model, name: `${spec.provider}/${spec.model}` };
    }
    if (!sessionModel) throw new Error("no worker model: set worker in pi-recurse.json or pick a session model");
    const m = sessionModel as { provider?: string; id?: string };
    return { model: sessionModel, name: `${m.provider ?? "?"}/${m.id ?? "?"}` };
  }

  buildPrompt(input: QueryInput): string {
    const prompt = input.context === undefined ? input.prompt : `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
    if (prompt.length > this.config.maxPromptChars) {
      throw new Error(
        `sub-query is ${prompt.length} chars; the limit is ${this.config.maxPromptChars}. Split the context into smaller pieces (rlm_peek ranges or files).`,
      );
    }
    return prompt;
  }

  async query(runtime: ModelRuntime, sessionModel: unknown, input: QueryInput, signal?: AbortSignal): Promise<QueryResult> {
    const started = performance.now();
    signal?.throwIfAborted();
    const { model, name } = this.resolveModel(runtime, sessionModel, input.model);
    const prompt = this.buildPrompt(input);
    const message = await this.limiter.run(() => {
      if (this.calls >= this.config.maxCalls) {
        throw new Error(`llm_query budget of ${this.config.maxCalls} calls is used up (maxCalls in pi-recurse.json)`);
      }
      this.calls++;
      // completeSimple maps provider-neutral reasoning to the model's native options.
      // "off" is represented by an absent reasoning level in Pi's simple API.
      return runtime.completeSimple(
        model,
        {
          systemPrompt: input.system ?? this.config.workerSystemPrompt,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          signal,
          maxTokens: input.maxTokens ?? this.config.workerMaxTokens,
          reasoning: this.config.workerThinking === "off" ? undefined : this.config.workerThinking,
          temperature: this.config.workerTemperature,
        },
      );
    }, signal);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(`worker ${name} failed: ${message.errorMessage ?? message.stopReason}`);
    }
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      text, model: name, inputTokens: message.usage?.input, outputTokens: message.usage?.output,
      stopReason: message.stopReason ?? "unknown", truncated: message.stopReason === "length",
      empty: text.trim().length === 0, durationMs: Math.round(performance.now() - started),
    };
  }
}
