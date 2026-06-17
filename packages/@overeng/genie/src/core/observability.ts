import path from 'node:path'

import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

const basename = (filePath: string): string =>
  filePath.split(/[\\/]/).findLast((part) => part.length > 0) ?? filePath

/** Span-label-friendly path: cwd-relative with forward slashes, falling back to the basename when outside cwd. */
export const relativePath = ({ cwd, filePath }: { cwd: string; filePath: string }): string => {
  const relative = path.relative(cwd, filePath).split(path.sep).join('/')
  return relative.length > 0 ? relative : basename(filePath)
}

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      error._tag === 'OtelAttrEncodeError'
        ? Effect.die(error)
        : Effect.fail(error as E),
    ),
  ) as Effect.Effect<A, E, R>

const trustedWith =
  <S extends Schema.Schema.AnyNoContext>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

const trustedAnnotate = <S extends Schema.Schema.AnyNoContext>({
  operation,
  attributes,
}: {
  operation: OtelOperationDefinition<S>
  attributes: Schema.Schema.Type<S>
}): Effect.Effect<void> => trustOtelContract<void, never, never>(operation.annotate(attributes))

const commandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
    dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
    concurrency: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.concurrency' }))),
  }),
)

const commandSpan = OtelOperation.define({
  name: 'genie/command',
  attributes: commandAttrs,
  label: ({ label }) => label,
  root: true,
})

const fileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    genieFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.source_path' })),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
    readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
    dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
  }),
)

const fileSpan = OtelOperation.define({
  name: 'genie/file',
  attributes: fileAttrs,
  label: ({ label }) => label,
})

const pathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'genie.path' })),
  }),
)

const pathOperation = OtelOperation.define({
  name: 'genie/path',
  attributes: pathAttrs,
  label: ({ label }) => label,
})

const oxfmtAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
    hasConfig: Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.oxfmt.has_config' })),
  }),
)

const oxfmtOperation = OtelOperation.define({
  name: 'genie/oxfmt',
  attributes: oxfmtAttrs,
  label: ({ label }) => label,
})

const validationAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    requirePackageJsonValidate: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'genie.validation.require_package_json_validate' }),
    ),
    fileCount: Schema.optional(
      Schema.Number.pipe(OtelAttr.key({ key: 'genie.validation.file_count' })),
    ),
    preloadedFileCount: Schema.optional(
      Schema.Number.pipe(OtelAttr.key({ key: 'genie.validation.preloaded_file_count' })),
    ),
  }),
)

const validationSpan = OtelOperation.define({
  name: 'genie/runValidation',
  attributes: validationAttrs,
  label: ({ label }) => label,
})

const atomicWriteAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
    mode: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.file.mode' }))),
  }),
)

const atomicWriteSpan = OtelOperation.define({
  name: 'atomicWriteFile',
  attributes: atomicWriteAttrs,
  label: ({ label }) => label,
})

const importMapResolverAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
  }),
)

const importMapResolverSpan = OtelOperation.define({
  name: 'genie.registerImportMapResolver',
  attributes: importMapResolverAttrs,
  label: ({ label }) => label,
})

const targetLockAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
  }),
)

const targetLockOperation = OtelOperation.define({
  name: 'genie/target-lock',
  attributes: targetLockAttrs,
  label: ({ label }) => label,
})

const cliModeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cliMode: Schema.String.pipe(OtelAttr.key({ key: 'cli.mode' })),
  }),
)

const cliModeOperation = (cliMode: string) =>
  OtelOperation.define({
    name: `genie/${cliMode}`,
    attributes: cliModeAttrs,
    label: ({ label }) => label,
  })

/** Wraps an effect in the root `genie/<cliMode>` span; the operation name varies by CLI mode (generate/check/watch/dry-run). */
export const withCliModeSpan = (cliMode: string) =>
  trustedWith({ operation: cliModeOperation(cliMode), attributes: { label: cliMode, cliMode } })

/** Wraps an effect in the `genie/command` span; optional attributes are omitted (not encoded as undefined) when absent. */
export const withCommandSpan = ({
  label,
  cwd,
  readOnly,
  dryRun,
  concurrency,
}: {
  label: string
  cwd: string
  readOnly?: boolean
  dryRun?: boolean
  concurrency?: number
}) =>
  trustedWith({
    operation: commandSpan,
    attributes: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  })

