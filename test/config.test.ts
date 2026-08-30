import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, formatConfig, parseConfirmationMode } from "../src/config.js";

describe("DEFAULT_CONFIG", () => {
  it("has correct defaults", () => {
    expect(DEFAULT_CONFIG.maxRangeReadLines).toBe(400);
    expect(DEFAULT_CONFIG.confirmation).toBe("protected-paths");
    expect(DEFAULT_CONFIG.overrideBuiltInEditTools).toBe(false);
    expect(DEFAULT_CONFIG.protectedPaths).toContain(".env");
    expect(DEFAULT_CONFIG.protectedPaths).toContain(".env.*");
    expect(DEFAULT_CONFIG.protectedPaths).toContain(".git/**");
    expect(DEFAULT_CONFIG.protectedPaths).toContain("migrations/**");
    expect(DEFAULT_CONFIG.protectedPaths).toContain("package-lock.json");
  });
});

describe("parseConfirmationMode", () => {
  it("parses valid modes", () => {
    expect(parseConfirmationMode("always")).toBe("always");
    expect(parseConfirmationMode("protected-paths")).toBe("protected-paths");
    expect(parseConfirmationMode("never")).toBe("never");
  });

  it("returns undefined for invalid values", () => {
    expect(parseConfirmationMode("invalid")).toBeUndefined();
    expect(parseConfirmationMode("ALWAYS")).toBeUndefined();
  });
});

describe("formatConfig", () => {
  it("formats config as a readable string", () => {
    const formatted = formatConfig(DEFAULT_CONFIG);
    expect(formatted).toContain("maxRangeReadLines");
    expect(formatted).toContain("400");
    expect(formatted).toContain("protectedPaths");
  });
});

describe("config override merge", () => {
  it("override replaces protectedPaths, not appends", () => {
    const config = { ...DEFAULT_CONFIG, protectedPaths: ["custom.txt"] };
    expect(config.protectedPaths).toEqual(["custom.txt"]);
    expect(config.protectedPaths).not.toContain(".env");
  });
});
