import * as fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, Option, Schema } from 'effect'

import { CliVersion } from '@overeng/utils/node/cli-version'

import {
  canonicalJson,
  compareUtf8,
  directoryDigest,
  reasonCodes,
} from '../runtime/node/input-observations.ts'
import type { InputRecording } from '../runtime/node/input-observations.ts'
import {
  getInputRecording,
  inputStatSync,
  recordInput,
  recordInputCwd,
  recordInputEnvironment,
  recordInputReason,
} from '../runtime/node/inputs.ts'

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => path.isAbsolute(value) && path.resolve(value) === value),
)
const Generator = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      !value.includes('\\'),
  ),
)
const By = Schema.Array(Generator)
const CodeFile = Schema.Struct({ path: AbsolutePath, digest: Digest })
const Identity = Schema.Struct({ version: Schema.String, files: Schema.NonEmptyArray(CodeFile) })
const Missing = { state: Schema.Literal('absent'), error: Schema.Literals(['ENOENT', 'ENOTDIR']) }
const EntryType = Schema.Literals([
  'file',
  'directory',
  'symlink',
  'socket',
  'fifo',
  'character-device',
  'block-device',
])
const File = Schema.Union([
  Schema.Struct({
    path: AbsolutePath,
    by: By,
    state: Schema.Literal('present'),
    digest: Digest,
    byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ path: AbsolutePath, by: By, ...Missing }),
])
const Directory = Schema.Union([
  Schema.Struct({
    path: AbsolutePath,
    by: By,
    state: Schema.Literal('present'),
    entries: Schema.Array(Schema.Struct({ name: Schema.String, type: EntryType })),
    digest: Digest,
  }),
  Schema.Struct({ path: AbsolutePath, by: By, ...Missing }),
])
const Environment = Schema.Union([
  Schema.Struct({ name: Schema.String, by: By, present: Schema.Literal(false) }),
  Schema.Struct({ name: Schema.String, by: By, present: Schema.Literal(true), digest: Digest }),
])
const Symlink = Schema.Union([
  Schema.Struct({
    path: AbsolutePath,
    by: By,
    state: Schema.Literal('present'),
    target: Schema.String,
  }),
  Schema.Struct({ path: AbsolutePath, by: By, ...Missing }),
])
const Decimal = Schema.String.check(Schema.isPattern(/^(0|-?[1-9][0-9]*)$/))
const StatValues = Schema.Struct({
  dev: Decimal,
  ino: Decimal,
  mode: Decimal,
  nlink: Decimal,
  uid: Decimal,
  gid: Decimal,
  rdev: Decimal,
  size: Decimal,
  blksize: Decimal,
  blocks: Decimal,
  atimeNs: Decimal,
  mtimeNs: Decimal,
  ctimeNs: Decimal,
  birthtimeNs: Decimal,
})
const Stat = Schema.Union([
  Schema.Struct({
    path: AbsolutePath,
    followSymlinks: Schema.Boolean,
    by: By,
    state: Schema.Literal('present'),
    type: EntryType,
    values: StatValues,
  }),
  Schema.Struct({ path: AbsolutePath, followSymlinks: Schema.Boolean, by: By, ...Missing }),
])
const Ref = Schema.Struct({ kind: Schema.Literals(['file', 'directory']), path: AbsolutePath })
const Resolution = Schema.Struct({
  importer: AbsolutePath,
  specifier: Schema.String,
  by: By,
  outcome: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('file'), lexical: AbsolutePath, physical: AbsolutePath }),
    Schema.Struct({ kind: Schema.Literal('builtin'), name: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('missing') }),
  ]),
  candidates: Schema.Array(Ref),
  contextEnv: Schema.Array(Schema.String),
  resolverCode: Schema.Array(CodeFile),
})
/** Validated evidence format emitted by a recorded Genie check. */
export const ReadSetSchema = Schema.Struct({
  schema: Schema.Literal('genie-check-read-set'),
  schemaVersion: Schema.Literal(1),
  invocationId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ),
  checkSucceeded: Schema.Boolean,
  complete: Schema.Boolean,
  repoRoot: AbsolutePath,
  argv: Schema.Array(Schema.String),
  generators: By,
  generatorResults: Schema.Array(
    Schema.Struct({
      generator: Generator,
      target: AbsolutePath,
      module: Identity,
      outputDigest: Digest,
    }),
  ),
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  genie: Identity,
  bun: Identity,
  envSalt: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  files: Schema.Array(File),
  directories: Schema.Array(Directory),
  environment: Schema.Array(Environment),
  cwd: Schema.Array(Schema.Struct({ lexical: AbsolutePath, physical: AbsolutePath, by: By })),
  symlinks: Schema.Array(Symlink),
  resolutions: Schema.Array(Resolution),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      executable: AbsolutePath,
      version: Schema.NullOr(Schema.String),
      files: Schema.Array(CodeFile),
      by: By,
    }),
  ),
  stats: Schema.Array(Stat),
  reasons: Schema.Array(
    Schema.Struct({
      code: Schema.Literals(reasonCodes),
      operation: Schema.String,
      detail: Schema.String,
      source: Schema.Struct({
        module: Schema.String,
        line: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      }),
      generators: By,
      evidence: Schema.Literals(['observed', 'unproven']),
    }),
  ),
}).annotate({ identifier: 'Genie.CheckReadSet' })
/** Evidence collected during a recorded Genie check. */
export type ReadSet = typeof ReadSetSchema.Type

