import { basename, dirname } from "node:path";
import { Text } from "@earendil-works/pi-tui";

/**
 * Display-name overrides applied in override mode: when a tool definition is
 * re-registered under a built-in name, its rendered title follows via this map
 * (renderToolCall closures capture the original registration name).
 */
const toolNameOverrides = new Map<string, string>();

export function setToolNameOverrides(map: Record<string, string>): void {
  toolNameOverrides.clear();
  for (const [from, to] of Object.entries(map)) toolNameOverrides.set(from, to);
}

export function clearToolNameOverrides(): void {
  toolNameOverrides.clear();
}

/** Resolve a registration name to its override-mode display name (if any). */
export function resolveToolDisplayName(toolName: string): string {
  return toolNameOverrides.get(toolName) ?? toolName;
}
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
  /** pi passes the tool call's arguments in its render context. */
  args?: Record<string, unknown>;
  lastComponent: Component | undefined;
  isError: boolean;
  /** pi renders tool calls collapsed by default; true when the user expanded. */
  expanded?: boolean;
};

/**
 * Build a renderer that prepends the tool title and a workspace-relative path
 * to the previously rendered component's text.
 */
export function renderToolCall(
  toolName: string,
  getSuffix?: (args: Record<string, unknown>, theme: Theme) => string,
  opts?: { skillClassification?: boolean },
): (args: Record<string, unknown>, theme: Theme, context: RenderContext) => Component {
  return (args, theme, context) => {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const displayName = toolNameOverrides.get(toolName) ?? toolName;
    const path = (args as { path?: string }).path;
    const suffix = getSuffix ? getSuffix(args, theme) : "";
    // pi's built-in read renders a collapsed call on a SKILL.md as a purple
    // `[skill] <name>` box (getCompactReadClassification in pi's read tool).
    // Mirror it so the anchored read — including the overridden `read` — keeps
    // that UI parity. Expanded calls keep the normal title, exactly like pi.
    if (opts?.skillClassification && path && !context.expanded && basename(path) === "SKILL.md") {
      const label = basename(dirname(path)) || "SKILL.md";
      text.setText(
        theme.fg("customMessageLabel", "\u001b[1m[skill]\u001b[22m ") +
          theme.fg("customMessageText", label) +
          suffix +
          // pi's compact read call appends the expand hint; mirror it.
          theme.fg("dim", " (ctrl+o to expand)"),
      );
      return text;
    }
    // No "..." fallback: tools whose path lives in a nested arg (batch edits)
    // carry it in their suffix instead — a bare "..." reads as noise.
    const pathDisplay = path ? theme.fg("accent", path) : "";
    // Suffixes own their spacing: a range suffix glues to the path
    // (`read path:1-2`), a target-name suffix carries its own leading space
    // (`edit a.ts`). Assembly never adds or removes spaces itself.
    const title = displayName + (pathDisplay ? ` ${pathDisplay}` : "") + suffix;
    text.setText(title);
    return text;
  };
}
