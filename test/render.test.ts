import { describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderReadAnchoredResult } from "../src/tools/read-anchored-file.js";
import { renderBatchResult } from "../src/tools/apply-anchored-edits.js";
import { renderEditResult } from "../src/tools/single-edit-runner.js";
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
    expect(textOf(component)).toBe('import fs from "node:fs"\nconst x = 1');
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

  it("shows '...' when no path", () => {
    const renderer = renderToolCall("test_tool");
    const component = renderer({}, theme, noContext);
    expect(textOf(component)).toContain("...");
  });
});
