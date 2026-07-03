/**
 * SEAM member contract for the `cli.*` telemetry namespace (decision 0005) — the foreign-namespace
 * catalog for genie's `cli.mode` root span, authored via the Layer-2 `@overeng/otel-contract/registry`
 * surface. This is the single home for the `cli.*` attribute catalog: the Weaver registry projection
 * derives from it, and genie's runtime `cli.mode` bridge encoder (`src/core/observability.ts`)
 * rebuilds from the IMPORTED schema below (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/core/` (NOT `src/runtime/`). `src/runtime/**` is genie's dependency-free zone
 * (`overeng/no-external-imports` = error); this file imports `@overeng/otel-contract`, so it lives
 * beside `genie.contract.ts` / `observability.ts`, which already import otel-contract.
 *
 * ATTRS-ONLY MEMBER (no `signals`). The only `cli.*` key reaches telemetry through the DYNAMIC-NAME
 * bridge span `genie/<cliMode>` (the span name varies by CLI mode), which has no stable single-signal
 * registry projection (SC-DQ5, mirroring restate's dynamic bridges). So the catalog key reaches the
 * registry via `docOnlyAttributes` for completeness (SC-R13), and the runtime bridge stays legacy
 * inline in `observability.ts`, rebuilt from the IMPORTED catalog schema below (identical encode —
 * proven by the colocated equivalence property test).
 */
import { attr, defineOtelContract } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the cli.* catalog SSOT)
// ---------------------------------------------------------------------------

/** CLI mode a genie invocation runs in (also the dynamic `genie/<cliMode>` span-name suffix). */
export const CliMode = attr.string({
  key: 'cli.mode',
  cardinality: 'bounded',
  brief: 'CLI mode a genie invocation runs in (the dynamic `genie/<cliMode>` span-name suffix).',
  stability: 'development',
  examples: ['generate', 'check', 'watch', 'dry-run'],
})

// ---------------------------------------------------------------------------
// contract seam (namespace `cli`, derived). Attrs-only member — see file docstring.
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/genie',
  displayName: 'CLI Attributes',
  // No `signals`: `cli.mode` reaches telemetry only via the DYNAMIC-NAME bridge span
  // `genie/<cliMode>`, which has no stable single-signal projection. The key reaches the catalog
  // via `docOnlyAttributes` (SC-R13).
  signals: [],
  docOnlyAttributes: [CliMode],
})
