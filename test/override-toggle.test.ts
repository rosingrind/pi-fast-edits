import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { LRUMap, type PiFastEditsConfig } from "../src/types.js";
import {
  ANCHORED_TOOL_NAMES,
  OVERRIDE_DISABLED_NOTICE,
  OVERRIDE_ENABLED_NOTICE,
  createOverrideNoticeHandler,
  createOverrideToggleTracker,
} from "../src/tools/override-notice.js";
import {
  applyOverrideMode,
  installInterceptionFallback,
  SUFFIXED_TOOL_NAMES,
  type OverrideDeps,
} from "../src/tools/override.js";
import { registerReadAnchoredFile } from "../src/tools/read-anchored.js";
import { registerApplyAnchoredEdits } from "../src/tools/edit-anchored.js";
import { registerGrepAnchoredFiles } from "../src/tools/grep-anchored.js";
import { registerWriteAnchored } from "../src/tools/write-anchored.js";

function makeConfig(overrideBuiltInEditTools: boolean): PiFastEditsConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedPaths: [...DEFAULT_CONFIG.protectedPaths],
    overrideBuiltInEditTools,
  };
}

/** The approved notice copy (task-4 brief, review-fix); pinned verbatim so copy edits are intentional. */
const ANCHORED_LIST =
  "read_anchored, grep_anchored, edit_anchored, write_anchored";

describe("override toggle notice", () => {
  it("notice copy matches the approved contract exactly", () => {
    expect(OVERRIDE_ENABLED_NOTICE).toBe(
      `Tool override enabled: read/edit/write/grep now use anchor-line contracts (see each tool's schema). Previous anchored tool names (${ANCHORED_LIST}) are deactivated.`,
    );
    expect(OVERRIDE_DISABLED_NOTICE).toBe(
      `Tool override disabled: the anchored tools (${ANCHORED_LIST}) are active again; read/edit/write/grep keep their anchored definitions until pi reloads the extension (fully native restore requires a reload).`,
    );
  });

  it("every listed anchored tool name appears in both notices", () => {
    for (const name of ANCHORED_TOOL_NAMES) {
      expect(OVERRIDE_ENABLED_NOTICE).toContain(name);
      expect(OVERRIDE_DISABLED_NOTICE).toContain(name);
    }
  });

  it("primes the baseline on the first turn: no notice, in either mode", () => {
    expect(createOverrideToggleTracker()(false)).toBeUndefined();
    expect(createOverrideToggleTracker()(true)).toBeUndefined();
  });

  it("injects the enabled notice exactly once on an off→on change, then stays silent", () => {
    const track = createOverrideToggleTracker();
    track(false); // first turn primes the stored previous mode
    const notice = track(true);
    expect(notice).toEqual({
      message: { customType: "pi-fast-edits", content: OVERRIDE_ENABLED_NOTICE, display: true },
    });
    expect(track(true)).toBeUndefined();
    expect(track(true)).toBeUndefined();
  });

  it("injects the disabled notice exactly once on an on→off change, then stays silent", () => {
    const track = createOverrideToggleTracker();
    track(true);
    expect(track(false)).toEqual({
      message: { customType: "pi-fast-edits", content: OVERRIDE_DISABLED_NOTICE, display: true },
    });
    expect(track(false)).toBeUndefined();
  });

  it("fires exactly once per change across alternating toggles", () => {
    const track = createOverrideToggleTracker();
    track(false);
    expect(track(true)?.message.content).toBe(OVERRIDE_ENABLED_NOTICE);
    expect(track(false)?.message.content).toBe(OVERRIDE_DISABLED_NOTICE);
    expect(track(true)?.message.content).toBe(OVERRIDE_ENABLED_NOTICE);
    expect(track(false)?.message.content).toBe(OVERRIDE_DISABLED_NOTICE);
    // steady state back at off: no further notice
    expect(track(false)).toBeUndefined();
  });
});

