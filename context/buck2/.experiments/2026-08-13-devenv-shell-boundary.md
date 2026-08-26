# Devenv shell and lazy Buck boundary

Date: 2026-08-13
Host class: x86_64-linux development host

## Question

Can repository setup and Buck stage-0 realization be removed from shell activation
while retaining a fast, validated path to warm Buck builds?

## Method

- The evaluated `devenv:enterShell` task had no dependencies after the change.
- `setup:gate` and `setup:record-cache` were absent from the evaluated task graph;
  explicit `setup:run` and `setup:strict` remained available.
- The Buck log file count was unchanged across failed shell-cache probes, proving
  that shell activation did not invoke Buck in those probes.
- Resolver integration tests used a counting fake Nix executable. Eight concurrent
  cold callers performed exactly four realizations, one for each required tool.
- Adversarial cache tests mutated the recorded ABI and fingerprint and removed a
  per-tool GC root; each mutation forced realization rather than a false hit.
- A continuously changing semantic input failed after three attempts instead of
  recursing without a bound.

## Result

| Workload                                                |                                           Observation | Verdict                |
| ------------------------------------------------------- | ----------------------------------------------------: | ---------------------- |
| Warm Buck status, 20 samples                            |                              p50 11.4 ms, p95 16.5 ms | Pass                   |
| Warm no-op Buck foundation build, 5 samples             |                p50 12.5 ms, max 18.5 ms; zero actions | Pass                   |
| Lazy stage-0 config hit, 8 samples                      |                                            170-200 ms | Pass                   |
| First lazy stage-0 recovery with cached Nix derivations |                                                 4.1 s | Informational          |
| Full shell activation                                   | 2.2.1 probes did not exit reliably on the loaded host | No performance verdict |

The full-shell samples do not measure repository setup: that work is absent from
the evaluated graph. Devenv 2.1 repeatedly performed a full Nix evaluation. The
pinned 2.2.1 upgrade completed, but repeated probes on a host with load averages
between 9 and 19 did not exit reliably; they were interrupted and are not timing
evidence. This experiment therefore does not claim that the shell latency budget
is met.

## Conclusion

Shell activation is a mutation-free environment boundary. It does not run Buck,
Nix stage-0 realization, package installation, Genie, or megarepo mutation.
Repository tasks resolve stage-0 lazily through a source-mode TypeScript CLI. The
resolver fingerprints the exact fileset exported by the Nix stage-0 definition,
retains realized outputs through per-fingerprint Nix GC roots, validates cached
metadata and root bindings, and publishes its config atomically under a
single-flight lock with bounded instability retries.

The remaining shell latency is a devenv evaluation-cache concern, independent of
Buck warmth. It must be benchmarked again after the pinned devenv upgrade; the
acceptance budget remains p50 at most 500 ms and p95 at most one second.

## VRS Impact

Grounds the capability-projection boundary in
[02-execution](../02-execution/spec.md): environment preparation is a
mutation-free projection step, direct Buck fails closed on a missing or stale
projection, and no shell activation becomes a hidden producer.
