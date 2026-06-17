# Intuition - @overeng/notion-react VRS

*For: notion-react maintainers · Assumes: Notion block rendering and React ·
Covers: owned-region sync mental model*

`@overeng/notion-react` renders a React tree into an owned Notion page region.

The package has sync-shaped mechanics: a desired candidate tree, cached base
state, live observations, drift checks, mutation planning, fallback behavior,
and checkpoints. Those mechanics overlap with the wider Notion sync stack and
should reuse shared vocabulary where that makes contracts clearer.

The authority model is different from datasource shared sync. React owns the
rendered region and may overwrite manual edits inside that region. It should
not become the datasource workspace planner, and datasource shared-mode conflict
semantics should not inherit React's owned-region overwrite policy.
