import { describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderReadAnchoredResult } from "../src/tools/read-anchored.js";
import { renderGrepResult } from "../src/tools/grep-anchored.js";
import { renderBatchResult } from "../src/tools/edit-anchored.js";
import { renderEditResult } from "../src/tools/render-edit-result.js";
import { renderToolCall } from "../src/tools/render.js";
import type { Theme } from "../src/tools/theme.js";

// The diff render path delegates to pi's renderDiff, which reads pi's global
// theme singleton. Initialize it (as the real harness does) before any test.
initTheme();

// Identity theme so the tests can assert on the rendered text.
const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const noContext = { lastComponent: undefined, isError: false };
const errorContext = { lastComponent: undefined, isError: true };

function textOf(component: any): string {
  if (!component) return "";
  if (component instanceof Text) return (component as any).text ?? "";
  // Diff results are wrapped in a Container holding a Spacer + diff Text.
  if (component instanceof Container) return component.children.map(textOf).join("");
  // Spacer and other primitives carry no text.
  return "";
}

describe("renderReadAnchoredResult", () => {
  it("strips header and anchor prefixes when expanded", () => {
    const component = renderReadAnchoredResult(
      {
        content: [
          {
            type: "text",
            text: 'File: sample.ts\nLines: 2\nRevision: abc123\n\nApple§ import fs from "node:fs"\nCider§ const x = 1',
          },
        ],
      },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe('\nimport fs from "node:fs"\nconst x = 1');
  });

  it("shows nothing when not expanded", () => {
    const component = renderReadAnchoredResult(
      { content: [{ type: "text", text: "File: a.ts\n\nApple§ one" }] },
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe("");
  });

  it("shows nothing when collapsed regardless of body size", () => {
    const body = Array.from({ length: 25 }, (_, i) => `Apple§ line ${i + 1}`).join("\n");
    const component = renderReadAnchoredResult(
      { content: [{ type: "text", text: `File: a.txt\n\n${body}` }] },
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe("");
  });

  it("shows error text", () => {
    const component = renderReadAnchoredResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: true, isPartial: false },
      theme,
      errorContext,
    );
    expect(textOf(component)).toBe("boom");
  });

  it("preserves § characters inside content lines", () => {
    const component = renderReadAnchoredResult(
      {
        content: [
          {
            type: "text",
            text: "File: test.txt\nLines: 1\nRevision: abc123\n\nApple§ value with § sign",
          },
        ],
      },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toContain("§ sign");
  });
});

describe("renderBatchResult", () => {
  it("renders the content diff even when collapsed", () => {
    const component = renderBatchResult(
      { content: [{ type: "text", text: "-1 alpha\n+1 ALPHA" }] },
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    const text = textOf(component);
    expect(text).toContain("-1 alpha");
    expect(text).toContain("+1 ALPHA");
  });

  it("renders the content diff when expanded", () => {
    const component = renderBatchResult(
      { content: [{ type: "text", text: "-1 alpha\n+1 ALPHA\n 2 beta" }] },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    const text = textOf(component);
    expect(text).toContain("-1 alpha");
    expect(text).toContain("+1 ALPHA");
    expect(text).toContain(" 2 beta");
  });

  it("renders a plain message as-is when content is not a diff", () => {
    const component = renderBatchResult(
      {
        content: [{ type: "text", text: "Edit cancelled. No files were changed." }],
      },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe("Edit cancelled. No files were changed.");
  });

  it("shows error text", () => {
    const component = renderBatchResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: false, isPartial: false },
      theme,
      errorContext,
    );
    expect(textOf(component)).toBe("boom");
  });

  it("shows error text even with non-string details", () => {
    const component = renderBatchResult(
      {
        content: [{ type: "text", text: "boom" }],
        details: [{ path: "a.ts", diff: 123 } as any],
      },
      { expanded: false, isPartial: false },
      theme,
      errorContext,
    );
    expect(textOf(component)).toBe("boom");
  });
});

describe("renderEditResult", () => {
  it("colors diff lines with theme tokens", () => {
    const component = renderEditResult(
      {
        content: [
          {
            type: "text",
            text: "-1 alpha\n+1 ALPHA\n 2 beta",
          },
        ],
      },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    const text = textOf(component);
    expect(text).toContain("ALPHA");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("returns plain text for non-diff content", () => {
    // Production now emits a unified diff for successful edits; the only
    // non-diff text renderEditResult sees is a cancellation message, so assert
    // that path is rendered as plain text.
    const component = renderEditResult(
      {
        content: [
          {
            type: "text",
            text: "Edit cancelled. No files were changed.",
          },
        ],
      },
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe("Edit cancelled. No files were changed.");
  });

  it("renders the diff even when collapsed", () => {
    const component = renderEditResult(
      { content: [{ type: "text", text: "-1 alpha\n+1 ALPHA" }] },
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    const text = textOf(component);
    expect(text).toContain("-1 alpha");
    expect(text).toContain("+1 ALPHA");
  });

  it("shows error text", () => {
    const component = renderEditResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: true, isPartial: false },
      theme,
      errorContext,
    );
    expect(textOf(component)).toBe("boom");
  });
});

describe("renderToolCall", () => {
  it("renders tool name and path", () => {
    const renderer = renderToolCall("test_tool");
    const component = renderer({ path: "file.ts" }, theme, noContext);
    expect(textOf(component)).toContain("test_tool");
    expect(textOf(component)).toContain("file.ts");
  });

  it("renders suffix when provided", () => {
    const renderer = renderToolCall("test_tool", () => " (skeleton)");
    const component = renderer({ path: "file.ts" }, theme, noContext);
    expect(textOf(component)).toContain("(skeleton)");
  });

  it("omits the path slot entirely when no path (suffix carries it)", () => {
    const renderer = renderToolCall("test_tool", () => " (skeleton)");
    const component = renderer({}, theme, noContext);
    const text = textOf(component);
    expect(text).not.toContain("...");
    expect(text).toContain("(skeleton)");
  });
});

describe("edit_anchored call chip (override-mode `edit`)", () => {
  const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

  it("shows the target file name in the suffix", async () => {
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
    const def = tools.get("edit_anchored");
    if (!def) throw new Error("edit_anchored not registered");
    const renderCall = def.renderCall as (
      args: Record<string, unknown>,
      theme: Record<string, (k: string, s: string) => string>,
      context: Record<string, unknown>,
    ) => unknown;
    const ctx = { lastComponent: undefined, isPartial: false, isError: false };

    const single = renderCall(
      {
        edits: [
          { type: "replace", path: "a.ts", startAnchor: "A", endAnchor: "A", replacement: "x" },
        ],
      },
      theme,
      ctx,
    );
    expect((single as any).render(200).join("\n")).toContain("a.ts");

    const multi = renderCall(
      {
        edits: [
          { type: "replace", path: "a.ts", startAnchor: "A", endAnchor: "A", replacement: "x" },
          { type: "insert", path: "b.ts", anchor: "A", position: "after", content: "y" },
        ],
      },
      theme,
      ctx,
    );
    expect((multi as any).render(200).join("\n")).toContain("a.ts (+1 more file)");

    const empty = renderCall({ edits: [] }, theme, ctx);
    expect((empty as any).render(200).join("\n")).not.toMatch(/\+\d+ more/);
  });
});

it("glues a range suffix to the path (read path:1-2) without extra spaces", () => {
  const renderer = renderToolCall("read_anchored", (args, t) =>
    t.fg(
      "warning",
      `:${args.startLine ?? 1}${args.endLine === undefined ? "" : `-${args.endLine}`}`,
    ),
  );
  const component = renderer({ path: "x.md", startLine: 1, endLine: 2 }, theme, noContext);
  const text = textOf(component).trim();
  expect(text).toBe("read_anchored x.md:1-2");
});

it("keeps a target-name suffix's own single leading space (edit a.ts)", () => {
  const renderer = renderToolCall("edit_anchored", (args, t) =>
    t.fg("warning", ` ${args.display}`),
  );
  const component = renderer({ display: "a.ts" }, theme, noContext);
  const text = textOf(component).trim();
  expect(text).toBe("edit_anchored a.ts");
  expect(text).not.toContain("  ");
});

describe("renderGrepResult", () => {
  const result = (text: string) => ({ content: [{ type: "text", text }] });

  it("expanded: keeps summary, strips headers/anchors, preserves indentation, drops the line-N suffix, leading newline", () => {
    const raw = [
      "1 file matched, 2 lines shown.",
      "File: src/x.ts",
      "Revision: abc123",
      "Quartz§     return foo(    line 12",
      "Robin§       bar,    line 13",
    ].join("\n");
    const component = renderGrepResult(
      result(raw),
      { expanded: true, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).toBe("\n1 file matched, 2 lines shown.\n    return foo(\n      bar,");
  });

  it("collapsed: shows the first 15 lines plus a remaining-lines hint", () => {
    const body = Array.from({ length: 20 }, (_, i) => `Apple§ line ${i + 1}    line ${i + 1}`).join(
      "\n",
    );
    const raw = `summary line\nFile: a.ts\nRevision: abc\n${body}`;
    const component = renderGrepResult(
      result(raw),
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    const out = textOf(component);
    const outLines = out.split("\n");
    expect(outLines.length).toBe(16); // 15 shown + hint
    expect(outLines[0]).toBe("summary line");
    expect(outLines[14]).toBe("Apple§ line 12    line 12"); // 15 slots include summary + headers
    expect(outLines[15]).toContain("... (8 more lines");
    expect(outLines[15]).toContain("ctrl+o to expand");
  });

  it("collapsed: no hint when everything fits", () => {
    const component = renderGrepResult(
      result("1 file matched, 1 line shown.\nFile: a.ts\nRevision: abc\nApple§ one    line 1"),
      { expanded: false, isPartial: false },
      theme,
      noContext,
    );
    expect(textOf(component)).not.toContain("more lines");
  });
});
