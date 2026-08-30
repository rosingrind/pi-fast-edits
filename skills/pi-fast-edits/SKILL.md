---
name: pi-fast-edits
description: Use when editing files with pi-fast-edits anchored tools (`read_anchored`, `apply_anchored`, `write_anchored`, `grep_anchored`, `preview_anchored`), or when tool output or rejections mention anchor words (like `Tunnel§`), `Revision mismatch`, `anchorLine mismatch`, `Overlapping edits`, `expectedRevision`, `allowAnchoredLines`, or `line N` suffixes — including when plain read/edit/write/grep tools behave this way because override mode is on.
---

# pi-fast-edits — anchored file editing

Anchored tools map every line to a stable random **anchor word** and guard edits with a **revision hash**, so concurrent or stale edits fail loudly instead of corrupting files. Core loop: **`read_anchored` (or `grep_anchored`) → `apply_anchored` with anchors + `expectedRevision` → verify**. These canonical names are used throughout; with `overrideBuiltInEditTools` enabled the same tools appear under pi's plain `read`/`grep`/`edit`/`write` names (the suffixed forms are deactivated) — every rule here applies unchanged. Full parameter reference: the repo README.

## Decode the rendered form

Tool output renders lines as `Tunnel§ target alpha one    line 13`. The `AnchorWord§` prefix and the trailing `line N` / `lines N` are **display metadata only** — never part of the file, never valid parameter content:

- `startAnchorLine` / `endAnchorLine` / `anchorLine` = the bare source line, copied verbatim: `target alpha one`. The mismatch error appends a drop-the-suffix hint only when your value ends in that rendered shape.
- Blank lines render as `Dragon§` but their content is the **empty string** — pass `""`.
- Identical lines get **distinct anchors** (Aster, Useful, Bridge…) — any instance's anchor addresses that exact line. Pass the bare word only (`Tango`, never `Tango§` or what follows the `§`). When the pool exhausts, names are reused with numeric suffixes (`Apple2`) and stay unique.
- A zero-line file has no anchors — `edit` it with an arbitrary anchor name and `anchorLine: ""` to create content from scratch.

## Revision lifecycle

Every file read/edited carries a `Revision:` hash — the first 16 hex chars of the file content's SHA-256, so it changes only when content changes. On every successful edit **and** every external modification (formatter, lint autofix, another agent, `bash`), the revision rotates and surviving anchors are re-pointed lazily. Consequences:

- Pass the current hash as `expectedRevision`; a mismatch rejects the whole batch with the current hash in the message — **re-read (or grep) and retry with it**. Never guess or reuse an old hash.
- Every successful edit rotates the hash — fetch the fresh revision (read/grep) before the **next** edit's `expectedRevision`, not only after a failure.
- A revision returned by `write` can already be stale if a hook/autofix touched the file afterward. When a tool notice says content was modified, **re-read before the first edit**.

## Choosing the tool

| Need                                                      | Tool                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Find anchors for target lines                             | `grep_anchored` (edit-ready output)                                                            |
| Big file, only a region matters                           | `read_anchored` mode `range`, or `skeleton` for structure                                      |
| Verbatim lines without anchors                            | `read_anchored` with `anchored: false`                                                         |
| One change                                                | `apply_anchored` with a single edit — range replace; same anchor for start + end = single line |
| Several changes (same or **multiple files**)              | `apply_anchored` with a batch — atomic: any failure rejects everything, zero partial writes    |
| Insert between two adjacent lines without touching either | zero-width `replace`: adjacent anchors, `includeStart`/`includeEnd` both `false`               |
| Dry-run a replacement                                     | `preview_anchored` — a replace's params, no write; apply with `apply_anchored`                 |

`write_anchored` seeds anchors and returns the revision + preview, so a fresh write is editable with no read.

## Batch rules

- Each edit names its own file and that file's `expectedRevision`; checks run **in order** — the first stale/invalid edit rejects the call.
- Two edits may not claim the same insertion point or overlapping ranges (`after`-A and `before`-B collide when A and B are adjacent). Split points or split calls.
- New content must be raw text. Anchor-shaped content (`Word§…` immediately after a word) requires `allowAnchoredLines: true`; a `§` elsewhere in the line is accepted.
- Content that lands at EOF without a trailing newline leaves the file without one (`write` preserves content verbatim either way) — a later external append (e.g. bash `>>`) fuses onto the last line.

## Failure playbook

| Rejection (verbatim prefix)                                                                              | Meaning                                                         | Fix                                                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `startAnchorLine` / `endAnchorLine` / `anchorLine` mismatch for `<anchor>` — the line is currently `"…"` | Provided line ≠ current content (copied `§`/`line N`, or stale) | Copy the bare current line from the error or a fresh read              |
| `Revision mismatch … current <hash>`                                                                     | File changed since that hash                                    | Re-read/grep, retry with `<hash>`                                      |
| `Overlapping edits are not supported in one file.`                                                       | Two edits share an insertion point/range                        | Restructure the batch                                                  |
| `Could not find [start\|end] anchor X`                                                                   | Unknown/stale anchor word (insert vs range forms)               | Grep the file for fresh anchors                                        |
| `Text contains anchor-marked content ("X§…")`                                                            | Anchor-shaped (`Word§…`) text in replacement/content            | Strip the shape, or set `allowAnchoredLines: true` for genuine content |

## If your plain tools behave this way

With `overrideBuiltInEditTools` enabled, the extension replaces pi's built-in `read`/`edit`/`write`/`grep` with these anchored implementations under the same names (canonical forms `read_anchored`, `apply_anchored`, `write_anchored`, `grep_anchored`, … are deactivated while overridden). If ordinary-looking tool calls suddenly mention anchors, revisions, or `§`, that is this extension working as designed — the rules above apply unchanged. `/pi-fast-edits status` shows the current mode.
