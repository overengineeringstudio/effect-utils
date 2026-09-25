# 0001 The Trace View Family

Status: accepted

Accepted 2026-09-25 (decision q21; Johannes), closing the terminology round
against the domain reference map.

## Context

The Tempo trace is a reduced view of the full event log. The working
vocabulary ("slim", "shaping", "projection") collided with fleet terms
("projection" = query views and capability projections; "sampling" = OTel
probabilistic mechanisms) and said nothing about the concept. The
cross-command wait concept likewise needed one name.

## Evidence and Argument

- "View" matches the relational sense exactly: a deterministic, derived,
  non-authoritative subset of a record, regenerable on demand — and collides
  with nothing in the six surveyed vocabularies (the nearby "editor view" is
  a different, always-qualified sense).
- The default view's content is defined by Buck's own strongest signal (the
  critical path), so the family's leitwort belongs to the _selection rule_,
  not to a mechanism word.
- "Daemon wait" names the phenomenon where it lives (the shared daemon);
  upstream's only organic word (CommandCritical) describes the boundary, and
  `SharedTaskStart` is dead (03).

## Options

| Option                  | Tradeoff                                              | Outcome  |
| ----------------------- | ----------------------------------------------------- | -------- |
| trace view family       | Relational meaning, no collisions, Buck leitwort kept | Accepted |
| trace projection family | Matches working term; two existing projection senses  | Rejected |
| shaped trace family     | Matches B6's working word; vague, mechanism-named     | Rejected |

## Decision

Anchor **trace view**; followers **full view**, **critical view** (the
default), **view threshold**, **view cap**; the wait concept is **daemon
wait** (with _inferred_ marking the join-derived spans). Recorded normatively
in the [ontology](../../ontology.md); "slim", "shaping", and unqualified
"projection" are retired for this lane.

## Consequences

- The critical view's rule (critical path + threshold + ancestors + summaries
  - cap) is specifiable and testable independent of storage choices.
- "View" joins the flagged ambiguities (always "trace view" vs the
  materialization surface's editor views).
