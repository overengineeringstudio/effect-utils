# Adapter implementation home — direct decode tiebreak (B2b)

Date: 2026-09-25 · n=7 serial per cell under the heavy-operation gate.

## Question

B1 changed the source from `log show` JSONL to direct protobuf+zstd decode.
Does that flip the home decision from TypeScript/Bun to Rust?

## Method

- TS direct prototype: runtime-reflection protobuf loading of the pinned
  protos, whole-buffer zstd decompression via the runtime's native API,
  varint-framed record walk, in-band critical path, and a port of the
  converter's mapping (264 physical lines; 199 KiB portable bundle;
  reflection installs 14 packages / 5.9 MB — the generated-code alternative
  measured 1.39 MB runtime + 110.8 MB dev closure).
- Rust direct prototype: streaming zstd + length-delimited protobuf via
  generated prost types (252 lines; 2.65 MB one-file tar; 76 lockfile
  packages).
- Both run on the largest (12,622 spans) and median (3,552 spans) corpus
  logs; equivalence to the scratch converter checked exactly (spans, ids,
  parents, names, times, critical-path spans, orphans).

## Result

| input   | impl           | wall median | peak RSS median | OTLP bytes |
| ------- | -------------- | ----------: | --------------: | ---------: |
| largest | TS reflection  |     1.805 s |        349.7 MB |   10.23 MB |
| largest | Rust streaming | **0.367 s** |    **109.1 MB** |    4.83 MB |
| median  | TS reflection  |     0.635 s |        142.4 MB |    2.71 MB |
| median  | Rust streaming | **0.074 s** |     **34.3 MB** |    1.37 MB |

Rust 4.9×/8.6× faster and 3.2×/4.2× lower RSS; equivalence exact on both
inputs for both prototypes (the Rust side emitted the core attribute set by
design; full parity remained port work).

## Conclusion

Direct decode flips the home to a **new dedicated Rust crate**: the job
becomes a high-volume wire-format decoder (zstd + varints + generated types

- versioned schema), where streaming prost holds the memory floor the
  runtime's whole-buffer API cannot. TypeScript stays viable and structurally
  exact but would pay a new runtime dependency tree plus slower decode to land
  in a less suitable runtime. The prior JSONL-era conclusion was true only for
  the JSONL source.

## VRS Impact

Settles the home half of [decision 0001](../.decisions/0001-direct-decode-rust-crate.md)
(BUCK.OBS.ADP-R05, q10). What would change it: a generated TS decoder within
2× wall / 1.5× RSS at full parity; formal stabilization of the event-log
format; or a hard platform-independent-descriptor requirement.
