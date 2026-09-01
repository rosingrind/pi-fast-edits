import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { clearToolNameOverrides, setToolNameOverrides } from "./render.js";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import type * as readAnchoredFileModule from "./read-anchored.js";
import type * as editAnchoredModule from "./edit-anchored.js";
import type * as grepAnchoredModule from "./grep-anchored.js";
import type * as writeAnchoredModule from "./write-anchored.js";

/**
 * Structural fingerprint of a tool definition for the override safety check.
 *
 * pi's `getAllTools()` returns `ToolInfo` (name, description, parameters,
 * sourceInfo; `promptGuidelines` only joins it in newer pi versions) and
 * never exposes `execute` or
 * `constrainedSampling` — only our own definitions carry the full handler. The
 * built-in `execute` presence rule from the design spec (D6) is therefore only
 * enforceable when the passed object actually carries the field; against real
 * pi data the load-time guard relies on existence + parameter shape, which is
 * exactly what catches the #57/#58 class of provider-breaking definition bugs.
 */
export type ToolDef = {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown> };
  /** Present on our definitions; absent from pi's getAllTools ToolInfo. */
  execute?: unknown;
};

/**
 * Result of the override safety check.
 *
 * `eligible` — built-ins that are present and structurally clean; the
 * override claims these names. `absent` — built-ins not registered at all,
 * which in child sessions means the agent-type allowlist filtered them out;
 * they are skipped (their suffixed anchored tools stay active) rather than
 * treated as an incompatibility. `reasons` — genuine fingerprint/shape
 * failures only.
 */
export type SafetyCheck = {
  ok: boolean;
  reasons: string[];
  eligible: string[];
  absent: string[];
};

/** Our tools whose behavior is replaced (and which are deactivated) in override mode. */
export const SUFFIXED_TOOL_NAMES = [
  "read_anchored",
  "grep_anchored",
  "write_anchored",
  "edit_anchored",
] as const;

/** The native built-in tool names override mode claims and suppress mode hides. */
const NATIVE_TOOL_NAMES = ["read", "edit", "write", "grep"] as const;
/**
 * Per-behavior override spec: the built-in name we claim, the suffixed tool
 * that provides the behavior, and the built-in parameter properties whose
 * presence the fingerprint check requires.
 */
const OVERRIDE_SPECS = [
  { name: "read", suffixed: "read_anchored", requiredProps: [] },
  { name: "edit", suffixed: "edit_anchored", requiredProps: ["edits"] },
  { name: "grep", suffixed: "grep_anchored", requiredProps: [] },
  { name: "write", suffixed: "write_anchored", requiredProps: ["path", "content"] },
] as const;

const hasExecute = (def: ToolDef): boolean => typeof def.execute === "function";

/**
 * Fingerprint pi's built-in `read`/`edit`/`write`/`grep` and our own
 * definitions before claiming any built-in name (design D6). Any failure
 * yields a human-readable reason so the caller can fall back to interception
 * instead of shipping a broken tool surface.
 *
 * Built-in rules (adapted to pi's real API — `getAllTools()` omits `execute`):
 * - `edit`: registered, `parameters.properties.edits` present, `execute` when the field exists
 * - `write`: registered, `parameters.properties.path` + `.content` present, `execute` when the field exists
 * - `read`/`grep`: registered, `execute` when the field exists
 *
 * Our rules (full definitions, so `execute` is always enforceable):
 * - all four behaviors registered with non-empty `parameters.properties` and an `execute` handler
 *
 * A missing built-in is reported in `absent` (child-session allowlists
 * filter tools per agent type) and is NOT a failure; `eligible` lists the
 * built-ins that are present and clean, and only those need matching `ours`
 * entries.
 */
export function checkOverrideCompatibility(builtins: ToolDef[], ours: ToolDef[]): SafetyCheck {
  const reasons: string[] = [];
  const eligible: string[] = [];
  const absent: string[] = [];
  const builtin = (name: string) => builtins.find((def) => def.name === name);

  // Built-ins: a missing name is an allowlist choice (child sessions filter
  // tools per agent type), recorded in `absent` and skipped — NOT an
  // incompatibility. A present-but-malformed definition stays a hard
  // fingerprint failure.
  for (const spec of OVERRIDE_SPECS) {
    const def = builtin(spec.name);
    if (!def) {
      absent.push(spec.name);
      continue;
    }
    eligible.push(spec.name);
    const props = def.parameters?.properties;
    for (const prop of spec.requiredProps) {
      if (!props?.[prop]) {
        reasons.push(`Built-in '${spec.name}' has no parameters.properties.${prop}.`);
      }
    }
    if (def.execute !== undefined && !hasExecute(def)) {
      reasons.push(`Built-in '${spec.name}' has no execute handler.`);
    }
  }

  // Our definitions are only required for the behaviors actually being
  // overridden (eligible built-ins); in a read-only child session nobody
  // needs edit/write parity.
  for (const spec of OVERRIDE_SPECS) {
    if (!eligible.includes(spec.name)) continue;
    const def = ours.find((d) => d.name === spec.suffixed);
    if (!def) {
      reasons.push(`Our '${spec.suffixed}' tool is not registered.`);
      continue;
    }
    const props = def.parameters?.properties;
    if (!props || Object.keys(props).length === 0) {
      reasons.push(`Our '${spec.suffixed}' tool has no parameters.properties.`);
    }
    if (!hasExecute(def)) {
      reasons.push(`Our '${spec.suffixed}' tool has no execute handler.`);
    }
  }

  return { ok: reasons.length === 0, reasons, eligible, absent };
}

