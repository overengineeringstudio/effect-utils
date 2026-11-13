import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Cause, Effect, Schema } from 'effect'

import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
} from './pnpm-lock.ts'

const InputPath = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => !isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')),
)
export const FreshnessManifest = Schema.Struct({
  lockfile: InputPath,
  workspaceManifests: Schema.Array(InputPath),
  patches: Schema.Array(InputPath),
  sidecar: InputPath,
  generatorSources: Schema.Array(InputPath),
  committedOutputs: Schema.Array(InputPath),
  inputPaths: Schema.Array(InputPath),
  generator: InputPath,
  repairCommand: Schema.NonEmptyString,
})
export type FreshnessManifest = typeof FreshnessManifest.Type

export const FreshnessReport = Schema.Struct({
  schema: Schema.Literal('effect-utils/declared-inputs-freshness/v1'),
  inputs: Schema.Array(Schema.Struct({ path: InputPath, sha256: Schema.String })),
  files: Schema.Array(
    Schema.Struct({
      path: InputPath,
      verdict: Schema.Literals(['fresh', 'stale', 'unchecked']),
      firstDiff: Schema.NullOr(Schema.String),
    }),
  ),
  verdict: Schema.Literals(['fresh', 'stale']),
})

export class FreshnessError extends Schema.TaggedError<FreshnessError>()('FreshnessError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const attempt = <T>(operation: () => Promise<T>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new FreshnessError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
  })

