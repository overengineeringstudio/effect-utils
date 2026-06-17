# Clean break v1: delete legacy datasource-sync public surfaces, no compat shims

Status: accepted

The already-landed datasource-sync exposes `rows`/`_nds_*`-style surfaces and
unversioned layouts. R05 mandates only the v1 surface (`pages`, versioned paths,
hidden `.notion/v1`), failing closed on unknown or mixed namespaces. Legacy
surfaces are removed entirely — no migration path, no compat shims. Unknown
namespaces fail closed with tracking guidance.

This is a pre-release project with no external users to migrate. T03, R05, and
Decision 0013-versioned-clean-break-workspace explicitly forbid a public `rows`
alias and implicit migration.

## Considered Options

| Option                                                                                                              | Result   | Reason                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard clean break: remove `rows`/`_nds_*`/unversioned layouts; unknown namespace fails closed with tracking guidance | Selected | One product contract; no dual-surface ambiguity (see workspace intuition); pre-release so no external users to migrate; VRS explicitly requires this (T03, R05, Decision 0013). |
| Keep `rows` as a read-only alias / provide migration path                                                           | Rejected | VRS explicitly forbids public `rows` alias and implicit migration (T03, R05, Decision 0013-versioned-clean-break-workspace).                                                      |

## Consequences

Existing tests and fixtures referencing old surfaces must be rewritten to the v1
surface, not adapted. Each removal is justified by the clean-break requirement
and must be replaced by a v1-surface test (honoring "never silently delete
tests").
