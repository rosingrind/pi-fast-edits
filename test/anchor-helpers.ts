/**
 * Shared test helpers for deriving anchors dynamically from tool output.
 *
 * AnchorPool now shuffles WORD_ANCHORS with a per-pool rng, so literal anchor
 * words ("Apple", "Brave", ...) are no longer valid in assertions. Tests must
 * derive anchors from the read/grep output captured in the same test.
 */

/** Extract the anchor word for a given source line from an anchored read output. */
export function anchorOf(anchoredOutput: string, lineText: string): string {
  const m = new RegExp(`(\\w+)§ ${lineText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(
    anchoredOutput,
  );
  if (!m) throw new Error(`No anchor found for line: ${lineText}`);
  return m[1];
}

/**
 * Extract the verbatim source line for a search text from rendered
 * grep_anchored_files output (`Anchor§ text    line N`). Throws when no
 * anchored line matches.
 */
export function lineTextFrom(anchoredOutput: string, searchText: string): string {
  const anchored = anchoredOutput.split("\n").filter((l) => l.includes("§ "));
  for (const line of anchored) {
    if (line.includes(searchText)) {
      const after = line.slice(line.indexOf("§ ") + 2);
      return after.replace(/ {4}line \d+$/, "");
    }
  }
  throw new Error(`No anchored line found for: ${searchText}`);
}
