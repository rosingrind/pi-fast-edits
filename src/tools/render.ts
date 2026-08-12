import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "./theme.js";

/** Shared result shape for renderer functions (subset of pi's AgentToolResult). */
export type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

/** Shared options shape for renderer functions. */
export type RenderOptions = {
  expanded: boolean;
  isPartial: boolean;
};

/** Shared context shape for renderer functions (subset of pi's ToolRenderContext). */
export type RenderContext = {
  lastComponent: Component | undefined;
  isError: boolean;
};

/**
 * Build a renderer that prepends the tool title and a workspace-relative path
 * to the previously rendered component's text.
 */
export function renderToolCall(
  toolName: string,
  getSuffix?: (args: Record<string, unknown>, theme: Theme) => string,
): (args: Record<string, unknown>, theme: Theme, context: RenderContext) => Component {
  return (args, theme, context) => {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const path = (args as { path?: string }).path;
    const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
    const suffix = getSuffix ? getSuffix(args, theme) : "";
    text.setText(theme.fg("toolTitle", theme.bold(toolName)) + " " + pathDisplay + suffix);
    return text;
  };
}
