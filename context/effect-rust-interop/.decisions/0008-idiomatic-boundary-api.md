# Decision: Idiomatic export, service, and recovery APIs

## Status

Status: accepted

## Context

Current-round q10–q15 require idiomatic APIs in both languages. Rust exports inside TypeScript strings evade Rust tooling; per-variant Effect errors distort Rust enums; Init on every method confuses acquisition with recovery.

## Decision

- Declare exports with `#[effect_rust::export]` in thin adapter crates. The application manifest lists crates only; generated export metadata drives Buck bindings and factories.
- Keep core crates plain Rust, with optional serde/schemars and one selected binary format's derives behind `cfg_attr` features in the defining crate.
- Map each Rust error enum to one Effect `Schema.TaggedError` with a tagged `reason` union and `catchReason`. Rust retains its own tag key; the codec maps it, rather than requiring `_tag` in Rust.
- Provide generic `Interop.wasmLayer.<runtime>(Service, { load, make })` plus generated `ContentCore.layerWasm.<runtime>` statics; native counterparts follow the same split.
- Init fails Layer construction only. A failed rebuild is a defect. Input streams expose Sinks; output streams expose Streams.
- Default to in-process lexical rebuild. Retire-only and dedicated Worker execution are explicit choices, with no replay or tier fallback. Native guarantees unwind panics only; hard fault isolation uses subprocesses.

## Evidence and Argument

The API preview's selected TS snippets typechecked against Effect 4.0.0-rc.118 and its plain Rust snippets compiled against rustc 1.98.1. The preview stubbed foundation helpers and did not compile proposed export macros; it is API-shape proof, not implementation admission. [B3](../.experiments/b3-panic-reclamation.md) exercised the hand-generated lifecycle equivalents and measured dedicated Worker costs of about 15–18 microseconds per call and 9.5–24 milliseconds per replacement.

## Options

| Option                                           | Tradeoff                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Thin export attribute + core cfg_attr (selected) | Rust-tool-visible exports; ordinary feature-gated ecosystem derives |
| Manifest Rust strings                            | No macro, but invisible to Rust rename and rustdoc                  |
| Adapter newtype for every contract               | Avoids core features, adds conversion boilerplate                   |
| One error per variant                            | Widens Effect error channel independently of Rust enums             |
| Init in all methods                              | Makes acquisition/recovery noise part of domain signatures          |
| Dedicated Worker default                         | Scheduling isolation but higher call/rebuild cost                   |

## Consequences

The export proc macro is separate from rejected contract-expansion macros. Raw binding handles, panic guards, and DataViews stay inside generated adapters. Explicit dedicated JS Worker isolation does not imply native crash containment or a workerd Worker API.

## Specification

[Errors and API sketch](../spec.md#errors-and-api-sketch-r05-r10r15) and [runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).
