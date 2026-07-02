/**
 * LAYER 1 — Weaver foundation (dep-free): a direct, faithful, UNOPINIONATED typed model of
 * the OTel Weaver `groups:` registry, plus deterministic renderers.
 *
 * This is genie's `semantic-conventions` generator Layer 1 (GEN-R01): a complete, typed 1:1
 * model of Weaver's own vocabulary that projects deterministically to output. It is
 * STANDALONE (usable without Layer 2), and dependency-light: no `effect`, no `node:*`. It
 * reuses genie's own dep-free YAML stringifier (`../utils/yaml.ts`) rather than the `yaml`
 * npm package the feasibility prototype used, so it stays inside genie's runtime dep ban
 * (see `docs/spec.md` §runtime-vs-build).
 *
 * Layer 2 (`@overeng/otel-contract` `./registry`) projects DOWN to these types; the genie
 * engine renders one file per `.genie.ts` (manifest / signals / per-namespace attributes /
 * TS constants). Provenance fingerprints are computed in the design-time layer (where
 * `node:crypto` is available) and passed in as strings — Layer 1 never hashes.
 */
import type { GenieOutput } from '../core.ts'
import { createGenieOutput } from '../core.ts'
import { stringify as yamlStringify } from '../utils/yaml.ts'

// ---------------------------------------------------------------------------
// Weaver vocabulary — plain typed data (the canonical model; Layer 2 mirrors these).
// ---------------------------------------------------------------------------

export type Stability = 'stable' | 'development'
export type Cardinality = 'low' | 'bounded' | 'high'
export type Encode = 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'drop' | 'redacted'

export type EnumMember = {
  readonly id: string
  readonly value: string | number
  readonly brief?: string
  readonly stability?: Stability
}

export type WeaverType =
  | 'string'
  | 'int'
  | 'double'
  | 'boolean'
  | 'string[]'
  | 'int[]'
  | 'boolean[]'
  | { readonly members: ReadonlyArray<EnumMember> }
  | `template[${string}]`

/** weaver 0.23+ STRUCTURED deprecation (the string form was removed). */
export type Deprecated =
  | { readonly reason: 'renamed'; readonly renamed_to: string }
  | { readonly reason: 'obsoleted' | 'uncategorized'; readonly note: string }

export type RequirementLevel =
  | 'required'
  | 'recommended'
  | 'opt_in'
  | { readonly conditionally_required: string }
  | { readonly recommended: string }

/**
 * The `bridge:` annotation (decision 0004) — an emission fact driving a central-collector OTTL
 * dual-emit config for a renamed metric label. Non-normative to Weaver; carried as an
 * annotation.
 */
export type Bridge = {
  readonly context: 'datapoint' | 'resource'
  readonly scope_metrics: ReadonlyArray<string>
}

export type AttrDef = {
  readonly id: string
  readonly type: WeaverType
  readonly brief: string
  readonly stability: Stability
  readonly examples?: ReadonlyArray<string | number | boolean>
  readonly note?: string
  readonly deprecated?: Deprecated
  /** machine-readable policy annotations (non-normative to upstream weaver). */
  readonly policy?: { readonly cardinality?: Cardinality; readonly encode?: Encode }
  readonly bridge?: Bridge
}

export type AttrRef = {
  readonly ref: string
  readonly requirement_level?: RequirementLevel
  readonly note?: string
  readonly sampling_relevant?: boolean
}

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer'
export type Instrument = 'counter' | 'updowncounter' | 'gauge' | 'histogram'

export type SignalDef =
  | {
      readonly kind: 'span'
      readonly id: string
      readonly span_kind: SpanKind
      readonly brief: string
      readonly stability: Stability
      readonly attributes: ReadonlyArray<AttrRef>
    }
  | {
      readonly kind: 'metric'
      readonly id: string
      readonly metric_name: string
      readonly instrument: Instrument
      readonly unit: string
      readonly brief: string
      readonly stability: Stability
      readonly attributes: ReadonlyArray<AttrRef>
    }

export type AttributeGroup = {
  readonly namespace: string
  readonly displayName: string
  readonly attributes: ReadonlyArray<AttrDef>
}

export type Dependency = { readonly name: string; readonly registry_path: string }

export type Registry = {
  readonly name: string
  readonly description: string
  readonly schemaUrl: string
  readonly dependencies: ReadonlyArray<Dependency>
  readonly groups: ReadonlyArray<AttributeGroup>
  readonly signals: ReadonlyArray<SignalDef>
}

/**
 * One member's slice, produced by Layer 2's projector (`@overeng/otel-contract` `./registry`).
 * Layer 2 re-declares a structurally-identical type (it cannot import genie — that would be a
 * project-reference cycle since genie depends on otel-contract); the root aggregator's
 * typecheck is the drift guard.
 */
