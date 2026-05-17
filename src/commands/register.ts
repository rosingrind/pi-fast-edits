import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatConfig, parseConfirmationMode } from "../config.js";
import type { PiFastEditsConfig, SessionState } from "../types.js";

export function registerCommands(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerCommand("pi-fast-edits", {
    description: "Configure pi-fast-edits. Usage: /pi-fast-edits status|config|override on|off|confirmations always|protected-paths|never",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const notify = (message: string) => ctx.ui?.notify?.(message, "info") ?? console.log(message);

      if (action === "status") {
        const trackedAnchors = [...session.files.values()].reduce((sum, file) => sum + file.lines.length, 0);
        notify([
          "pi-fast-edits status",
          `Override built-ins: ${config.overrideBuiltInEditTools ? "on" : "off"}`,
          `Confirmation mode: ${config.confirmation}`,
          `Tracked files: ${session.files.size}`,
          `Tracked anchors: ${trackedAnchors}`,
          `Large file mode: ${config.largeFileMode}`
        ].join("\n"));
        return;
      }

      if (action === "config") {
        notify(formatConfig(config));
        return;
      }

      if (action === "override") {
        const value = parts[1];
        if (value !== "on" && value !== "off") {
          notify("Usage: /pi-fast-edits override on|off");
          return;
        }
        config.overrideBuiltInEditTools = value === "on";
        notify(`pi-fast-edits override is now ${value}.`);
        return;
      }

      if (action === "confirmations") {
        const mode = parseConfirmationMode(parts[1] ?? "");
        if (!mode) {
          notify("Usage: /pi-fast-edits confirmations always|protected-paths|never");
          return;
        }
        config.confirmation = mode;
        notify(`pi-fast-edits confirmation mode is now ${mode}.`);
        return;
      }

      notify("Usage: /pi-fast-edits status|config|override on|off|confirmations always|protected-paths|never");
    }
  });
}
