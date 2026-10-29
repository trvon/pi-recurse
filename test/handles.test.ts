import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HandleStore } from "../src/handles.js";

let dir: string;
const opts = () => ({ cwd: dir, maxBytes: 1024 * 1024, maxFiles: 100 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-recurse-"));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n// TODO: fix a\nconst x = 2;\n");
  await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n// TODO: fix b\n");
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "// TODO: should be excluded\n");
  await writeFile(join(dir, "src", "bin.dat"), Buffer.from([1, 0, 2, 3]));
});

describe("HandleStore", () => {
  it("loads text and reports stats", () => {
    const s = new HandleStore();
    const h = s.loadText("one\ntwo\nthree");
    expect(h).toMatchObject({ lines: 3, files: 0, chars: 13 });
    expect(s.lineRange(h.handle, 2, 1)).toBe("two");
    expect(s.charRange(h.handle, 4, 7)).toBe("two");
  });

  it("loads a directory, skipping node_modules and binary files", async () => {
    const s = new HandleStore();
    const h = await s.loadFiles(["src"], opts());
    expect(h.files).toBe(2);
    expect(h.skipped).toEqual([join("src", "bin.dat")]);
    expect(s.get(h.handle).text).not.toContain("should be excluded");
    expect(s.fileText(h.handle, "b.ts").text).toBe("export const b = 2;\n// TODO: fix b\n");
  });

  it("loads globs and greps with file-relative line numbers", async () => {
    const s = new HandleStore();
    const h = await s.loadFiles(["src/*.ts"], opts());
    const m = s.grep(h.handle, "TODO", { context: 1 });
    expect(m.map((x) => [x.file, x.line])).toEqual([
      [join("src", "a.ts"), 2],
      [join("src", "b.ts"), 2],
    ]);
    expect(m[0]?.before).toEqual(["export const a = 1;"]);
    expect(m[0]?.after).toEqual(["const x = 2;"]);
  });

  it("caps grep matches and ignores file headers", async () => {
    const s = new HandleStore();
    const h = await s.loadFiles(["src/*.ts"], opts());
    expect(s.grep(h.handle, "FILE").length).toBe(0);
    expect(s.grep(h.handle, "const", { maxMatches: 1 }).length).toBe(1);
  });

  it("enforces size and file limits", async () => {
    const s = new HandleStore();
    await expect(s.loadFiles(["src"], { ...opts(), maxBytes: 10 })).rejects.toThrow(/exceeds/);
    await expect(s.loadFiles(["src"], { ...opts(), maxFiles: 1 })).rejects.toThrow(/limit is 1/);
  });

  it("rejects unknown handles and files", () => {
    const s = new HandleStore();
    expect(() => s.get("nope")).toThrow(/unknown handle/);
    const h = s.loadText("x");
    expect(() => s.fileText(h.handle, "missing.ts")).toThrow(/no file/);
    expect(s.drop(h.handle)).toBe(true);
    expect(s.list()).toEqual([]);
  });

  it("resolves handle references flexibly", () => {
    const store = new HandleStore();
    expect(() => store.resolve()).toThrow(/rlm_load first/);
    const a = store.loadText("a").handle;
    const b = store.loadText("b").handle;
    expect(store.resolve()).toBe(b);
    expect(store.resolve(a)).toBe(a);
    expect(store.resolve({ handle: a, files: 1 })).toBe(a);
    // a result rewriter turned the structured result into text
    expect(store.resolve(`Handle ${a}: 0 files, 1 lines, 1 chars.`)).toBe(a);
    expect(() => store.resolve(`${a} and ${b}`)).toThrow(/unknown handle/);
    expect(() => store.resolve("nope")).toThrow(/unknown handle/);
  });

  it("never picks an internal handle as the default", () => {
    const store = new HandleStore();
    const a = store.loadText("a").handle;
    store.loadText("slice", "s", { internal: true });
    expect(store.latest()).toBe(a);
  });
});

