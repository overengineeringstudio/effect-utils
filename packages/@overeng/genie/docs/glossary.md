# Genie Glossary

Canonical terms for the `@overeng/genie` subsystem. Generator-specific terms live in [generators/glossary.md](./generators/glossary.md).

- **Bootstrap** — the phase in which Genie runs before package-manager install state exists (fresh checkout / CI), when `node_modules` and generated workspace state may be absent. See requirements R05–R07.
- **Bootstrap-safe import closure** — the set of modules transitively reachable at runtime from a `.genie.ts` source, all of which must be importable during bootstrap. A `.genie.ts` satisfies the contract when its entire closure is bootstrap-safe (R06).
- **Runtime-only package** — a package whose value imports require an installed dependency graph and so is unavailable during bootstrap (e.g. `effect`, `@effect/platform`, `typescript`). A generator closure must not reach one.
- **Closure boundary** — a bare specifier (non-relative, non-`#`/`#mr`, non-node-builtin) encountered while walking a closure. It is the reported violation, not an edge to follow, so the walk never descends into `node_modules`.
- **Type-only edge** — an import/export erased at compile time (`import type`, `export type`, `export type *`, or a fully per-specifier `{ type X }` list). Excluded from the runtime closure because it does not exist at runtime.
- **`#mr/<member>/...`** — a megarepo member import resolved against `megarepo.lock` to the member's global store worktree (lock-pinned identity), rather than a bare package name or a `repos/` symlink. The bootstrap-safe way for a generator to reach another member's source. See spec _Import Resolution_.
- **Baseline + ratchet** — the enforcement mode for the bootstrap-closure check: pre-existing violations are captured in a committed baseline so the gate is green today; only new violations fail, and the baseline is expected to shrink as violations are fixed.
