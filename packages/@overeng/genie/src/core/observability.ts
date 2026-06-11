import path from 'node:path'

import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelSpan, type OtelSpanDefinition } from '@overeng/utils/node'

const basename = (filePath: string): string =>
  filePath.split(/[\\/]/).findLast((part) => part.length > 0) ?? filePath

export const relativePath = ({ cwd, filePath }: { cwd: string; filePath: string }): string => {
  const relative = path.relative(cwd, filePath).split(path.sep).join('/')
  return relative.length > 0 ? relative : basename(filePath)
}

const applySpan = <S extends Schema.Schema.AnyNoContext>({
  span,
  attributes,
}: {
  span: OtelSpanDefinition<S>
  attributes: Schema.Schema.Type<S>
}) => OtelSpan.unsafeWith({ span, attributes })

export const commandSpan = {
  name: 'genie/command',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
      dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
      concurrency: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.concurrency' }))),
    }),
  ),
  root: true,
} as const

export const fileSpan = {
  name: 'genie/file',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      genieFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.source_path' })),
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
      readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
      dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
    }),
  ),
} as const

export const pathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'genie.path' })),
  }),
)

export const oxfmtAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
    hasConfig: Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.oxfmt.has_config' })),
  }),
)

export const validationSpan = {
  name: 'genie/runValidation',
  attributes: OtelAttrs.defineSync(
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
  ),
} as const

export const atomicWriteSpan = {
  name: 'atomicWriteFile',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
      mode: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.file.mode' }))),
    }),
  ),
} as const

export const importMapResolverSpan = {
  name: 'genie.registerImportMapResolver',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    }),
  ),
} as const

export const targetLockAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
    targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
  }),
)

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
  applySpan({
    span: commandSpan,
    attributes: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
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
  applySpan({
    span: fileSpan,
    attributes: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
  })

export const withAtomicWriteSpan = ({
  targetFilePath,
  mode,
}: {
  targetFilePath: string
  mode?: number
}) =>
  applySpan({
    span: atomicWriteSpan,
    attributes: {
      label: basename(targetFilePath),
      targetFilePath,
      ...(mode === undefined ? {} : { mode }),
    },
  })

export const withImportMapResolverSpan = applySpan({
  span: importMapResolverSpan,
  attributes: { label: 'import-map' },
})

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
  applySpan({
    span: validationSpan,
    attributes: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
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
  OtelSpan.unsafeAnnotate({
    attributes: commandSpan.attributes,
    value: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
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
  OtelSpan.unsafeAnnotate({
    attributes: fileSpan.attributes,
    value: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
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
  OtelSpan.unsafeAnnotate({
    attributes: validationSpan.attributes,
    value: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
  })

export const annotatePath = ({ label, path }: { label?: string; path: string }) =>
  OtelSpan.unsafeAnnotate({
    attributes: pathAttrs,
    value: { label: label ?? basename(path), path },
  })

export const annotateTargetLock = ({
  cwd,
  targetFilePath,
}: {
  cwd: string
  targetFilePath: string
}) =>
  OtelSpan.unsafeAnnotate({
    attributes: targetLockAttrs,
    value: {
      label: relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      targetFilePath,
    },
  })

export const annotateOxfmt = ({
  targetFilePath,
  hasConfig,
}: {
  targetFilePath: string
  hasConfig: boolean
}) =>
  OtelSpan.unsafeAnnotate({
    attributes: oxfmtAttrs,
    value: {
      label: basename(targetFilePath),
      targetFilePath,
      hasConfig,
    },
  })