const sorted = <TValue>({
  values,
  key,
}: {
  values: Iterable<TValue>
  key: (value: TValue) => unknown
}): TValue[] =>
  [...values].toSorted((left, right) =>
    compareUtf8(canonicalJson(key(left)), canonicalJson(key(right))),
  )
const unique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || compareUtf8(values[index - 1]!, value) < 0)
const ordered = <TValue>({
  values,
  key,
}: {
  values: readonly TValue[]
  key: (value: TValue) => unknown
}): boolean => unique(values.map((value) => canonicalJson(key(value))))
const assert = (condition: boolean): void => {
  if (condition === false) throw new Error('Inconsistent genie read-set evidence')
}
const identity = (value: ReadSet['genie']): void => {
  assert(ordered({ values: value.files, key: (file) => file.path }))
}
/** Strict producer validation. Consumers must independently validate before considering reuse. */
export const validateReadSet = (input: unknown): ReadSet => {
  const result = Schema.decodeUnknownSync(ReadSetSchema, { onExcessProperty: 'error' })(input)
  canonicalJson(result) // Reject non-Unicode strings, including nested diagnostics.
  assert(result.complete === (result.reasons.length === 0))
  assert(unique(result.generators))
  const attribution = (by: readonly string[]): void => {
    assert(unique(by) && by.every((generator) => result.generators.includes(generator)))
    assert(result.generators.length === 0 || by.length > 0)
  }
  for (const observations of [result.files, result.directories, result.symlinks]) {
    assert(ordered<{ path: string }>({ values: observations, key: (item) => item.path }))
    for (const observation of observations) attribution(observation.by)
  }
  assert(ordered({ values: result.environment, key: (item) => item.name }))
  assert(ordered({ values: result.cwd, key: (item) => item.lexical }))
  assert(ordered({ values: result.stats, key: (item) => [item.path, item.followSymlinks] }))
  assert(ordered({ values: result.resolutions, key: (item) => [item.importer, item.specifier] }))
  assert(ordered({ values: result.tools, key: (item) => item.name }))
  for (const observations of [
    result.environment,
    result.cwd,
    result.stats,
    result.resolutions,
    result.tools,
  ])
    for (const observation of observations) attribution(observation.by)
  assert(ordered({ values: result.generatorResults, key: (item) => [item.generator, item.target] }))
  assert(result.generatorResults.length === result.generators.length)
  const representedGenerators = new Set(result.generatorResults.map((entry) => entry.generator))
  assert(
    representedGenerators.size === result.generators.length &&
      result.generators.every((generator) => representedGenerators.has(generator)),
  )
  identity(result.genie)
  identity(result.bun)
  for (const generator of result.generatorResults) {
    assert(result.generators.includes(generator.generator))
    identity(generator.module)
    assert(
      result.files.some(
        (file) =>
          file.path === generator.target &&
          file.state === 'present' &&
          file.digest === generator.outputDigest &&
          file.by.includes(generator.generator),
      ),
    )
  }
  for (const directory of result.directories)
    if (directory.state === 'present') {
      assert(unique(directory.entries.map((entry) => entry.name)))
      assert(
        directory.entries.every(
          ({ name }) => name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name),
        ),
      )
      assert(directoryDigest([...directory.entries]) === directory.digest)
    }
  assert(ordered({ values: result.reasons, key: (reason) => reason }))
  for (const reason of result.reasons) attribution(reason.generators)
  for (const resolution of result.resolutions) {
    assert(
      result.files.some((file) => file.path === resolution.importer && file.state === 'present'),
    )
    if (resolution.outcome.kind === 'file') {
      const { lexical, physical } = resolution.outcome
      assert(
        [lexical, physical].every((inputPath) =>
          result.files.some((file) => file.path === inputPath && file.state === 'present'),
        ),
      )
    } else if (resolution.outcome.kind === 'builtin')
      assert(resolution.outcome.name.startsWith('node:') && isBuiltin(resolution.outcome.name))
    for (const candidate of resolution.candidates)
      assert(
        (candidate.kind === 'file' ? result.files : result.directories).some(
          (entry) => entry.path === candidate.path,
        ),
      )
    assert(
      unique(resolution.contextEnv) &&
        resolution.contextEnv.every((name) =>
          result.environment.some((entry) => entry.name === name),
        ),
    )
    assert(ordered({ values: resolution.resolverCode, key: (file) => file.path }))
  }
  for (const tool of result.tools) {
    assert(ordered({ values: tool.files, key: (file) => file.path }))
    assert(tool.files.some((file) => file.path === tool.executable))
  }
  return result
}

