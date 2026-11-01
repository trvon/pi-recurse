import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandleStore } from "../src/handles.js";

describe("child handle views", () => {
  it("uses assigned private input as default and hides parent/sibling handles", () => {
    const root = new HandleStore();
    const parent = root.loadText("whole input").handle;
    const slice = root.loadText("slice", "private", { internal: true }).handle;
    const sibling = root.loadText("sibling", "private", { internal: true }).handle;
    const child = root.scope([slice]);
    expect(root.latest()).toBe(parent);
    expect(root.list().map((h) => h.handle)).toEqual([parent]);
    expect(child.resolve()).toBe(slice);
    expect(child.get(child.resolve()).text).toBe("slice");
    expect(child.list().map((h) => h.handle)).toEqual([slice]);
    for (const id of [parent, sibling]) {
      expect(() => child.get(id)).toThrow(/unknown handle/);
      expect(child.tryResolve(`handle ${id}`)).toBeUndefined();
      expect(child.drop(id)).toBe(false);
      expect(() => child.scope([id])).toThrow(/unknown handle/);
    }
    expect(child.drop(slice)).toBe(false);
    expect(root.get(slice).text).toBe("slice");
    const local = child.loadText("answer").handle;
    const localSlice = child.loadText("private descendant", "slice", { internal: true }).handle;
    expect(child.latest()).toBe(local);
    expect(child.list().map((h) => h.handle)).toEqual([slice, local]);
    expect(root.list().map((h) => h.handle)).toEqual([parent]);
    const grandchild = child.scope([localSlice]);
    expect(grandchild.resolve()).toBe(localSlice);
    expect(grandchild.tryResolve(local)).toBeUndefined();
    grandchild.dispose();
    expect(child.drop(local)).toBe(true);
    expect(child.latest()).toBe(slice);
    child.dispose();
    expect(root.get(slice).text).toBe("slice");
    expect(() => root.get(localSlice)).toThrow(/unknown/);
    expect(() => child.get(slice)).toThrow(/unknown/);
    expect(() => child.loadText("late allocation")).toThrow(/disposed/);
    expect(() => child.scope([])).toThrow(/disposed/);
  });

  it("retains borrowed text if the parent drops its reference during a call", () => {
    const root = new HandleStore();
    const { handle } = root.loadText("borrowed input");
    const child = root.scope([handle]);
    expect(root.drop(handle)).toBe(true);
    expect(child.get(child.resolve()).text).toBe("borrowed input");
    child.dispose();
    expect(child.list()).toEqual([]);
  });

  it("keeps an empty child view empty instead of falling back to the root", () => {
    const root = new HandleStore();
    root.loadText("parent");
    const child = root.scope([]);
    expect(() => child.resolve()).toThrow(/no handle/);
    expect(child.list()).toEqual([]);
    const own = child.loadText("own").handle;
    expect(child.resolve()).toBe(own);
    child.dispose();
    expect(() => root.get(own)).toThrow(/unknown/);
  });

  it("tracks file loads in the view and rejects ambiguous suffixes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-recurse-scope-"));
    try {
      for (const dir of ["a", "b"]) {
        await mkdir(join(cwd, dir));
        await writeFile(join(cwd, dir, "same.ts"), dir);
      }
      const root = new HandleStore();
      const child = root.scope([]);
      const { handle } = await child.loadFiles(["a/same.ts", "b/same.ts"], { cwd, maxBytes: 1024, maxFiles: 2 });
      expect(child.resolve()).toBe(handle);
      expect(() => child.fileText(handle, "same.ts")).toThrow(/ambiguous/);
      expect(child.fileText(handle, join("b", "same.ts")).text).toBe("b");
      expect(child.fileText(handle, join("a", "same.ts")).text).toBe("a");
      expect(root.list()).toEqual([]);
      child.dispose();
      expect(() => root.get(handle)).toThrow(/unknown/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
