# Decision: Borsh bulk frames and fixed-width columns

## Status

Status: accepted

## Context

Current-round q25–q30 refine the JSON-control/binary-bulk split selected in q5. Positional formats need explicit evolution and all boundaries need owned, validated data.

## Decision

Use Borsh layout with compiler-emitted JS codecs for bulk frames. Require `[contract-id u32 LE][version u16 LE][payload]`; reject unknown ids/versions rather than guess. Effect Schema validation is default; `.trusted` is explicit opt-in for admitted generated codecs and does not waive structural safety, ranges, UTF-8, or ownership.

Emit our own fixed-width owned columns; use Arrow only at actual Arrow-ecosystem boundaries. Rust types may have one selected binary format's derives behind cfg_attr, not a multi-format derive stack. Exclude FlatBuffers, Cap'n Proto, and bincode from JS-facing contracts. Protobuf is for external contracts only.

## Evidence and Argument

[X](../.experiments/x-binary-bulk.md) compared 11 formats / 13 JS implementations. Emitted Borsh was byte-identical to Rust, in the fixed-width speed class, and added 1,831 gzip JS bytes plus 13,587 gzip optimized wasm bytes. Arrow added 352,661 gzip wasm bytes, and apache-arrow encode failed in workerd. Schema traversal added 23–131% to decoded-bulk time and about 2.5 times encode time; the explicit trusted option exposes that tradeoff without weakening defaults.

## Options

| Option                                  | Tradeoff                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| Borsh layout + emitted codec (selected) | Published canonical spec; version envelope required       |
| Own general little-endian frame         | Similar speed, another format specification to own        |
| postcard                                | Smaller wire, slower JS varints                           |
| Arrow everywhere                        | Ecosystem interoperability, size/runtime cost             |
| Reflective Borsh JS library             | Same bytes, much slower and weaker trailing-byte behavior |
| Unversioned frames                      | Silent positional-layout breakage                         |

## Consequences

The compiler owns id/version dispatch and length/width checks. Borsh offsets do not authorize borrowed eight-byte typed-array views. Fixed-width results are a performance tie class, not evidence that one implementation always wins. External format interoperability remains explicit, never an automatic fallback.

## Specification

[Binary bulk](../spec.md#binary-bulk).
