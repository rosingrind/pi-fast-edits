import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";
import { SETTINGS, applySetting, parsePositiveInt, toPositiveInt } from "./config-settings.js";
import { saveConfig } from "./config-persistence.js";
import type { PiFastEditsConfig } from "./types.js";

const MAX_VISIBLE = 10;
const SUBMENU_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 40 };
const ADD_PATTERN = "__add__";

/**
 * Submenu for entering a bounded numeric setting via a single-line input.
 * Enter applies the value, Esc returns to the settings list.
 */
class NumberInputSubmenu extends Container {
  private readonly input: Input;

  constructor(
    title: string,
    description: string,
    currentValue: string,
    theme: Theme,
    onApply: (value: number) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.input = new Input();
    this.input.setValue(currentValue);
    this.input.onSubmit = (raw) => {
      const parsed = parsePositiveInt(raw);
      if (parsed === undefined) {
        this.input.setValue(currentValue);
        return;
      }
      onApply(parsed);
    };
    this.input.onEscape = () => onCancel();
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

/**
 * Submenu for managing the protected-paths glob list. Renders a SelectList of
 * existing patterns (Enter removes) plus an "Add pattern" entry that swaps in a
 * free text Input.
 */
class ProtectedPathsSubmenu extends Container {
  private readonly theme: Theme;
  private readonly onChange: (paths: string[]) => void;
  private readonly onDone: (countText?: string) => void;
  private readonly input: Input;
  private selectList: SelectList | null = null;
  private mode: "list" | "input" = "list";
  private paths: string[];

  constructor(
    paths: string[],
    theme: Theme,
    onChange: (paths: string[]) => void,
    onDone: (countText?: string) => void,
  ) {
    super();
    this.theme = theme;
    this.paths = [...paths];
    this.onChange = onChange;
    this.onDone = onDone;
    this.input = new Input();
    this.input.onSubmit = (raw) => {
      const value = raw.trim();
      if (value && !this.paths.includes(value)) {
        this.paths = [...this.paths, value];
        this.onChange(this.paths);
      }
      this.input.setValue("");
      this.showList();
    };
    this.input.onEscape = () => this.showList();
    this.showList();
  }

  private addHeader(): void {
    this.addChild(new Text(this.theme.bold(this.theme.fg("accent", "Protected paths")), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        this.theme.fg("muted", "Glob patterns that block anchored edits without confirmation."),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
  }

  private showList(): void {
    this.mode = "list";
    this.clear();
    this.addHeader();
    this.selectList = new SelectList(
      [
        { value: ADD_PATTERN, label: "＋ Add new pattern", description: "Type a glob to protect" },
        ...this.paths.map((p) => ({ value: p, label: p, description: "Enter to remove" })),
      ],
      Math.min(this.paths.length + 1, MAX_VISIBLE),
      getSelectListTheme(),
      SUBMENU_LAYOUT,
    );
    this.selectList.onSelect = (item) => {
      if (item.value === ADD_PATTERN) {
        this.showInput();
      } else {
        this.paths = this.paths.filter((p) => p !== item.value);
        this.onChange(this.paths);
        this.showList();
      }
    };
    this.selectList.onCancel = () => this.onDone(String(this.paths.length));
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
    this.invalidate();
  }

  private showInput(): void {
    this.mode = "input";
    this.clear();
    this.addHeader();
    this.addChild(new Text(this.theme.fg("muted", "New protected glob:"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "  Enter to add · Esc to go back"), 0, 0));
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode === "input") {
      this.input.handleInput(data);
    } else {
      this.selectList?.handleInput(data);
    }
  }
}

/**
 * Main interactive settings menu, rendered via `ctx.ui.custom()`. Mirrors the
 * built-in `/settings` selector: blue borders, a searchable SettingsList, and
 * submenus for numeric/protected-path settings.
 */
class ConfigMenuComponent extends Container {
  constructor(
    items: SettingItem[],
    theme: Theme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super();
    const border = (str: string) => theme.fg("border", str);
    this.addChild(new DynamicBorder(border));
    this.addChild(
      new SettingsList(items, MAX_VISIBLE, getSettingsListTheme(), onChange, onCancel, {
        enableSearch: true,
      }),
    );
    this.addChild(new DynamicBorder(border));
  }

  handleInput(data: string): void {
    // Forward all input to the SettingsList, which itself routes to active submenus.
    const settingsList = this.children[1];
    if (settingsList && typeof (settingsList as SettingsList).handleInput === "function") {
      (settingsList as SettingsList).handleInput(data);
    }
  }
}

export function buildItems(
  config: PiFastEditsConfig,
  theme: Theme,
  onChange: (id: string, newValue: string) => void,
): SettingItem[] {
  const numeric = (
    id: string,
    label: string,
    description: string,
    current: number,
  ): SettingItem => ({
    id,
    label,
    description,
    currentValue: String(current),
    submenu: (currentValue, done) =>
      new NumberInputSubmenu(
        label,
        description,
        currentValue,
        theme,
        (value) => {
          onChange(id, String(value));
          done(String(value));
        },
        () => done(),
      ),
  });

  // One row per registry descriptor — adding a setting to SETTINGS (and to
  // the config type) is all it takes for it to appear here automatically.
  // The label leads with the config key: the menu's search matches labels
  // only, so every setting must be findable by its key name.
  return SETTINGS.map((descriptor) => {
    const keyedLabel = `${descriptor.id} — ${descriptor.label}`;
    switch (descriptor.kind.type) {
      case "boolean":
        return {
          id: descriptor.id,
          label: keyedLabel,
          description: descriptor.description,
          currentValue: config[descriptor.id] ? "on" : "off",
          values: ["on", "off"],
        };
      case "enum":
        return {
          id: descriptor.id,
          label: keyedLabel,
          description: descriptor.description,
          currentValue: config[descriptor.id] as string,
          values: [...descriptor.kind.values],
        };
      case "number":
        return numeric(
          descriptor.id,
          keyedLabel,
          descriptor.description,
          config[descriptor.id] as number,
        );
      case "pathList":
        return {
          id: descriptor.id,
          label: keyedLabel,
          description: descriptor.description,
          currentValue: `${config.protectedPaths.length} pattern${config.protectedPaths.length === 1 ? "" : "s"}`,
          submenu: (_currentValue, done) =>
            new ProtectedPathsSubmenu(
              config.protectedPaths,
              theme,
              (paths) => {
                config.protectedPaths = paths;
                void saveConfig(config);
              },
              (countText) => done(countText),
            ),
        };
    }
  });
}

/**
 * Open an interactive `/settings`-style menu for pi-fast-edits. Mutations are
 * applied to the live runtime config object and persisted to disk. Resolves
 * when the menu closes.
 */
export async function showConfigMenu(
  config: PiFastEditsConfig,
  ctx: ExtensionCommandContext,
  onConfigChanged: (id: string, ctx: ExtensionCommandContext) => void,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The pi-fast-edits config menu requires an interactive terminal.", "warning");
    return;
  }
  await ctx.ui.custom<void>((_ctx, theme, _keybindings, done) => {
    const onChange = (id: string, newValue: string) => {
      // Generic coercion per the descriptor's kind; unknown ids and the
      // path-list submenu are no-ops.
      applySetting(config, id, newValue);
      // Re-register the edit tools so their schemas follow the new setting,
      // then re-apply the tool surface (suppress toggles take effect live).
      onConfigChanged(id, ctx);
      void saveConfig(config).then((ok) => {
        if (!ok) ctx?.ui?.notify?.("pi-fast-edits: failed to save settings to disk", "warning");
      });
    };
    return new ConfigMenuComponent(buildItems(config, theme, onChange), theme, onChange, () =>
      done(),
    );
  });
}
