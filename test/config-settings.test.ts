import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SETTINGS, applySetting } from "../src/config-settings.js";
import { buildItems } from "../src/config-ui.js";

/**
 * The config menu is schema-driven: SETTINGS is the single source of truth,
 * and buildItems renders one row per descriptor. These tests guarantee that
 * ANY field added to PiFastEditsConfig/DEFAULT_CONFIG either gets a menu row
 * or fails loudly — the "always pick up any added setting" contract.
 */

const stubTheme = {
  bold: (s: string) => s,
  fg: (_color: string, s: string) => s,
} as any;

describe("SETTINGS registry completeness", () => {
  it("covers every key of DEFAULT_CONFIG (any added setting must get a row)", () => {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(
        SETTINGS.some((d) => d.id === key),
        `DEFAULT_CONFIG key "${key}" has no config-menu descriptor`,
      ).toBe(true);
    }
  });

  it("has no stale descriptors (every id exists in DEFAULT_CONFIG)", () => {
    for (const d of SETTINGS) {
      expect(
        Object.hasOwn(DEFAULT_CONFIG, d.id),
        `descriptor "${d.id}" is not a real config field`,
      ).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = SETTINGS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("applySetting (generic coercion)", () => {
  it("toggles booleans from 'on'/'off'", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    applySetting(config, "suppressNativeTools", "on");
    expect(config.suppressNativeTools).toBe(true);
    applySetting(config, "suppressNativeTools", "off");
    expect(config.suppressNativeTools).toBe(false);
    applySetting(config, "requireAnchorLines", "on");
    expect(config.requireAnchorLines).toBe(true);
  });

  it("accepts 'true'/'false' spellings", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    applySetting(config, "suppressNativeTools", "true");
    expect(config.suppressNativeTools).toBe(true);
    applySetting(config, "suppressNativeTools", "false");
    expect(config.suppressNativeTools).toBe(false);
  });

  it("treats any other string as off (matches 'on' semantics)", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    config.suppressNativeTools = true;
    applySetting(config, "suppressNativeTools", "banana");
    expect(config.suppressNativeTools).toBe(false);
  });

  it("applies valid enum values and ignores invalid ones", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    applySetting(config, "confirmation", "always");
    expect(config.confirmation).toBe("always");
    applySetting(config, "confirmation", "bogus");
    expect(config.confirmation).toBe("always"); // unchanged
  });

  it("clamps numbers: positive integers apply, junk keeps the current value", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    applySetting(config, "maxReadLines", "500");
    expect(config.maxReadLines).toBe(500);
    applySetting(config, "maxReadLines", "0");
    expect(config.maxReadLines).toBe(500);
    applySetting(config, "maxReadLines", "-3");
    expect(config.maxReadLines).toBe(500);
    applySetting(config, "maxReadLines", "12.9");
    expect(config.maxReadLines).toBe(500);
    applySetting(config, "maxReadLines", "abc");
    expect(config.maxReadLines).toBe(500);
  });

  it("leaves the protectedPaths list untouched (its submenu owns it)", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const before = [...config.protectedPaths];
    applySetting(config, "protectedPaths", "on");
    expect(config.protectedPaths).toEqual(before);
  });

  it("no-ops on unknown ids", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    applySetting(config, "noSuchSetting", "on");
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      protectedPaths: [...DEFAULT_CONFIG.protectedPaths],
    });
  });
});

describe("buildItems (menu rows)", () => {
  it("renders exactly one row per descriptor, in registry order", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    expect(items.map((i) => i.id)).toEqual(SETTINGS.map((d) => d.id));
  });

  it("boolean rows show on/off from the live config", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    const suppress = items.find((i) => i.id === "suppressNativeTools")!;
    expect(suppress.currentValue).toBe("off");
    expect(suppress.values).toEqual(["on", "off"]);
    config.suppressNativeTools = true;
    const items2 = buildItems(config, stubTheme, () => {});
    expect(items2.find((i) => i.id === "suppressNativeTools")!.currentValue).toBe("on");
  });

  it("enum rows expose the valid values", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    const confirmation = items.find((i) => i.id === "confirmation")!;
    expect(confirmation.values).toEqual(["always", "protected-paths", "never"]);
    expect(confirmation.currentValue).toBe("protected-paths");
  });

  it("number rows carry a submenu (lazily constructed)", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    const maxRead = items.find((i) => i.id === "maxReadLines")!;
    expect(maxRead.currentValue).toBe("2000");
    expect(typeof maxRead.submenu).toBe("function");
  });

  it("path-list rows carry a submenu", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    const paths = items.find((i) => i.id === "protectedPaths")!;
    expect(typeof paths.submenu).toBe("function");
    expect(paths.currentValue).toContain(String(DEFAULT_CONFIG.protectedPaths.length));
  });
});

describe("menu search finds settings by config key", () => {
  it("every row label carries its config key (search matches labels only)", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
    const items = buildItems(config, stubTheme, () => {});
    for (const item of items) {
      expect(
        item.label.startsWith(`${item.id} — `),
        `row "${item.label}" must lead with its config key "${item.id}" so the menu search finds it`,
      ).toBe(true);
    }
  });
});
