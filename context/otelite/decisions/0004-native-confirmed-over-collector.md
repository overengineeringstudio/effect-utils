# Native receiver empirically confirmed over collector-contrib

Three prototypes were built and measured head-to-head (see
`tmp/otelite-compare/`, summarized below). The native Rust receiver wins
decisively on every axis that matters for a test-capture tool.

## Measured comparison

| Axis                 | Native (scratch)          | Collector-contrib wrap                  |
| -------------------- | ------------------------- | --------------------------------------- |
| Footprint            | 5.1 MB binary (94 crates) | 321.7 MiB closure                       |
| Startup → listening  | ~5 ms                     | ~100 ms warm / ~600 ms cold             |
| Code owned           | 424 LOC (one `main.rs`)   | ~150 LOC wrapper + YAML schema coupling |
| Ephemeral `:0` ports | yes                       | no — must pre-pick (TOCTOU-racy)        |
| Transports verified  | HTTP json+proto + gRPC    | same (free)                             |

All three transports were verified end-to-end against real emitters in the
native build using the official `opentelemetry-proto` (`gen-tonic`) generated
service traits — no hand-rolled wire handling.

## Why this settles it

- ~60× smaller closure, ~20× faster start, and **ephemeral ports** — the last is
  load-bearing for parallel test isolation, which the collector cannot do.
- The collector's headline advantage (free protocol coverage) is matched by the
  native build; its real cost (321 MiB into every consumer's CI/nix cache,
  YAML/version coupling) buys nothing the test lane needs.

## Cost we accept

Native's 94-crate / 3.7 MB weight is almost entirely the tokio+hyper+tonic+h2
async stack, driven by the **gRPC** requirement (HTTP-only would be ~15 deps).
Accepted: gRPC-from-day-one was chosen deliberately (0002), and 5 MB is trivial
next to 321 MiB.
