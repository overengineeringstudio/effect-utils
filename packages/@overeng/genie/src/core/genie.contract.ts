/**
 * SEAM member contract for the `genie.*` telemetry namespace (decision 0005) — genie's OWN
 * observability, authored via the Layer-2 `@overeng/otel-contract/registry` surface. This is the
 * single home for genie's telemetry contract: the registry projection AND the runtime encoders
 * (`src/core/observability.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file`
 * lint and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated
 * no-orphan-seam test asserts this).
 *
 * Placement: `src/core/` (NOT `src/runtime/`). `src/runtime/**` is genie's dependency-free zone
 * (`overeng/no-external-imports` = error); this file imports `@overeng/otel-contract`, so it
 * lives beside `observability.ts`, which already imports otel-contract at runtime.
 *
 * NOTE: genie's `cli.mode` root span (`genie/<cliMode>`, a DYNAMIC span name with a foreign
 * `cli.*` key) is NOT a `genie`-namespace signal — a runtime-varying span name has no stable
 * single-signal registry projection, and `cli.*` is a separate namespace. Its attribute key is
 * catalogued in the sibling `cli.contract.ts` attrs-only seam; the span stays a legacy inline
 * `OtelOperation.define` bridge in `observability.ts`, rebuilt from that imported catalog schema
 * (SC-DQ5 migration-bridge state).
 */
import { Schema } from 'effect'

import { OtelAttr } from '@overeng/otel-contract'
import {
  attr,
  defineOtelContract,
  operation,
  recommended,
  required,
} from '@overeng/otel-contract/registry'

// ---- attributes (annotated Effect Schemas; the genie.* catalog SSOT) ----

/** Working directory the genie invocation runs in. */
export const GenieCwd = attr.string({
  key: 'genie.cwd',
  cardinality: 'high',
  brief: 'Absolute working directory of the genie invocation.',
  stability: 'development',
  examples: ['/home/user/project'],
})

/** Whether the run is read-only (check mode; no files written). */
export const GenieReadOnly = attr.boolean({
  key: 'genie.read_only',
  brief: 'Whether the run is read-only (check mode; no files are written).',
  stability: 'development',
})

/** Whether the run is a dry run (planned writes are logged, not applied). */
export const GenieDryRun = attr.boolean({
  key: 'genie.dry_run',
  brief: 'Whether the run is a dry run (planned writes are logged, not applied).',
  stability: 'development',
})

/** Configured generation concurrency (parallel file generations). */
export const GenieConcurrency = attr.number({
  key: 'genie.concurrency',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured generation concurrency (parallel file generations).',
  stability: 'development',
  examples: [4],
})

/** Path to the `*.genie.ts` source file that produces a target. */
export const GenieFileSourcePath = attr.string({
  key: 'genie.file.source_path',
  cardinality: 'high',
  brief: 'Path to the `*.genie.ts` source file that produces a target.',
  stability: 'development',
  examples: ['package.json.genie.ts'],
})

/** Path to the generated target file. */
export const GenieFileTargetPath = attr.string({
  key: 'genie.file.target_path',
  cardinality: 'high',
  brief: 'Path to the generated target file.',
  stability: 'development',
  examples: ['package.json'],
})

/** POSIX file mode applied to an atomically-written target file. */
export const GenieFileMode = attr.number({
  key: 'genie.file.mode',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'POSIX file mode applied to an atomically-written target file.',
  stability: 'development',
  examples: [420],
})

/** A filesystem path annotated onto the current span (basename-labelled). */
export const GeniePath = attr.string({
  key: 'genie.path',
  cardinality: 'high',
  brief: 'A filesystem path annotated onto the current span.',
  stability: 'development',
  examples: ['/home/user/project'],
})

/** Whether an oxfmt config was resolved for a formatted target. */
export const GenieOxfmtHasConfig = attr.boolean({
  key: 'genie.oxfmt.has_config',
  brief: 'Whether an oxfmt config was resolved for the formatted target.',
  stability: 'development',
})

/** Whether the validation pass requires `package.json` validation. */
export const GenieValidationRequirePackageJsonValidate = attr.boolean({
  key: 'genie.validation.require_package_json_validate',
  brief: 'Whether the validation pass requires `package.json` validation.',
  stability: 'development',
})

/** Number of files considered in a cross-file validation pass. */
export const GenieValidationFileCount = attr.number({
  key: 'genie.validation.file_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of files considered in a cross-file validation pass.',
  stability: 'development',
  examples: [12],
})

