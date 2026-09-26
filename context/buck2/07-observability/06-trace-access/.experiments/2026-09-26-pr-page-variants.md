# PR Trace Page Variants (2026-09-26)

## Question

An overview backed by several main runs is more useful for review than an
immediate trace viewer or a single base-revision main-run comparison; a
short verdict and critical-chain header make the overview quicker to scan.

## Method

A desktop and phone variants review compared four page arrangements using
real CI task timings: V1 runs → jobs → top tasks with a k=7 main-run A/B;
V2 the same overview against one base-revision main run; V3 a direct Grafana
entry; V4 a verdict and slowest-job task-span chain above the principal
deltas. The review combined V1 and V4 after inspecting these alternatives.
This experiment records the review findings, not a deployed page.

## Result

| Variant | Observation |
| --- | --- |
| V1: seven main runs | 12 tasks faster than every main sample, none slower, 64 inside the spread. Runs, jobs and top tasks stayed accessible. |
| V2: one base-revision main run | Reported apparent regressions of +22.7 s and +15.1 s that both sat inside the multi-run main spread. |
| V3: Grafana redirect | Left almost nothing readable on a phone. |
| V4: verdict + critical chain | The short header improved orientation; its chain was a heuristic over task spans, not Buck's action-level critical path. |

The review established the k=7 baseline instead of the earlier suggested
k=5. The main spread is a noise band, not a confidence interval or proof
of causation.

## Conclusion

Lead V1's full overview with V4's verdict and chain. Use Buck's action
critical path when available; otherwise label the task-span chain honestly.
Freeze a Vista review snapshot only on demand, since frozen captures are
not the everyday 30-day Tempo view.

## VRS Impact

The [trace access spec](../spec.md) uses the V1 overview with V4's header,
seven eligible main runs and their spread; a one-run A/B is not the baseline.
