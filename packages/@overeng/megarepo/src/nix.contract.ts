/**
 * SEAM member contract for the `nix.*` telemetry namespace (decision 0005) — the foreign-namespace
 * catalog for megarepo's nix flake-metadata / nix-lock spans, authored via the Layer-2
 * `@overeng/otel-contract/registry` surface. This is the single home for the `nix.*` attribute
 * catalog: the Weaver registry projection derives from it, and megarepo's runtime nix bridges
 * (`src/lib/observability.ts`) rebuild from the IMPORTED schemas below (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (megarepo has no dependency-free zone; `lib/observability.ts` already imports
 * `@overeng/otel-contract` at runtime, so this file's `./registry` import is runtime-safe).
 *
 * ATTRS-ONLY MEMBER (no `signals`). Every `nix.*` key reaches telemetry through a nix bridge span
 * whose name is either static (`fetchNixFlakeMetadata`, `megarepo/nix-lock/file`) or DYNAMIC
 * (`withNixLockPathSpan`/`withNixLockPathTypeSpan` take a runtime `name`) — none of which the
 * migration promotes to a single-signal projection (kept uniform with the restate mirror, SC-DQ5).
 * So every key reaches the registry via `docOnlyAttributes` for completeness (SC-R13), and the
 * runtime bridges stay legacy inline in `observability.ts`, rebuilt from the IMPORTED catalog schemas
 * below (identical encode — proven by the colocated equivalence property test).
 *
 * NOTE: `nix.lock.path` is the SAME concept in two bridges (`megarepo/nix-lock/file` and the nested
 * single-lock-file span), so it is catalogued ONCE here and referenced from both rebuilt bundles.
 */
import { attr, defineOtelContract } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the nix.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- flake metadata --
/** Flake owner (git host org/user) a `nix flake metadata` fetch targets. */
export const NixFlakeOwner = attr.string({
  key: 'nix.flake.owner',
  cardinality: 'high',
  brief: 'Flake owner (git host org/user) a `nix flake metadata` fetch targets.',
  stability: 'development',
  examples: ['overengineeringstudio'],
})

/** Flake repository a `nix flake metadata` fetch targets. */
export const NixFlakeRepo = attr.string({
  key: 'nix.flake.repo',
  cardinality: 'high',
  brief: 'Flake repository a `nix flake metadata` fetch targets.',
  stability: 'development',
  examples: ['effect-utils'],
})

/** Resolved flake revision a `nix flake metadata` fetch pinned. */
export const NixFlakeRev = attr.string({
  key: 'nix.flake.rev',
  cardinality: 'high',
  brief: 'Resolved flake revision a `nix flake metadata` fetch pinned.',
  stability: 'development',
  examples: ['a3c1b6323f0e'],
})

// -- nix lock file (the lock file's own path/type) --
/** Path of a nix lock file a span processes (also the nested single-lock-file span). */
export const NixLockPath = attr.string({
  key: 'nix.lock.path',
  cardinality: 'high',
  brief: 'Path of a nix lock file a span processes.',
  stability: 'development',
  examples: ['/home/user/project/flake.lock'],
})

/** Kind of a nix lock file a span processes. */
export const NixLockType = attr.string({
  key: 'nix.lock.type',
  cardinality: 'bounded',
  brief: 'Kind of a nix lock file a span processes.',
  stability: 'development',
  examples: ['flake', 'devenv'],
})

// -- nix-lock sync over a source file (flake.nix / devenv.yaml) --
/** Path of a synced source file (flake.nix / devenv.yaml) a nix-lock span operates on. */
export const NixLockSourcePath = attr.string({
  key: 'nix.lock.source_path',
  cardinality: 'high',
  brief: 'Path of a synced source file (flake.nix / devenv.yaml) a nix-lock span operates on.',
  stability: 'development',
  examples: ['/home/user/project/flake.nix'],
})

/** Kind of a synced source file a nix-lock span operates on. */
export const NixLockSourceType = attr.string({
  key: 'nix.lock.source_type',
  cardinality: 'bounded',
  brief: 'Kind of a synced source file a nix-lock span operates on.',
  stability: 'development',
  examples: ['flake', 'devenv'],
})

// ---------------------------------------------------------------------------
// contract seam (namespace `nix`, derived). Attrs-only member — see file docstring.
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/megarepo',
  displayName: 'Nix Attributes',
  // No `signals`: every nix.* key reaches telemetry via a nix bridge span (static or dynamic-name)
  // with no single-signal projection under this migration. Keys reach the catalog via
  // `docOnlyAttributes` (SC-R13).
  signals: [],
  docOnlyAttributes: [
    NixFlakeOwner,
    NixFlakeRepo,
    NixFlakeRev,
    NixLockPath,
    NixLockType,
    NixLockSourcePath,
    NixLockSourceType,
  ],
})
