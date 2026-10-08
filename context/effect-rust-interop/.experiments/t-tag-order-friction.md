# Experiment T: Tag-order friction and buffering

Non-normative extension of [R](./r-generated-rust.md), investigating the historical strict-first-tag proposal rather than declaring the current decoder contract.

## Question

What buffering advantage and producer/storage friction follow from requiring the discriminator first?

## Hypothesis

A discriminator-first streaming decoder avoids object-heavy buffering, but requiring that order at a text boundary introduces producer and storage incompatibilities absent from ordinary tagged JSON.

## Method

Use Effect 4.0.0-rc.118, Bun 1.4.2, Rust 1.98.1, serde 1.0.229, and serde_json 1.0.151. Exercise 24 Effect/JavaScript/HTTP/log-transform probes, serde producers, real PostgreSQL 18.6 and Redis 8.10.1, and jq transformations. Benchmark R's unchanged streaming visitor and public path-tracking decoder, serde derive, and a strict visitor prototype. Seven rotated release rounds per case process approximately 16 MiB; allocations are measured separately. Fixtures are 225 bytes/4 rows, 412,611 bytes/4,096 rows, and a 1,048,635-byte single-large-string payload.

## Result

| Boundary                                       | Observed behavior                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Effect TaggedStruct and stringify              | Ordinary fields emit tag first, but an integer-index field `"0"` precedes `_tag`               |
| Plain Struct, spreads, and plain serde structs | Declaration/construction order can put the tag later                                           |
| Native serde internally tagged enum            | Direct serialization emits tag first; deserialization buffers either order                     |
| serde Value or sorted jq output                | Uppercase/numeric names can precede the discriminator                                          |
| PostgreSQL json                                | Preserves already-first input text                                                             |
| PostgreSQL jsonb                               | Reorders `{"_tag":"Item","id":1,"payload":"x"}` to `{"id": 1, "_tag": "Item", "payload": "x"}` |
| Redis strings and local opaque HTTP echo       | Preserve input bytes                                                                           |
| Redis JSON                                     | Not measured: JSON.SET unavailable; no observed reordering claim                               |

Median decimal MB/s:

| Shape         | R stream first | R fallback last | Public decoder first / last |
| ------------- | -------------: | --------------: | --------------------------: |
| Small control |          285.9 |           132.4 |                111.1 / 69.0 |
| Many objects  |          538.6 |           139.6 |                242.9 / 91.6 |
| Large scalar  |        6,144.4 |         5,965.5 |           6,114.8 / 5,972.8 |

For many objects, peak added live heap was 425,988 bytes streaming versus 3,199,613 bytes fallback (7.51×); allocation requests were 4,109 versus 20,496 (4.99×). All tracked live bytes returned to zero after dropping output. These are allocator-requested bytes, not RSS, input size, or byte-copy counts. The large-scalar result does not support a universal double-payload-memory rule.

A tag-first-then-sorted encoding and whole-document sorted encoding produced equal typed values but unequal SHA-256 hashes. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785#section-3.2.3) recursively sorts all properties; a discriminator-first canonical profile is not JCS when another key sorts before the tag.

## Conclusion

The object-heavy fast path has a measured buffering advantage. Removing fallback does not inherently accelerate that existing fast path; it trades order-independent acceptance for an enforced buffering bound and simpler implementation. Ordinary Schema object validation cannot enforce original text order, and generic stores cannot be assumed to preserve it. The experiment does not change the selected decoder policy.

## Intent Impact

Distinguish canonical encoder order from decoder acceptance. Treat strict-first-tag rejection as a substantive wire restriction, not an inherent property of tagged unions.

## Limits and current evidence

The loaded host recorded load1 193.86 and large outliers; medians are descriptive, not capacity guarantees. Allocation and timing runs are separate. The strict visitor is a scratch prototype; hostile-input parity, prefix-only buffering, production intermediaries, and Redis JSON were not established. The supplied later review describes canonical tag-first encoding with order-independent decoding; T's strict rejection probes remain evidence about the rejected/reconsidered restriction, not proof of current late-tag rejection.

## Sources

- Supplied private T report, producer table, canonical witnesses, performance and allocation sections; supplied private interop review summary for the later encoding/decoding distinction.
- [PostgreSQL JSON representation](https://www.postgresql.org/docs/18/datatype-json.html), documenting jsonb's lack of key-order preservation.
- [serde internally tagged derive](https://github.com/serde-rs/serde/blob/v1.0.228/serde_derive/src/de/enum_internally.rs); the report inspected pinned 1.0.229 locally, not this older public version as its measurement source.
- [Foundation PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578), open when consulted; implemented product evidence is distinct from R/T's scratch decoders.