/** Wraps per-file generation in the `genie/file` span; label defaults to the cwd-relative target path when omitted. */
export const withFileSpan = ({
  label,
  cwd,
  genieFilePath,
  targetFilePath,
  readOnly,
  dryRun,
}: {
  label?: string
  cwd: string
  genieFilePath: string
  targetFilePath: string
  readOnly?: boolean
  dryRun?: boolean
}) =>
  trustedWith({
    operation: fileSpan,
    attributes: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
  })

/** Wraps a single atomic file write in the `atomicWriteFile` span, labelled by the target's basename. */
export const withAtomicWriteSpan = ({
  targetFilePath,
  mode,
}: {
  targetFilePath: string
  mode?: number
}) =>
  trustedWith({
    operation: atomicWriteSpan,
    attributes: {
      label: basename(targetFilePath),
      targetFilePath,
      ...(mode === undefined ? {} : { mode }),
    },
  })

/** Pre-applied wrapper for the `genie.registerImportMapResolver` span (no per-call attributes beyond the fixed label). */
export const withImportMapResolverSpan = trustedWith({
  operation: importMapResolverSpan,
  attributes: { label: 'import-map' },
})

/** Wraps the cross-file validation pass in the `genie/runValidation` span. */
export const withValidationSpan = ({
  cwd,
  requirePackageJsonValidate,
  fileCount,
  preloadedFileCount,
}: {
  cwd: string
  requirePackageJsonValidate: boolean
  fileCount?: number
  preloadedFileCount?: number
}) =>
  trustedWith({
    operation: validationSpan,
    attributes: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
  })

/** Annotates the current span with `genie/command` attributes (in-place, no child span). */
export const annotateCommand = ({
  label,
  cwd,
  readOnly,
  dryRun,
  concurrency,
}: {
  label: string
  cwd: string
  readOnly?: boolean
  dryRun?: boolean
  concurrency?: number
}) =>
  trustedAnnotate({
    operation: commandSpan,
    attributes: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  })

/** Annotates the current span with `genie/file` attributes; label defaults to the cwd-relative target path. */
export const annotateFile = ({
  label,
  cwd,
  genieFilePath,
  targetFilePath,
  readOnly,
  dryRun,
}: {
  label?: string
  cwd: string
  genieFilePath: string
  targetFilePath: string
  readOnly?: boolean
  dryRun?: boolean
}) =>
  trustedAnnotate({
    operation: fileSpan,
    attributes: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
  })

/** Annotates the current span with `genie/runValidation` attributes (in-place). */
export const annotateValidation = ({
  cwd,
  requirePackageJsonValidate,
  fileCount,
  preloadedFileCount,
}: {
  cwd: string
  requirePackageJsonValidate: boolean
  fileCount?: number
  preloadedFileCount?: number
}) =>
  trustedAnnotate({
    operation: validationSpan,
    attributes: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
  })

/** Annotates the current span with a single `genie.path` attribute; label defaults to the path's basename. */
export const annotatePath = ({ label, path }: { label?: string; path: string }) =>
  trustedAnnotate({
    operation: pathOperation,
    attributes: { label: label ?? basename(path), path },
  })

/** Annotates the current span with `genie/target-lock` attributes, labelled by the cwd-relative target path. */
export const annotateTargetLock = ({
  cwd,
  targetFilePath,
}: {
  cwd: string
  targetFilePath: string
}) =>
  trustedAnnotate({
    operation: targetLockOperation,
    attributes: {
      label: relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      targetFilePath,
    },
  })

/** Annotates the current span with `genie/oxfmt` attributes; `hasConfig` records whether an oxfmt config was resolved. */
export const annotateOxfmt = ({
  targetFilePath,
  hasConfig,
}: {
  targetFilePath: string
  hasConfig: boolean
}) =>
  trustedAnnotate({
    operation: oxfmtOperation,
    attributes: {
      label: basename(targetFilePath),
      targetFilePath,
      hasConfig,
    },
  })
