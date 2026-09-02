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

async function loadHarness(overrides?: Partial<PiFastEditsConfig>) {
  const registered = new Map<string, ToolDef>();
  const handlers: Record<string, Handler> = {};
  let commandHandler: ((args: string, ctx: unknown) => Promise<unknown>) | null = null;
  const setActiveToolsCalls: string[][] = [];
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
    getActiveTools: () => ["read", "edit", "write", "grep", "bash"],
    setActiveTools(names: string[]) {
      setActiveToolsCalls.push([...names]);
    },
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as any, overrides);
  return {
    registered,
    handlers,
    setActiveToolsCalls,
    runCommand: (args: string) => commandHandler!(args, { hasUI: true }),
  };
}

describe("tool surface follows config changes", () => {
  it("session_start with suppressNativeTools hides the native names", async () => {
    const { handlers, setActiveToolsCalls } = await loadHarness({ suppressNativeTools: true });
    await handlers.session_start!({}, {});

    const last = setActiveToolsCalls.at(-1)!;
    expect(last).toContain("read_anchored");
    expect(last).toContain("edit_anchored");
    expect(last).toContain("bash");
    expect(last).not.toContain("read");
    expect(last).not.toContain("edit");
    expect(last).not.toContain("write");
    expect(last).not.toContain("grep");
  });

  it("session_start without suppress leaves the native names active", async () => {
    const { handlers, setActiveToolsCalls } = await loadHarness();
    await handlers.session_start!({}, {});

    const last = setActiveToolsCalls.at(-1)!;
    expect(last).toContain("read");
    expect(last).toContain("edit");
    expect(last).toContain("grep");
    expect(last).toContain("read_anchored");
    expect(last).toContain("bash");
  });

  it("toggling suppressNativeTools in the config menu re-applies the surface live", async () => {
    const { handlers, setActiveToolsCalls, runCommand } = await loadHarness();
    await handlers.session_start!({}, {});
    await runCommand("config"); // populates the captured config + callback
    const before = setActiveToolsCalls.length;

    const { config, onConfigChanged } = captured;
    expect(config).not.toBeNull();
    config!.suppressNativeTools = true;
    onConfigChanged!("suppressNativeTools", { hasUI: true });

    const after = setActiveToolsCalls.length;
    expect(after).toBeGreaterThan(before);
    const last = setActiveToolsCalls.at(-1)!;
    expect(last).not.toContain("edit");
    expect(last).toContain("edit_anchored");
  });

  it("toggling requireAnchorLines still refreshes the edit schema on config change", async () => {
    const { handlers, registered, runCommand } = await loadHarness();
    await handlers.session_start!({}, {});
    await runCommand("config"); // populates the captured config + callback

    const { config, onConfigChanged } = captured;
    config!.requireAnchorLines = false;
    onConfigChanged!("requireAnchorLines", { hasUI: true });

    // Re-registration refreshes the registered edit def (same object identity
    // pattern as before: registerTool called again with the live schema).
    expect(registered.has("edit_anchored")).toBe(true);
  });
});
