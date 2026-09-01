---
name: pi-fast-edits
description: Use when editing files with pi-fast-edits anchored tools (`read_anchored`, `edit_anchored`, `write_anchored`, `grep_anchored`), or when tool output or rejections mention anchor words (like `Tunnel§`), `Revision mismatch`, `anchorLine mismatch`, `Overlapping edits`, `expectedRevision`, `allowAnchoredLines`, or `line N` suffixes — including when plain read/edit/write/grep tools behave this way because override mode is on.
---

# pi-fast-edits — anchored file editing

Anchored tools map every line to a stable random **anchor word** and guard edits with a **revision hash**, so concurrent or stale edits fail loudly instead of corrupting files. Core loop: **`read_anchored` (or `grep_anchored`) → `edit_anchored` with anchors + `expectedRevision` → verify**. These canonical names are used throughout; with `overrideBuiltInEditTools` enabled the same tools appear under pi's plain `read`/`grep`/`edit`/`write` names (the suffixed forms are deactivated) — every rule here applies unchanged. Full parameter reference: the repo README.

## Decode the rendered form

Tool output renders lines as `Tunnel§ target alpha one` — `grep` appends `line N` per line; `range`/`full` reads append no suffix. The `AnchorWord§` prefix and any trailing `line N` are **display metadata only** — never part of the file, never valid parameter content:

- `startAnchorLine` / `endAnchorLine` / `anchorLine` = the bare source line, copied verbatim: `target alpha one`. The mismatch error appends a drop-the-suffix hint only when your value ends in that rendered shape.
- Blank lines render as `Dragon§` but their content is the **empty string** — pass `""`.
- Identical lines get **distinct anchors** (Aster, Useful, Bridge…) — any instance's anchor addresses that exact line. Pass the bare word only (`Tango`, never `Tango§` or what follows the `§`). When the pool exhausts, names are reused with numeric suffixes (`Apple2`) and stay unique.
- A zero-line file has no anchors — `edit` it with an arbitrary anchor name and `anchorLine: ""` to create content from scratch.

## Revision lifecycle

Every file read/edited carries a `Revision:` hash — the first 16 hex chars of the file content's SHA-256, so it changes only when content changes. On every successful edit **and** every external modification (formatter, lint autofix, another agent, `bash`), the revision rotates and surviving anchors are re-pointed lazily. Consequences:

- Pass the current hash as `expectedRevision`; a mismatch rejects the batch with the current hash **plus fresh coordinates for every anchor you named** (current text + line) — retry in one turn with those and the new hash. The fresh rows' anchor words **supersede your originals** — use the words the error shows, not your earlier read's. Rows whose text is truncated say so — re-read them with `anchored: false` to copy verbatim. Re-read only when the error says an anchor no longer exists. Never guess or reuse an old hash.
- Every successful edit rotates the hash — fetch the fresh revision (read/grep) before the **next** edit's `expectedRevision`, not only after a failure.
- A revision returned by `write` can already be stale if a hook/autofix touched the file afterward. When a tool notice says content was modified, **re-read before the first edit**.

## Choosing the tool

| Need                                                      | Tool                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find anchors for target lines                             | `grep_anchored` (edit-ready output)                                                                                                                       |
| Big file, only a region matters                           | `read_anchored` mode `range`                                                                                                                              |
| Orientation in an unknown file                            | `grep_anchored` a declaration regex — the on-demand skeleton                                                                                              |
| Verbatim lines without anchors                            | `read_anchored` with `anchored: false`                                                                                                                    |
| One change                                                | `edit_anchored` with a single edit — range replace; same anchor for start + end = single line                                                             |
| Several changes (same or **multiple files**)              | `edit_anchored` with a batch — validation failures reject everything, zero partial writes; a mid-batch I/O error or abort is reported as partial progress |
| Insert between two adjacent lines without touching either | zero-width `replace`: adjacent anchors, `includeStart`/`includeEnd` both `false`                                                                          |

`write_anchored` seeds anchors and returns the revision + preview, so a fresh write is editable with no read. Full reads are capped (`maxReadLines`, default 2000, + a 50KB budget) and end with a `[N more lines... Use startLine=X to continue.]` notice — continue with `startLine`; lines over 300 chars render truncated, so re-read them with `anchored: false` before editing.

## Batch rules

- Each edit names its own file and that file's `expectedRevision`; checks run **in order** — the first stale/invalid edit rejects the call.
- Two edits may not claim the same insertion point or overlapping ranges (`after`-A and `before`-B collide when A and B are adjacent). Split points or split calls.
- New content must be raw text. Anchor-shaped content (`Word§…` immediately after a word) requires `allowAnchoredLines: true`; a `§` elsewhere in the line is accepted.
- Content that lands at EOF without a trailing newline leaves the file without one (`write` preserves content verbatim either way) — a later external append (e.g. bash `>>`) fuses onto the last line.
- Batch `delete` includes **both** anchor lines and takes no include flags.

## Failure playbook

| Rejection (verbatim prefix)                                                                              | Meaning                                                                         | Fix                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `startAnchorLine` / `endAnchorLine` / `anchorLine` mismatch for `<anchor>` — the line is currently `"…"` | Provided line ≠ current content (copied `§`/`line N`, or stale)                 | Copy the bare current line from the error or a fresh read                     |
| `Revision mismatch … current <hash>` + fresh coordinates                                                 | File changed since that hash                                                    | Retry with the hinted anchors + `<hash>`; re-read only if anchors are missing |
| `Overlapping edits are not supported in one file.`                                                       | Two edits share an insertion point/range                                        | Restructure the batch                                                         |
| `Could not find [start\|end] anchor <word> in <abs path>.`                                               | Unknown/stale anchor word (replace uses `start`/`end`; insert/delete uses none) | Grep the file for fresh anchors                                               |
| `Text contains anchor-marked content ("X§…")`                                                            | Anchor-shaped (`Word§…`) text in replacement/content                            | Strip the shape, or set `allowAnchoredLines: true` for genuine content        |

## If your plain tools behave this way

With `overrideBuiltInEditTools` enabled, the extension replaces pi's built-in `read`/`edit`/`write`/`grep` with these anchored implementations under the same names (canonical forms `read_anchored`, `edit_anchored`, `write_anchored`, `grep_anchored`, … are deactivated while overridden). If ordinary-looking tool calls suddenly mention anchors, revisions, or `§`, that is this extension working as designed — the rules above apply unchanged. `/pi-fast-edits status` shows the current mode.
