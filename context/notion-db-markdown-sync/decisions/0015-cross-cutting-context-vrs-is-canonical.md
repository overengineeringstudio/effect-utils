# Cross-cutting `context/notion-db-markdown-sync` VRS is canonical for the integrated system

Status: accepted

Three VRS doc sets exist: the cross-cutting `context/notion-db-markdown-sync`
(vision/requirements/spec/glossary + decisions), per-package
`notion-md/docs/vrs`, and `notion-datasource-sync/docs/vrs`. The cross-cutting
`context/` VRS is the canonical integrated-system contract. Per-package VRS docs
must not contradict it; they scope down to their package only.

The integrated system spans packages, so the integrated contract must have a
single home. Per-package VRS docs reconcile downward to the cross-cutting
contract.

## Considered Options

| Option                                                                                            | Result   | Reason                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cross-cutting `context/` VRS is canonical; per-package VRS scopes down and must not contradict it | Selected | The system composes across packages; the integrated contract must have a single home.                                     |
| Per-package VRS is canonical; `context/` is a summary                                             | Rejected | Creates no single authoritative contract for the integrated system; inconsistencies between packages become unresolvable. |

## Consequences

`vision.md` and `requirements.md` are protected — no edits without human
sign-off. Specs may be updated freely to track implementation but must trace to
requirements. VRS stays timeless. Per-package specs that diverge must be
reconciled to the cross-cutting contract.