/**
 * Install the fallback `tool_call` interception that blocks the built-in
 * `write`/`edit` names and steers the model toward the anchored tools. Used
 * only when the override safety check fails — the override is requested but
 * cannot claim the names, so a blocked call with a teaching message is the
 * visible fallback tier (spec behavior matrix, row 3).
 *
 * The handler is installed at most once per pi runtime (WeakSet guard):
 * `applyOverrideMode` re-runs on every session_start and config change, so
 * without the guard repeated fail-path runs would stack duplicate handlers.
 * It reads the live `config` at call time: toggling the override OFF from the
 * menu un-blocks `write`/`edit` immediately (and re-blocks on re-enable)
 * without needing to uninstall/reinstall the handler.
 */
const interceptionInstalled = new WeakSet<ExtensionAPI>();

export function installInterceptionFallback(pi: ExtensionAPI, config: PiFastEditsConfig): void {
  if (interceptionInstalled.has(pi)) return;
  interceptionInstalled.add(pi);
  pi.on("tool_call", (event, _ctx) => {
    if (!config.overrideBuiltInEditTools) return undefined;
    const name = event.toolName ?? "";
    if (name === "write" || name === "edit") {
      return {
        block: true,
        reason:
          "pi-fast-edits override is enabled but the built-in tools could not be replaced. Use read_anchored plus the anchored edit tools instead.",
      };
    }
    return undefined;
  });
}

/** The registration functions (re-callable, stateless) that produce our tool definitions. */
export type OverrideDeps = {
  registerRead: typeof readAnchoredFileModule.registerReadAnchored;
  registerEdit: typeof editAnchoredModule.registerEditAnchored;
  registerGrep: typeof grepAnchoredModule.registerGrepAnchored;
  registerWrite: typeof writeAnchoredModule.registerWriteAnchored;
  installInterception: (pi: ExtensionAPI, config: PiFastEditsConfig) => void;
};

/** The subset of pi's ExtensionContext that the warning path reads. */
type OverrideContext = {
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
};

/** Description prefix applied to each renamed override so the model can tell them apart. */
const OVERRIDE_DESCRIPTIONS: Array<{ builtin: string; prefix: string }> = [
  { builtin: "read", prefix: "Anchored read (default). " },
  { builtin: "edit", prefix: "Anchored edit (batch). " },
  { builtin: "grep", prefix: "Anchored grep (edit-ready). " },
  { builtin: "write", prefix: "Anchored write (anchor-seeding). " },
];

/**
 * Apply the override mode matching `config.overrideBuiltInEditTools`:
 *
 * - Enabled → safety check first:
 *   - Pass → re-register our behaviors under each eligible built-in name
 *     (present + structurally clean; renamed defs, descriptions prefixed)
 *     and deactivate the matching suffixed names via `setActiveTools`
 *     (design D7). Built-ins absent from the registry (child-session
 *     allowlists) are skipped — not treated as failure.
 *   - Genuine fingerprint/shape failure → install the interception fallback
 *     and surface a warning through `ctx.ui` — never silently do nothing.
 * - Disabled → restore: the suffixed anchored tools remain registered (they
 *   are re-registered on every config change), so re-activate them via
 *   `setActiveTools`. The four override names keep our definitions — pi has no
 *   unregister API, so they stay registered until the extension reloads.
 *
 * Must be invoked from an event handler (e.g. `session_start`) or the config
 * change path, not from the extension factory: pi's runtime actions
 * (`getAllTools`/`setActiveTools`) are only bound after extension loading, and
 * `registerTool` at runtime refreshes the registry in-session.
 */
export function applyOverrideMode(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
  deps: OverrideDeps,
  ctx?: OverrideContext,
): void {
  if (config.overrideBuiltInEditTools) {
    enableOverride(pi, session, config, deps, ctx);
    return;
  }
  disableOverride(pi, config.suppressNativeTools);
}

/**
 * Disable path (mid-session toggle-off): the suffixed names are still in the
 * registry, just deactivated — re-add them to the active set.
 */
