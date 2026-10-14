# Devtools Vision

## The Problem

1. **Problem 1 — Regressions are discovered late.** Frame stalls, growing work queues, memory pressure, and excess rendering are difficult to notice during ordinary development without opening a separate diagnostic tool.
2. **Problem 2 — Diagnostic surfaces disagree.** Live displays and automated performance checks often measure the same interaction independently, producing different histories and results.
3. **Problem 3 — Embedded diagnostics become application overhead.** Instrumentation can remain active when its UI is hidden or absent, and application-specific development tools are difficult to reuse safely.
4. **Problem 4 — Attractive readings can be misleading.** Unsupported APIs, missing instrumentation, truncated history, and interrupted measurements can appear as healthy zero values.
5. **Problem 5 — Inspection is fragmented.** Performance signals and request details live in disconnected surfaces, making an incident hard to explore without losing context.

## The Vision

- Make real performance and activity signals visible during normal development, with a clear path from a live signal to its details (Problems 1 and 5).
- Give visual inspection and automated gates the same measurement evidence without making either depend on the other (Problem 2).
- Let each host choose its diagnostic composition while keeping absent diagnostics absent from execution and delivery (Problem 3).
- Show uncertainty, missing capability, and incomplete evidence as first-class outcomes instead of presenting fabricated health (Problem 4).
- Reuse diagnostic foundations across hosts without importing host-specific policy, identity, or application structure (Problems 3 and 5).

## What This Is Not

- A production monitoring backend, durable trace database, or telemetry exporter.
- An application transport, request replay tool, or automatic instrumentation of every application service.
- A general-purpose charting system or replacement for a full component profiler.
- A mandate that every host display the same meters or persist diagnostic preferences in the same way.

## Success Criteria

1. Disabled diagnostics add no diagnostic modules to the ordinary production delivery graph and start no diagnostic work.
2. A visual reader and an automated reader observe the same source evidence; adding readers does not add collectors or consume another reader's history.
3. Every displayed number is traceable to an actual observation; unavailable signals and incomplete gates are distinguishable from measured zero.
4. A user can reach a meter's details and control its frozen view with both keyboard and pointer, without interrupting collection.
5. A host can combine performance meters, request inspection, and its own status segments without coupling their core packages or copying collectors.
