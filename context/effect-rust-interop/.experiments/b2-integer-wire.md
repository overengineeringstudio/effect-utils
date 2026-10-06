# Experiment B2: Full-width integer transport

## Question

Which eligible full-range integer representation wins after losslessness, then throughput, then readability and size?

## Hypothesis

Full-range u64/i64 can cross every portable runtime without losing value, and eligible representations can be ranked after correctness.

## Method

Compared decimal strings/bigint, source-aware numeric JSON (`context.source`/`rawJSON`), lossless-json 4.3.0, a generated fixed-schema little-endian binary layout, and safe-number defaults with optional string annotations. Node 24.20.0, Bun 1.4.2, Chromium 153, local workerd, and Rust serde executed extrema, lexical/type rejection, encode-range, and exact-value checks. Effect was 4.0.0-rc.118.

Correctness ran separately from timing. Final timing used an eight-CPU CI runner with load 0.15–1.22: three warmup cycles, 12 measured rounds with rotated/reversed candidate order and alternating encode/decode order. [The successful run](https://github.com/overengineeringstudio/effect-utils/actions/runs/36783266878) is the public performance reference. The temporary benchmark PR [#1554](https://github.com/overengineeringstudio/effect-utils/pull/1554) was closed without merge.

## Result

| Candidate                             | Each JS runtime                   | Rust                              | Eligibility                    |
| ------------------------------------- | --------------------------------- | --------------------------------- | ------------------------------ |
| Decimal strings                       | 39/39                             | 35/35                             | Lossless                       |
| Source-aware numeric JSON             | 39/39                             | 35/35                             | Lossless on exercised versions |
| lossless-json                         | 39/39                             | 35/35                             | Lossless                       |
| Fixed LE binary                       | 42/42, including malformed widths | 35/35; exact 44-byte frame parity | Lossless for this layout       |
| Optional string annotations / numbers | 13/39 failures                    | Cannot restore rounded JS output  | Ineligible                     |

10 MB semantic-batch codec throughput, mean ± sample SD, decimal semantic MB/s:

| Runtime / representation |        Decode |          Encode | Wire bytes |
| ------------------------ | ------------: | --------------: | ---------: |
| Node strings             |    89.4 ± 4.4 |    124.2 ± 11.2 |  9,999,879 |
| Node source-aware        |    31.1 ± 1.8 |      75.1 ± 7.6 |  9,082,459 |
| Node lossless-json       |    54.1 ± 8.1 |      55.4 ± 5.7 |  9,082,459 |
| Node binary              |  317.3 ± 52.8 | 1,558.5 ± 174.6 |  3,669,684 |
| Bun strings              |  172.5 ± 25.5 |    173.3 ± 28.5 |  9,999,879 |
| Bun binary               | 970.1 ± 227.9 | 1,905.4 ± 302.0 |  3,669,684 |

Incremental gzip codec bytes, excluding Effect/binaries: strings 494, source-aware 542, lossless-json 3,195, binary 637. The generated Effect Schema smoke executed 74 checks. Source-aware JSON APIs and BigUint64Array were present on all four exercised JS runtimes, without fallback.

## Conclusion

[Decision 0010](../.decisions/0010-json-control-plane.md) selects decimal-string JSON plus explicit binary bulk, canonical base-10, and required widths. Strings were the fastest eligible JSON path in every measured Node/Bun payload size. Source-aware versus lossless-json has direction/runtime-dependent rankings, not a universal winner.

## Intent Impact

Closes the general integer-wire choice while retaining explicit binary bulk and forbidding safe-number narrowing.

## Limits

This measures codec parsing, validation, bigint conversion, and object materialization, not end-to-end Effect/wasm/native calls, Rust algorithms, UTF-8 conversion, startup, or network. Throughput is normalized to the identical logical string-JSON batch, not actual wire MB/s: Node binary decode 317.3 semantic MB/s corresponds to about 116.4 wire MB/s. The layout is a fixed five-field experiment, not the later Borsh contract. Browser/workerd correctness is local; no production Cloudflare or older-runtime admission is claimed.

## Specification

[Wire protocols](../spec.md#wire-protocols-r03-r04-r12-r14).
