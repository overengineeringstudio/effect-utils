# Caller correlation and span-id salting (bakeoff)

Date: 2026-09-25 · Corpus: a 22-log fleet corpus (local + cold CI) plus
purpose-built reproductions on a local-disk checkout; the pinned Buck
(unstable-2026-09-01) with a warm shared daemon.

## Question

1. How does a caller (devenv task, CI job) link its OTEL context to a Buck
   command so `buck2.command` lands inside the caller's trace: (a) derive
   `BUCK_WRAPPER_UUID` from the caller's W3C trace id; (b) independent Buck
   trace plus an OTel span link; (c) a sidecar mapping file only?
2. Does Buck validate `BUCK_WRAPPER_UUID`, and what happens on bad values?
3. Do concurrent commands on one daemon and repeated/nested invocations need
   span-id treatment?

## Method

- Source reading of the wrapper's invocation-id parsing plus an empirical
  12-case matrix (unset, hyphenated uuid, simple 32-hex, uppercase, nil, a
  reserved-variant nibble, `not-a-uuid`, 31/33 hex, empty) — one real `buck2
targets` per row on a shared-isolation daemon.
- Two real builds of the repository's check aggregate after a one-file edit
  (edit→build→sha256-verified restore), one per scheme: (a) derived uuid +
  traceparent conversion; (b) independent uuid + root link to the caller task
  span. Readback from Tempo by trace id; parenting checked at the span-id
  level.
- A real two-command task body (editor publish: uquery + build) run under one
  task span with one derived uuid exported once.
- Three concurrent-command reproductions on one shared daemon (build+build,
  test+build, test+test), including timeline extraction from both logs; a scan
  of 46 corpus logs for upstream wait-attribution events; span-id overlap
  measured for sequential, concurrent, and cross-daemon pairs.

## Result

- **Buck parsing:** any 32-hex string round-trips into the event log's trace
  id and filename; version/variant bits are never checked. Every malformed
  value — including the empty string — fails the whole command at client
  startup (rc=2). An all-zero (nil) trace id is accepted but W3C-invalid.
- **Scheme (a):** one caller trace, 9,831 spans; `buck2.command build`'s
  parent span id decodes to exactly the caller task span's id; the log's trace
  id is the caller's. **Scheme (b):** a separate 9,858-span Buck trace whose
  root links to the caller span — the tree is discoverable only from the Buck
  side. Scheme (c) is (a)'s plumbing with a worse rendering and is subsumed
  (the sidecar is needed for the _span-id_ parent regardless).
- **Nested invocations:** one trace, task span + two sibling command roots
  (uquery 84 spans, build 8,441), 8,526/8,526 unique span ids with salting.
  Without salting every invocation pair collides (id 0 always; heavy low-id
  overlap across daemons).
- **Concurrent commands:** two commands on one daemon keep distinct uuids and
  independently decodable logs. The reproduced wait case: the consuming
  command's 6.49 s gap (54% of its wall) ends at the exact nanosecond the
  producing command's action finishes, and its log contains zero
  ActionExecution spans — the shared work ran in the other command.
  `SharedTaskStart`/`DiceBlockConcurrentCommand` never fired (0/46 corpus
  logs), so a batch join (demonstrated as a synthetic inferred wait span with
  a producer link) was the only attribution path — hardened later in the
  [daemon-wait bakeoff](../../03-event-log-adapter/.experiments/2026-09-25-daemon-wait-attribution-bakeoff.md).

## Conclusion

Adopt scheme (a) with per-command derived uuids plus a one-line sidecar
(`<uuid> <traceparent>`): the wrapper validates the W3C regex and exports
only on match (a malformed export kills builds), derives the uuid as a pure
function of the caller context, always salts exported span ids per invocation,
and degrades to _unset_ — never to garbage — when context is missing.
Confidence: high on parsing (source + matrix), scheme (a) end-to-end, and
salting (real task, Tempo-verified); medium-high on the concurrent join (one
reproduction, later hardened).

## VRS Impact

Settled [BUCK.OBS.ID-R02..R06](../requirements.md) and
[decision 0001](../.decisions/0001-otel-span-buck2-mode.md) (q11). The
concurrent-wait finding seeded the daemon-wait decision in 03 (q23) and the
editor-publish spans merged in #1382.
