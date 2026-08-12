# Buck2 Dependency-Closure Roadmap

This non-normative roadmap is subsumed by the canonical
[`context/buck2/roadmap.md`](../../buck2/roadmap.md) and its linked GitHub
refactor epic.

Dependency-closure work remains a distinct execution slice because resolver
equivalence and target-local invalidation can be proven and retired
independently from language execution, artifact import, or remote-cache
admission. Exact issues, revisions, benchmarks, and status are tracked in the
epic rather than duplicated here.
