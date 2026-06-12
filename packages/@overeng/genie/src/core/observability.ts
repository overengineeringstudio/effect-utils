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
  <S extends Schema.Schema.AnyNoContext>(
    operation: OtelOperationDefinition<S>,
    attributes: Schema.Schema.Type<S>,
  ): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

const trustedAnnotate = <S extends Schema.Schema.AnyNoContext>(
  operation: OtelOperationDefinition<S>,
  attributes: Schema.Schema.Type<S>,
): Effect.Effect<void> => trustOtelContract<void, never, never>(operation.annotate(attributes))

const commandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
    dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
    concurrency: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.concurrency' }))),
  }),
)

export const commandSpan = OtelOperation.define({
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

export const fileSpan = OtelOperation.define({
  name: 'genie/file',
  attributes: fileAttrs,
  label: ({ label }) => label,
})

export const pathAttrs = OtelAttrs.defineSync(
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

export const oxfmtAttrs = OtelAttrs.defineSync(
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

export const validationSpan = OtelOperation.define({
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

export const atomicWriteSpan = OtelOperation.define({
  name: 'atomicWriteFile',
  attributes: atomicWriteAttrs,
  label: ({ label }) => label,
})

const importMapResolverAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
  }),
)

export const importMapResolverSpan = OtelOperation.define({
  name: 'genie.registerImportMapResolver',
  attributes: importMapResolverAttrs,
  label: ({ label }) => label,
})

export const targetLockAttrs = OtelAttrs.defineSync(
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

export const withCliModeSpan = (cliMode: string) =>
  trustedWith(cliModeOperation(cliMode), { label: cliMode, cliMode })

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
  trustedWith(commandSpan, {
    label,
    cwd,
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(concurrency === undefined ? {} : { concurrency }),
  })

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
  trustedWith(fileSpan, {
    label: label ?? relativePath({ cwd, filePath: targetFilePath }),
    cwd,
    genieFilePath,
    targetFilePath,
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(dryRun === undefined ? {} : { dryRun }),
  })

export const withAtomicWriteSpan = ({
  targetFilePath,
  mode,
}: {
  targetFilePath: string
  mode?: number
}) =>
  trustedWith(atomicWriteSpan, {
    label: basename(targetFilePath),
    targetFilePath,
    ...(mode === undefined ? {} : { mode }),
  })

export const withImportMapResolverSpan = trustedWith(importMapResolverSpan, { label: 'import-map' })

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
  trustedWith(validationSpan, {
    label: 'validate',
    cwd,
    requirePackageJsonValidate,
    ...(fileCount === undefined ? {} : { fileCount }),
    ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
  })

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
  trustedAnnotate(commandSpan, {
    label,
    cwd,
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(concurrency === undefined ? {} : { concurrency }),
  })

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
  trustedAnnotate(fileSpan, {
    label: label ?? relativePath({ cwd, filePath: targetFilePath }),
    cwd,
    genieFilePath,
    targetFilePath,
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(dryRun === undefined ? {} : { dryRun }),
  })

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
  trustedAnnotate(validationSpan, {
    label: 'validate',
    cwd,
    requirePackageJsonValidate,
    ...(fileCount === undefined ? {} : { fileCount }),
    ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
  })

export const annotatePath = ({ label, path }: { label?: string; path: string }) =>
  trustedAnnotate(pathOperation, { label: label ?? basename(path), path })

export const annotateTargetLock = ({
  cwd,
  targetFilePath,
}: {
  cwd: string
  targetFilePath: string
}) =>
  trustedAnnotate(targetLockOperation, {
    label: relativePath({ cwd, filePath: targetFilePath }),
    cwd,
    targetFilePath,
  })

export const annotateOxfmt = ({
  targetFilePath,
  hasConfig,
}: {
  targetFilePath: string
  hasConfig: boolean
}) =>
  trustedAnnotate(oxfmtOperation, {
    label: basename(targetFilePath),
    targetFilePath,
    hasConfig,
  })
