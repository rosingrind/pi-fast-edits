import { describe, expect, it } from "vitest";

describe("edit_anchored prepareArguments (edits-as-string quirk)", () => {
  async function getDef() {
    const tools = new Map<string, any>();
    const { default: piFastEdits } = await import("../src/index.js");
    await piFastEdits(
      {
        registerTool: (t: any) => tools.set(t.name, t),
        registerCommand: () => {},
        on: () => {},
      } as any,
      { requireAnchorLines: false },
    );
    return tools.get("edit_anchored");
  }

  it("normalizes edits sent as a JSON string", async () => {
    const def = await getDef();
    const out = def.prepareArguments({
      edits: JSON.stringify([
        { type: "replace", path: "a.ts", startAnchor: "A", endAnchor: "B", replacement: "x" },
      ]),
    });
    expect(Array.isArray(out.edits)).toBe(true);
    expect(out.edits).toHaveLength(1);
  });

  it("wraps a single edit object into an array", async () => {
    const def = await getDef();
    const out = def.prepareArguments({
      edits: { type: "insert", path: "a.ts", anchor: "A", position: "after", content: "y" },
    });
    expect(Array.isArray(out.edits)).toBe(true);
    expect(out.edits).toHaveLength(1);
  });

  it("passes arrays through unchanged", async () => {
    const def = await getDef();
    const edits = [
      { type: "replace", path: "a.ts", startAnchor: "A", endAnchor: "B", replacement: "x" },
    ];
    const out = def.prepareArguments({ edits });
    expect(out.edits).toBe(edits);
  });
});
