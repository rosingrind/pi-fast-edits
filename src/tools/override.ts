import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import type * as readAnchoredFileModule from "./read-anchored-file.js";
import type * as applyAnchoredEditsModule from "./apply-anchored-edits.js";
import type * as grepAnchoredModule from "./grep-anchored.js";
import type * as writeAnchoredModule from "./write-anchored.js";

/**
 * Structural fingerprint of a tool definition for the override safety check.
 *
 * pi's `getAllTools()` returns `ToolInfo` (name, description, parameters,
 * promptGuidelines, sourceInfo) and never exposes `execute` or
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

export type SafetyCheck = { ok: boolean; reasons: string[] };

/** Our tools whose behavior is replaced (and which are deactivated) in override mode. */
export const SUFFIXED_TOOL_NAMES = [
  "read_anchored_file",
  "grep_anchored_files",
  "write_anchored",
  "edit_anchored_range",
  "insert_at_anchor",
  "delete_anchor_range",
  "preview_anchored_edit",
  "apply_anchored_edits",
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
 */
export function checkOverrideCompatibility(builtins: ToolDef[], ours: ToolDef[]): SafetyCheck {
  const reasons: string[] = [];
  const builtin = (name: string) => builtins.find((def) => def.name === name);
  const oursByName = (name: string) => ours.find((def) => def.name === name);

  const edit = builtin("edit");
  if (edit) {
    if (!edit.parameters?.properties?.edits) {
      reasons.push("Built-in 'edit' has no parameters.properties.edits.");
    }
    if (edit.execute !== undefined && !hasExecute(edit)) {
      reasons.push("Built-in 'edit' has no execute handler.");
    }
  } else {
    reasons.push("Built-in 'edit' tool is not registered.");
  }

  const write = builtin("write");
  if (write) {
    const props = write.parameters?.properties;
    if (!props?.path) {
      reasons.push("Built-in 'write' has no parameters.properties.path.");
    }
    if (!props?.content) {
      reasons.push("Built-in 'write' has no parameters.properties.content.");
    }
    if (write.execute !== undefined && !hasExecute(write)) {
      reasons.push("Built-in 'write' has no execute handler.");
    }
  } else {
    reasons.push("Built-in 'write' tool is not registered.");
  }

  for (const name of ["read", "grep"]) {
    const def = builtin(name);
    if (!def) {
      reasons.push(`Built-in '${name}' tool is not registered.`);
    } else if (def.execute !== undefined && !hasExecute(def)) {
      reasons.push(`Built-in '${name}' has no execute handler.`);
    }
  }

  for (const oursName of [
    "read_anchored_file",
    "apply_anchored_edits",
    "grep_anchored_files",
    "write_anchored",
  ]) {
    const def = oursByName(oursName);
    if (!def) {
      reasons.push(`Our '${oursName}' tool is not registered.`);
      continue;
    }
    const props = def.parameters?.properties;
    if (!props || Object.keys(props).length === 0) {
      reasons.push(`Our '${oursName}' tool has no parameters.properties.`);
    }
    if (!hasExecute(def)) {
      reasons.push(`Our '${oursName}' tool has no execute handler.`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Install the fallback `tool_call` interception that blocks the built-in
 * `write`/`edit` names and steers the model toward the anchored tools. Used
 * only when the override safety check fails — the override is requested but
 * cannot claim the names, so a blocked call with a teaching message is the
 * visible fallback tier (spec behavior matrix, row 3).
 */
export function installInterceptionFallback(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, _ctx) => {
    const name = event.toolName ?? "";
    if (name === "write" || name === "edit") {
      return {
        block: true,
        reason:
          "pi-fast-edits override is enabled but the built-in tools could not be replaced. Use read_anchored_file plus the anchored edit tools instead.",
      };
    }
    return undefined;
  });
}

/** The registration functions (re-callable, stateless) that produce our tool definitions. */
export type OverrideDeps = {
  registerRead: typeof readAnchoredFileModule.registerReadAnchoredFile;
  registerEdit: typeof applyAnchoredEditsModule.registerApplyAnchoredEdits;
  registerGrep: typeof grepAnchoredModule.registerGrepAnchoredFiles;
  registerWrite: typeof writeAnchoredModule.registerWriteAnchored;
  installInterception: (pi: ExtensionAPI) => void;
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
 * Decide override vs. interception for `overrideBuiltInEditTools`:
 *
 * - Safety check passes → re-register our four behaviors under the built-in
 *   names (renamed defs, descriptions prefixed) and deactivate our suffixed
 *   names via `setActiveTools` (design D7).
 * - Safety check fails → install the interception fallback and surface a
 *   warning through `ctx.ui` — never silently do nothing.
 *
 * Must be invoked from an event handler (e.g. `session_start`), not from the
 * extension factory: pi's runtime actions (`getAllTools`/`setActiveTools`) are
 * only bound after extension loading, and `registerTool` at runtime refreshes
 * the registry in-session.
 */
export function applyOverrideMode(
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
    deps.installInterception(pi);
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

  // Renamed registrations: same definition object, built-in name, prefixed
  // description. constrainedSampling parity is skipped because pi's
  // getAllTools() ToolInfo does not expose the field to copy from (verified
  // against the .d.ts during Task 3).
  pi.registerTool({
    ...readDef,
    name: "read",
    description: OVERRIDE_DESCRIPTIONS[0].prefix + readDef.description,
  });
  pi.registerTool({
    ...editDef,
    name: "edit",
    description: OVERRIDE_DESCRIPTIONS[1].prefix + editDef.description,
  });
  pi.registerTool({
    ...grepDef,
    name: "grep",
    description: OVERRIDE_DESCRIPTIONS[2].prefix + grepDef.description,
  });
  pi.registerTool({
    ...writeDef,
    name: "write",
    description: OVERRIDE_DESCRIPTIONS[3].prefix + writeDef.description,
  });

  // setActiveTools replaces the whole active set: keep everything pi considers
  // active today except our suffixed names (the four override names were just
  // registered, so they stay active).
  const suffixed = new Set<string>(SUFFIXED_TOOL_NAMES);
  const keepActive = pi.getActiveTools().filter((name) => !suffixed.has(name));
  pi.setActiveTools(keepActive);
}
