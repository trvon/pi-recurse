import type { RecurseConfig } from "./config.js";
import { parseModelSpec } from "./config.js";
import { Limiter } from "./limiter.js";

/** The parts of pi's model registry this extension uses. */
export interface ModelRuntime {
  find(provider: string, modelId: string): unknown | undefined;
  complete(model: unknown, context: unknown, options?: { signal?: AbortSignal; maxTokens?: number }): Promise<WorkerMessage>;
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
}

export class Worker {
  private calls = 0;
  private readonly limiter: Limiter;

  constructor(private readonly config: RecurseConfig) {
    this.limiter = new Limiter(config.concurrency);
  }

  get callsUsed(): number {
    return this.calls;
  }

  get callsLeft(): number {
    return Math.max(0, this.config.maxCalls - this.calls);
  }

  /** Model to use: per-call override, then PI_RECURSE_WORKER, then the session's model. */
  resolveModel(runtime: ModelRuntime, sessionModel: unknown, override?: string): { model: unknown; name: string } {
    const spec = override ? parseModelSpec(override) : this.config.worker;
    if (override && !spec) throw new Error(`model "${override}" must look like "provider/model"`);
    if (spec) {
      const model = runtime.find(spec.provider, spec.model);
      if (!model) throw new Error(`model ${spec.provider}/${spec.model} is not configured in pi`);
      return { model, name: `${spec.provider}/${spec.model}` };
    }
    if (!sessionModel) throw new Error("no worker model: set PI_RECURSE_WORKER=provider/model or pick a session model");
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
    const { model, name } = this.resolveModel(runtime, sessionModel, input.model);
    const prompt = this.buildPrompt(input);
    if (this.calls >= this.config.maxCalls) {
      throw new Error(`llm_query budget of ${this.config.maxCalls} calls is used up (PI_RECURSE_MAX_CALLS)`);
    }
    this.calls++;
    const message = await this.limiter.run(() =>
      runtime.complete(
        model,
        {
          systemPrompt: input.system,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        { signal, maxTokens: input.maxTokens },
      ),
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(`worker ${name} failed: ${message.errorMessage ?? message.stopReason}`);
    }
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return { text, model: name, inputTokens: message.usage?.input, outputTokens: message.usage?.output };
  }
}
