# Cache efficiency baseline (2026-10-06)

Pre-ordering baseline for
[BUILD.BUCK.REUSE-R08–R14](../requirements.md), measured before queue writers
populate the public tier ahead of readers. Johannes ratified the targets on
2026-10-06 (decision Q139).

## Hypothesis

The CI hit-rate gap comes from lane ordering and writer posture, not from
unstable action keys.

## Method

- Public tier server counters (`GetActionResult`, `UpdateActionResult`), daily
  and 3-hour increases over 7 days.
- CI cache-evidence artifacts for 10 main pushes, 10 PR runs and 6 merge-queue
  runs between 05:05 and 11:15 UTC; rate = remote hit / (remote hit + local
  execution + local cache + upload).
- Two-root loopback proof: `buck2 build //:quick` populated in one isolated
  root, then rebuilt in a second root after `buck2 kill` and a clean
  `buck-out`.

## Results

| Measurement                              | Value                                              |
| ---------------------------------------- | -------------------------------------------------- |
| Public tier daily action-cache hit ratio | 0.2–4.3%                                           |
| Main writer / main reader lanes          | 21% / 6–19%                                        |
| Merge-queue and PR lanes                 | 0%                                                 |
| Two-root loopback proof                  | 1,281 remote hits, 7 local executions (99.46%)     |
| Private tier                             | about 50% hits until traffic stopped on 2026-09-30 |

One 24-hour window had no public-tier action-cache writes while main was
active. Each main push cancelled the previous run before its writer jobs
finished.

## Conclusion

Keys are portable across roots. The CI gap is lane ordering and writer
completion, which R09–R11 measure.
