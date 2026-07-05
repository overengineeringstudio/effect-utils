# Experiment: bootstrap-closure engine selection (2026-07-05)

Validation evidence for decision 0003. Prototypes were throwaway; the numbers below are what they produced against the real effect-utils tree (87 `.genie.ts`, which contains **79** pre-existing violations).

## Functional fit — can the engine inject genie's `#`/`#mr` resolver AND expose the transitive graph?

| Engine             | Injects `#mr` by function                                                | Exposes graph                     | New deps    | Verdict                             |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------- | ----------- | ----------------------------------- |
| TS compiler API    | yes (`resolveModuleNameLiterals` / per-specifier `ts.resolveModuleName`) | via reused parse + walk           | 0           | **chosen**                          |
| dependency-cruiser | yes (enhanced-resolve plugin)                                            | yes (graph-as-data)               | ~20 (~8 MB) | viable fallback                     |
| tsgo               | no (RPC to Go binary; only virtual-FS freeze)                            | trace only                        | 0           | out (shared scope)                  |
| oxlint             | no (oxc-resolver static-only)                                            | no (graph is built-in-rules-only) | in-stack    | out — watch-item (effect-utils#889) |
| skott              | plugin iface, but ~112 MB                                                | yes                               | ~131 pkgs   | dominated                           |
| madge              | no custom-resolver injection                                             | yes                               | ~113 pkgs   | out                                 |

All engines that ran flagged the **identical 79-file set** — mutual validation of the walk + type-only exclusion.

## Runtime + footprint (post-install, median of ≥5 runs)

| Config             | warm    | cold e2e    | new deps    |
| ------------------ | ------- | ----------- | ----------- |
| TS compiler API    | ~92 ms  | ~377 ms     | 0           |
| dependency-cruiser | ~467 ms | ~995 ms     | ~20 / ~8 MB |
| tsgo (CLI trace)   | —       | ~108–248 ms | 0           |

The naive TS `createProgram` variant balloons post-install (parses `node_modules` `.d.ts`) unless a bare-specifier cutoff is added. The shipped implementation avoids this entirely: per-file `ts.createSourceFile` + never resolving bare specifiers, so it never touches `node_modules`.

## oxlint plugin-context probe

In a single oxlint 1.39 run, `import/no-cycle` (proving the multi-file graph is live — it emitted a cycle chain) ran alongside a context-dump plugin; the plugin `context` gained zero graph/module/resolver keys. The full `import/*` rule catalog has only `no-cycle` consuming the graph (no reachability-to-target rule). Confirms oxlint cannot carry this without re-walking the tree in a plugin (the anti-goal).

## `#mr` lock-branch end-to-end

With no override map, a fixture `.genie.ts` importing `#mr/<member>/mod.ts` against a fixture `megarepo.lock` + store worktree resolved through `resolveLocalMegarepoMemberRootSync → deriveStoreWorktreePath` and the reach-to-`effect` was detected with the chain. Proves the injected genie resolver drives the walk (not delegated on faith).

## Megarepo-wide `#mr` usage (why the shared checker must resolve `#mr`)

effect-utils is the genie hub; downstream members import its building blocks by `#mr/effect-utils/...`. A survey across the downstream megarepo members found roughly three dozen real `.genie.ts`/helper sources using `#mr/effect-utils/...` (effect-utils itself: 0, because it is the source). This is why `#mr`-by-function-injection is the decisive engine requirement and rules out tsgo/oxlint for a shared check.
