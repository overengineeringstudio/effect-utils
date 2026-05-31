# Reframe the vision around local-first data API

Status: accepted

The vision centers the user-facing value: a Notion data source as a trusted
local file that can be queried, edited, diffed, and reconciled safely.

## Center

A Notion data source, as a **trusted local file you can query and write** — the
`.nmd` analogy extended from page bodies to rows, schema, and lifecycle. Value
and direction lead; safety is a supporting property, not the headline.

## Problem framing

Notion's UI is excellent for humans working _in Notion_. But **local work is
better served by trusted local files** (markdown, SQLite) than by the live
API/CLI:

- PRIMARY motivating audience: **coding agents**, which reason, diff, and edit
  better over a durable local artifact than over live API calls.
- Also: **scripts and tooling** that want a stable local data surface.
- SECONDARY: **humans working locally** (editor/CLI) rather than in the Notion UI.

The Notion API and CLI are steps toward local work, but a trusted local artifact
is still preferable.

## Safety placement

Safety/correctness hazards (coarse timestamps, query absence, destructive schema
edits, ambiguous permissions/trash, no durable change stream) live in
`requirements.md` (cross-cutting + planner-guards) and the `planner-guards`
spec. The word "trusted" carries their weight in the vision.

## Consequences

- "The Vision" leads with local-file value and the human-UI-vs-local-work
  contrast.
- "Success Criteria" centers agents and humans querying and safely editing the
  local artifact.
- "What This Is Not" keeps the not-an-offline-clone, not-LWW, and
  not-a-notion-md-feature boundaries.
- See [[0001-subsystem-decomposition]] and [[0002-mutation-support-matrix]].
