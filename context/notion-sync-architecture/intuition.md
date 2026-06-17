# Notion Sync Architecture Intuition

*For: maintainers designing Notion sync cleanup · Assumes: package-level VRS
for datasource-sync, notion-md, and notion-react · Covers: stack-wide sync
contracts, realization boundaries, and verification ownership*

The Notion sync stack has several systems that look similar from far away:
each compares desired local state with observed Notion state, plans mutations,
and records enough evidence to avoid silent data loss. They are not the same
sync engine.

This VRS tree separates three levels:

- the stack-wide contract for shared vocabulary and invariants,
- the reusable sync contract that packages may refine,
- concrete realizations with their own authority model and product surface.

The datasource plus `.nmd` workspace is a bidirectional local workspace
realization. It must preserve user edits across SQL files, page files, hidden
state, and Notion. React is an owned-region renderer realization. It may reuse
the same vocabulary for snapshots, digests, observations, checkpoints, and
mutation plans, but it intentionally owns a page region and may overwrite
manual edits inside that region.

The architecture therefore unifies contracts before implementation. A shared
engine is allowed only when two realizations prove they need the same mechanism,
not merely the same words.
