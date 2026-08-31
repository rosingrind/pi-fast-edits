import { afterEach, describe, expect, it } from "vitest";
import { experimentalToolSampling } from "../src/tools/experimental-sampling.js";
import { LRUMap, type PiFastEditsConfig, type SessionState } from "../src/types.js";
import { registerReadAnchored } from "../src/tools/read-anchored.js";

describe("experimentalToolSampling", () => {
  const ENV = process.env.PI_EXPERIMENTAL;

  afterEach(() => {
    if (ENV === undefined) delete process.env.PI_EXPERIMENTAL;
    else process.env.PI_EXPERIMENTAL = ENV;
  });

  it("is undefined unless PI_EXPERIMENTAL=1 (mirrors pi's built-ins)", () => {
    delete process.env.PI_EXPERIMENTAL;
    expect(experimentalToolSampling()).toBeUndefined();
    process.env.PI_EXPERIMENTAL = "0";
    expect(experimentalToolSampling()).toBeUndefined();
  });

  it("prefers strict json_schema decoding when PI_EXPERIMENTAL=1", () => {
    process.env.PI_EXPERIMENTAL = "1";
    expect(experimentalToolSampling()).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("is carried on registered tool definitions when enabled", () => {
    process.env.PI_EXPERIMENTAL = "1";
    const tools: Array<{ name: string; constrainedSampling?: unknown }> = [];
    const pi = {
      registerTool: (t: never) => tools.push(t as never),
      on: () => {},
      registerCommand: () => {},
    };
    const session: SessionState = { files: new LRUMap(), readRoots: [] };
    const config: PiFastEditsConfig = { ...({} as PiFastEditsConfig), protectedPaths: [] };
    registerReadAnchored(pi as never, session, config);
    const read = tools.find((t) => t.name === "read_anchored");
    expect(read?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });
});
