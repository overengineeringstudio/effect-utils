# 0003 Trace Access Child and Fleet Boundary

Status: accepted

Accepted 2026-09-26 (Johannes, q47).

## Context

The observability lane already separates identity (01), portable records
(02), event decoding (03), views (04), and ingest/archive (05). A PR page,
trace resolver and agent JSON are consumers of the index rather than ingest
mechanics, even though one service binary can host both surfaces.

## Evidence and Argument

The [PR trace access prototype](../06-trace-access/.experiments/2026-09-25-pr-trace-access.md)
used the index for both human and agent lookup. Folding its review/agent
contract into 05 would tie consumer UX to queued ingest; putting fleet
placement here would duplicate dotfiles ownership. The existing 05 boundary
already puts deployment in dotfiles.

## Options

| Option                                                          | Outcome  | Reason                                                    |
| --------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| Add `06-trace-access`; refine 01/02/05; fleet trait in dotfiles | Accepted | Preserves the data-flow order and one owner per contract  |
| Fold resolver and PR page into 05                               | Rejected | Mixes ingest mechanics with review/agent access contracts |

## Decision

The `06-trace-access` child owns the PR resolver and page, stable trace links,
CI comment/summary links, versioned agent JSON, `gh-ci-utils traces`, and the
A/B baseline. Children 01, 02, and 05 retain identity, record, and ingest
changes. Dotfiles owns the fleet build-evidence trait and Tempo tuning in a
separate cross-linked VRS change. One `buck2-evidence` binary may implement
05 and serve 06 without moving either contract.

## Consequences

- The root diagram and ontology include the read-only path after ingest.
- The protected buck2 root vision and requirements do not change; this
  lane's own requirements may be refined by the accepted decisions.
