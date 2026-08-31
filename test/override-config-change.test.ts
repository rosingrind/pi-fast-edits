import { describe, expect, it, vi } from "vitest";
import type { PiFastEditsConfig } from "../src/types.js";

// Replace the real config menu (src/config-ui.ts) with a capture stub: the
// menu's onChange path is "mutate the live config, then call onConfigChanged",
// so tests capture both the internal config object and the callback and drive
// that path directly — no TUI interaction required.
const { showConfigMenuMock, captured } = vi.hoisted(() => ({
  showConfigMenuMock: vi.fn(),
  captured: {
    config: null as PiFastEditsConfig | null,
    onConfigChanged: null as ((id: string, ctx: unknown) => void) | null,
  },
}));

vi.mock("../src/config-ui.js", () => ({
  showConfigMenu: async (
    config: PiFastEditsConfig,
    _ctx: unknown,
    onConfigChanged: (id: string, ctx: unknown) => void,
  ) => {
    captured.config = config;
    captured.onConfigChanged = onConfigChanged;
    showConfigMenuMock(config, onConfigChanged);
  },
}));

import piFastEdits from "../src/index.js";

type ToolDef = { name: string; parameters: unknown };
type Handler = (event?: unknown, ctx?: any) => Promise<unknown> | unknown;

/** Pass-shaped built-ins so the override safety check succeeds. */
function passBuiltins() {
  return [
    { name: "read", parameters: { properties: { path: {} } } },
    { name: "edit", parameters: { properties: { edits: {} } } },
    { name: "write", parameters: { properties: { path: {}, content: {} } } },
    { name: "grep", parameters: { properties: { pattern: {} } } },
  ];
}

async function loadHarness(overrides?: Partial<PiFastEditsConfig>) {
  const registered = new Map<string, ToolDef>();
  const handlers: Record<string, Handler> = {};
  let commandHandler: ((args: string, ctx: unknown) => Promise<unknown>) | null = null;
  const pi = {
    registerTool(tool: ToolDef) {
      registered.set(tool.name, tool);
    },
    registerCommand(
      _name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<unknown> },
    ) {
      commandHandler = def.handler;
    },
    getAllTools: () => passBuiltins(),
    getActiveTools: () => ["read", "edit", "write", "grep", "bash"],
    setActiveTools() {},
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as any, overrides);
  return {
    registered,
    handlers,
    runCommand: (args: string) => commandHandler!(args, { hasUI: true }),
  };
}

describe("override wiring follows non-override config changes", () => {
  it("re-runs applyOverrideMode on any config change while override is active, refreshing the edit schema", async () => {
    const { registered, handlers, runCommand } = await loadHarness({
      overrideBuiltInEditTools: true,
      requireAnchorLines: true,
    });

    // Activate override the way session_start does: strict edit schema.
    await handlers.session_start!({}, {});
    // The overridden `edit` uses the batch schema: strictness lives on each
    // per-edit variant (outer `required` is just ["edits"]).
    const batchRequired = (params: any) =>
      params.properties.edits.items.anyOf.flatMap((t: any) =>
        t.allOf.flatMap((s: any) => s.required ?? []),
      );
    const strictEdit = registered.get("edit")!.parameters as any;
    expect(batchRequired(strictEdit)).toContain("startAnchorLine");

    // Open the config menu: captures the live config + the change callback.
    await runCommand("config");
    expect(captured.config).not.toBeNull();
    expect(captured.onConfigChanged).not.toBeNull();

    // Simulate the menu's requireAnchorLines toggle (mutate → notify).
    captured.config!.requireAnchorLines = false;
    captured.onConfigChanged!("requireAnchorLines", { hasUI: true });

    // The overridden `edit` must be re-registered with the lenient schema —
    // no stale strict defs.
    const lenientEdit = registered.get("edit")!.parameters as any;
    expect(batchRequired(lenientEdit)).not.toContain("startAnchorLine");
    expect(batchRequired(lenientEdit)).not.toContain("endAnchorLine");
    expect(batchRequired(lenientEdit)).not.toContain("anchorLine");
  });
});