const InputManifestMetadata = Schema.Struct({
  schema: Schema.Literal('genie-input-manifest-metadata'),
  schemaVersion: Schema.Literal(1),
  invocationId: ReadSetSchema.fields.invocationId,
  complete: Schema.Boolean,
  digestEvidence: Schema.Boolean,
})

/** Validate paired output provenance only; this does not validate current inputs or authorize reuse. */
export const validateReadSetPair = ({
  readSet,
  metadata,
}: {
  readSet: unknown
  metadata: unknown
}): ReadSet => {
  const result = validateReadSet(readSet)
  const companion = Schema.decodeUnknownSync(InputManifestMetadata, { onExcessProperty: 'error' })(
    metadata,
  )
  assert(
    companion.invocationId === result.invocationId &&
      companion.complete === result.complete &&
      companion.digestEvidence === true,
  )
  return result
}

const compiled = process.argv[1]?.includes('/$bunfs/') === true
const enginePath = compiled === true ? process.execPath : fileURLToPath(import.meta.url)
const packagePath =
  compiled === true ? undefined : fileURLToPath(new URL('../../package.json', import.meta.url))
/** Begin before discovery. Opaque engine/tool closures remain explicit blockers. */
export const initializeReadSet = Effect.fn('genie/initializeReadSet')(function* (cwd: string) {
  const evidence = getInputRecording()?.evidence
  if (evidence === undefined) return
  recordInputCwd(cwd)
  recordInputCwd(process.cwd())
  recordInput(enginePath)
  if (packagePath !== undefined) recordInput(packagePath)
  recordInput(process.execPath)
  const version = yield* Effect.serviceOption(CliVersion)
  if (Option.isSome(version) === true) evidence.genieVersion = version.value.version
  else if (packagePath !== undefined) {
    const raw = yield* Effect.try(() => fs.readFileSync(packagePath, 'utf8'))
    evidence.genieVersion = (yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
    )(raw)).version
  }
  for (const module of ['@overeng/genie', 'bun:runtime'])
    recordInputReason({
      code: 'unknown-capability',
      operation: 'component identity closure',
      detail: 'The complete influencing engine/runtime closure is not yet accounted for',
      source: { module, line: null },
      generators: [],
      evidence: 'unproven',
    })
})

