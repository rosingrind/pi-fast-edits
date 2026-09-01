import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig } from "../src/types.js";
import {
  checkOverrideCompatibility,
  SUFFIXED_TOOL_NAMES,
  type ToolDef,
} from "../src/tools/override.js";

/** Built-ins shaped like what pi's getAllTools() actually returns (ToolInfo). */
function fullBuiltins(): ToolDef[] {
  return [
    { name: "bash", parameters: { properties: { command: {} } } },
    { name: "read", parameters: { properties: { path: {} } } },
    { name: "edit", parameters: { properties: { edits: {} } } },
    { name: "write", parameters: { properties: { path: {}, content: {} } } },
    { name: "grep", parameters: { properties: { pattern: {} } } },
    { name: "ls", parameters: { properties: {} } },
    { name: "find", parameters: { properties: {} } },
  ];
}

function oursFull(): ToolDef[] {
  return [
    { name: "read_anchored", parameters: { properties: { path: {} } }, execute: () => {} },
    {
      name: "edit_anchored",
      parameters: { properties: { edits: {} } },
      execute: () => {},
    },
    {
      name: "grep_anchored",
      parameters: { properties: { pattern: {} } },
      execute: () => {},
    },
    {
      name: "write_anchored",
      parameters: { properties: { path: {}, content: {} } },
      execute: () => {},
    },
  ];
}

function withBuiltin(
  builtins: ToolDef[],
  name: string,
  mutate: (def: ToolDef) => ToolDef,
): ToolDef[] {
  return builtins.map((def) => (def.name === name ? mutate(def) : def));
}

function withoutBuiltin(builtins: ToolDef[], name: string): ToolDef[] {
  return builtins.filter((def) => def.name !== name);
}

function withoutOurs(ours: ToolDef[], name: string): ToolDef[] {
  return ours.filter((def) => def.name !== name);
}

