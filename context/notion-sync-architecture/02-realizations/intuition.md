# Realizations Intuition

*For: maintainers mapping sync contracts to packages · Assumes: shared sync
contract vocabulary · Covers: concrete product authority models*

A realization is where the abstract sync contract becomes a product shape.

The datasource Markdown workspace and React owned-region renderer both sync
with Notion, but they promise different things to users. Keeping them as sibling
realizations makes reuse possible without implying that one can inherit the
other's conflict policy.
