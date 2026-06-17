# Datasource Markdown workspace VRS is canonical for its realization

Status: superseded by
[`context/notion-sync-architecture/.decisions/0001`](../../../.decisions/0001-stack-vrs-root-and-realizations.md)
for stack-wide architecture; accepted for the datasource Markdown workspace
realization.

Three VRS doc sets originally existed: the cross-cutting DB Markdown Sync
context (vision/requirements/spec/glossary + decisions), per-package
`notion-md/docs/vrs`, and `notion-datasource-sync/docs/vrs`. That context is now
migrated under `context/notion-sync-architecture` as the datasource Markdown
workspace realization.

The datasource Markdown workspace spans packages, so this realization contract
has a single home. Per-package VRS docs reconcile downward to it for this
realization and to the stack root for stack-wide sync architecture.

## Considered Options

| Option                                                                                            | Result   | Reason                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cross-cutting `context/` VRS is canonical; per-package VRS scopes down and must not contradict it | Selected | The system composes across packages; the integrated contract must have a single home.                                     |
| Per-package VRS is canonical; `context/` is a summary                                             | Rejected | Creates no single authoritative contract for the integrated system; inconsistencies between packages become unresolvable. |

## Consequences

The stack `vision.md` and this realization's `requirements.md` are protected by
VRS process unless the human explicitly asks for migration or design changes.
Specs may be updated to track implementation but must trace to requirements.
VRS stays timeless. Per-package specs that diverge must be reconciled to the
stack root or this realization, depending on the claim.
