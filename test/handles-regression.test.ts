import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandleStore } from "../src/handles.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-recurse-handles-"));
  roots.push(cwd);
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(cwd, name), text)));
  const store = new HandleStore();
  const loaded = await store.loadFiles(Object.keys(files), { cwd, maxBytes: 4 * 1024 * 1024, maxFiles: 100 });
  return { store, id: loaded.handle };
}

describe("handle range/search regressions", () => {
  it("matches split/slice semantics across line boundaries without splitting the whole input", () => {
    const store = new HandleStore();
    for (const text of ["", "a", "a\n", "\na\n\nb", "a\r\nb\r\n", "😀\nx\n"]) {
      const id = store.loadText(text).handle;
      for (let start = -1; start < 8; start++) {
        for (let count = -1; count < 8; count++) {
          const from = Math.max(1, start) - 1;
          expect(store.lineRange(id, start, count)).toBe(text.split("\n").slice(from, from + Math.max(0, count)).join("\n"));
        }
      }
    }
  });

  it("keeps exact file-relative line numbers at headers, empty lines and trailing newlines", async () => {
    const { store, id } = await fixture({ "a.txt": "first\n\nthird\n", "b.txt": "only", "c.txt": "" });
    const matches = store.grep(id, ".*", { flags: "gy", maxMatches: 100 });
    expect(matches.filter((m) => m.file).map(({ file, line, text }) => ({ file, line, text }))).toEqual([
      { file: "a.txt", line: 1, text: "first" },
      { file: "a.txt", line: 2, text: "" },
      { file: "a.txt", line: 3, text: "third" },
      { file: "a.txt", line: 4, text: "" },
      { file: "b.txt", line: 1, text: "only" },
      { file: "c.txt", line: 1, text: "" },
    ]);
    expect(store.fileAt(id, store.get(id).files[0]?.start ?? 0)?.path).toBe("a.txt");
    expect(store.fileAt(id, -1)).toBeUndefined();
  });

  it("returns the same paths as a full grep, including empty files and regex flags", async () => {
    const { store, id } = await fixture({ "a.txt": "needle\nneedle", "b.txt": "NEEDLE\n", "empty.txt": "", "headers.txt": "=== FILE: not-a-real-header ===\n" });
    for (const pattern of ["needle", "^NEEDLE$", "^$", "FILE", "missing", "only|needle"]) {
      for (const flags of ["", "i", "giy"]) {
        const expected = [...new Set(store.grep(id, pattern, { flags, maxMatches: 10_000 }).map((m) => m.file).filter(Boolean))];
        expect(store.matchingFiles(id, pattern, flags)).toEqual(expected);
      }
    }
    const literal = store.loadText("needle").handle;
    expect(store.matchingFiles(literal, "needle")).toEqual([]);
    expect(() => store.matchingFiles(id, "[invalid")).toThrow();
  });

  it("enforces maxFiles for explicit paths as well as glob patterns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recurse-count-"));
    roots.push(root);
    await writeFile(join(root, "one.txt"), "one");
    await writeFile(join(root, "two.txt"), "two");
    await expect(new HandleStore().loadFiles(["one.txt", "two.txt"], { cwd: root, maxBytes: 100, maxFiles: 1 })).rejects.toThrow(/limit is 1/);
  });
});
