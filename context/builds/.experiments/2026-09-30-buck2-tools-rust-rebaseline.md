# buck2-tools Rust rewrite rebaseline

Date: 2026-09-30

Status: completed; full rewrite stopped after slice 1, further ports parked

## Question

After the Rust tree-fingerprint cutover, do the remaining speed, runtime-closure
and maintenance benefits justify completing the buck2-tools rewrite?

## Method

Rebaseline on a Linux x86_64 dev host using CI-log inspection, guarded-entry
imports, same-input TS/native snapshot verification, source and Nix-closure
inventories, and package-tree action replays with CPU/syscall profiling.

Source keys below refer to the five parts of the study: **A** (CI attribution
and startup), **B** (read-only verifier prototype), **C** (coupling and cost),
**P** (package-tree filesystem profile), and **R** (adversarial review). The
study reports were working material; the durable evidence summary is
[issue #1522](https://github.com/overengineeringstudio/effect-utils/issues/1522),
which also preserves the prototype source.
R reviewed A/B/C before P completed; P resolves its proposed package-tree speed
investigation rather than inheriting that earlier recommendation.

B used Bun 1.4.2 and a release Rust verifier, with 12 hyperfine runs per state,
3 warmups for warm measurements, and the largest maximum RSS from 3 separate
GNU time samples. Its cold state evicted input regular-file pages only. P used
10 warm runs and 2 warmups, fresh-output replays, CPU profiles and strace; its
sources and outputs crossed ZFS/ext4, preventing reflinks. Estimates below are
not measured delivery throughput or CI savings.

## Result

| Boundary                          | Observation                                                                                                                                                                            | Source                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Already-landed slice 1            | CI editor publication 507.5 → 373.8 s, −133.7 s (26.3%); not the projected 150–200 s                                                                                                   | R, original slice-1 evidence summarized in #1522       |
| Startup/load controls             | Empty Bun 1.205 ms mean; Rust empty-tree fingerprint 0.894 ms; remaining guarded entry imports approximately 7–20 ms                                                                   | A, warm hyperfine                                      |
| Small warm snapshot verification  | TS/Bun 18.10–20.19 ms; native 1.08–2.24 ms across 3 source-tree controls                                                                                                               | B, hyperfine                                           |
| Real warm dependency snapshot     | 13,890 files / 194,158,044 regular-file bytes: TS/Bun 329.67 ± 5.20 ms; native 311.35 ± 7.26 ms (5.6% reduction)                                                                       | B, hyperfine mean ± sample standard deviation          |
| Real snapshot memory              | Warm maximum RSS 43,576 KiB TS/Bun vs 2,620 KiB native                                                                                                                                 | B, GNU time                                            |
| Verifier parity                   | Successful stdout/digests byte-identical on 4 inputs; both reject all 10 exercised mutations; stderr differs                                                                           | B, diffs and rejection fixtures                        |
| Warm package-tree assembly        | utils-dev 10.180 ms; content-address 18.849 ms; import-only control 8.858 ms                                                                                                           | P, hyperfine                                           |
| Long package-tree actions         | 980.265 s execution sum comprises 2 overlapping 489.6–489.7 s processes plus 0.909 s; exact later replays 4.294 / 4.504 s, with low CPU and independently observed filesystem blocking | P, Buck action events, process accounting and strace   |
| TypeScript wrapper child boundary | ≥69.016 s of a 120.111 s timed-out replay inside 90 completed, already-Rust fingerprint children                                                                                       | A, child timing; lower bound, not complete attribution |
| Eligible marginal Bun closure     | 79,580,840 uncompressed NAR bytes unique relative to the existing core closure; not measured transfer/cache cost                                                                       | C, Nix closure inventory                               |
| Remaining work estimates          | Slice 2: 17–28 person-days; selected slices 3–5: 22–37; generic package-command orchestration around retained Bun adapter adds 8–15                                                    | B/C, author estimates; R review                        |
| Recent CI attribution             | 3 green runs inspected; no retrievable per-module traces; approximately 260 eligible Bun launches per PR remains unverified                                                            | A; trace-delivery defect #1521                         |

## Conclusion

Johannes stopped q17's full rewrite after slice 1 on 2026-09-30 following the
rebaseline. [Issue #1394](https://github.com/overengineeringstudio/effect-utils/issues/1394)
was closed as not planned; #1522 supersedes it as a parked, trigger-based record.
Existing TS support tools remain TS and are maintained in place. New tooling
follows the Rust-for-system/infra/tooling rule; Effect/TS remains the application
code rule. Axe decisions q1/q2 record rebaselining and stopping at slice 1.

The remaining measured verifier benefit is milliseconds and lower RSS, not a
whole-publisher or CI critical-path speedup. Package-tree profiling found kernel
copying and filesystem blocking, not a dominant JS compute loop; it produced no
Rust assembler or measured Rust speedup. The original long-action stall cause
is not proved, so its overlapping wall times are not a port saving target.
Bun build/compile products, Vitest and JS checkers retain Bun regardless of
launcher language; replacing the bundler would change the product contract.

The selected reopen triggers (Axe q3, #1522) are:

1. **Module needs a big rewrite:** port that module to Rust when a change would
   already touch most of it, rather than rewriting it in TS.
2. **Bun closure becomes a cost:** reopen when the approximately 80 MB unique
   Bun root in eligible action closures becomes a measured transfer/cache cost,
   for example with remote execution. Current execution is local.

A measured-CI-hotspot trigger was not selected. Missing CI trace delivery is a
separate defect, [issue #1521](https://github.com/overengineeringstudio/effect-utils/issues/1521)
(Axe q4), not authorization to resume the rewrite.

## Limits

- Local, shared-host Linux samples do not establish macOS parity, cold-VM
  startup, per-job launch counts, or CI critical-path savings. Cwd affected
  import measurements; loaded imports are not interpreter-only overhead.
- The prototype verifies snapshots but does not publish, recover or watch.
  Successful stdout parity does not establish full error, path or race parity.
- Package-tree replays preserve TS output bytes and symlink targets, not Rust
  parity. Cross-filesystem copies and variable stalls are not same-filesystem
  CI reflink measurements; the original stalls lack syscall history.
- Closure NAR bytes are not action-key bytes, downloads or measured ROI. Bun
  removal applies only where no retained child/product requires it.
- Cost/test inventories are revision-specific estimates and source counts;
  the study did not establish a successful full cold typecheck/test/publication
  pipeline or an integrated native slice's actual delivery cost.

## Intent Impact

Adjacent-work tracking in
[observability](../04-buck2/07-observability/open-questions.md) and the remaining publish
tail tracking in [materialization](../04-buck2/04-materialization/open-questions.md)
reflect the stopped full rewrite; the [roadmap](../04-buck2/07-observability/roadmap.md)
records only the selected reopen triggers.
This evidence changes continuation status, not requirements or admission
contracts; the earlier materialization measurements remain historical facts.
