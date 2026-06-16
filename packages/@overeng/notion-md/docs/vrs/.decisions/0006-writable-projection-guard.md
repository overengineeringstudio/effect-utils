# The guard hash and `put` write unit are the writable projection, not the literal rendered document

The base hash that guards `put` is computed over a canonical serialization of
the **writable projection** of a page, identical across both streaming modes:

- title,
- writable metadata (icon, external cover, `in_trash`, `is_locked`),
- writable properties,
- body.

Read-only / computed fields — formula/rollup values, `created_time`,
`last_edited_by`, `unique_id`, expiring cover URLs — are **excluded** from the
hash and **ignored on write** (with a stderr note if the user changed one). The
projection body must be **URL-canonicalized** (decision 0007).

## Why

Two reasons, and live validation (experiments.md) corrected which one matters:

1. **Semantic:** the guard should cover exactly what `put` can write. A
   concurrent change to a field the user cannot write (a rollup, a computed
   value) is not a conflict for the user's intended write, so it must not
   manufacture one.
2. **Idempotence — and this is the operative one:** the volatility that breaks
   `cat`→`put` is **not** in the metadata. Live testing showed
   `last_edited_time` is minute-rounded and only advances on a real edit, so two
   no-op pulls never differ on it. The real per-pull volatility is the
   **hosted-media signed URL inside the body** — a writable projection that
   embeds the body _verbatim_ is non-idempotent for media pages, while a
   URL-canonicalized body is stable. So the projection's body must be
   URL-canonicalized (decision 0007); metadata exclusion is correct but
   secondary, and is justified by computed/formula/rollup values (which _can_
   change underneath a no-op pull), not by `last_edited_time`.

One guard rule serves both modes (default mode is the projection where title is
the only non-body writable field). Property **schema drift** since the pull is
still refused separately (R14); the projection guard covers value/body drift,
not schema changes.

## Status

accepted (refines decision 0002; idempotence rationale corrected by live
validation — see experiments.md)

## Consequences

- The canonical writable-projection serialization must be deterministic and
  stable across pulls: defined field order, volatile/computed fields omitted,
  and the body URL-canonicalized (decision 0007).
- Streaming scope (including the object-store-overflow boundary) is governed by
  decision 0008.