export type RegistryFragment = {
  readonly namespace: string
  readonly memberPath: string
  readonly displayName: string
  readonly attributes: ReadonlyArray<AttrDef>
  /** refs to OTHER namespaces (cross-member / upstream) — carried for aggregation integrity. */
  readonly foreignRefs: ReadonlyArray<string>
  readonly signals: ReadonlyArray<SignalDef>
}

// ---------------------------------------------------------------------------
// Structured (JS object) projection — the intermediate the YAML encoder serializes.
// Building plain objects (not strings) is what avoids the nesting bugs the prototype hit.
// ---------------------------------------------------------------------------

const POLICY_ANNOTATION_NS = 'overeng_policy'

const attrDefToObject = (a: AttrDef): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: a.id,
    type:
      typeof a.type === 'object'
        ? {
            members: a.type.members.map((m) => ({
              id: m.id,
              value: m.value,
              ...(m.brief !== undefined ? { brief: m.brief } : {}),
              // weaver 0.24.2 REQUIRES `stability` on every enum member; default to the attr's.
              stability: m.stability ?? a.stability,
            })),
          }
        : a.type,
    stability: a.stability,
    brief: a.brief,
  }
  if (a.note !== undefined) out['note'] = a.note
  if (a.examples !== undefined && a.examples.length > 0) out['examples'] = [...a.examples]
  if (a.deprecated !== undefined) out['deprecated'] = { ...a.deprecated }
  const annotations: Record<string, unknown> = {}
  if (a.policy?.cardinality !== undefined || a.policy?.encode !== undefined) {
    annotations[POLICY_ANNOTATION_NS] = {
      ...(a.policy.cardinality !== undefined ? { cardinality: a.policy.cardinality } : {}),
      ...(a.policy.encode !== undefined ? { encode: a.policy.encode } : {}),
    }
  }
  if (a.bridge !== undefined) {
    annotations['bridge'] = {
      context: a.bridge.context,
      scope_metrics: [...a.bridge.scope_metrics],
    }
  }
  if (Object.keys(annotations).length > 0) out['annotations'] = annotations
  return out
}

const attrRefToObject = (r: AttrRef): Record<string, unknown> => {
  const out: Record<string, unknown> = { ref: r.ref }
  if (r.requirement_level !== undefined) {
    out['requirement_level'] =
      typeof r.requirement_level === 'string' ? r.requirement_level : { ...r.requirement_level }
  }
  if (r.sampling_relevant !== undefined) out['sampling_relevant'] = r.sampling_relevant
  if (r.note !== undefined) out['note'] = r.note
  return out
}

const byId = <T extends { id: string }>(xs: ReadonlyArray<T>): ReadonlyArray<T> =>
  xs.toSorted((a, b) => a.id.localeCompare(b.id))

const attributeGroupToObject = (g: AttributeGroup): Record<string, unknown> => ({
  id: `registry.${g.namespace}`,
  type: 'attribute_group',
  display_name: g.displayName,
  brief: `Attributes for the ${g.namespace} namespace.`,
  attributes: byId(g.attributes).map(attrDefToObject),
})

const signalToObject = (sig: SignalDef): Record<string, unknown> => {
  const base: Record<string, unknown> = { id: sig.id, type: sig.kind }
  if (sig.kind === 'span') base['span_kind'] = sig.span_kind
  if (sig.kind === 'metric') {
    base['metric_name'] = sig.metric_name
    base['instrument'] = sig.instrument
    base['unit'] = sig.unit
  }
  base['stability'] = sig.stability
  base['brief'] = sig.brief
  base['attributes'] = sig.attributes.map(attrRefToObject)
  return base
}

// ---------------------------------------------------------------------------
// Provenance (GEN-R07). The engine adds the `# Generated / # Source:` banner; we add the
// input fingerprint + source path below it. The fingerprint is computed in the design-time
// layer and passed in (Layer 1 stays node-free — no `node:crypto`).
// ---------------------------------------------------------------------------

export type Provenance = {
  /** repo-relative path to the authored registry source (the aggregator module). */
  readonly source: string
  /** `sha256:<hex>` over ALL semantic inputs relevant to THIS output (see fingerprint split). */
  readonly fingerprint: string
}

const provenanceComment = ({
  provenance,
  prefix,
}: {
  provenance: Provenance
  prefix: '#' | '//'
}): string =>
  [
    `${prefix} registry-source: ${provenance.source}`,
    `${prefix} fingerprint: ${provenance.fingerprint}`,
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// Renderers (deterministic, pure): one function per target file. Each takes the model plus the
// per-output {@link Provenance} (object args per the repo's named-args convention).
// ---------------------------------------------------------------------------

/** Weaver registry `manifest.yaml` (name/description/schema_url/dependencies). */
export const renderManifest = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    name: registry.name,
    description: registry.description,
    schema_url: registry.schemaUrl,
    ...(registry.dependencies.length > 0
      ? {
          dependencies: registry.dependencies
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((d) => ({ name: d.name, registry_path: d.registry_path })),
        }
      : {}),
  })

