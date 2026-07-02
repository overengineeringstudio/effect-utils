/**
 * Root aggregator (design-time) for the first-party OTel semantic-convention registry.
 *
 * Imports every member seam contract, projects each to a Layer-1 fragment (via
 * `@overeng/otel-contract` `./registry`), and composes them into ONE Weaver registry (via
 * `@overeng/genie` `./composition`, which enforces namespace uniqueness + global ref
 * integrity). Computes the provenance fingerprints HERE — `node:crypto` is available at
 * design time; genie's dep-free Layer 1 never hashes.
 *
 * This module is imported by the sibling `*.genie.ts` emitters; the genie engine renders one
 * output file per emitter (manifest / signals / per-namespace attributes / TS + Rust
 * constants). It is deliberately NOT a `.genie.ts` (it emits nothing itself).
 *
 * NOTE: `@overeng/otel-contract` cannot import `@overeng/genie` (genie depends on it — a
 * project-reference cycle), so the two `RegistryFragment` type mirrors meet HERE; this
 * module's typecheck is the drift guard between them.
 */
import { createHash } from 'node:crypto'

import genieContract from '../packages/@overeng/genie/src/core/genie.contract.ts'
import { registryFromMembers } from '../packages/@overeng/genie/src/runtime/composition/mod.ts'
import type { Provenance } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import megarepoContract from '../packages/@overeng/megarepo/src/megarepo.contract.ts'
import notionMdContract from '../packages/@overeng/notion-md/src/notion-md.contract.ts'
import demoContract from '../packages/@overeng/otel-contract/src/registry-demo.contract.ts'
import { fragment } from '../packages/@overeng/otel-contract/src/registry.ts'

// --- pinned semantic inputs (all change the emitted output → part of the fingerprint) ---
export const PINNED_WEAVER_VERSION = '0.24.2'
export const PINNED_UPSTREAM_SEMCONV_VERSION = 'v1.37.0'
/** Bump when the emitter's output shape changes (independent of the authored registry). */
export const GENERATOR_VERSION = '1'

/**
 * The member seam files composed into this registry. The no-orphan-seam check (a colocated
 * test) globs every `*.contract.ts` on disk and asserts each appears here — the completeness
 * guarantee the path-based lint structurally cannot provide (decision 0005).
 */
export const memberSeamPaths = [
  'packages/@overeng/genie/src/core/genie.contract.ts',
  'packages/@overeng/megarepo/src/megarepo.contract.ts',
  'packages/@overeng/notion-md/src/notion-md.contract.ts',
  'packages/@overeng/otel-contract/src/registry-demo.contract.ts',
] as const

const contracts = [genieContract, megarepoContract, notionMdContract, demoContract]

// Build members: each member contributes its fragment on the non-emitted `meta.registry`
// channel (a minimal GenieOutput — no per-member slice is emitted for M1).
const members = contracts.map((c) => {
  const f = fragment(c)
  return { data: f, stringify: () => '', meta: { registry: f } }
})

const composition = registryFromMembers({
  members,
  name: 'acme-effect-utils',
  description: 'First-party OpenTelemetry semantic-convention registry (effect-utils).',
  schemaUrl: 'https://opentelemetry.io/schemas/acme/0.1.0',
  upstream: [
    {
      // Pinned upstream OTel semconv. weaver resolves `http.*` refs against this dependency.
      // The `weaver:check` task materializes it hermetically as a local FS path (SC-A03,
      // confirmed working with 0.24.2). The committed string is the portable git-URL form.
      dependency: {
        name: 'otel',
        registry_path: `https://github.com/open-telemetry/semantic-conventions.git@${PINNED_UPSTREAM_SEMCONV_VERSION}[model]`,
      },
      providesNamespaces: ['http'],
    },
  ],
})

export const registry = composition.registry
export const compositionIssues = composition.issues

// --- provenance fingerprints (GEN-R07), split so doc-only edits don't churn const targets ---
const sha256 = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

const versionInputs = {
  weaver: PINNED_WEAVER_VERSION,
  upstream: PINNED_UPSTREAM_SEMCONV_VERSION,
  generator: GENERATOR_VERSION,
}

/** Identity = only the attribute keys the TS/Rust const targets encode (no doc prose). */
const identityKeys = registry.groups
  .flatMap((g) => g.attributes.map((a) => a.id))
  .toSorted((a, b) => a.localeCompare(b))

/** Doc fingerprint: the FULL registry (brief/stability/examples/notes/deprecated) → YAML headers. */
export const docFingerprint = sha256({ registry, ...versionInputs })
/** Identity fingerprint: keys only → TS/Rust const headers (a prose edit must not churn these). */
export const identityFingerprint = sha256({ keys: identityKeys, ...versionInputs })

export const REGISTRY_SOURCE = 'weaver-registry/registry.ts'
export const docProvenance: Provenance = { source: REGISTRY_SOURCE, fingerprint: docFingerprint }
export const identityProvenance: Provenance = {
  source: REGISTRY_SOURCE,
  fingerprint: identityFingerprint,
}

/**
 * Rust identity = the exact names the Rust const target encodes: attribute keys PLUS span ids
 * PLUS metric names (a Rust telemetry producer needs signal-name consts too). Kept SEPARATE
 * from {@link identityFingerprint} (attr-keys-only, for the TS `constants.ts`) so a span/metric
 * rename re-hashes the `.rs` without churning `constants.ts`, and a doc-only edit churns neither
 * (GEN-R07 §fingerprint granularity).
 */
const rustIdentityNames = {
  attributeKeys: identityKeys,
  spanIds: registry.signals
    .filter((s) => s.kind === 'span')
    .map((s) => s.id)
    .toSorted((a, b) => a.localeCompare(b)),
  metricNames: registry.signals
    .filter(
      (s): s is Extract<(typeof registry.signals)[number], { kind: 'metric' }> =>
        s.kind === 'metric',
    )
    .map((s) => s.metric_name)
    .toSorted((a, b) => a.localeCompare(b)),
}
export const rustIdentityFingerprint = sha256({ ...rustIdentityNames, ...versionInputs })
export const rustProvenance: Provenance = {
  source: REGISTRY_SOURCE,
  fingerprint: rustIdentityFingerprint,
}

/** The own namespaces, each emitted as `<ns>.attributes.yaml` (M3 adds `genie` next to `acme`). */
export const namespaces = registry.groups.map((g) => g.namespace)