/** Build and validate a read-set from the evidence retained by an invocation. */
export const buildReadSet = ({
  recording,
  cwd,
  argv,
}: {
  recording: InputRecording
  cwd: string
  argv: readonly string[]
}): ReadSet => {
  const evidence = recording.evidence
  if (evidence === undefined) throw new Error('Read-set digest recording was not installed')
  // Revalidate consumed evidence without replacing earlier observations. This is a
  // stability check over the original keys, not a post-run dependency census.
  for (const input of new Set([
    ...evidence.files.keys(),
    ...evidence.directories.keys(),
    ...evidence.symlinks.keys(),
  ]))
    recordInput(input)
  for (const name of evidence.environment.keys()) recordInputEnvironment(name)
  for (const observedCwd of evidence.cwd.values()) recordInputCwd(observedCwd.lexical)
  for (const stat of evidence.stats.values()) {
    try {
      inputStatSync(stat.path)
    } catch {
      /* The reader retains the exact failed observation. */
    }
  }
  const by = (values: readonly string[]): readonly string[] =>
    values.length === 0 ? recording.generators : [...new Set(values)].toSorted(compareUtf8)
  const attributed = <TValue extends { by: readonly string[] }>({
    values,
    key,
  }: {
    values: Iterable<TValue>
    key: (value: TValue) => unknown
  }) =>
    sorted({
      values: [...values].map((value) => Object.assign({}, value, { by: by(value.by) })),
      key,
    })
  const codeFile = (input: string) => {
    const observed = evidence.files.get(input)
    if (observed?.state !== 'present') throw new Error('Missing component identity bytes')
    return { path: input, digest: observed.digest }
  }
  const version = evidence.genieVersion
  if (version === undefined) throw new Error('Genie build version is unavailable')
  return validateReadSet({
    schema: 'genie-check-read-set',
    schemaVersion: 1,
    invocationId: evidence.invocationId,
    checkSucceeded: true,
    complete: recording.reasons.length === 0,
    repoRoot: path.resolve(cwd),
    argv: [...argv],
    generators: recording.generators,
    generatorResults: sorted({
      values: evidence.generatorResults.values(),
      key: (result) => [result.generator, result.target],
    }),
    platform: { os: process.platform, arch: process.arch },
    genie: { version, files: [codeFile(enginePath)] },
    bun: { version: Bun.version, files: [codeFile(process.execPath)] },
    envSalt: evidence.envSalt,
    files: attributed({ values: evidence.files.values(), key: (item) => item.path }),
    directories: attributed({ values: evidence.directories.values(), key: (item) => item.path }),
    environment: attributed({ values: evidence.environment.values(), key: (item) => item.name }),
    cwd: attributed({ values: evidence.cwd.values(), key: (item) => item.lexical }),
    symlinks: attributed({ values: evidence.symlinks.values(), key: (item) => item.path }),
    stats: attributed({
      values: evidence.stats.values(),
      key: (item) => [item.path, item.followSymlinks],
    }),
    resolutions: attributed({
      values: evidence.resolutions.values(),
      key: (item) => [item.importer, item.specifier],
    }),
    tools: [],
    reasons: sorted({
      values: recording.reasons.map((reason) =>
        Object.assign({}, reason, { generators: by(reason.generators) }),
      ),
      key: (reason) => reason,
    }),
  })
}
