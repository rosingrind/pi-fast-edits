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
    { name: "read_anchored_file", parameters: { properties: { path: {} } }, execute: () => {} },
    {
      name: "apply_anchored_edits",
      parameters: { properties: { edits: {} } },
      execute: () => {},
    },
    {
      name: "grep_anchored_files",
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

  it("fails when built-in edit is missing", () => {
    const check = checkOverrideCompatibility(withoutBuiltin(fullBuiltins(), "edit"), oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'edit' tool is not registered.");
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

  it("fails when built-in write is missing", () => {
    const check = checkOverrideCompatibility(withoutBuiltin(fullBuiltins(), "write"), oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'write' tool is not registered.");
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

  it("fails when built-in read is missing", () => {
    const check = checkOverrideCompatibility(withoutBuiltin(fullBuiltins(), "read"), oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'read' tool is not registered.");
  });

  it("fails when built-in grep is missing", () => {
    const check = checkOverrideCompatibility(withoutBuiltin(fullBuiltins(), "grep"), oursFull());
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Built-in 'grep' tool is not registered.");
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
      def.name === "read_anchored_file" ? { ...def, execute: null } : def,
    );
    const check = checkOverrideCompatibility(fullBuiltins(), ours);
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("Our 'read_anchored_file' tool has no execute handler.");
  });
});

type RegisteredTool = { name: string; description?: string };
type Handler = (event?: any, ctx?: any) => Promise<any> | any;

async function loadOverride(
  overrides?: Partial<PiFastEditsConfig>,
  builtins: ToolDef[] = fullBuiltins(),
) {
  const registered = new Map<string, RegisteredTool>();
  const handlers: Record<string, Handler> = {};
  const setActiveToolsCalls: string[][] = [];
  // Mirrors pi's real default active set: grep is registered-but-inactive.
  let activeTools = ["read", "bash", "edit", "write", ...SUFFIXED_TOOL_NAMES];
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
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as any, overrides);
  return { registered, handlers, setActiveToolsCalls, activeTools: () => [...activeTools] };
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
    const read = await handlers.tool_call!({ toolName: "read_anchored_file" }, {});
    expect(read).toBeUndefined();

    // A visible warning explains the fallback.
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("warning");
    expect(notifications[0].message).toContain("read");
  });

  it("disabled (default): no interception, no override names, no setActiveTools call", async () => {
    const { registered, handlers, setActiveToolsCalls } = await loadOverride();
    await handlers.session_start!({}, {});

    expect(handlers.tool_call).toBeUndefined();
    expect(registered.has("read")).toBe(false);
    expect(registered.has("edit")).toBe(false);
    expect(setActiveToolsCalls).toHaveLength(0);
  });
});
