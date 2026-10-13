# Experiment X: Binary bulk layout bakeoff

## Question

Which binary layout and implementation provide efficient, safe, idiomatic bulk data without a second schema authority?

## Hypothesis

A published fixed-width layout with compiler-emitted JS can preserve full-width values while outperforming reflective or varint paths and fitting both language APIs.

## Method

Compared 11 formats / 13 JS implementations: own LE, Borsh emitted/reflective, postcard, bincode, rkyv, Cap'n Proto, FlatBuffers, Arrow apache-arrow/flechette, MessagePack, CBOR, and protobuf. Record rows contained four u64, one i64, string, and bytes; columns contained five integer arrays. Extrema, UTF-8, alignment, truncation, trailing data, and malformed lengths were checked. Wasm/native producers and Node 24.20, Bun 1.4.2, Chromium 153, local workerd ran cross-language correctness.

Final timings used 32-CPU hardware at load 6.4–8.6, seven warmed samples of ≥60 ms, reporting medians. Logical bytes were 40 integer bytes plus row string/payload, identical for every format. Rust→JS includes Rust encoding and owned JS decode; JS→Rust includes JS encode, bindgen copy, and owned Rust decode.

## Result

Every format had full-width value parity through an admitted JS implementation; apache-arrow encoding failed on workerd (`new Function` forbidden). Native/wasm output matched 33/33 cases; Rust verified 39/39 JS-encoded files. Emitted Borsh matched Rust bytes exactly, rejected all 63 truncations and trailing bytes, and returned owned payloads/columns even from misaligned inputs.

| Borsh emitted workload                    | Node Rust→JS MB/s | Bun Rust→JS MB/s | Node JS→Rust MB/s | Bun JS→Rust MB/s |
| ----------------------------------------- | ----------------: | ---------------: | ----------------: | ---------------: |
| 80,000 rows, 9.98 logical MB              |               302 |              670 |               265 |              231 |
| 262,144 rows of columns, 10.49 logical MB |             4,124 |            3,779 |             1,950 |            1,773 |

Borsh added 1,831 gzip JS bytes and 13,587 gzip wasm bytes after -Oz. Own LE added 1,945 / 5,269; Arrow added 15,052 or 52,932 JS bytes and 352,661 wasm bytes. Reflective Borsh used the same bytes but measured 11.5/14.4 MB/s on the large Rust→JS record case, and did not reject trailing data.

Schema re-validation at 80,000 rows changed Borsh decode from 41.5→70.6 ms on Node (+70%) and 18.9→43.7 on Bun (+131%). Across five implementations decode overhead was 23–131%; encode was about 2.5×. These overheads motivate an explicit trusted path, not a permissive default.

FlatBuffers JS rejected only 51/63 truncations and has no verifier; its Rust verifier accepted three truncations. Rkyv accepted one truncation as different valid data and depends on format-control features. Cap'n Proto JS was much slower and pre-1.0. Bincode's upstream was tombstoned. Postcard reduced wire by about 10% records / 18% columns but JS varints lost throughput.

## Conclusion

[Decision 0011](../.decisions/0011-binary-bulk.md) selects Borsh layout with emitted JS, mandatory id/version envelope, validated default/trusted opt-in, own fixed-width columns, one cfg_attr binary derive, Arrow boundaries only, and explicit format exclusions.

## Intent Impact

Closes binary format selection while preserving owned defaults, explicit trusted admission, and versioned contract identity.

## Limits

Fixed-width timings overlap: Borsh/LE/rkyv/Arrow are a tie class, not a strict total rank. Timed wasm was unoptimized; -Oz was applied only for separate size measurements. Browser/workerd were correctness-only; native bytes were compared but Node-API throughput was not measured. No streaming frame, production Cloudflare, general union/option IR, or mandatory final six-byte envelope was exercised in X. Direct wasm output views existed only during decode; returned fields were owned, not escaping borrowed views. Proposed direct encoder writes and a minimal custom Arrow implementation were not built.

## Specification

[Binary bulk](../spec.md#binary-bulk).
