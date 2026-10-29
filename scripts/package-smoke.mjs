#!/usr/bin/env node
// Checks the packed tarball contents and that the built extension registers its tools.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
const parsed = JSON.parse(raw);
// npm <= 11 prints an array of reports; npm 12 prints an object keyed by package name.
const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
if (!report?.files) throw new Error("unexpected npm pack --json output");

const files = new Set(report.files.map((f) => f.path));
for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
  if (!files.has(required)) throw new Error(`tarball must include ${required}`);
}
for (const path of files) {
  if (path.startsWith("src/") || path.startsWith("test/")) throw new Error(`tarball must not include ${path}`);
}

const mod = await import(pathToFileURL(resolve("dist/index.js")).href);
const names = [];
const events = [];
mod.default({ registerTool: (tool) => names.push(tool.name), on: (event) => events.push(event) });
if (!events.includes("tool_result")) throw new Error("expected a tool_result hook");
const expected = ["rlm_load", "rlm_peek", "llm_query", "llm_query_batched", "rlm_handles", "rlm_query"];
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`registered ${names.join(",")}, expected ${expected.join(",")}`);

console.log(`package smoke ok: ${files.size} files, tools ${names.join(", ")}`);
