# 0001 Direct Decode in a Dedicated Rust Crate

Status: accepted

Accepted 2026-09-25 (decision q10; Johannes), on the round-1 decode bakeoffs
(B1, B2, B2b).

## Context

Decision 0011 promises versioned adapters that decode native evidence. The
decode source and implementation home had to be chosen once, with
performance in mind (standing direction q12: best long-term approach, bakeoff
when unclear).

## Evidence and Argument

- **Source (B1):** direct zstd+protobuf decode with a vendored proto beat
  every alternative on the largest CI log — 42 ms / 13.7 MB RSS vs
  `buck2 log show` 59 ms / 36.3 MB, the JSONL pipeline 191 ms / 96 MB,
  chrome-trace 94 ms. The critical path arrives in-band (22/22 corpus logs),
  deleting the second subprocess; the artifact is a 2.5 MB binary instead of
  a 136 MB pinned Buck. The JSONL key set follows the _reader binary's_
  proto, not the log's — a measured `bool → enum` retag misrendering — so
  `log show` has no stability advantage; the pin is simply made explicit and
  auditable. `chrome-trace`/`what-ran`/invocation-record are incomplete span
  sources (992 of 12,622 spans on the big log).
- **Home (B2 then B2b):** for the JSONL source the validated TypeScript
  converter was _faster_ than a minimal Rust port (0.60 s vs 0.72 s) — but
  direct decode flipped the result: Rust/prost streaming 0.37 s / 109 MB vs
  TS reflection 1.81 s / 350 MB on the largest log (4.9× / 3.2×; median log
  8.6× / 4.2×), with exact span/ID/parent/name/critical-path parity on both
  inputs. The TS route would add an npm protobuf runtime (1.4 MB) plus a
  110.8 MB codegen closure, or pay runtime reflection and whole-buffer zstd.
- **Not otel-scrape:** its exporter is private and live-wrapper-specific, and
  its boundary decision (0021) reserves it for wrapped-tool adapters; an
  offline, truncation-tolerant, batch-capable parser is a different concern.

## Options

| Option                          | Tradeoff                                                                                                 | Outcome                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| Direct decode, new Rust crate   | 4.9–8.6× faster, 3–4× lower RSS, no runtime Buck binary; costs a full attribute/label port               | Accepted                    |
| `buck2 log show` JSONL in TS    | Reuses the validated 561-line converter; 136 MB pinned binary, second subprocess, reader-proto re-keying | Fallback only               |
| Extend otel-scrape              | Reuses exporter plumbing; violates its accepted boundary; exporter is private                            | Rejected                    |
| Upstream native OTLP (PR #1370) | No adapter to own; exports one InvocationRecord wide span, unmerged                                      | Rejected as the lane's path |

## Decision

Decode `*_events.pb.zst` directly with a vendored `data.proto` pinned to the
newest fleet producer; keep `buck2 log show` (matching binary) as fallback
and debugging surface; unknown fields are recorded data loss, never errors.
Implement as a new dedicated Rust crate (prost) in the Buck-tooling
workspace, shipped through the existing cargo → Buck product → Nix path. The
bump procedure (regen + field-number _and type_ diff + cross-version corpus
replay) is part of the contract (BUCK.OBS.ADP-R03).

## Consequences

- Runtime independence from the Buck binary and a pinned, auditable schema
  dependency instead of an implicit one.
- The validated TS converter's attribute/label mapping must be ported and
  fixture-diffed before the crate is complete (B2b's prototype proved
  structure, not full attribute parity).
- Upstream shipping a stable OTLP export, a framing change, or a
  diverging-producer fleet would reopen the source decision (recorded in the
  experiments' "what would change" sections).