/** `<ns>.attributes.yaml` for one namespace's DEFINE-once catalog. */
export const renderAttributeGroup = ({
  group,
  provenance,
}: {
  group: AttributeGroup
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({ groups: [attributeGroupToObject(group)] })

/** `signals.yaml` — all spans + metrics (which only REF the catalog). */
export const renderSignals = ({
  signals,
  provenance,
}: {
  signals: ReadonlyArray<SignalDef>
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    groups: byId(signals as ReadonlyArray<{ id: string }>).map((s) =>
      signalToObject(s as SignalDef),
    ),
  })

// --- TS / Rust name constants (GEN-R06 multi-language targets) ---

const pascal = (key: string): string =>
  key
    .split(/[.\-:]/)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('')

const screamingSnake = (key: string): string => key.replace(/[.\-:]/g, '_').toUpperCase()

/** Single-quoted string literal (matches the repo's oxfmt style, so no reformat is needed). */
const sq = (k: string): string => `'${k}'`

const ownKeys = (r: Registry): ReadonlyArray<string> =>
  byId(r.groups.flatMap((g) => g.attributes)).map((a) => a.id)

/**
 * TS name constants + a key union (own-namespace keys only — upstream-referenced keys come
 * from upstream's own generated constants, per spec.md §TS-constants scope).
 */
export const renderTsConstants = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string => {
  const keys = ownKeys(registry)
  const lines: string[] = [provenanceComment({ provenance, prefix: '//' }).trimEnd(), '']
  for (const k of keys) lines.push(`export const ${pascal(k)} = ${sq(k)} as const`)
  lines.push('', 'export type AttributeKey =', ...keys.map((k) => `  | ${sq(k)}`), '')
  return lines.join('\n')
}

/**
 * Rust const module (GEN-R06 / decision 0007's Rust target). Emits `pub const <NAME>: &str`
 * for each own-namespace attribute key. The first real Rust consumer (otel-scrape) is a
 * follow-up epic; this proves the emitter shape.
 */
export const renderRustConstants = ({
  registry,
  provenance,
}: {
  registry: Registry
  provenance: Provenance
}): string => {
  const keys = ownKeys(registry)
  const lines: string[] = [
    `// registry-source: ${provenance.source}`,
    `// fingerprint: ${provenance.fingerprint}`,
    '',
    '//! Generated attribute-key constants.',
    '',
  ]
  for (const k of keys) lines.push(`pub const ${screamingSnake(k)}: &str = ${JSON.stringify(k)};`)
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Per-member author-time well-formedness (partial). Cross-member checks happen at
// aggregation (see `@overeng/genie/composition`), not here.
// ---------------------------------------------------------------------------

export type FragmentIssue = { readonly message: string; readonly attrId?: string }

/** Partial, per-fragment checks that do not need cross-member context. */
export const fragmentWellFormednessIssues = (f: RegistryFragment): ReadonlyArray<FragmentIssue> => {
  const issues: FragmentIssue[] = []
  for (const a of f.attributes) {
    if (a.type === 'string' && (a.examples === undefined || a.examples.length === 0)) {
      issues.push({
        attrId: a.id,
        message: `attr ${a.id}: string attributes require examples under weaver --future`,
      })
    }
    if (a.id.split('.')[0] !== f.namespace) {
      issues.push({
        attrId: a.id,
        message: `attr ${a.id}: own key does not share the fragment namespace ${JSON.stringify(f.namespace)}`,
      })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Genie builder — a member emits its RegistryFragment on the non-emitted `meta.registry`
// channel, plus an optional per-member slice on `data`/`stringify` (SC-R07).
// ---------------------------------------------------------------------------

/** Render a single member's fragment as a standalone (informational) YAML slice. */
export const renderMemberSlice = ({
  fragment,
  provenance,
}: {
  fragment: RegistryFragment
  provenance: Provenance
}): string =>
  provenanceComment({ provenance, prefix: '#' }) +
  yamlStringify({
    groups: [
      attributeGroupToObject({
        namespace: fragment.namespace,
        displayName: fragment.displayName,
        attributes: fragment.attributes,
      }),
      ...byId(fragment.signals as ReadonlyArray<{ id: string }>).map((s) =>
        signalToObject(s as SignalDef),
      ),
    ],
  })

/**
 * A member's `.genie.ts` returns this: the fragment rides `meta.registry` for the root
 * aggregator to compose (never re-derived from emitted files), and a slice is emitted as
 * `data`/`stringify`. Guard `fragment` with `Strict<>` at the call site if authored inline.
 */
export const registryFragment = ({
  fragment,
  provenance,
}: {
  fragment: RegistryFragment
  provenance: Provenance
}): GenieOutput<RegistryFragment, { registry: RegistryFragment }> =>
  createGenieOutput({
    data: fragment,
    stringify: () => renderMemberSlice({ fragment, provenance }),
    meta: { registry: fragment },
  })
