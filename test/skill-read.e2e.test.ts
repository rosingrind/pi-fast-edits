import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import type { Theme } from "../src/tools/theme.js";

type ToolDef = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: Theme, context: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const theme: Theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

async function harness() {
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(t: ToolDef) {
      tools.set(t.name, t);
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as unknown as Parameters<typeof piFastEdits>[0]);
  return { handlers, tools };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content[0]?.text ?? "";

describe("agent reads a skill (host-sanctioned read roots)", () => {
  it("before_agent_start → read SKILL.md + sibling → [skill] box; strangers rejected; writes bounded", async () => {
    const ws = await mkdtemp(join(tmpdir(), "pfe-skill-ws-"));
    const skillDir = await mkdtemp(join(tmpdir(), "pfe-skill-pkg-"));
    const skillSub = join(skillDir, "my-skill");
    await mkdir(skillSub, { recursive: true });
    await writeFile(join(skillSub, "SKILL.md"), "alpha\nbeta\n", "utf8");
    await mkdir(join(skillSub, "references"), { recursive: true });
    const nested = join(skillSub, "references", "deep.md");
    await writeFile(nested, "deep content\n", "utf8");
    const strangerDir = await mkdtemp(join(tmpdir(), "pfe-skill-stranger-"));
    const stranger = join(strangerDir, "secret.txt");
    await writeFile(stranger, "nope\n", "utf8");

    const s = await harness();
    // The host announces what it loaded; skills live OUTSIDE the workspace.
    await s.handlers.before_agent_start!(
      {
        systemPromptOptions: {
          skills: [{ name: "my-skill", baseDir: skillSub, filePath: join(skillSub, "SKILL.md") }],
        },
      },
      {},
    );

    // 1) The SKILL.md read succeeds on the first try (no -1 turn, no cat fallback).
    const main = await s.tools
      .get("read_anchored")!
      .execute("1", { path: join(skillSub, "SKILL.md") }, undefined, undefined, { cwd: ws });
    expect(textOf(main)).toContain("SKILL.md");
    expect(textOf(main)).toContain("alpha");

    // 2) A sibling resource under the same skill root is allowed too.
    const deep = await s.tools
      .get("read_anchored")!
      .execute("2", { path: nested }, undefined, undefined, { cwd: ws });
    expect(textOf(deep)).toContain("deep content");

    // 3) A path outside the workspace and every sanctioned root is still
    //    rejected, and the message teaches the cat escape.
    await expect(
      s.tools
        .get("read_anchored")!
        .execute("3", { path: stranger }, undefined, undefined, { cwd: ws }),
    ).rejects.toThrow(/outside workspace[\s\S]*bash cat/);

    // 4) Writes stay workspace-bound even under sanctioned roots.
    await expect(
      s.tools
        .get("write_anchored")!
        .execute("4", { path: join(skillSub, "SKILL.md"), content: "x\n" }, undefined, undefined, {
          cwd: ws,
        }),
    ).rejects.toThrow(/outside workspace/);

    // 5) UI: a collapsed call on a SKILL.md renders pi's [skill] box.
    const tool = s.tools.get("read_anchored")!;
    const collapsed = tool.renderCall?.({ path: join(skillSub, "SKILL.md") }, theme, {
      lastComponent: undefined,
      isError: false,
      expanded: false,
    }) as { text?: string } | undefined;
    expect(collapsed?.text ?? "").toContain("[skill]");
    expect(collapsed?.text ?? "").toContain("my-skill");
    // pi\u2019s compact read call appends the expand hint; mirror it.
    expect(collapsed?.text ?? "").toContain("ctrl+o to expand");

    // 6) Expanded calls keep the normal title (pi only classifies when collapsed).
    const expanded = tool.renderCall?.({ path: join(skillSub, "SKILL.md") }, theme, {
      lastComponent: undefined,
      isError: false,
      expanded: true,
    }) as { text?: string } | undefined;
    expect(expanded?.text ?? "").not.toContain("[skill]");
  });
});
