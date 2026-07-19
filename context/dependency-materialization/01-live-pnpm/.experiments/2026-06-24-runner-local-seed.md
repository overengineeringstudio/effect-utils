# 2026-06-24 Runner-Local Seed

## Question

Can a runner-local seed of package content plus job-local writable metadata
preserve isolation and reduce install time?

## Method

Compared synthetic hardlink reuse with integrated real-workspace installs and
tested the seed across the explored pnpm store-version boundary.

## Result

Synthetic hardlink results were promising, but integrated installs were slower
than the warm baseline and the seed exposed pnpm store-version portability
problems.

## Conclusion

The explored seed was rejected. A new immutable-seed design must prove complete
identity, pnpm-version compatibility, real-workload latency, parallel safety,
and actual immutability rather than assuming a hardlink is read-only.

## VRS Impact

Constrains DMP-R24 and DELTA-001 resolution without rejecting a differently
constructed, atomically published immutable seed.
