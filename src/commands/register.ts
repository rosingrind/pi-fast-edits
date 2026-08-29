import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { showConfigMenu } from "../config-ui.js";
import type { PiFastEditsConfig, SessionState } from "../types.js";

const SUBCOMMANDS = ["status", "config"] as const;

export function registerCommands(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
  onConfigChanged: () => void,
): void {
  pi.registerCommand("pi-fast-edits", {
    description: "Configure pi-fast-edits. Usage: /pi-fast-edits status|config",
    getArgumentCompletions(_currentArg: string): AutocompleteItem[] | null {
      return SUBCOMMANDS.map((s) => ({ value: s, label: s }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";

      if (action === "status") {
        const trackedAnchors = [...session.files.values()].reduce(
          (sum, file) => sum + file.lines.length,
          0,
        );
        const summary = [
          `Override built-ins: ${config.overrideBuiltInEditTools ? "on" : "off"}`,
          `Confirmation mode: ${config.confirmation}`,
          `Tracked files: ${session.files.size}`,
          `Tracked anchors: ${trackedAnchors}`,
        ];
        if (ctx.hasUI) {
          // notify() renders inline in the chat transcript (dim text), not a modal.
          ctx.ui.notify(summary.join("\n"));
        } else {
          // No TUI (e.g. print mode): ui.notify is a no-op, so log directly.
          console.log(summary.join("\n"));
        }
        return;
      }

      if (action === "config") {
        await showConfigMenu(config, ctx, onConfigChanged);
        return;
      }

      ctx.ui.notify("Usage: /pi-fast-edits status|config", "info");
    },
  });
}
