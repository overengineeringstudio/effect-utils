# 2026-06-24 Setup Fan-Out Archive

## Question

Can one setup job install once, archive prepared live state, and fan it out more
cheaply than each sibling job running a warm install?

## Method

Compared integrated archive pack/restore with independent warm installs on the
explored self-hosted runner shape.

## Result

Archive pack and restore cost outweighed the warm-install savings.

## Conclusion

Live setup/fan-out must beat the current warm path in integrated real-workload
benchmarks, not only synthetic copy tests.

## VRS Impact

Supports DMP.STORE-R14 and DMP.VER-R12's same-workload, multidimensional default
gate.
