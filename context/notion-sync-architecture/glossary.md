# Glossary - Notion Sync Architecture

- **Authority model:** The rule that decides which surface may write, merge,
  overwrite, or refuse a change.
- **Base snapshot:** The previously accepted state used to decide whether a new
  desired state is still safe to apply.
- **Desired snapshot:** The local state a realization wants Notion or another
  durable surface to reach.
- **Observed snapshot:** The state read from Notion or another durable surface
  during a sync pass.
- **Realization:** A concrete product sync shape that refines shared contracts
  with its own user surface, hidden state, and authority model.
- **Shared sync contract:** Reusable vocabulary and invariants that multiple
  realizations can refine without sharing one implementation.
- **Surface identity:** The stable identity of the surface being compared or
  mutated, such as a page body, property, lifecycle state, rendered region, or
  workspace file.

