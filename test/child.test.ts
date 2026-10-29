import { describe, expect, it } from "vitest";
import { CHILD_EXCLUDED_TOOLS, childPrompt } from "../src/child.js";

describe("child", () => {
  it("describes handles in the prompt", () => {
    const p = childPrompt({ task: "count TODOs", handles: [{ handle: "h1", label: "src", files: 3, lines: 90, chars: 2000 }] });
    expect(p).toBe('Input:\n- handle "h1" (src): 3 files, 90 lines, 2000 chars\n\nTask: count TODOs');
    expect(childPrompt({ task: "x", handles: [] })).toBe("Task: x");
  });

  it("keeps children read-only", () => {
    expect(CHILD_EXCLUDED_TOOLS).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
  });
});
