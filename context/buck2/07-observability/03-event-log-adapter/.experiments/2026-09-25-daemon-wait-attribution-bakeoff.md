# Daemon-wait attribution bakeoff (WaitAttribution)

Date: 2026-09-25 · Corpus of 43 joinable logs (15 cold CI + 7 local + the
correlation-track pairs + 11 new reproductions); upstream source and history
read at the pinned commit.

## Question

When two Buck commands share one daemon and one waits on work the other
produces, what is the best _long-term_ attribution design: (a) gap-summary
attributes only, (b) a hardened cross-log join emitting inferred wait spans,
(c) upstream-native events, or (d) exact join keys already in the logs?

## Method

- Upstream archaeology: grep for `SharedTaskStart` producers at the pinned
  release; history of the emitting code (introduction, move, deletion commit)
  via the GitHub API; location of the modern wait point (dice shared-cache
  await) and its dependency isolation; conditions under which
  `DiceBlockConcurrentCommand` fires; a deliberate different-state
  reproduction (7 attempts; 5 earlier variants failed for documented
  watcher-lag/timing reasons).
- Exact-key audit of the logs: `ConcurrentCommands{trace_ids[]}` presence
  (17/41 logs — exactly those that truly shared), the per-daemon shared
  span-id counter, cross-log parent references, and action-identity
  stability.
- Join prototype (~330 lines): peers by strict `ConcurrentCommands` (time
  overlap only as fallback); level-aware gap detection with coalescing and
  startup margins; causal producer ranking (ends ≤ wake-up, closest;
  identity absent from the waiter); confidence tiers; DiceBlock override.
  Ground truth from four independent sources (upstream-exact event, the
  prior reproduction, a serial differential control, and a rule with an
  empirically measured coincidence baseline: a random instant falls within
  10 ms of some action end 5.1% of the time on the densest peer).
- End-to-end proof: the triple reproduction converted and pushed with the
  wait span; readback verified (13,150 spans, wait parented, linked,
  confidence tier present).

## Result

- **Upstream (c):** `SharedTaskStart` has zero producers — the emitting code
  was deleted (2024-12, "not used anymore"); the schema message is dead
  weight. Dice no longer depends on the events crate, so the old insertion
  point cannot be rebuilt; the modern patch is a hook trait at the
  shared-cache await (~200–350 lines), acceptance odds low-to-moderate with
  months of lag (the OTel PR has sat 2.5 months with zero reviews).
  `DiceBlockConcurrentCommand` is emitted only for _different-state_
  blocking — reproduced once, exactly (6,715.6 ms, owner id exact); organic
  fleet concurrency is same-state, where the waiter's log is silent.
- **Exact keys (d):** `ConcurrentCommands.trace_ids[]` scopes peers exactly
  (daemon-provided); a per-daemon span-id counter and one cross-log parent
  reference corroborate; no DICE key or digest appears in the waiter's log —
  the join cannot be made exact with in-log data alone.
- **Join (b):** across the corpus, 23 emitted waits vs 22 true: P 0.957 /
  R 1.0 at 500 ms; P = R = 1.0 at 1 s (losing 6 true 0.6–0.9 s waits);
  the single FP (a 535 ms loading jitter coincidentally aligned) is
  suppressed by the 1 s threshold. Multi-producer case resolves the causal
  primary correctly (the co-producer finished _after_ wake-up); negatives
  (serial, cached) emit zero. Python runtime 3.0 s for 41 logs — ms-level
  in the Rust adapter.
- **CI reality:** the macOS build waited 79.5 s (62% of its 128 s wall)
  across 15 distinct waits on the concurrent test command; the Linux pair
  showed one 625 ms startup hole — a _busy_ waiter starves lanes without a
  silent gap, the one blind spot no downstream method can fix.
- **(a) attributes-only:** exact gap windows per log, zero batch dependency
  — kept as the always-on floor; cannot name the producer.

## Conclusion

The long-term design is the hardened join at ingest with exact scoping
(`ConcurrentCommands`), direct DiceBlock reading, inferred daemon-wait spans
with confidence tiers and producer links at a 1 s default / 500 ms opt-in,
gap attributes always — plus a parallel, non-gating upstream track (issue +
small hook PR). Interim (pre-crate): gap attributes in the per-command path
and the join in the batched ingest path; nothing is thrown away by the
long-term design. Confidence: high on upstream findings and join P/R for
detected gaps; medium on busy-waiter recall (phenomenon-level blind spot).

## VRS Impact

Settled [BUCK.OBS.ADP-R07](../requirements.md) and
[decision 0003](../.decisions/0003-daemon-wait-at-ingest.md) (q23; the q12
reframe demanded this bakeoff). The 62%-wait CI finding is cross-referenced
to [02-execution](../../../02-execution/open-questions.md); upstream
acceptance stays open as [OQ2](../../open-questions.md).
