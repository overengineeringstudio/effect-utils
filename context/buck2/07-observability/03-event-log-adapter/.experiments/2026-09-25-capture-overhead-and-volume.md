# Capture overhead and volume (B4)

Date: 2026-09-25 · Local-disk checkout, clean tree with sha256-verified
edit/restore per run; warm daemon and local action cache; every build under
the fleet's heavy-operation gate with timing stamps inside the lock; n=7
paired (5 AB + 2 BA, interleaved) after warmups; bootstrap 95% CIs (10k
resamples).

## Question

What does event-log capture plus conversion cost per build — and what does
the evidence weigh per build type? Conditions: `default` (Buck always writes
its own log) vs `explicit` (`BUCK_WRAPPER_UUID=<uuid>` + `--event-log
<path>`: the wiring an adapter/CI uses).

## Method

- Paired wall-time blocks on warm no-ops (single target and the check
  aggregate, ~25 ms builds) and warm one-file-edit builds (6–30 s).
- Capture mechanics probed directly (default-log presence, second-write
  byte-identity via sha256, uuid propagation into filename and invocation
  record).
- Converter + push costs on the produced logs plus the 15 cold-CI logs
  (n=5/n=3), including a readback of one pushed trace from the trace store.
- A local-cache-cold rebuild lane was attempted in an isolation dir and
  abandoned for environmental reasons (anonymous remote auth rejects writes;
  documented, excluded from conclusions) — cold-side evidence comes from the
  CI corpus instead.

## Result

- Build wall time: the only statistically resolvable capture cost is the
  second byte-identical write on no-ops: +2.5–7 ms (95% CI, significant).
  On working builds the paired CI bounds the delta at ±1–2.5 s while the
  mechanism (one extra sequential write of ≤0.7 MiB) is single-digit ms —
  ambient noise is ~100× the effect. Supported bound: **< 10 ms and
  < 0.1%** on any build that does real work.
- Log weight by build type: no-op 3–5 KB (8–50 spans); one-file-edit single
  target 9 KB (33 spans); one-file-edit of the check aggregate 462 KB
  (9,830 spans — 78% of the cold CI log's span count, from 2,793 re-verified
  actions); cold CI check aggregate 711 KB (12,622 spans, 10 MB OTLP JSON).
  Span volume tracks graph size, not executed work.
- Converter + push (TS prototype): small logs dominated by ~100 ms process
  startup; a 10–12 k-span log converts in ~0.5 s and pushes in 0.6–0.8 s
  (1,000-span chunks); all 15 CI logs convert in 4.8 s single-threaded.
- Full CI run: 3.6 MiB zstd artifacts / 66,948 spans / 60.09 MiB OTLP JSON;
  one 50-span trace read back 50/50 from the store.

## Conclusion

Capture is effectively free and should be unconditional wherever a caller is
traced; the real cost is conversion and storage, and the binding constraint
is **volume**: any always-on wiring must expect ~10 k spans per non-trivial
warm build and ~67 k per cold CI run. Confidence: high on mechanics and
converter cost; medium on the ms-level bound (mechanistic, under load noise).

## VRS Impact

Grounded BUCK.OBS.REC-R02 (unconditional capture) and BUCK.OBS-R06's volume
model; motivated the trace-view lane ([04](../../04-trace-views/requirements.md))
before any always-on rollout (q10). What would change it: an upstream change
to event-log writing (e.g. fsync per event) — recheck on bumps.
