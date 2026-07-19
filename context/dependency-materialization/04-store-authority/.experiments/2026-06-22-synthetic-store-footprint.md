# 2026-06-22 Synthetic Store Footprint

## Question

Does reusing package content reduce host-wide bytes and files relative to
isolated stores?

## Method

Materialized synthetic overlapping dependency graphs with isolated and shared
package-content realizations and compared aggregate footprint.

## Result

Shared package content produced a material byte and file-count reduction.

## Conclusion

The result supports broad reuse of immutable package data as a design signal,
but it does not select a default without integrated real-workspace correctness,
purity, concurrency, repair, and performance gates.

## VRS Impact

Supports DMP.STORE-R03 and DMP.STORE-R14 while leaving the realization choice to
the full verification matrix.
