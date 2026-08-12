import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate config reads from the real ~/.pi/agent directory.
// getAgentDir() in @earendil-works/pi-coding-agent honors PI_CODING_AGENT_DIR,
// so point it at a throwaway temp dir for the whole test run. Because the temp
// dir has no pi-fast-edits.json, loadConfig() falls back to DEFAULT_CONFIG,
// keeping boundary tests deterministic regardless of the developer's real config.
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-fast-edits-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;