/**
 * SEAM member contract for the `ci_tools.*` telemetry namespace (decision 0005) — ci-tools' OWN
 * deploy observability catalog, authored via the Layer-2 `@overeng/otel-contract/registry` surface.
 * This is the single home for the `ci_tools.deploy.*` catalog + signals: the Weaver registry
 * projection AND the runtime encoders (`src/deploy-domain.ts`, `src/deploy-vercel.ts`,
 * `src/deploy-netlify.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (ci-tools has no dependency-free zone; `deploy-domain.ts` already imports
 * `@overeng/otel-contract` at runtime, so this file's `./registry` import is runtime-safe).
 *
 * SCOPE — `ci_tools` namespace only. All keys are already namespaced `ci_tools.deploy.*` (NO
 * bare-key renames). Every operation is a STATIC-name span whose label extractor reads a catalog
 * attribute directly (no separate span-label field), mirroring notion's operations.
 *
 * ROOT FLAG (BEHAVIOR NOTE). The pre-migration `DeployOperation` was authored with `root: true`. The
 * Layer-2 `operation()` DSL derives root at the CALL SITE via `.withRoot` (as megarepo/genie do), not
 * in the definition, so the migrated `DeployOperation` reports `metadata.root === false`. This is
 * UNOBSERVABLE: `DeployOperation` has NO runtime call site (only `encodeSync` in a unit test, which
 * root does not affect), and `encodeSync` output is byte-identical (proven by the equivalence test).
 *
 * DOC-ONLY. `ci_tools.deploy.operation` is carried only by the parallel `DeploySpanAttributes` record
 * schema in `deploy-domain.ts` (a plain typed attribute record, not an OTel encoder), never by a span
 * signal — so it reaches the catalog via `docOnlyAttributes` (SC-R13 completeness).
 */
import {
  attr,
  defineOtelContract,
  operation,
  recommended,
  required,
} from '@overeng/otel-contract/registry'

/** Span labels are capped at 40 chars (mirrors `deploy-domain.ts`). */
const shortSpanLabel = (value: string): string => value.slice(0, 40)

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the ci_tools.deploy.* catalog SSOT)
// ---------------------------------------------------------------------------

/** Deploy provider a run targets. */
export const DeployProvider = attr.enum({
  key: 'ci_tools.deploy.provider',
  values: ['netlify', 'vercel'],
  briefs: { netlify: 'Netlify.', vercel: 'Vercel.' },
  brief: 'Deploy provider a run targets.',
  stability: 'development',
})

/** Deploy target (app/site name). */
export const DeployTarget = attr.string({
  key: 'ci_tools.deploy.target',
  cardinality: 'bounded',
  brief: 'Deploy target (app/site name).',
  stability: 'development',
  examples: ['effect-react', 'docs'],
})

/** Deploy mode (production vs. preview flavor). */
export const DeployMode = attr.enum({
  key: 'ci_tools.deploy.mode',
  values: ['prod', 'pr', 'draft', 'preview'],
  briefs: {
    prod: 'Production deploy.',
    pr: 'Pull-request preview deploy.',
    draft: 'Draft deploy.',
    preview: 'Preview deploy.',
  },
  brief: 'Deploy mode (production vs. preview flavor).',
  stability: 'development',
})

/** CI run id owning a deploy. */
export const DeployRunId = attr.string({
  key: 'ci_tools.deploy.run_id',
  cardinality: 'high',
  brief: 'CI run id owning a deploy.',
  stability: 'development',
  examples: ['run-123', '18234567890'],
})

/** Which sub-operation of the deploy pipeline a span/record represents. */
export const DeployOperationKind = attr.enum({
  key: 'ci_tools.deploy.operation',
  values: ['core', 'provider', 'attempt', 'verify', 'cleanup'],
  briefs: {
    core: 'The enclosing deploy.',
    provider: 'A provider deploy command.',
    attempt: 'One deploy attempt.',
    verify: 'Post-deploy verification.',
    cleanup: 'Preview cleanup.',
  },
  brief: 'Which sub-operation of the deploy pipeline a span/record represents.',
  stability: 'development',
})

/** 1-based deploy attempt number. */
export const DeployAttempt = attr.number({
  key: 'ci_tools.deploy.attempt',
  weaverType: 'int',
  cardinality: 'bounded',
  brief: '1-based deploy attempt number.',
  stability: 'development',
  examples: [1, 2],
})

/** Terminal status of a deploy sub-operation. */
export const DeployStatus = attr.enum({
  key: 'ci_tools.deploy.status',
  values: ['success', 'failure', 'skipped'],
  briefs: { success: 'Succeeded.', failure: 'Failed.', skipped: 'Skipped.' },
  brief: 'Terminal status of a deploy sub-operation.',
  stability: 'development',
})

