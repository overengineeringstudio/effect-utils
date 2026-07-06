# Decision 0003: Bootstrap-closure check reuses the TypeScript compiler API with genie's resolver injected

## Status

Accepted

## Context

R30 requires detecting, before generation, any `.genie.ts` whose transitive runtime import closure reaches a package unavailable before install, and reporting the importer chain. The hard, bug-prone part is the graph engine: transitive traversal, `export *` / re-export barrel widening, cycles, memoization, and type-only-edge erasure. A prior attempt hand-rolled a transitive import-graph analyzer from scratch inside an oxlint plugin; that was rejected as unprincipled, since off-the-shelf analyzers already solve the graph problem.

The genie-specific parts are only (a) resolving `#`/`#mr` specifiers with genie's own lock-pinned semantics and (b) the bootstrap policy plus the chain diagnostic. So the choice is: which engine can accept genie's resolver by injection AND expose the transitive graph, without us re-owning the graph walk.

The discriminator is **`#mr` resolution by function injection**. `#mr/<member>/...` resolves dynamically against `megarepo.lock` (see spec _Import Resolution_), so it cannot be expressed as static resolver config. And it is load-bearing: downstream megarepo members reach into effect-utils' genie building blocks via `#mr/effect-utils/...` (dozens of real `.genie.ts` sources across members), so a shared checker must honor it.

## Decision

Reuse the **TypeScript compiler API** as the parser + resolver, injecting genie's own `resolveImportMapSpecifierForImporterSync` for `#`/`#mr` edges. We own only the transitive walk (a short BFS over reused, memoized per-file edges) and the bootstrap policy + chain formatter — not the resolver, not module resolution, not `export *` widening.

Sub-decisions:

- **Policy is a strict allowlist**, not a runtime-only denylist: a violation is any bare specifier (non-relative, non-`#`/`#mr`, non-node-builtin), reusing the "external = non-relative, non-`node:`" definition already encoded by the `no-external-imports` rule. Node builtins are exempt (importable pre-install with or without the `node:` prefix). Bare first-party `@overeng/*` IS a violation (not resolvable pre-install; use relative or `#mr`).
- **Enforcement is baseline + ratchet**: the pre-existing violations are baselined so the gate is green today; only new violations fail, and stale baseline entries are flagged so it ratchets down.
- **Integration is a devenv task** (`bootstrap-closure:check`) wired into `check:all`, mirroring `weaver:check` — not a new genie CLI subcommand. The `checkBootstrapClosure` walker is exported from `@overeng/genie/node` for downstream reuse.
- **The walker is itself bootstrap-safe.** It imports genie's resolver from `core/import-map/sync-resolver.ts` — the effect-free sync resolution path (only `node:fs`/`node:path`), extracted out of `import-map/mod.ts` (whose Effect functions eagerly pull `@overeng/otel-contract` via observability). So the walker's whole import closure is `typescript` + node builtins, and it runs in a nix-packaged-genie consumer that never installs effect-utils' node deps. `mod.ts` re-exports the sync API for backward compatibility. Without this, the tool that enforces "importable pre-install" is not itself importable pre-install (verified downstream in dotfiles).

## Options considered

- **oxlint (in-stack)** — REJECTED. Its module graph powers `import/no-cycle` but is not exposed to JS plugins (empirically: a dump plugin run alongside `import/no-cycle` sees zero graph keys); its resolver (`oxc-resolver`) is static-config-only with no JS hook; and there is no reachability-to-target rule. A JS plugin could only re-walk the tree itself — the rejected anti-goal. Captured as a watch-item (effect-utils#889): adopt if oxlint later exposes the graph/resolver to plugins.
- **dependency-cruiser** — VIABLE (injects genie's resolver via an enhanced-resolve plugin; type-only and graph for free). Rejected as primary only on footprint: ~20 net-new dependencies vs 0 for the TS compiler API. Remains the fallback if owning the small edge-extraction surface becomes a burden.
- **tsgo (`@typescript/native-preview`)** — REJECTED for the shared checker. Fastest, and already in-stack as a CLI, but its JS API is an RPC client to the Go binary with no `resolveModuleNameLiterals`-equivalent, so genie's `#mr` resolver cannot be injected by function (only a virtual-FS freeze). Viable only if the check were scoped effect-utils-local (where `#mr` never appears in the closure).
- **skott / madge** — OUT. skott has a resolver-plugin interface but a ~112 MB footprint (dominated); madge has no custom-resolver injection at all.

## Rationale

The TS compiler API is the only engine that is both zero-new-dependency (typescript is already a direct genie dependency) and able to inject `#mr` resolution by function. It does not reintroduce the anti-goal: `ts.createSourceFile` + `ts.resolveModuleName` are the reused, authoritative parser and resolver; the transitive walk is a trivial memoized BFS. The owned surface is bounded edge-classification glue (import/export/dynamic-import extraction and type-only exclusion), not a resolver or a graph engine.

## Consequences

- Genie carries a shared, node-only bootstrap-closure walker other members can enforce against their own `.genie.ts`.
- We maintain the edge-extraction/type-only classification (small, unit-tested). Two known-latent gaps are handled: dynamic `import('…')` string literals are detected; per-specifier `{ type X }` exclusion is implemented for both imports and exports.
- The check never descends into `node_modules`, so it has no dependency on install state and no `.d.ts` parsing cost.

## Evidence

See `.experiments/2026-07-05-bootstrap-closure-engine.md` — candidate matrix, runtime/footprint benchmarks, the oxlint plugin-context probe, the `#mr` lock-branch end-to-end proof, and the megarepo-wide `#mr` usage survey.
