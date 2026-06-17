# React Owned Region Intuition

*For: notion-react maintainers · Assumes: shared sync contract vocabulary ·
Covers: React's owned-region realization*

React sync renders a JSX tree into a Notion page region it owns.

It has desired state, cached base state, observed drift, mutation planning, and
checkpointing, so it should share sync vocabulary where useful. It does not
promise datasource shared-mode conflict preservation for manual edits inside
the owned region.
