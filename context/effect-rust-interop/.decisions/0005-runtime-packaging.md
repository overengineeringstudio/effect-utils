# Decision: Runtime packaging defaults

## Status

Status: accepted

## Context

Generated bindgen targets alone do not provide one relocatable package across the supported runtime and bundler matrix.

## Decision

Use conditional exports: Node CJS glue, Bun/browser inline bytes by default plus an explicit URL/streaming entry, and Workers precompiled Module loading. Facilitate other legitimate explicit application delivery options. Native products are Nix-fleet-only and built on native builders.

## Evidence and Argument

The [packaging experiment](../.experiments/e4-packaging.md) executed a conditional root in Node, Bun, Vite dev/prod, Chromium, and local Workers. Inline bytes failed local Workers execution despite successful bundling. Native products ran on three platforms but retained Nix-store dependencies.

## Options

| Option                                                                | Tradeoff                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| Inline default, explicit URL, compiled Workers, Nix native (selected) | Simple defaults with explicit deployment alternatives |
| URL-only default                                                      | Separate caching, consumer asset configuration        |
| Raw bundler glue                                                      | Runtime-specific failures                             |
| Public npm native prebuilds                                           | Requires unproven portability normalization           |
| Cross-built native products                                           | No admitted experimental artifact                     |

URL-only defaults need consumer asset configuration. Raw bundler glue was not portable across the matrix. Public npm native prebuilds require portability floors and dependency normalization not established by these probes. Cross builds did not produce admitted artifacts.

## Consequences

Inline delivery increases JS and prevents independent wasm caching. URL consumers own deployment and content types; Workers cannot use inline compilation. Every advertised delivery option requires emitted-artifact digest smoke, not just a build or dry-run.

## Specification

[Runtime packaging and admission](../spec.md#runtime-packaging-and-admission-r06-r07-r09).

## Amendment 1

[K2](../.experiments/k2-build-admission.md) found Bun also matches `node`; order `bun` **before** `node`, retaining `workerd` first. Darwin Node-API products need `-Clink-arg=-Wl,-undefined,dynamic_lookup` to resolve `_napi_*` symbols from the host runtime. This is macOS Node-API-specific, not a global linker option. All six wasm/native/app × Node/Bun smokes passed on x86_64-linux, aarch64-linux, and aarch64-darwin. Local workerd and browser execution remain out-of-tree proof, not production Cloudflare or complete Buck capability admission.

## Amendment 2

The browser/default entry now uses an external wasm asset through the pinned wasm-bindgen fetch/instantiateStreaming loader; inline delivery is explicit. Node retains CJS and Bun retains inline delivery. `browserWorker` names browser Web Workers and uses the external-asset loader; `workerd` remains a distinct precompiled `WebAssembly.Module` entry without fetch. Fresh lexical glue state is acquired per instance, including finalizers.

This supersedes the original browser inline default, not the explicit-runtime/no-fallback policy. Internal app pilot A (image/byte processing) exposed a first-initialization cost that outweighed inline convenience; [the pilot evidence](../.experiments/pilot-a-image-byte-processing.md) and [PR #1604](https://github.com/overengineeringstudio/effect-utils/pull/1604) record the rationale and implementation. #1604 is an open implementation PR, not a merged release. Consumers must serve the emitted asset correctly; explicit inline remains useful for bundler-less applications.
