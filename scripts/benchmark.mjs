#!/usr/bin/env node
// Deterministic local handle workload; no model calls or credentials needed.
// Run after npm run build. Optional: node --cpu-prof scripts/benchmark.mjs
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HandleStore } from "../dist/handles.js";

const root = await mkdtemp(join(tmpdir(), "pi-recurse-bench-"));
try {
  const text = Array.from({ length: 30_000 }, (_, i) => `row ${String(i).padStart(5, "0")} needle ${"x".repeat(48)}`).join("\n");
  await writeFile(join(root, "large.txt"), text);
  const store = new HandleStore();
  const { handle } = await store.loadFiles(["large.txt"], { cwd: root, maxBytes: 8 * 1024 * 1024, maxFiles: 10 });
  const workloads = [
    ["lineRange (30 slices)", () => { for (let i = 0; i < 30; i++) store.lineRange(handle, 25_000 + i, 10); }],
    ["grep (1000 late-file matches)", () => store.grep(handle, "^row 2[89]", { maxMatches: 1000 })],
    ["matching files (dense matches)", () => store.matchingFiles ? store.matchingFiles(handle, "needle") : [...new Set(store.grep(handle, "needle", { maxMatches: Number.MAX_SAFE_INTEGER }).map((m) => m.file).filter(Boolean))]],
  ];
  console.log(`Node ${process.version}; ${text.length} chars; 30000 lines; median of 5 samples (after warmup)`);
  for (const [name, run] of workloads) {
    run();
    const times = Array.from({ length: 5 }, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a, b) => a - b);
    console.log(`${name}: ${times[2].toFixed(2)} ms`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
