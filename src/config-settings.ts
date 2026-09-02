import type { ConfirmationMode, PiFastEditsConfig } from "./types.js";

/**
 * Schema-driven config menu. SETTINGS is the single source of truth for the
 * interactive menu: buildItems (config-ui.ts) renders one row per descriptor,
 * and applySetting coerces the raw menu string back onto the live config.
 * Adding a field to PiFastEditsConfig/DEFAULT_CONFIG and one descriptor here
 * is all it takes for the setting to appear in /pi-fast-edits config —
 * test/config-settings.test.ts enforces that the registry never drifts from
 * the config type (every key must have a row, every row must be a real key).
 */
export type SettingKind =
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] }
  | { type: "number" }
  | { type: "pathList" };

export type SettingDescriptor = {
  id: keyof PiFastEditsConfig;
  label: string;
  description: string;
  kind: SettingKind;
};

export const SETTINGS: SettingDescriptor[] = [
  {
    id: "confirmation",
    label: "Confirmation mode",
    description: "When to ask before editing: always, only for protected paths, or never",
    kind: {
      type: "enum",
      values: ["always", "protected-paths", "never"] satisfies ConfirmationMode[],
    },
  },
  {
    id: "requireAnchorLines",
    label: "Require anchor line args",
    description:
      "Edit tools require the exact anchor line content (startAnchorLine/endAnchorLine/anchorLine) on every edit",
    kind: { type: "boolean" },
  },
  {
    id: "suppressNativeTools",
    label: "Hide native read/edit/write/grep",
    description:
      "Remove the native tool names from the model's active set — only the anchored tools are callable",
    kind: { type: "boolean" },
  },
  {
    id: "maxRangeReadLines",
    label: "Max range-read lines",
    description: "Maximum lines returned by a range read (longer windows are clamped)",
    kind: { type: "number" },
  },
  {
    id: "maxReadLines",
    label: "Max full-read lines",
    description:
      "Maximum lines returned by a full read (longer files are truncated with a continuation notice)",
    kind: { type: "number" },
  },
  {
    id: "protectedPaths",
    label: "Protected paths",
    description: "Glob patterns that require confirmation before edits",
    kind: { type: "pathList" },
  },
];

/** Parse a positive integer. Returns undefined for empty, zero, negative, or non-integer input.
 * Zero breaks read tools (invalid range, or returns 1 line). */
export function parsePositiveInt(value: string): number | undefined {
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function toPositiveInt(value: string, fallback: number): number {
  return parsePositiveInt(value) ?? fallback;
}

/**
 * Apply a menu change to the live config, coercing the raw string per the
 * descriptor's kind:
 * - boolean: "on"/"true" -> true, anything else -> false
 * - enum:    only known values apply (invalid input leaves the field unchanged)
 * - number:  positive integers apply, junk keeps the current value
 * - pathList: owned by its submenu — no-op here
 * Unknown ids are ignored (defensive; the registry drives the menu).
 */
export function applySetting(config: PiFastEditsConfig, id: string, newValue: string): void {
  const descriptor = SETTINGS.find((d) => d.id === id);
  if (!descriptor) return;
  // SAFETY: `id` was matched against SETTINGS, whose ids are all real
  // `keyof PiFastEditsConfig` fields, so each write below lands on an actual
  // config property with a value type matching the descriptor's kind.
  const target = config as unknown as Record<string, unknown>;
  switch (descriptor.kind.type) {
    case "boolean":
      target[id] = newValue === "on" || newValue === "true";
      break;
    case "enum": {
      if (descriptor.kind.values.includes(newValue)) {
        target[id] = newValue;
      }
      break;
    }
    case "number": {
      const current = target[id];
      target[id] = toPositiveInt(newValue, typeof current === "number" ? current : 0);
      break;
    }
    case "pathList":
      break;
  }
}
