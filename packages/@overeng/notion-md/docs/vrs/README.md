# notion-md VRS

These documents are the design source of truth for `@overeng/notion-md`.

- [Vision](./vision.md)
- [Requirements](./requirements.md) — cross-cutting; per-subsystem requirements live in the numeric dirs
- [Spec](./spec.md) — thin architecture index + subsystem map
- [Glossary](./glossary.md)
- [Decisions](./.decisions/) — `0001`–`0021` (some early ids superseded and removed; rationale in [experiments.md](./experiments.md))
- [Open Questions](./open-questions.md)
- [Implementation Delta](./impl-delta.md)
- [Experiments](./experiments.md)

The design is decomposed into layered subsystems, each with its own
`requirements.md` + `spec.md` (global requirement IDs preserved, never
renumbered):

- [01-editor](./01-editor/spec.md) — `cat`/`put`/`edit` surface + sync-progress indicator
- [02-file-sync](./02-file-sync/spec.md) — pull/status/push flows, CLI, watch, batch/tree
- [03-sync-engine](./03-sync-engine/spec.md) — shared guarded push, 3-way merge, settle
- [04-fidelity](./04-fidelity/spec.md) — round-trip classifier, uniform lossy refusal, media canonicalization
- [05-local-state](./05-local-state/spec.md) — `.nmd` envelope + content-addressed object store
- [06-data-source](./06-data-source/spec.md) — typed property/metadata surface + schema-drift guard

The package docs explain usage. The VRS documents define the product shape,
constraints, implementation model, evidence, and long-term design decisions.
