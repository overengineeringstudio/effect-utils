# Decision: Tiered delivery

## Status

Status: accepted

## Context

The foundation needs a portable default without hiding desktop performance or host-state isolation tradeoffs.

## Decision

Use wasm-bindgen by default across supported runtimes, explicit Node-API Layers only for measured desktop hot paths, and subprocess Layers for coarse host-state/tree operations. There is no automatic fallback.

## Evidence and Argument

The [delivery experiment](../.experiments/i-delivery.md) exercised all portable runtimes. Native reached about 2.2 GB/s while wasm reached 183–360 MB/s; JSON CLI transport reached 15–22 MB/s. Runtime crypto already matched the addon for plain hashing.

## Options

| Option                              | Tradeoff                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| Tiered explicit delivery (selected) | Portable baseline with measured native and coarse process choices |
| Wasm-only                           | Simpler artifacts, no native hot-path option                      |
| WASI Component                      | Neutral interface, greater glue/init cost                         |
| Automatic fallback                  | Hidden capability/lifetime changes                                |

Wasm-only avoids platform products but gives up measured hot-path throughput. WASI Component delivery added initialization/glue cost without a required-runtime advantage. Automatic fallback hides capability and lifetime differences.

## Consequences

Consumers retain domain services and choose a Layer explicitly. Native products need platform admission; subprocess isolation is available without turning fine-grained calls into process launches.

## Specification

[Delivery and responsibility](../spec.md#delivery-and-responsibility-r01-r05-r07).

## Amendment 1

Native admission guarantees **unwind panics only**, not double panics, OOM, process faults, or addon unload. Products requiring hard crash isolation declare it and use the subprocess tier; a dedicated JS Worker does not contain native process death. [B3](../.experiments/b3-panic-reclamation.md) caught every exercised generated unwind boundary but double-panic children terminated with SIGABRT. This clarifies the original tier decision without expanding its guarantee.