function disableOverride(pi: ExtensionAPI, suppressNativeTools: boolean): void {
  clearToolNameOverrides();
  const keepActive = new Set(pi.getActiveTools());
  for (const name of SUFFIXED_TOOL_NAMES) {
    keepActive.add(name);
  }
  if (suppressNativeTools) {
    // Hide the native names entirely: the model can only call the anchored
    // tools, so no name-shadowed dispatch (built-in edit body vs extension
    // def) can occur at all.
    for (const name of NATIVE_TOOL_NAMES) {
      keepActive.delete(name);
    }
  }
  pi.setActiveTools([...keepActive]);
}

/**
 * Enabled path: build fresh definitions, fingerprint, then claim exactly the
 * eligible built-ins (renamed registrations, active-set membership, rendered
 * titles). Genuine fingerprint failures fall back to interception.
 */
function enableOverride(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
  deps: OverrideDeps,
  ctx?: OverrideContext,
): void {
  // Build fresh definitions (re-callable registrations; re-registering a
  // suffixed name under its own name is idempotent replacement in pi).
  const readDef = deps.registerRead(pi, session, config);
  const editDef = deps.registerEdit(pi, session, config);
  const grepDef = deps.registerGrep(pi, session, config);
  const writeDef = deps.registerWrite(pi, session, config);
  const ours: ToolDef[] = [readDef, editDef, grepDef, writeDef];

  const fail = (reasons: string[]) => {
    clearToolNameOverrides();
    deps.installInterception(pi, config);
    ctx?.ui?.notify?.(
      `pi-fast-edits: built-in read/edit/write/grep override could not be enabled ` +
        `(safety check failed: ${reasons.join("; ")}). Falling back to interception — ` +
        `write/edit calls will be blocked with a steering message.`,
      "warning",
    );
  };

  let check: SafetyCheck;
  try {
    check = checkOverrideCompatibility(pi.getAllTools(), ours);
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
    return;
  }
  if (!check.ok) {
    fail(check.reasons);
    return;
  }

  // Renamed registrations for the eligible built-ins only: same definition
  // object, built-in name, prefixed description. constrainedSampling parity
  // is skipped because pi's getAllTools() ToolInfo does not expose the field
  // to copy from (verified against the .d.ts during Task 3).
  for (const name of check.eligible) {
    // Concrete defs (not a union) so registerTool's parameter-schema generic
    // instantiates per call, exactly as in the unconditional version.
    switch (name) {
      case "read":
        registerRenamed(pi, readDef, name, OVERRIDE_DESCRIPTIONS[0].prefix);
        break;
      case "edit":
        registerRenamed(pi, editDef, name, OVERRIDE_DESCRIPTIONS[1].prefix);
        break;
      case "grep":
        registerRenamed(pi, grepDef, name, OVERRIDE_DESCRIPTIONS[2].prefix);
        break;
      case "write":
        registerRenamed(pi, writeDef, name, OVERRIDE_DESCRIPTIONS[3].prefix);
        break;
      default:
        // Unreachable: eligible names are validated by checkOverrideCompatibility.
        break;
    }
  }

  activateEligible(pi, check.eligible);
}

/** Register one of our definitions under a built-in name with a prefixed description. */
function registerRenamed<TParams extends TSchema>(
  pi: ExtensionAPI,
  def: ToolDefinition<TParams, unknown, any>,
  name: string,
  prefix: string,
): void {
  pi.registerTool({ ...def, name, description: prefix + def.description });
}

/**
 * setActiveTools replaces the whole active set: keep everything pi considers
 * active today except the suffixed names whose built-in we now override, and
 * force the eligible built-in names active. The union matters: pi's default
 * active set is [read, bash, edit, write] — grep is registered-but-inactive,
 * so without forcing the override names the model would have no search tool.
 * Suffixed tools for absent built-ins (e.g. edit_anchored in a read-only
 * child session) stay as the allowlist left them.
 */
function activateEligible(pi: ExtensionAPI, eligible: string[]): void {
  const suffixedToBuiltin = new Map<string, string>(
    OVERRIDE_SPECS.map((s) => [s.suffixed, s.name] as const),
  );
  const overridden = new Set<string>(eligible);
  const keepActive = new Set(
    pi
      .getActiveTools()
      .filter(
        (name) => !(suffixedToBuiltin.has(name) && overridden.has(suffixedToBuiltin.get(name)!)),
      ),
  );
  for (const name of eligible) {
    keepActive.add(name);
  }
  pi.setActiveTools([...keepActive]);
  // Rendered titles follow the built-in names the definitions now carry —
  // only for the pairs actually claimed.
  setToolNameOverrides(
    Object.fromEntries([...suffixedToBuiltin].filter(([, builtin]) => overridden.has(builtin))),
  );
}
