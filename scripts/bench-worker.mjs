#!/usr/bin/env node
// Explicit live-model benchmark; unlike `npm run bench`, this uses configured credentials.
// Build first. Usage: node scripts/bench-worker.mjs provider/model [baseline|default]
// baseline reproduces the old unbounded generation, but has a 60s cancellation deadline.
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULTS } from "../dist/config.js";
import { Worker, workerRuntime } from "../dist/worker.js";

const [spec, mode = "default"] = process.argv.slice(2);
if (!spec?.includes("/") || !["baseline", "default"].includes(mode)) {
  console.error("Usage: node scripts/bench-worker.mjs provider/model [baseline|default]");
  process.exit(1);
}
const slash = spec.indexOf("/");
const runtime = await ModelRuntime.create();
try {
  const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) throw new Error(`model ${spec} is not configured`);
  const fixture = ('// Worker configuration reference.\nworker = "local/small"\nconcurrency = 2\nmaxCalls = 500\n' +
    '// Context stays outside the parent conversation; inspect selected slices before querying.\n'.repeat(400)).slice(0, 32_768);
  let completion;
  const simple = workerRuntime(new ModelRegistry(runtime));
  const capture = async (method, ...args) => {
    completion = await (method === "completeSimple" ? simple.completeSimple(...args) : runtime.complete(...args));
    return completion;
  };
  const adapter = {
    find: (provider, id) => runtime.getModel(provider, id),
    complete: (...args) => capture("complete", ...args),
    completeSimple: (...args) => capture("completeSimple", ...args),
  };
  const input = { prompt: "List the distinct configuration keys in this text, one per line, nothing else.", context: fixture };
  const start = performance.now();
  try {
    const signal = AbortSignal.timeout(60_000);
    const result = mode === "baseline"
      ? await adapter.complete(model, { messages: [{ role: "user", content: `<context>\n${fixture}\n</context>\n\n${input.prompt}`, timestamp: Date.now() }] }, { signal })
      : await new Worker(DEFAULTS).query(adapter, model, input, signal);
    if (completion.stopReason === "aborted" || completion.stopReason === "error") process.exitCode = 1;
    const answer = mode === "baseline" ? completion.content.filter((c) => c.type === "text").map((c) => c.text).join("") : result.text;
    const expected = ["concurrency", "maxCalls", "worker"];
    const correct = JSON.stringify([...new Set(answer.trim().split("\n").map(line => line.trim()))].sort()) === JSON.stringify(expected);
    if (!correct) process.exitCode = 1;
    console.log(JSON.stringify({ mode, model: spec, correct, reasoning_capable: model.reasoning, supports_reasoning_effort: model.compat?.supportsReasoningEffort ?? null, fixture_bytes: Buffer.byteLength(fixture), duration_ms: Math.round(performance.now() - start), output_tokens: completion.usage?.output, input_tokens: completion.usage?.input, answer_chars: answer.length, stop_reason: completion.stopReason, answer }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ mode, model: spec, duration_ms: Math.round(performance.now() - start), error: String(error) }));
    process.exitCode = 1;
  }
} finally {
  await runtime.dispose?.();
}