/** Tagged error kind when a deploy sub-operation fails (bounded — never free text). */
export const DeployErrorKind = attr.string({
  key: 'ci_tools.deploy.error_kind',
  cardinality: 'bounded',
  brief: 'Tagged error kind when a deploy sub-operation fails (bounded — never free text).',
  stability: 'development',
  examples: ['ProviderOperationFailed', 'VerificationFailed'],
})

/** Identifier of the preview being cleaned up. */
export const DeployCleanupId = attr.string({
  key: 'ci_tools.deploy.cleanup_id',
  cardinality: 'high',
  brief: 'Identifier of the preview being cleaned up.',
  stability: 'development',
  examples: ['effect-react-pr-42'],
})

/** Outcome of a preview cleanup. */
export const DeployCleanupStatus = attr.enum({
  key: 'ci_tools.deploy.cleanup_status',
  values: ['succeeded', 'failed', 'skipped'],
  briefs: { succeeded: 'Cleaned up.', failed: 'Cleanup failed.', skipped: 'Nothing to clean up.' },
  brief: 'Outcome of a preview cleanup.',
  stability: 'development',
})

/** Host of the final deploy URL (host only — never the full URL). */
export const DeployUrlHost = attr.string({
  key: 'ci_tools.deploy.url_host',
  cardinality: 'bounded',
  brief: 'Host of the final deploy URL (host only — never the full URL).',
  stability: 'development',
  examples: ['preview.example.netlify.app'],
})

// ---------------------------------------------------------------------------
// signals (operations: static-name spans; label extractor reads a catalog attr)
// ---------------------------------------------------------------------------

/** `ci-tools.deploy` — the enclosing deploy (applied as a ROOT span at runtime via `.withRoot`). */
export const DeployOperation = operation({
  id: 'span.ci_tools.deploy',
  name: 'ci-tools.deploy',
  brief: 'The enclosing deploy.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    provider: required(DeployProvider),
    target: required(DeployTarget),
    mode: required(DeployMode),
    runId: recommended(DeployRunId),
  },
  label: (v: { target: string }) => shortSpanLabel(v.target),
})

/** `ci-tools.deploy.provider` — a provider deploy command. */
export const DeployProviderOperation = operation({
  id: 'span.ci_tools.deploy_provider',
  name: 'ci-tools.deploy.provider',
  brief: 'A provider deploy command.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    provider: required(DeployProvider),
    target: required(DeployTarget),
  },
  label: (v: { provider: string }) => v.provider,
})

/** `ci-tools.deploy.attempt` — one deploy attempt. */
export const DeployAttemptOperation = operation({
  id: 'span.ci_tools.deploy_attempt',
  name: 'ci-tools.deploy.attempt',
  brief: 'One deploy attempt.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    provider: required(DeployProvider),
    target: required(DeployTarget),
    mode: required(DeployMode),
    attempt: required(DeployAttempt),
    status: required(DeployStatus),
    errorKind: recommended(DeployErrorKind),
  },
  label: (v: { attempt: number }) => String(v.attempt),
})

/** `ci-tools.deploy.verify` — post-deploy verification. */
export const DeployVerifyOperation = operation({
  id: 'span.ci_tools.deploy_verify',
  name: 'ci-tools.deploy.verify',
  brief: 'Post-deploy verification.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    provider: required(DeployProvider),
    target: required(DeployTarget),
    status: required(DeployStatus),
    urlHost: required(DeployUrlHost),
    errorKind: recommended(DeployErrorKind),
  },
  label: (v: { urlHost: string }) => shortSpanLabel(v.urlHost),
})

/** `ci-tools.deploy.cleanup` — preview cleanup. */
export const DeployCleanupOperation = operation({
  id: 'span.ci_tools.deploy_cleanup',
  name: 'ci-tools.deploy.cleanup',
  brief: 'Preview cleanup.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    provider: required(DeployProvider),
    target: required(DeployTarget),
    cleanupId: recommended(DeployCleanupId),
    cleanupStatus: required(DeployCleanupStatus),
  },
  label: (v: { cleanupId?: string; cleanupStatus: string }) =>
    shortSpanLabel(v.cleanupId ?? v.cleanupStatus),
})

// ---------------------------------------------------------------------------
// contract seam (namespace `ci_tools`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/ci-tools',
  displayName: 'CI Tools Deploy Attributes',
  signals: [
    DeployOperation,
    DeployProviderOperation,
    DeployAttemptOperation,
    DeployVerifyOperation,
    DeployCleanupOperation,
  ],
  // `ci_tools.deploy.operation` is carried only by the parallel `DeploySpanAttributes` record schema
  // in `deploy-domain.ts`, never by a span signal — catalog completeness (SC-R13).
  docOnlyAttributes: [DeployOperationKind],
})
