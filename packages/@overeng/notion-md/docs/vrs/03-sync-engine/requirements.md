# Requirements: 03-sync-engine

**Role.** The shared correctness engine both surfaces call: the guarded push
(re-read remote, refuse stale last-writer-wins overwrites), the conservative
three-way Markdown merge from a base snapshot, the settle-and-re-pull, the
review-safety guard, and the explicit-force escape hatch. The editor's `edit`
verb ([01-editor](../01-editor/requirements.md)) and the file path
([02-file-sync](../02-file-sync/requirements.md)) both push through this engine;
the stateless `cat`/`put` pipes use its 2-way verified-replace facade.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
clean-base requirement R09 depends on the last-clean base snapshots maintained by
[05-local-state](../05-local-state/requirements.md). The lossy-page refusal that
prevents a `replace_content` over an opaque block is owned by
[04-fidelity](../04-fidelity/requirements.md) (R30/R38); schema-drift refusal on a
property write is owned by [06-data-source](../06-data-source/requirements.md)
(R14).

## Requirements

### Must Prevent Data Loss

- **R09 Base snapshots:** The local state store must preserve last-clean bases needed for guarded push and three-way merge.
- **R11 Guarded push:** Default push must re-read remote state and refuse last-writer-wins overwrites when the stored base is stale.
- **R13 Review safety:** Unresolved local review/suggestion markup must not be sent to Notion body content by default.
- **R15 Force clarity:** Destructive modes must be separate from normal push and report exactly which protections they bypass.