describe("createOverrideNoticeHandler (the before_agent_start body)", () => {
  it("reads the live config each turn: a menu toggle shows on the next turn", () => {
    const config = makeConfig(false);
    const handler = createOverrideNoticeHandler(config);
    expect(handler()).toBeUndefined(); // first turn: baseline, no notice
    config.overrideBuiltInEditTools = true; // /pi-fast-edits config toggle
    expect(handler()).toEqual({
      message: { customType: "pi-fast-edits", content: OVERRIDE_ENABLED_NOTICE, display: true },
    });
    expect(handler()).toBeUndefined();
    config.overrideBuiltInEditTools = false;
    expect(handler()?.message.content).toBe(OVERRIDE_DISABLED_NOTICE);
    expect(handler()).toBeUndefined();
  });

  it("startup with override already on: first turn stays silent", () => {
    const config = makeConfig(true);
    const handler = createOverrideNoticeHandler(config);
    expect(handler()).toBeUndefined();
    expect(handler()).toBeUndefined();
  });
});

describe("before_agent_start wiring (index.ts)", () => {
  async function load(overrides?: Partial<PiFastEditsConfig>) {
    const handlers: Record<string, (event?: unknown, ctx?: unknown) => Promise<unknown> | unknown> =
      {};
    const pi = {
      registerTool() {},
      registerCommand() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      on(event: string, handler: (event?: unknown, ctx?: unknown) => Promise<unknown> | unknown) {
        handlers[event] = handler;
      },
    };
    await piFastEdits(pi as any, overrides);
    return handlers;
  }

  it("registers a before_agent_start handler that is silent on the first turn", async () => {
    const handlers = await load({ overrideBuiltInEditTools: true });
    expect(typeof handlers.before_agent_start).toBe("function");
    expect(await handlers.before_agent_start!({}, {})).toBeUndefined();
  });
});

describe("interception fallback reads the live config flag", () => {
  it("un-blocks write/edit once override is toggled off, re-blocks on re-enable", async () => {
    const config = makeConfig(true);
    const handlers: Record<string, (event?: { toolName?: string }, ctx?: unknown) => unknown> = {};
    const pi = {
      on(event: string, handler: (event?: { toolName?: string }, ctx?: unknown) => unknown) {
        handlers[event] = handler;
      },
    };
    installInterceptionFallback(pi as any, config);

    // Fail mode: write/edit are blocked.
    const write = (await handlers.tool_call!({ toolName: "write" }, {})) as any;
    expect(write?.block).toBe(true);
    const edit = (await handlers.tool_call!({ toolName: "edit" }, {})) as any;
    expect(edit?.block).toBe(true);

    // Menu toggle-off mutates the live config object; the handler must
    // un-block without being re-installed.
    config.overrideBuiltInEditTools = false;
    expect(await handlers.tool_call!({ toolName: "write" }, {})).toBeUndefined();
    expect(await handlers.tool_call!({ toolName: "edit" }, {})).toBeUndefined();

    // Toggling back on re-blocks through the same handler.
    config.overrideBuiltInEditTools = true;
    const reblocked = (await handlers.tool_call!({ toolName: "write" }, {})) as any;
    expect(reblocked?.block).toBe(true);
  });
});

describe("applyOverrideMode disable path (menu toggle-off)", () => {
  const deps: OverrideDeps = {
    registerRead: registerReadAnchoredFile,
    registerEdit: registerApplyAnchoredEdits,
    registerGrep: registerGrepAnchoredFiles,
    registerWrite: registerWriteAnchored,
    installInterception: installInterceptionFallback,
  };

  function fakePi(initialActive: string[]) {
    const setActiveToolsCalls: string[][] = [];
    let activeTools = [...initialActive];
    return {
      pi: {
        registerTool() {},
        getAllTools: () => [],
        getActiveTools: () => [...activeTools],
        setActiveTools(names: string[]) {
          setActiveToolsCalls.push([...names]);
          activeTools = [...names];
        },
      },
      setActiveToolsCalls,
    };
  }

  it("re-activates every suffixed anchored tool while keeping the current active set", () => {
    // Post-override state: the four built-in names (our defs) + bash; the
    // suffixed names were deactivated when override was enabled.
    const { pi, setActiveToolsCalls } = fakePi(["read", "edit", "write", "grep", "bash"]);
    applyOverrideMode(pi as any, { files: new LRUMap() }, makeConfig(false), deps);

    expect(setActiveToolsCalls).toHaveLength(1);
    const last = setActiveToolsCalls[0];
    for (const name of SUFFIXED_TOOL_NAMES) {
      expect(last).toContain(name);
    }
    // Nothing previously active is dropped.
    for (const name of ["read", "edit", "write", "grep", "bash"]) {
      expect(last).toContain(name);
    }
  });
});