/** Number of files preloaded before a cross-file validation pass. */
export const GenieValidationPreloadedFileCount = attr.number({
  key: 'genie.validation.preloaded_file_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of files preloaded before a cross-file validation pass.',
  stability: 'development',
  examples: [3],
})

// ---- signals (operations: a span whose label is derived from a runtime-only field) ----

/** The runtime-only span-label source field shared by every genie operation. */
const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) } as const
const labelOf = (v: { label: string }): string => v.label

/** `genie/command` — the top-level command span (applied as a ROOT span at runtime). */
export const CommandOperation = operation({
  id: 'span.genie.command',
  name: 'genie/command',
  brief: 'A top-level genie command invocation.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(GenieCwd),
    readOnly: recommended(GenieReadOnly),
    dryRun: recommended(GenieDryRun),
    concurrency: recommended(GenieConcurrency),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `genie/file` — per-file generation span. */
export const FileOperation = operation({
  id: 'span.genie.file',
  name: 'genie/file',
  brief: 'Generation of a single target file from its `*.genie.ts` source.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(GenieCwd),
    genieFilePath: required(GenieFileSourcePath),
    targetFilePath: required(GenieFileTargetPath),
    readOnly: recommended(GenieReadOnly),
    dryRun: recommended(GenieDryRun),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `genie/path` — annotates the current span with a single filesystem path. */
export const PathOperation = operation({
  id: 'span.genie.path',
  name: 'genie/path',
  brief: 'A filesystem path annotated onto the current span.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    path: required(GeniePath),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `genie/oxfmt` — annotates a formatted target with its oxfmt config presence. */
export const OxfmtOperation = operation({
  id: 'span.genie.oxfmt',
  name: 'genie/oxfmt',
  brief: 'oxfmt formatting of a generated target file.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    targetFilePath: required(GenieFileTargetPath),
    hasConfig: required(GenieOxfmtHasConfig),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `genie/runValidation` — the cross-file validation pass span. */
export const ValidationOperation = operation({
  id: 'span.genie.run_validation',
  name: 'genie/runValidation',
  brief: 'The cross-file validation pass.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(GenieCwd),
    requirePackageJsonValidate: required(GenieValidationRequirePackageJsonValidate),
    fileCount: recommended(GenieValidationFileCount),
    preloadedFileCount: recommended(GenieValidationPreloadedFileCount),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `atomicWriteFile` — a single atomic file write. */
export const AtomicWriteOperation = operation({
  id: 'span.genie.atomic_write',
  name: 'atomicWriteFile',
  brief: 'A single atomic file write.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    targetFilePath: required(GenieFileTargetPath),
    mode: recommended(GenieFileMode),
  },
  labelFields: labelField,
  label: labelOf,
})

/**
 * `genie.registerImportMapResolver` — import-map resolver registration (label-only). Its runtime
 * encoder is DERIVED from the seam like the others, but it is INTENTIONALLY excluded from the
 * `signals` list projected to Weaver: it carries no catalog attributes (only a fixed span label),
 * and a Weaver span group with zero attributes is rejected (`missing extends or attributes`). A
 * label-only span has no semantic-convention content, so it is runtime-only, not registry-projected.
 */
export const ImportMapResolverOperation = operation({
  id: 'span.genie.register_import_map_resolver',
  name: 'genie.registerImportMapResolver',
  brief: 'Registration of the import-map module resolver.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {},
  labelFields: labelField,
  label: labelOf,
})

/** `genie/target-lock` — annotates the current span with the locked target path. */
export const TargetLockOperation = operation({
  id: 'span.genie.target_lock',
  name: 'genie/target-lock',
  brief: 'Acquisition of the per-target write lock.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(GenieCwd),
    targetFilePath: required(GenieFileTargetPath),
  },
  labelFields: labelField,
  label: labelOf,
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/genie',
  displayName: 'Genie Attributes',
  // `ImportMapResolverOperation` is authored above (its encoder is derived) but deliberately NOT
  // listed here — it is a label-only span with no catalog attributes, which Weaver rejects as an
  // empty group (see its docstring). It stays runtime-only, not registry-projected.
  signals: [
    CommandOperation,
    FileOperation,
    PathOperation,
    OxfmtOperation,
    ValidationOperation,
    AtomicWriteOperation,
    TargetLockOperation,
  ],
})