/** A bounded unified hunk around the first differing line, including EOF differences. */
export const firstDiff = (path: string, actual: string, expected: string): string => {
  const before = actual.split('\n')
  const after = expected.split('\n')
  let line = 0
  while (line < Math.min(before.length, after.length) && before[line] === after[line]) line++
  const start = Math.max(0, line - 2)
  const oldEnd = Math.min(before.length, line + 4)
  const newEnd = Math.min(after.length, line + 4)
  return [
    `--- committed/${path}`,
    `+++ expected/${path}`,
    `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
    ...before.slice(start, line).map((value) => ` ${value}`),
    ...before.slice(line, oldEnd).map((value) => `-${value}`),
    ...after.slice(line, newEnd).map((value) => `+${value}`),
  ].join('\n')
}

const GeneratorOutput = Schema.Struct({ stringify: Schema.Unknown })

/** Runs only against the staged declared tree; the rule supplies an OS read/network boundary. */
export const checkFreshness = Effect.fn('declared-inputs-freshness.check')(function* ({
  source,
  manifest,
  output,
}: {
  source: string
  manifest: FreshnessManifest
  output: string
}) {
  const root = resolve(source)
  const input = (path: string) => join(root, path)
  const read = (path: string) => attempt(() => readFile(input(path), 'utf8'))
  const inputs: { path: string; sha256: string }[] = []
  const digest = async (path: string): Promise<void> => {
    const stat = await lstat(input(path))
    if (stat.isSymbolicLink()) {
      inputs.push({ path, sha256: createHash('sha256').update(`symlink:${await readlink(input(path))}`).digest('hex') })
    } else if (stat.isDirectory()) {
      const entries = await readdir(input(path), { withFileTypes: true })
      for (const entry of entries.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        await digest(join(path, entry.name))
      }
    } else {
      inputs.push({ path, sha256: createHash('sha256').update(await readFile(input(path))).digest('hex') })
    }
  }
  yield* attempt(async () => {
    for (const path of [...new Set(manifest.inputPaths)].toSorted()) await digest(path)
    await mkdir(output, { recursive: true })
  })
  const files: { path: string; verdict: 'fresh' | 'stale' | 'unchecked'; firstDiff: string | null }[] =
    manifest.committedOutputs.map((path) => ({ path, verdict: 'unchecked', firstDiff: null }))
  const writeReport = (verdict: 'fresh' | 'stale') =>
    Schema.encodeEffect(Schema.fromJsonString(FreshnessReport))({
      schema: 'effect-utils/declared-inputs-freshness/v1', inputs, files, verdict,
    }).pipe(Effect.flatMap((json) => attempt(() => writeFile(join(output, 'freshness.json'), `${json}\n`))))

  let failurePath = manifest.lockfile
  const generation = Effect.gen(function* () {
    const workspace = manifest.workspaceManifests.find((path) => path.endsWith('pnpm-workspace.yaml'))
    if (workspace === undefined) return yield* new FreshnessError({ message: 'workspace_manifests must declare pnpm-workspace.yaml' })
    const lockfileText = yield* read(manifest.lockfile)
    const workspaceText = yield* read(workspace)
    const patchBytes = new Map<string, Uint8Array>()
    for (const patch of manifest.patches) patchBytes.set(patch, yield* attempt(() => readFile(input(patch))))
    const sidecarText = yield* read(manifest.sidecar)
    const expectedSidecar = yield* attempt(async () => {
      const metadata = translatePnpmLock({
        lockfileText, workspaceText,
        readPatch: (path) => {
          const bytes = patchBytes.get(path)
          if (bytes === undefined) throw new FreshnessError({ message: `undeclared patch input: ${path}` })
          return bytes
        },
      })
      failurePath = manifest.sidecar
      const sidecar = decodePnpmSha256Sidecar(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(sidecarText))
      validatePnpmSha256Sidecar({ metadata, sidecar })
      const refuse = async (path: string): Promise<never> => {
        throw new FreshnessError({ message: `offline sidecar cannot refresh archive: ${path}` })
      }
      return generatePnpmSha256Sidecar({ metadata, previous: sidecar, fetchArchive: refuse, readProductTarball: refuse })
    })
    failurePath = manifest.generator.replace(/\.genie\.ts$/, '')
    process.env.EFFECT_UTILS_PNPM_OFFLINE = '1'
    // The consumer-selected generator is a runtime module boundary, not a fixed import.
    const generated = yield* attempt(() => import(pathToFileURL(input(manifest.generator)).href))
    const generator = yield* Schema.decodeUnknownEffect(GeneratorOutput)(generated.default)
    const stringify = generator.stringify
    if (typeof stringify !== 'function') return yield* new FreshnessError({ message: 'generator default must expose stringify(context)' })
    const buck = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.String)(stringify({ cwd: root, location: dirname(manifest.generator), mode: 'check' })),
      catch: (cause) => new FreshnessError({ message: String(cause), cause }),
    })
    const expected = new Map([
      [manifest.generator.replace(/\.genie\.ts$/, ''), buck],
      [manifest.sidecar, `${JSON.stringify(expectedSidecar, null, 2)}\n`],
    ])
    for (const file of files) {
      failurePath = file.path
      const text = expected.get(file.path)
      if (text === undefined) return yield* new FreshnessError({ message: `unsupported committed output: ${file.path}` })
      const actual = yield* attempt(() => readFile(input(file.path)))
      yield* attempt(async () => {
        const scratch = join(output, 'expected', file.path)
        await mkdir(dirname(scratch), { recursive: true })
        await writeFile(scratch, text)
      })
      const equal = actual.equals(Buffer.from(text))
      file.verdict = equal ? 'fresh' : 'stale'
      file.firstDiff = equal ? null : firstDiff(file.path, actual.toString('utf8'), text)
    }
  })
  const generated = yield* Effect.result(generation)
  if (generated._tag === 'Failure') {
    const file = files.find((file) => file.path === failurePath)
    if (file !== undefined) {
      file.verdict = 'stale'
      file.firstDiff = `--- committed/${failurePath}\n+++ expected/${failurePath}\n@@ validation @@\n-${generated.failure.message}\n+valid offline generated output required`
    }
    yield* writeReport('stale')
    return yield* new FreshnessError({ message: `${file?.firstDiff ?? generated.failure.message}\nRepair: ${manifest.repairCommand}`, cause: generated.failure })
  }
  const stale = files.filter((file) => file.verdict === 'stale')
  yield* writeReport(stale.length === 0 ? 'fresh' : 'stale')
  if (stale.length > 0) return yield* new FreshnessError({ message: `${stale.map((file) => file.firstDiff).join('\n')}\nRepair: ${manifest.repairCommand}` })
  yield* attempt(() => writeFile(join(output, 'freshness.ok'), 'fresh\n'))
})

if (import.meta.main) {
  const argumentsByName = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key !== undefined && value !== undefined) argumentsByName.set(key, value)
  }
  const program = Effect.gen(function* () {
    const source = argumentsByName.get('--source')
    const manifestPath = argumentsByName.get('--manifest')
    const output = argumentsByName.get('--output')
    if (source === undefined || manifestPath === undefined || output === undefined) return yield* new FreshnessError({ message: 'required: --source TREE --manifest JSON --output DIRECTORY' })
    const manifestText = yield* attempt(() => readFile(manifestPath, 'utf8'))
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FreshnessManifest))(manifestText)
    yield* checkFreshness({ source, manifest, output })
  })
  const result = await Effect.runPromiseExit(program)
  if (result._tag === 'Failure') {
    console.error(Cause.pretty(result.cause))
    process.exitCode = 1
  }
}
