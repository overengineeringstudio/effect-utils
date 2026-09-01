/**
 * SEAM member contract for the `git.*` telemetry namespace (decision 0005) — the foreign-namespace
 * catalog for megarepo's git-subprocess/git-operation spans, authored via the Layer-2
 * `@overeng/otel-contract/registry` surface. This is the single home for the `git.*` attribute
 * catalog: the Weaver registry projection derives from it, and megarepo's runtime git bridges
 * (`src/core/observability.ts`) rebuild from the IMPORTED schemas below (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (megarepo has no dependency-free zone; `core/observability.ts` already imports
 * `@overeng/otel-contract` at runtime, so this file's `./registry` import is runtime-safe).
 *
 * ATTRS-ONLY MEMBER (no `signals`). Every `git.*` key reaches telemetry through a git bridge span
 * whose name is either DYNAMIC (`withGitUrlSpan`/`withGitBranchSpan`/`withGitCommitSpan` take a
 * runtime `name`), an annotate-only bundle (`git.output.*`), or the static `git/cmd` span — none of
 * which the migration promotes to a single-signal projection (kept uniform with the restate mirror,
 * SC-DQ5). So every key reaches the registry via `docOnlyAttributes` for completeness (SC-R13), and
 * the runtime bridges stay legacy inline in `observability.ts`, rebuilt from the IMPORTED catalog
 * schemas below (identical encode — proven by the colocated equivalence property test).
 *
 * NOTE: megarepo ALSO instruments a few `git/*`-named spans that carry `megarepo.*` keys
 * (`git/delete-branch`, `git/detach-worktree-head`) — those belong to the `megarepo` namespace and
 * live in `megarepo.contract.ts`, not here. This contract owns only keys under the `git.*` namespace.
 */
import { attr, defineOtelContract } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the git.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- git/cmd (per-subprocess span) --
/** git subcommand a subprocess runs (the first CLI arg, e.g. `status`). */
export const GitSubcommand = attr.string({
  key: 'git.subcommand',
  cardinality: 'bounded',
  brief: 'git subcommand a subprocess runs (the first CLI arg).',
  stability: 'development',
  examples: ['status', 'fetch', 'worktree'],
})

/** Whether the git subprocess output was streamed (vs buffered). */
export const GitStreamed = attr.boolean({
  key: 'git.streamed',
  brief: 'Whether the git subprocess output was streamed (vs buffered).',
  stability: 'development',
})

/** Configured timeout (milliseconds) for a git subprocess. */
export const GitTimeoutMs = attr.number({
  key: 'git.timeout_ms',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured timeout (milliseconds) for a git subprocess.',
  stability: 'development',
  examples: [30000, 600000],
})

/** Total output size (bytes) a git subprocess produced. */
export const GitOutputBytes = attr.number({
  key: 'git.output.bytes',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Total output size (bytes) a git subprocess produced.',
  stability: 'development',
  examples: [0, 4096],
})

/** Total number of output lines a git subprocess produced. */
export const GitOutputLines = attr.number({
  key: 'git.output.lines',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Total number of output lines a git subprocess produced.',
  stability: 'development',
  examples: [0, 42],
})

// -- git remote / ref operations --
/** Remote URL a git operation targets. */
export const GitUrl = attr.string({
  key: 'git.url',
  cardinality: 'high',
  brief: 'Remote URL a git operation targets.',
  stability: 'development',
  examples: ['https://github.com/org/repo.git'],
})

/** Whether the git operation targets a bare repository. */
export const GitBare = attr.boolean({
  key: 'git.bare',
  brief: 'Whether the git operation targets a bare repository.',
  stability: 'development',
})

/** Git branch name a git operation acts on. */
export const GitBranch = attr.string({
  key: 'git.branch',
  cardinality: 'high',
  brief: 'Git branch name a git operation acts on.',
  stability: 'development',
  examples: ['main', 'schickling/feature'],
})

/** Resolved commit sha a git operation acts on. */
export const GitCommit = attr.string({
  key: 'git.commit',
  cardinality: 'high',
  brief: 'Resolved commit sha a git operation acts on.',
  stability: 'development',
  examples: ['a3c1b6323f0e'],
})

// ---------------------------------------------------------------------------
// contract seam (namespace `git`, derived). Attrs-only member — see file docstring.
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/megarepo',
  displayName: 'Git Attributes',
  // No `signals`: every git.* key reaches telemetry via a git bridge span (dynamic-name /
  // annotate-only / static `git/cmd`) with no single-signal projection under this migration. Keys
  // reach the catalog via `docOnlyAttributes` (SC-R13).
  signals: [],
  docOnlyAttributes: [
    GitSubcommand,
    GitStreamed,
    GitTimeoutMs,
    GitOutputBytes,
    GitOutputLines,
    GitUrl,
    GitBare,
    GitBranch,
    GitCommit,
  ],
})
