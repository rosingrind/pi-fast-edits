import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolResult, RenderOptions, RenderContext } from "./render.js";
import type { Theme } from "./theme.js";

/**
 * Render an edit-tool result. Diffs (lines prefixed with `+`/`-`) are
 * colored with pi's diff theme; plain success messages render as-is. The diff
 * is always visible regardless of collapse state, matching the built-in edit
 * tool's rendering.
 */
export function renderEditResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (context.isError) {
    const text = result.content?.[0]?.text ?? "error";
    return new Text(theme.fg("error", text), 0, 0);
  }
  const raw = result.content?.[0]?.text ?? "";
  // A diff has at least one `+`/`-` change line; a plain success message never
  // starts with one. Detect on the change marker so indented message lines or
  // space-prefixed context lines do not false-positive into diff rendering.
  const isDiff = raw.split("\n").some((line) => /^[+-]/.test(line));
  if (!isDiff) {
    // Not a diff — render the success message as-is.
    return new Text(raw, 0, 0);
  }
  // Match the built-in edit tool's rendering: a blank line spacer, then the
  // diff colored (with intra-line change highlighting) via pi's renderDiff,
  // indented one column. renderDiff uses pi's global theme singleton.
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(renderDiff(raw), 1, 0));
  return container;
}
