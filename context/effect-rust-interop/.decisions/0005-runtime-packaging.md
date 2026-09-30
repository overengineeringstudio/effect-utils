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