describe("checkOverrideCompatibility", () => {
  it("passes when built-ins and our definitions are well-shaped", () => {
    const check = checkOverrideCompatibility(fullBuiltins(), oursFull());
    expect(check.ok).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it("treats a missing built-in as absent (allowlist-filtered), not incompatible", () => {
    const check = checkOverrideCompatibility(withoutBuiltin(fullBuiltins(), "edit"), oursFull());
    expect(check.ok).toBe(true);
    expect(check.absent).toContain("edit");
    expect(check.eligible).toContain("read");
    expect(check.eligible).not.toContain("edit");
    expect(check.reasons).toEqual([]);
  });

  it("treats all missing built-ins as absent across the board", () => {
    let builtins = fullBuiltins();
    for (const name of ["read", "edit", "write", "grep"]) builtins = withoutBuiltin(builtins, name);
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(true);
    expect(check.absent).toEqual(["read", "edit", "grep", "write"]);
    expect(check.eligible).toEqual([]);
  });

  it("auditor-shaped child surface: read/grep eligible, edit/write absent", () => {
    const builtins = fullBuiltins().filter((d) => d.name !== "edit" && d.name !== "write");
    const ours = oursFull().filter(
      (d) => d.name !== "edit_anchored" && d.name !== "write_anchored",
    );
    const check = checkOverrideCompatibility(builtins, ours);
    expect(check.ok).toBe(true);
    expect(check.eligible).toEqual(["read", "grep"]);
    expect(check.absent).toEqual(["edit", "write"]);
  });

  it("fails when built-in edit lacks parameters.properties.edits", () => {
    const builtins = withBuiltin(fullBuiltins(), "edit", (def) => ({
      ...def,
      parameters: { properties: { file: {} } },
    }));
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'edit' has no parameters.properties.edits.");
  });

  it("fails when built-in edit exposes no execute handler", () => {
    const builtins = withBuiltin(fullBuiltins(), "edit", (def) => ({ ...def, execute: null }));
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'edit' has no execute handler.");
  });

  it("fails when built-in write lacks parameters.properties.path", () => {
    const builtins = withBuiltin(fullBuiltins(), "write", (def) => ({
      ...def,
      parameters: { properties: { content: {} } },
    }));
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'write' has no parameters.properties.path.");
  });

  it("fails when built-in write lacks parameters.properties.content", () => {
    const builtins = withBuiltin(fullBuiltins(), "write", (def) => ({
      ...def,
      parameters: { properties: { path: {} } },
    }));
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'write' has no parameters.properties.content.");
  });

  it("fails when built-in grep exposes no execute handler", () => {
    const builtins = withBuiltin(fullBuiltins(), "grep", (def) => ({ ...def, execute: null }));
    const check = checkOverrideCompatibility(builtins, oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'grep' has no execute handler.");
  });

  it("fails when our definition for a behavior is missing", () => {
    const ours = withoutOurs(oursFull(), "write_anchored");
    const check = checkOverrideCompatibility(fullBuiltins(), ours);
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Our 'write_anchored' tool is not registered.");
  });

  it("fails when our definition has empty parameters.properties", () => {
    const ours = oursFull().map((def) =>
      def.name === "write_anchored" ? { ...def, parameters: { properties: {} } } : def,
    );
    const check = checkOverrideCompatibility(fullBuiltins(), ours);
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Our 'write_anchored' tool has no parameters.properties.");
  });

  it("fails when our definition has no execute handler", () => {
    const ours = oursFull().map((def) =>
      def.name === "read_anchored" ? { ...def, execute: null } : def,
    );
    const check = checkOverrideCompatibility(fullBuiltins(), ours);
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Our 'read_anchored' tool has no execute handler.");
  });
});

type RegisteredTool = { name: string; description?: string };
type Handler = (event?: any, ctx?: any) => Promise<any> | any;

async function loadOverride(
  overrides?: Partial<PiFastEditsConfig>,
  builtins: ToolDef[] = fullBuiltins(),
  initialActive?: string[],
) {
  const registered = new Map<string, RegisteredTool>();
  const handlers: Record<string, Handler> = {};
  let toolCallInstallCount = 0;
  const setActiveToolsCalls: string[][] = [];
  // Mirrors pi's real default active set: grep is registered-but-inactive.
  let activeTools = initialActive ?? ["read", "bash", "edit", "write", ...SUFFIXED_TOOL_NAMES];
  const pi = {
    registerTool(tool: RegisteredTool) {
      registered.set(tool.name, tool);
    },
    registerCommand() {},
    getAllTools: () => builtins,
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      setActiveToolsCalls.push([...names]);
      activeTools = [...names];
    },
    on(event: string, handler: Handler) {
      if (event === "tool_call") toolCallInstallCount += 1;
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as any, overrides);
  return {
    registered,
    handlers,
    setActiveToolsCalls,
    toolCallInstallCount: () => toolCallInstallCount,
    activeTools: () => [...activeTools],
  };
}

describe("applyOverrideMode wiring", () => {
  it("pass: registers the four override names, deactivates suffixed tools, no interception", async () => {
    const { registered, handlers, setActiveToolsCalls } = await loadOverride({
      overrideBuiltInEditTools: true,
    });
    await handlers.session_start!({}, {});

    // The four built-in names are (re-)registered with anchored descriptions.
    expect(registered.has("read")).toBe(true);
    expect(registered.has("edit")).toBe(true);
    expect(registered.has("write")).toBe(true);
    expect(registered.has("grep")).toBe(true);
    expect(registered.get("read")!.description).toContain("Anchored read (default).");
    expect(registered.get("edit")!.description).toContain("Anchored");
    expect(registered.get("write")!.description).toContain("Anchored");
    expect(registered.get("grep")!.description).toContain("Anchored");

    // setActiveTools keeps every active tool except our suffixed names, and
    // the four override names are forced active even when pi had them
    // registered-but-inactive (grep is inactive by default in pi).
    const last = setActiveToolsCalls.at(-1)!;
    for (const suffixed of SUFFIXED_TOOL_NAMES) {
      expect(last).not.toContain(suffixed);
    }
    for (const name of ["read", "edit", "write", "grep", "bash"]) {
      expect(last).toContain(name);
    }
    // The fake mirrors pi's real default active set: ls/find stay inactive.
    expect(last).not.toContain("ls");
    expect(last).not.toContain("find");

    // Override mode replaces interception entirely.
    expect(handlers.tool_call).toBeUndefined();
  });

  it("fail: installs interception blocking write/edit, warns, and registers no override names", async () => {
    const builtins = withBuiltin(fullBuiltins(), "write", (def) => ({
      ...def,
      parameters: { properties: { path: {} } }, // missing content
    }));
    const notifications: Array<{ message: string; type?: string }> = [];
    const { registered, handlers } = await loadOverride(
      { overrideBuiltInEditTools: true },
      builtins,
    );
    await handlers.session_start!(
      {},
      {
        ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
      },
    );

    // No override names claimed on an unsafe fingerprint.
    expect(registered.has("read")).toBe(false);
    expect(registered.has("edit")).toBe(false);
    expect(registered.has("write")).toBe(false);
    expect(registered.has("grep")).toBe(false);

    // Fallback interception blocks write/edit with a steering message.
    expect(handlers.tool_call).toBeDefined();
    const write = await handlers.tool_call!({ toolName: "write" }, {});
    expect(write?.block).toBe(true);
    expect(write?.reason).toContain("pi-fast-edits override");
    const edit = await handlers.tool_call!({ toolName: "edit" }, {});
    expect(edit?.block).toBe(true);
    const read = await handlers.tool_call!({ toolName: "read_anchored" }, {});
    expect(read).toBeUndefined();

    // A visible warning explains the fallback.
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("warning");
    expect(notifications[0].message).toContain("read");
  });

  it("installed-once guard: repeated fail-path runs install a single interception handler", async () => {
    const builtins = withBuiltin(fullBuiltins(), "write", (def) => ({
      ...def,
      parameters: { properties: { path: {} } }, // missing content → check fails
    }));
    const { handlers, toolCallInstallCount } = await loadOverride(
      { overrideBuiltInEditTools: true },
      builtins,
    );
    // Three fail-path runs (session_start re-runs applyOverrideMode each time)
    // must not stack duplicate tool_call handlers.
    await handlers.session_start!({}, {});
    await handlers.session_start!({}, {});
    await handlers.session_start!({}, {});

    expect(toolCallInstallCount()).toBe(1);
    // The single handler still blocks write in fail mode.
    const write = await handlers.tool_call!({ toolName: "write" }, {});
    expect(write?.block).toBe(true);
  });

  it("disabled (default): restores the suffixed tools, installs nothing else", async () => {
    const { registered, handlers, setActiveToolsCalls } = await loadOverride();
    await handlers.session_start!({}, {});

    expect(handlers.tool_call).toBeUndefined();
    expect(registered.has("read")).toBe(false);
    expect(registered.has("edit")).toBe(false);
    // The disabled path re-activates the suffixed anchored tools (restore).
    expect(setActiveToolsCalls).toHaveLength(1);
    for (const name of SUFFIXED_TOOL_NAMES) {
      expect(setActiveToolsCalls[0]).toContain(name);
    }
  });

  it("partial child surface: replaces only present built-ins, no interception for absent ones", async () => {
    const builtins = fullBuiltins().filter((d) => d.name !== "edit" && d.name !== "write");
    const { registered, handlers, setActiveToolsCalls } = await loadOverride(
      { overrideBuiltInEditTools: true },
      builtins,
      ["read", "bash", "read_anchored", "grep_anchored"],
    );
    await handlers.session_start!({}, {});

    // Only the present built-ins are claimed.
    expect(registered.has("read")).toBe(true);
    expect(registered.has("grep")).toBe(true);
    expect(registered.get("read")!.description).toContain("Anchored read (default).");
    expect(registered.has("edit")).toBe(false);
    expect(registered.has("write")).toBe(false);

    // Active set keeps pre-existing tools, forces the eligible names, and
    // does NOT resurrect the allowlisted-out ones.
    const last = setActiveToolsCalls.at(-1)!;
    expect(last).toContain("read");
    expect(last).toContain("grep");
    expect(last).toContain("bash");
    expect(last).not.toContain("edit");
    expect(last).not.toContain("write");
    for (const suffixed of SUFFIXED_TOOL_NAMES) {
      expect(last).not.toContain(suffixed);
    }

    // Absent built-ins are an allowlist choice, not an incompatibility —
    // no interception fallback is installed.
    expect(handlers.tool_call).toBeUndefined();
  });

  it("partial child surface: rendered titles remap only the eligible pairs", async () => {
    const builtins = fullBuiltins().filter((d) => d.name !== "edit" && d.name !== "write");
    const { handlers } = await loadOverride({ overrideBuiltInEditTools: true }, builtins, [
      "read",
      "bash",
      "read_anchored",
      "grep_anchored",
    ]);
    await handlers.session_start!({}, {});

    const { renderToolCall, clearToolNameOverrides } = await import("../src/tools/render.js");
    const { Text } = await import("@earendil-works/pi-tui");
    const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
    const ctx = { lastComponent: undefined, isPartial: false, isError: false } as any;

    const renderRead = renderToolCall("read_anchored", () => "");
    const readComp = renderRead({ path: "a.txt" }, theme as any, ctx);
    expect((readComp as InstanceType<typeof Text>).render(200)[0]).toContain("read ");
    expect((readComp as InstanceType<typeof Text>).render(200)[0]).not.toContain("read_anchored");

    // edit_anchored stays unmapped: its built-in pair is absent in this child.
    const renderEdit = renderToolCall("edit_anchored", () => "");
    const editComp = renderEdit({ path: "a.txt" }, theme as any, ctx);
    expect((editComp as InstanceType<typeof Text>).render(200)[0]).toContain("edit_anchored");

    clearToolNameOverrides();
  });
});

describe("renderToolCall name overrides", () => {
  it("rendered titles follow the built-in names in override mode", async () => {
    const { renderToolCall, setToolNameOverrides, clearToolNameOverrides } =
      await import("../src/tools/render.js");
    const { Text } = await import("@earendil-works/pi-tui");
    const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

    const render = renderToolCall("read_anchored", () => "");
    render(
      { path: "a.txt" },
      theme as any,
      { lastComponent: undefined, isPartial: false, isError: false } as any,
    );
    // (component text asserted below after overrides are set)

    setToolNameOverrides({ read_anchored: "read" });
    const comp = render(
      { path: "a.txt" },
      theme as any,
      { lastComponent: undefined, isPartial: false, isError: false } as any,
    );
    expect((comp as InstanceType<typeof Text>).render(200)[0]).toContain("read ");
    expect((comp as InstanceType<typeof Text>).render(200)[0]).not.toContain("read_anchored");

    clearToolNameOverrides();
    const comp2 = render(
      { path: "a.txt" },
      theme as any,
      { lastComponent: undefined, isPartial: false, isError: false } as any,
    );
    expect((comp2 as InstanceType<typeof Text>).render(200)[0]).toContain("read_anchored");
  });
});

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
