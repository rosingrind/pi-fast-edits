import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands/register.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { LRUMap, type PiFastEditsConfig, type SessionState } from "../src/types.js";

describe("command handlers", () => {
  function createMock(hasUI: boolean) {
    const notifications: string[] = [];
    const selects: { title: string; options: string[] }[] = [];
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerTool() {},
      registerCommand(_name: string, cmd: { description: string; handler: typeof handler }) {
        handler = cmd.handler;
      },
      on() {},
    };
    const session: SessionState = { files: new LRUMap(), readRoots: [] };
    const config: PiFastEditsConfig = {
      ...DEFAULT_CONFIG,
      protectedPaths: [...DEFAULT_CONFIG.protectedPaths],
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerCommands(pi as any, session, config, () => {});

    return {
      handler,
      config,
      session,
      selects,
      logCalls: logSpy.mock.calls,
      logSpy,
      notify: async (args: string) => {
        await handler!(args, {
          hasUI,
          ui: {
            notify: (message: string) => notifications.push(message),
            select: async (title: string, options: string[]) => {
              selects.push({ title, options });
              return options[0];
            },
          },
        });
      },
      notifications,
    };
  }

  it("status uses notify when UI is available", async () => {
    const { notify, config, notifications, logSpy } = createMock(true);
    config.confirmation = "always";
    await notify("status");
    expect(notifications).toHaveLength(1);
    const text = notifications[0];
    expect(text).toContain("Confirmation mode: always");
    expect(text).not.toContain("{");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("status logs a human-readable summary without UI", async () => {
    const { notify, logCalls, logSpy } = createMock(false);
    await notify("status");
    const text = String(logCalls[0]?.[0] ?? "");
    expect(text).toContain("Confirmation mode:");
    expect(text).not.toContain("{");
    logSpy.mockRestore();
  });

  it("config warns when no interactive UI is available", async () => {
    const { notify, notifications, logSpy } = createMock(false);
    await notify("config");
    expect(notifications[0]).toContain("interactive");
    logSpy.mockRestore();
  });

  it("unknown action shows usage", async () => {
    const { notify, notifications, logSpy } = createMock(false);
    await notify("bogus");
    expect(notifications[0]).toContain("Usage");
    expect(notifications[0]).toContain("status|config");
    logSpy.mockRestore();
  });

  it("no argument defaults to status", async () => {
    const { notify, logCalls, logSpy } = createMock(false);
    await notify("");
    expect(String(logCalls[0]?.[0] ?? "")).toContain("Confirmation mode:");
    logSpy.mockRestore();
  });
});
