# Stack VRS root and realizations

## Status

Accepted.

## Context

The repository had separate VRS docs for datasource sync, NotionMD, React, and
a cross-cutting `context/notion-db-markdown-sync` contract. The cross-cutting
contract was accurate for the datasource plus `.nmd` workspace, but its name and
scope were too narrow for the whole Notion sync stack.

React also has overlapping sync mechanics, but its product contract is an
owned-region renderer, not a shared-mode datasource workspace.

## Decision

`context/notion-sync-architecture` is the canonical stack-wide VRS root for
Notion sync architecture.

The previous `context/notion-db-markdown-sync` material is migrated under
`02-realizations/01-datasource-markdown-workspace` as one realization. React is
modeled as a separate `02-realizations/02-react-owned-region` realization.

The reusable layer starts as shared contracts, vocabulary, evidence semantics,
and verification requirements. A shared implementation can be extracted only by
a later decision that proves the mechanism is genuinely common.

## Consequences

Stack-wide questions now resolve through this tree. Package VRS docs remain
binding for package-local behavior, but they must not contradict this root.

Existing references to the old context path must be updated to either the new
stack root or the datasource Markdown workspace realization, depending on the
claim being made.

