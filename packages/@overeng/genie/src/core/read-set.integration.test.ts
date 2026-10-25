import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { ByteSize, Effect, Exit, FileSystem, Schema } from 'effect'
import { expect } from 'vitest'

import {
  canonicalJson,
  digestBytes,
  directoryDigest,
  environmentDigest,
  reasonCodes,
} from '../runtime/node/input-observations.ts'
import {
  beginInputRecording,
  endInputRecording,
  getInputRecording,
  inputExistsSync,
  inputReadFileSync,
  inputReaddirSync,
  inputRealpathSync,
  inputStatSync,
  isInputRecording,
  recordInput,
  recordInputCwd,
  recordInputEnvironment,
} from '../runtime/node/inputs.ts'
import { findGenieFiles } from './discovery.ts'
import { auditEngineFileSystem, inputEngineFileSystem } from './engine-inputs.ts'
import { withInputManifest } from './input-manifest.ts'
import {
  ReadSetSchema,
  recordEngineIdentityFiles,
  validateReadSet,
  validateReadSetPair,
} from './read-set.ts'

const cliPath = fileURLToPath(new URL('../../bin/genie.tsx', import.meta.url))
const readersPath = fileURLToPath(new URL('../runtime/node/inputs.ts', import.meta.url))
const decode = Schema.decodeSync(Schema.fromJsonString(ReadSetSchema), {
  onExcessProperty: 'error',
})
const decodeBundleIdentity = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.Literal('bundle'),
      files: ReadSetSchema.fields.files,
      reasons: ReadSetSchema.fields.reasons,
      runtime: Schema.String,
    }),
  ),
)
const decodeMetadata = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      schema: Schema.Literal('genie-input-manifest-metadata'),
      schemaVersion: Schema.Literal(1),
      invocationId: Schema.String,
      legacyComplete: Schema.Boolean,
      readSetComplete: Schema.NullOr(Schema.Boolean),
      digestEvidence: Schema.Boolean,
    }),
  ),
)
const decodeReport = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      invocationId: Schema.String,
      reasons: ReadSetSchema.fields.reasons,
      groups: Schema.Array(
        Schema.Struct({
          code: Schema.Literals(reasonCodes),
          source: Schema.Struct({
            module: Schema.String,
            line: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          }),
          occurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          generators: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
)
// Some filesystems or sandbox policies do not support creating symlinks.
// Keep the independent inventory assertions running when that capability is absent.
const trySymlink = ({ target, link }: { target: string; link: string }) => {
  try {
    fs.symlinkSync(target, link)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code)) === true
    )
      return false
    throw error
  }
}

const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-read-set-')))
  const artifact = path.join(root, 'evidence.json')
  const manifest = path.join(root, 'inputs.manifest')
  fs.mkdirSync(path.join(root, 'empty'))
  fs.writeFileSync(path.join(root, 'runtime.txt'), 'input\n')
  fs.writeFileSync(
    path.join(root, 'shared.ts'),
    `
import { inputReadFileSync, inputExistsSync, inputReaddirSync, recordInputEnvironment } from ${JSON.stringify(readersPath)}
export const read = () => {
  inputExistsSync(${JSON.stringify(path.join(root, 'optional.txt'))})
  inputReaddirSync(${JSON.stringify(path.join(root, 'empty'))})
  recordInputEnvironment('GENIE_READ_SET_TEST_VALUE')
  return inputReadFileSync(${JSON.stringify(path.join(root, 'runtime.txt'))}, 'utf8')
}
`,
  )
  for (const name of ['one', 'two'])
    fs.writeFileSync(
      path.join(root, `${name}.txt.genie.ts`),
      `import { read } from './shared.ts'\nexport default { data: {}, stringify: read }\n`,
    )
  const run = (args: string[], legacy = true, manifestPath = manifest) =>
    spawnSync('bun', [cliPath, '--cwd', root, '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GENIE_INPUT_MANIFEST: legacy === true ? manifestPath : '',
        XDG_STATE_HOME: path.join(root, 'state'),
      },
    })
  const generate = run(['--writeable'], false)
  expect(generate.status, generate.stdout + generate.stderr).toBe(0)
  return { root, artifact, manifest, run }
}

describe('check read-set recording', () => {
  it.effect(
    'records bundled engine bytes separately from the Bun runtime and fails closed for analysis',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bundle-identity-')),
        )
        try {
          const entry = path.join(root, 'entry.ts')
          const bundle = path.join(root, 'genie.js')
          const readSetPath = fileURLToPath(new URL('./read-set.ts', import.meta.url))
          const scannerPath = fileURLToPath(new URL('./input-manifest.ts', import.meta.url))
          fs.writeFileSync(
            entry,
            `
import { Effect } from ${canonicalJson(fileURLToPath(import.meta.resolve('effect')))}
import { initializeReadSet } from ${canonicalJson(readSetPath)}
import { recordGeneratorSourceGraph } from ${canonicalJson(scannerPath)}
import { beginInputRecording, getInputRecording, endInputRecording } from ${canonicalJson(readersPath)}
beginInputRecording({ digests: true })
await Effect.runPromise(initializeReadSet(process.cwd()))
await recordGeneratorSourceGraph({ entries: [], cwd: process.cwd() })
const recording = getInputRecording()
console.log(JSON.stringify({
  mode: recording.evidence.engineMode,
  files: [...recording.evidence.files.values()],
  reasons: recording.reasons,
  runtime: process.execPath,
}))
endInputRecording()
`,
          )
          const built = spawnSync('bun', ['build', '--target=bun', '--outfile', bundle, entry], {
            encoding: 'utf8',
          })
          expect(built.status, built.stdout + built.stderr).toBe(0)
          const executed = spawnSync('bun', [bundle], { cwd: root, encoding: 'utf8' })
          expect(executed.status, executed.stdout + executed.stderr).toBe(0)
          const observed = decodeBundleIdentity(executed.stdout.trim())
          expect(observed.files).toContainEqual(
            expect.objectContaining({ path: bundle, digest: digestBytes(fs.readFileSync(bundle)) }),
          )
          expect(observed.files).toContainEqual(
            expect.objectContaining({
              path: observed.runtime,
              digest: digestBytes(fs.readFileSync(observed.runtime)),
            }),
          )
          for (const operation of ['engine-analysis-unavailable', 'validator-analysis-unavailable'])
            expect(observed.reasons).toContainEqual(
              expect.objectContaining({ code: 'unknown-capability', operation }),
            )
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )
  it.effect(
    'retains an unknown runtime descriptor read for every generator in the published artifact',
    () =>
      Effect.sync(() => {
        const { root, artifact, run } = fixture()
        try {
          fs.writeFileSync(
            path.join(root, 'shared.ts'),
            `
import { openSync, closeSync } from 'node:fs'
import { inputReadFileSync } from ${canonicalJson(readersPath)}
export const read = () => {
  const descriptor = openSync(${canonicalJson(path.join(root, 'runtime.txt'))}, 'r')
  try { return inputReadFileSync(descriptor, 'utf8') }
  finally { closeSync(descriptor) }
}
`,
          )
          const checked = run(['--check', '--read-set', artifact])
          expect(checked.status, checked.stdout + checked.stderr).toBe(0)
          const evidence = validateReadSet(decode(fs.readFileSync(artifact, 'utf8')))
          expect(evidence.reasons).toContainEqual(
            expect.objectContaining({
              code: 'unknown-capability',
              operation: 'readFileSync(fd)',
              evidence: 'observed',
              generators: ['one.txt.genie.ts', 'two.txt.genie.ts'],
            }),
          )
          expect(
            evidence.files.find((file) => file.path === path.join(root, 'one.txt.genie.ts'))?.by,
          ).toEqual(['one.txt.genie.ts', 'two.txt.genie.ts'])
          expect(evidence.complete).toBe(false)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    120_000,
  )
  it.effect('binds engine identity to bytes rather than a non-store executable path', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const first = path.join(root, 'runtime-a')
      const second = path.join(root, 'runtime-b')
      yield* fs.writeFileString(first, 'binary-a')
      yield* fs.writeFileString(second, 'binary-a')
      beginInputRecording({ digests: true })
      try {
        recordEngineIdentityFiles([first, second])
        const observations = getInputRecording()!.evidence!.files
        const before = observations.get(first)
        expect(before).toMatchObject({ path: first, digest: digestBytes('binary-a') })
        expect(observations.get(second)).toMatchObject({
          path: second,
          digest: digestBytes('binary-a'),
        })
        endInputRecording()
        yield* fs.writeFileString(first, 'binary-b')
        beginInputRecording({ digests: true })
        recordEngineIdentityFiles([first, second])
        const changed = getInputRecording()!.evidence!.files
        expect(changed.get(first)).toMatchObject({
          path: first,
          digest: digestBytes('binary-b'),
        })
        expect(changed.get(first)).not.toEqual(before)
        expect(changed.get(second)).toMatchObject({
          path: second,
          digest: digestBytes('binary-a'),
        })
      } finally {
        endInputRecording()
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('records engine outcomes when lazy filesystem effects run, not when constructed', () =>
    Effect.gen(function* () {
      const service = yield* FileSystem.FileSystem
      const root = yield* service.makeTempDirectoryScoped()
      const input = path.join(root, 'input')
      const directory = path.join(root, 'directory')
      const statInput = path.join(root, 'stat')
      fs.writeFileSync(input, 'before')
      fs.writeFileSync(statInput, 'before')
      fs.mkdirSync(directory)
      beginInputRecording({ digests: true })
      try {
        const engine = inputEngineFileSystem({
          fs: service,
          source: { module: '@overeng/genie/src/core/read-set.integration.test.ts', line: null },
        })
        const exists = engine.exists(input)
        const names = engine.readDirectory(directory)
        const stat = engine.stat(statInput)
        expect(getInputRecording()!.paths.size).toBe(0)
        fs.unlinkSync(input)
        fs.writeFileSync(path.join(directory, 'after'), 'new')
        fs.writeFileSync(statInput, 'changed after effect construction')
        expect(yield* exists).toBe(false)
        expect(yield* names).toEqual(['after'])
        const info = yield* stat
        const evidence = getInputRecording()!.evidence!
        expect(evidence.files.get(input)).toMatchObject({ state: 'absent', error: 'ENOENT' })
        expect(evidence.directories.get(directory)).toMatchObject({
          state: 'present',
          entries: [{ name: 'after', type: 'file' }],
        })
        expect(evidence.stats.get(canonicalJson([statInput, true]))).toMatchObject({
          state: 'present',
          values: { size: String(ByteSize.toBigInt(info.size)) },
        })
        const target = path.join(root, 'target')
        const link = path.join(root, 'link')
        fs.writeFileSync(target, 'target')
        if (trySymlink({ target: statInput, link }) === true) {
          const readLink = engine.readLink(link)
          const realPath = engine.realPath(link)
          fs.unlinkSync(link)
          fs.symlinkSync(target, link)
          expect(yield* readLink).toBe(target)
          expect(yield* realPath).toBe(fs.realpathSync(target))
          expect(evidence.symlinks.get(link)).toMatchObject({ state: 'present', target })
        }
        expect(getInputRecording()!.reasons).toEqual([])
      } finally {
        endInputRecording()
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains failures actually consumed by lazy engine filesystem effects', () =>
    Effect.gen(function* () {
      const service = yield* FileSystem.FileSystem
      const root = yield* service.makeTempDirectoryScoped()
      const directory = path.join(root, 'directory')
      const input = path.join(root, 'input')
      fs.mkdirSync(directory)
      fs.writeFileSync(input, 'before')
      beginInputRecording({ digests: true })
      try {
        const engine = inputEngineFileSystem({
          fs: service,
          source: { module: '@overeng/genie/src/core/read-set.integration.test.ts', line: null },
        })
        const readDirectory = engine.readDirectory(directory)
        const readLink = engine.readLink(input)
        const realPath = engine.realPath(input)
        const stat = engine.stat(input)
        const readFile = engine.readFile(input)
        const readFileString = engine.readFileString(input)
        expect(getInputRecording()!.paths.size).toBe(0)
        fs.rmdirSync(directory)
        fs.unlinkSync(input)
        expect(Exit.isFailure(yield* Effect.exit(readDirectory))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(readLink))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(realPath))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(stat))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(readFile))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(readFileString))).toBe(true)
        const evidence = getInputRecording()!.evidence!
        expect(evidence.directories.get(directory)).toMatchObject({
          state: 'absent',
          error: 'ENOENT',
        })
        expect(evidence.symlinks.get(input)).toMatchObject({ state: 'absent', error: 'ENOENT' })
        expect(evidence.files.get(input)).toMatchObject({ state: 'absent', error: 'ENOENT' })
        expect(evidence.stats.get(canonicalJson([input, true]))).toMatchObject({
          state: 'absent',
          error: 'ENOENT',
        })
      } finally {
        endInputRecording()
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('fails closed if a consumed engine outcome changes before post-read enrichment', () =>
    Effect.gen(function* () {
      const service = yield* FileSystem.FileSystem
      const root = yield* service.makeTempDirectoryScoped()
      const input = path.join(root, 'input')
      fs.writeFileSync(input, 'present at consumption')
      beginInputRecording({ digests: true })
      try {
        const engine = inputEngineFileSystem({
          fs: {
            ...service,
            exists: () =>
              Effect.sync(() => {
                fs.unlinkSync(input)
                return true
              }),
          },
          source: { module: '@overeng/genie/src/core/read-set.integration.test.ts', line: null },
        })
        expect(yield* engine.exists(input)).toBe(true)
        expect(getInputRecording()!.reasons).toContainEqual(
          expect.objectContaining({
            code: 'unstable-observation',
            operation: 'engine FileSystem.exists',
            evidence: 'observed',
          }),
        )
      } finally {
        endInputRecording()
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('reports an actual unrecorded engine read with its engine source location', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const input = path.join(root, 'engine-input.txt')
      yield* fs.writeFileString(input, 'engine data')
      beginInputRecording({ digests: true })
      try {
        recordEngineIdentityFiles([fileURLToPath(import.meta.url)])
        const engineFs = auditEngineFileSystem({
          fs,
          source: { module: '@overeng/genie/src/core/read-set.integration.test.ts', line: null },
        })
        expect(yield* engineFs.readFileString(input)).toBe('engine data')
        const reasons = getInputRecording()!.reasons
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toMatchObject({
          code: 'unmediated-fs',
          operation: 'engine FileSystem.readFileString',
          source: { module: '@overeng/genie/src/core/read-set.integration.test.ts' },
          evidence: 'observed',
        })
        expect(reasons[0]!.source.line).toBeGreaterThan(0)
        recordInput(input)
        expect(yield* engineFs.readFileString(input)).toBe('engine data')
        expect(reasons).toHaveLength(1)
      } finally {
        endInputRecording()
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'attributes discovery source bytes only to the generator consuming that projection',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const one = 'one.txt.genie.ts'
        const two = 'two.txt.genie.ts'
        yield* fs.writeFileString(path.join(root, one), 'export default "one"')
        yield* fs.writeFileString(path.join(root, two), 'export default "two"')
        yield* fs.writeFileString(path.join(root, 'unrelated.txt'), 'not a discovery input')
        beginInputRecording({ digests: true })
        recordInputCwd(root)
        try {
          expect((yield* findGenieFiles(root)).toSorted()).toEqual([one, two])
          const recording = getInputRecording()!
          expect(recording.evidence!.files.get(path.join(root, one))).toMatchObject({
            state: 'present',
            by: [one],
            byteLength: Buffer.byteLength('export default "one"'),
          })
          expect(recording.evidence!.files.get(path.join(root, two))).toMatchObject({
            state: 'present',
            by: [two],
            byteLength: Buffer.byteLength('export default "two"'),
          })
          expect(recording.evidence!.files.has(path.join(root, 'unrelated.txt'))).toBe(false)
          expect(recording.evidence!.directories.size).toBe(0)
          expect(recording.paths.has(root)).toBe(false)
          expect([...recording.paths].toSorted()).toEqual(
            [
              ...recording.evidence!.files.keys(),
              ...recording.evidence!.directories.keys(),
            ].toSorted(),
          )
          expect(recording.reasons.some((reason) => reason.operation === 'git discovery')).toBe(
            false,
          )
          const before = recording.evidence!.files.get(path.join(root, one))!
          const peerBefore = recording.evidence!.files.get(path.join(root, two))!
          yield* fs.writeFileString(path.join(root, two), 'export default "changed peer"')
          endInputRecording()
          beginInputRecording({ digests: true })
          yield* findGenieFiles(root)
          const next = getInputRecording()!.evidence!
          expect(next.files.get(path.join(root, one))).toEqual(before)
          expect(next.files.get(path.join(root, two))).not.toEqual(peerBefore)
          expect(next.files.get(path.join(root, two))!.by).toEqual([two])
        } finally {
          endInputRecording()
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'dispatches the original effect without installing a recorder when outputs are absent',
    () =>
      Effect.sync(() => {
        const previous = process.env.GENIE_INPUT_MANIFEST
        delete process.env.GENIE_INPUT_MANIFEST
        try {
          const effect = Effect.sync(() => expect(isInputRecording()).toBe(false))
          expect(withInputManifest({ effect, complete: true })).toBe(effect)
          expect(getInputRecording()).toBeUndefined()
          // No hashing maps/salt/UUID are allocated in path-only mode.
          beginInputRecording()
          expect(getInputRecording()?.evidence).toBeUndefined()
        } finally {
          endInputRecording()
          if (previous === undefined) delete process.env.GENIE_INPUT_MANIFEST
          else process.env.GENIE_INPUT_MANIFEST = previous
        }
      }),
  )

  it.effect('retains bytes, typed inventories, absences, exact stat and symlink inputs', () =>
    Effect.sync(() => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-observations-')))
      try {
        fs.mkdirSync(path.join(root, 'empty'))
        fs.writeFileSync(path.join(root, 'input'), 'bytes')
        const hasSymlink = trySymlink({ target: 'input', link: path.join(root, 'link') })
        beginInputRecording({ digests: true })
        expect(inputReadFileSync(path.join(root, 'input'), 'utf8')).toBe('bytes')
        expect(inputExistsSync(path.join(root, 'absent'))).toBe(false)
        inputReaddirSync(path.join(root, 'empty'))
        inputStatSync(path.join(root, 'input'))
        if (hasSymlink === true) {
          expect(fs.readlinkSync(path.join(root, 'link'))).toBe('input')
          expect(inputRealpathSync(path.join(root, 'link'))).toBe(
            fs.realpathSync(path.join(root, 'input')),
          )
        }
        const evidence = getInputRecording()!.evidence!
        expect(evidence.files.get(path.join(root, 'input'))).toMatchObject({
          state: 'present',
          byteLength: 5,
        })
        expect(evidence.files.get(path.join(root, 'absent'))).toMatchObject({
          state: 'absent',
          error: 'ENOENT',
        })
        expect(evidence.directories.get(path.join(root, 'absent'))).toMatchObject({
          state: 'absent',
          error: 'ENOENT',
        })
        expect(evidence.directories.get(path.join(root, 'empty'))).toMatchObject({
          state: 'present',
          entries: [],
          digest: directoryDigest([]),
        })
        expect([...evidence.stats.values()][0]).toMatchObject({
          state: 'present',
          followSymlinks: true,
          values: { size: '5' },
        })
        if (hasSymlink === true)
          expect(evidence.symlinks.get(path.join(root, 'link'))).toMatchObject({
            state: 'present',
            target: fs.readlinkSync(path.join(root, 'link')),
          })
        fs.writeFileSync(path.join(root, 'input'), 'changed')
        inputReadFileSync(path.join(root, 'input'))
        expect(
          getInputRecording()!.reasons.some((reason) => reason.code === 'unstable-observation'),
        ).toBe(true)
        endInputRecording()
        beginInputRecording({ digests: true })
        expect(getInputRecording()!.paths.size).toBe(0)
      } finally {
        endInputRecording()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }),
  )

  it.effect(
    'preserves numeric, bigint, and missing stat results while recording exact metadata',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'genie-stat-semantics-')),
        )
        try {
          const input = path.join(root, 'input')
          fs.writeFileSync(input, 'bytes')
          beginInputRecording({ digests: true })
          const numeric = inputStatSync(input)
          const exact = inputStatSync(input, { bigint: true })
          expect(numeric).toEqual(fs.statSync(input))
          expect(exact).toEqual(fs.statSync(input, { bigint: true }))
          expect(typeof numeric.size).toBe('number')
          expect(typeof exact.size).toBe('bigint')
          const absent = path.join(root, 'absent')
          expect(inputStatSync(absent, { throwIfNoEntry: false })).toBeUndefined()
          expect(inputStatSync(absent, { bigint: true, throwIfNoEntry: false })).toBeUndefined()
          expect(() => inputStatSync(absent)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
          expect(() => inputStatSync(path.join(input, 'child'))).toThrow(
            expect.objectContaining({ code: 'ENOTDIR' }),
          )
          expect(
            inputStatSync(path.join(input, 'child'), { throwIfNoEntry: false }),
          ).toBeUndefined()
          expect(
            getInputRecording()!.evidence!.stats.get(canonicalJson([input, true])),
          ).toMatchObject({
            state: 'present',
            values: {
              size: '5',
              mtimeNs: exact.mtimeNs.toString(),
              ctimeNs: exact.ctimeNs.toString(),
            },
          })
          expect(
            getInputRecording()!.evidence!.stats.get(canonicalJson([absent, true])),
          ).toMatchObject({ state: 'absent', error: 'ENOENT' })
          expect(getInputRecording()!.reasons).toEqual([])
        } finally {
          endInputRecording()
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    'retains a consumed stat disagreement when the original state is restored before revalidation',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-stat-race-')))
        try {
          fs.writeFileSync(path.join(root, 'input'), 'original')
          fs.writeFileSync(path.join(root, 'changed'), 'changed and longer')
          const readersUrl = new URL('../runtime/node/inputs.ts', import.meta.url).href
          const result = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
        import assert from 'node:assert/strict'
        import fs from 'node:fs'
        import { syncBuiltinESMExports } from 'node:module'
        import path from 'node:path'
        const input = path.join(process.argv[1], 'input')
        const changed = path.join(process.argv[1], 'changed')
        const stat = fs.statSync
        const consumed = { bigint: false, throwIfNoEntry: false }
        const originalError = Object.assign(new Error('original stat failure'), { code: 'EACCES' })
        let outcome = 'changed'
        let returned
        fs.statSync = new Proxy(stat, {
          apply(target, receiver, args) {
            if (args[0] === input && args[1] === consumed) {
              if (outcome === 'error') throw originalError
              returned = outcome === 'missing' ? undefined : Reflect.apply(target, receiver, [changed, args[1]])
              return returned
            }
            return Reflect.apply(target, receiver, args)
          },
        })
        syncBuiltinESMExports()
        // Import after patching: this regression intentionally exercises the
        // module-loading boundary so the wrapper captures the controlled target.
        const { beginInputRecording, endInputRecording, getInputRecording, inputStatSync } = await import(${canonicalJson(readersUrl)})
        for (const bigint of [false, true]) {
          consumed.bigint = bigint
          for (const nextOutcome of ['changed', 'missing', 'error']) {
            outcome = nextOutcome
            beginInputRecording({ digests: true })
            if (outcome === 'error') assert.throws(() => inputStatSync(input, consumed), error => error === originalError)
            else assert.equal(inputStatSync(input, consumed), returned)
            // Every probe, including a second complete observation, sees A again.
            assert.equal(inputStatSync(input, { bigint }).size, stat(input, { bigint }).size)
            assert.equal(getInputRecording().reasons.some(reason => reason.code === 'unstable-observation' && reason.operation === 'statSync'), true)
            endInputRecording()
          }
        }
      `,
              root,
            ],
            { encoding: 'utf8' },
          )
          expect(result.status, result.stdout + result.stderr).toBe(0)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect(
    'captures read-only inventories under Bun whether non-Unicode names are supported or rejected',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'genie-readonly-observations-')),
        )
        const directory = path.join(root, 'dependency')
        const empty = path.join(directory, 'empty')
        try {
          fs.mkdirSync(empty, { recursive: true })
          fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../worktrees/dependency\n')
          fs.writeFileSync(path.join(directory, 'input.txt'), 'bytes')
          const hasSymlink = trySymlink({ target: 'missing', link: path.join(directory, 'link') })
          fs.chmodSync(empty, 0o555)
          fs.chmodSync(directory, 0o555)
          const observationsPath = fileURLToPath(
            new URL('../runtime/node/input-observations.ts', import.meta.url),
          )
          const result = spawnSync(
            'bun',
            [
              '-e',
              `
        import assert from 'node:assert/strict'
        import * as fs from 'node:fs'
        import path from 'node:path'
        import { makeInputRecording, capturePath, directoryDigest } from ${canonicalJson(observationsPath)}
        const directory = process.argv[1]
        const hasSymlink = process.argv[2] === 'true'
        // chmod alone does not prove access is denied: root can bypass mode bits.
        const probe = path.join(directory, 'permission-probe')
        let writeDenied = false
        try {
          fs.writeFileSync(probe, 'probe')
        } catch (error) {
          assert.equal(['EACCES', 'EPERM'].includes(error.code), true)
          writeDenied = true
        }
        if (writeDenied === true) {
          assert.equal(fs.existsSync(probe), false)
        } else {
          assert.equal(fs.readFileSync(probe, 'utf8'), 'probe')
          fs.unlinkSync(probe)
        }
        assert.equal(fs.existsSync(probe), false)
        assert.equal(fs.statSync(directory).mode & 0o777, 0o555)
        assert.equal(fs.statSync(path.join(directory, 'empty')).mode & 0o777, 0o555)
        const recording = makeInputRecording({ digests: true })
        capturePath({ recording, input: directory })
        capturePath({ recording, input: path.join(directory, 'empty') })
        const entries = [
          { name: '.git', type: 'file' }, { name: 'empty', type: 'directory' },
          { name: 'input.txt', type: 'file' },
          ...(hasSymlink === true ? [{ name: 'link', type: 'symlink' }] : []),
        ]
        assert.deepEqual(recording.evidence.directories.get(directory), {
          path: directory, by: [], state: 'present', entries, digest: directoryDigest(entries),
        })
        assert.deepEqual(recording.evidence.directories.get(path.join(directory, 'empty')).entries, [])
        assert.deepEqual(recording.reasons, [])
        if (hasSymlink === true) {
          const link = path.join(directory, 'link')
          assert.equal(fs.readlinkSync(link), 'missing')
          assert.throws(() => fs.realpathSync(link), { code: 'ENOENT' })
          capturePath({ recording, input: link })
          assert.deepEqual(recording.evidence.symlinks.get(link), {
            path: link, by: [], state: 'present', target: fs.readlinkSync(link),
          })
          assert.deepEqual(recording.reasons, [])
        }
        assert.equal(fs.statSync(directory).mode & 0o777, 0o555)
        assert.equal(fs.statSync(path.join(directory, 'empty')).mode & 0o777, 0o555)
        // Probe raw names only after every normal read-only assertion has run.
        fs.chmodSync(directory, 0o755)
        const invalidName = Buffer.from([0xff])
        const invalidPath = Buffer.concat([Buffer.from(directory + path.sep), invalidName])
        let rejectsInvalidName = false
        try {
          fs.writeFileSync(invalidPath, '')
        } catch (error) {
          assert.equal(error.code, 'EILSEQ')
          rejectsInvalidName = true
        }
        const rawEntries = fs.readdirSync(directory, { encoding: 'buffer' })
        if (rejectsInvalidName === true) {
          // APFS rejects this filename at creation, rather than at capture.
          assert.equal(rawEntries.some(name => name.equals(invalidName)), false)
          assert.deepEqual(
            rawEntries.map(name => name.toString('hex')).sort(),
            entries.map(entry => Buffer.from(entry.name).toString('hex')).sort(),
          )
          const valid = makeInputRecording({ digests: true })
          capturePath({ recording: valid, input: directory })
          assert.deepEqual(valid.evidence.directories.get(directory).entries, entries)
          assert.deepEqual(valid.reasons, [])
        } else {
          assert.equal(rawEntries.some(name => name.equals(invalidName)), true)
          const invalid = makeInputRecording({ digests: true })
          capturePath({ recording: invalid, input: directory })
          assert.equal(invalid.evidence.directories.has(directory), false)
          assert.equal(invalid.reasons.some(reason => reason.code === 'capture-error'), true)
        }
      `,
              directory,
              String(hasSymlink),
            ],
            { encoding: 'utf8' },
          )
          expect(result.status, result.stdout + result.stderr).toBe(0)
        } finally {
          fs.chmodSync(directory, 0o755)
          fs.chmodSync(empty, 0o755)
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect(
    'fails closed when a listed child disappears before its type is observed',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'genie-directory-race-')),
        )
        try {
          fs.writeFileSync(path.join(root, 'child'), 'bytes')
          const observationsUrl = new URL('../runtime/node/input-observations.ts', import.meta.url)
            .href
          const result = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
        import assert from 'node:assert/strict'
        import fs from 'node:fs'
        import { syncBuiltinESMExports } from 'node:module'
        import path from 'node:path'
        import { makeInputRecording, capturePath } from ${canonicalJson(observationsUrl)}
        const directory = process.argv[1]
        const recording = makeInputRecording({ digests: true })
        capturePath({ recording, input: directory })
        assert.equal(recording.evidence.directories.get(directory).state, 'present')
        const readdir = fs.readdirSync
        fs.readdirSync = new Proxy(readdir, {
          apply(target, receiver, args) {
            const entries = Reflect.apply(target, receiver, args)
            if (args[0] === directory) fs.unlinkSync(path.join(directory, 'child'))
            return entries
          },
        })
        syncBuiltinESMExports()
        capturePath({ recording, input: directory })
        assert.equal(fs.existsSync(directory), true)
        assert.equal(recording.evidence.directories.has(directory), false)
        assert.equal(recording.evidence.files.has(directory), false)
        assert.equal(recording.reasons.some(reason => reason.code === 'capture-error'), true)
      `,
              root,
            ],
            { encoding: 'utf8' },
          )
          expect(result.status, result.stdout + result.stderr).toBe(0)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect('distinguishes ENOTDIR from ENOENT and fails closed on capture errors', () =>
    Effect.sync(() => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'genie-observation-errors-')),
      )
      try {
        fs.writeFileSync(path.join(root, 'file'), '')
        beginInputRecording({ digests: true })
        recordInput(path.join(root, 'file', 'child'))
        expect(
          getInputRecording()!.evidence!.files.get(path.join(root, 'file', 'child')),
        ).toMatchObject({ state: 'absent', error: 'ENOTDIR' })
        recordInput(path.join(root, '\0invalid'))
        expect(getInputRecording()!.reasons.some((reason) => reason.code === 'capture-error')).toBe(
          true,
        )
      } finally {
        endInputRecording()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }),
  )

  it.effect('salts every environment value, preserving unset and empty without plaintext', () =>
    Effect.sync(() => {
      const name = 'GENIE_READ_SET_TEST_VALUE'
      const previous = process.env[name]
      try {
        for (const value of [undefined, '', 'private fixture value']) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
          beginInputRecording({ digests: true })
          expect(recordInputEnvironment(name)).toBe(value)
          const evidence = getInputRecording()!.evidence!
          expect(evidence.environment.get(name)).toEqual(
            value === undefined
              ? { name, by: [], present: false }
              : {
                  name,
                  by: [],
                  present: true,
                  digest: environmentDigest({ salt: evidence.envSalt, name: name, value: value }),
                },
          )
          expect(canonicalJson([...evidence.environment.values()])).not.toContain(
            'private fixture value',
          )
          endInputRecording()
        }
      } finally {
        endInputRecording()
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }),
  )

  it.effect(
    'publishes one successful recording, exact legacy projection and expanded private reports',
    () =>
      Effect.sync(() => {
        const { root, artifact, manifest, run } = fixture()
        try {
          const result = run(['--check', '--read-set', artifact])
          expect(result.status, result.stdout + result.stderr).toBe(0)
          const readSet = validateReadSet(decode(fs.readFileSync(artifact, 'utf8')))
          expect(readSet.checkSucceeded).toBe(true)
          expect(readSet.complete).toBe(false)
          expect(readSet.generatorResults.map((entry) => entry.generator)).toEqual([
            'one.txt.genie.ts',
            'two.txt.genie.ts',
          ])
          expect(
            readSet.generatorResults.every((entry) => entry.outputDigest.startsWith('sha256:')),
          ).toBe(true)
          const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n')
          expect(lines[0]).toBe('genie-inputs-v1')
          expect(lines.slice(1).sort()).toEqual(
            [
              ...new Set([...readSet.files, ...readSet.directories].map((entry) => entry.path)),
            ].sort(),
          )
          expect(
            readSet.files.find((entry) => entry.path === path.join(root, 'optional.txt')),
          ).toMatchObject({ state: 'absent' })
          expect(
            readSet.reasons.find(
              (reason) => reason.code === 'dynamic-import' && reason.source.module === 'shared.ts',
            ),
          ).toMatchObject({ generators: ['one.txt.genie.ts', 'two.txt.genie.ts'] })
          expect(
            readSet.reasons.some(
              (reason) =>
                reason.code === 'unknown-capability' && reason.source.module === 'shared.ts',
            ),
          ).toBe(false)
          expect(
            readSet.resolutions.find(
              (entry) =>
                entry.importer === path.join(root, 'one.txt.genie.ts') &&
                entry.specifier === './shared.ts',
            ),
          ).toMatchObject({
            outcome: {
              kind: 'file',
              lexical: path.join(root, 'shared.ts'),
              physical: path.join(root, 'shared.ts'),
            },
          })
          expect(
            readSet.resolutions.some(
              (entry) => entry.outcome.kind === 'builtin' && entry.outcome.name === 'node:fs',
            ),
          ).toBe(true)
          const metadata = decodeMetadata(fs.readFileSync(`${manifest}.meta.json`, 'utf8'))
          expect(metadata).toMatchObject({
            invocationId: readSet.invocationId,
            legacyComplete: true,
            readSetComplete: readSet.complete,
            digestEvidence: true,
          })
          const report = decodeReport(fs.readFileSync(`${artifact}.reasons.json`, 'utf8'))
          expect(report).toMatchObject({
            invocationId: readSet.invocationId,
            reasons: readSet.reasons,
          })
          expect(report.groups.reduce((count, group) => count + group.occurrences, 0)).toBe(
            report.reasons.length,
          )
          expect(
            report.groups.find(
              (group) => group.code === 'dynamic-import' && group.source.module === 'shared.ts',
            ),
          ).toMatchObject({
            generators: ['one.txt.genie.ts', 'two.txt.genie.ts'],
          })
          for (const file of [
            artifact,
            manifest,
            `${manifest}.meta.json`,
            `${artifact}.reasons.json`,
          ])
            expect(fs.statSync(file).mode & 0o777).toBe(0o600)
          expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect(
    'rejects metadata from a previous real check while accepting the current recording pair',
    () =>
      Effect.sync(() => {
        const { root, artifact, manifest, run } = fixture()
        try {
          const first = run(['--check', '--read-set', artifact])
          expect(first.status, first.stdout + first.stderr).toBe(0)
          const oldMetadata = decodeMetadata(fs.readFileSync(`${manifest}.meta.json`, 'utf8'))
          const second = run(['--check', '--read-set', artifact])
          expect(second.status, second.stdout + second.stderr).toBe(0)
          const readSet = decode(fs.readFileSync(artifact, 'utf8'))
          const metadata = decodeMetadata(fs.readFileSync(`${manifest}.meta.json`, 'utf8'))
          expect(readSet.invocationId).not.toBe(oldMetadata.invocationId)
          expect(() => validateReadSetPair({ readSet, metadata: oldMetadata })).toThrow()
          expect(validateReadSetPair({ readSet, metadata })).toEqual(readSet)
          expect(readSet.complete).toBe(false)
          expect(metadata.legacyComplete).toBe(true)
          expect(metadata.readSetComplete).toBe(false)
          expect(() =>
            validateReadSetPair({ readSet, metadata: { ...metadata, readSetComplete: true } }),
          ).toThrow()
          expect(() =>
            validateReadSetPair({ readSet, metadata: { ...metadata, readSetComplete: null } }),
          ).toThrow()
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect(
    'removes stale successful artifacts when one generator fails the combined check',
    () =>
      Effect.sync(() => {
        const { root, artifact, manifest, run } = fixture()
        try {
          const first = run(['--check', '--read-set', artifact])
          expect(first.status, first.stdout + first.stderr).toBe(0)
          fs.writeFileSync(path.join(root, 'one.txt'), 'drift')
          const failed = run(['--check', '--read-set', artifact])
          expect(failed.status).not.toBe(0)
          for (const file of [
            artifact,
            manifest,
            `${manifest}.meta.json`,
            `${artifact}.reasons.json`,
          ])
            expect(fs.existsSync(file)).toBe(false)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  for (const collision of [
    'same output',
    'manifest at read-set companion',
    'read-set at manifest companion',
  ]) {
    it.effect(
      `removes stale artifacts after a collision: ${collision}`,
      () =>
        Effect.sync(() => {
          const { root, artifact, manifest, run } = fixture()
          const readSetPath =
            collision === 'read-set at manifest companion' ? `${manifest}.meta.json` : artifact
          const manifestPath =
            collision === 'same output'
              ? artifact
              : collision === 'manifest at read-set companion'
                ? `${artifact}.reasons.json`
                : manifest
          const outputs = [
            readSetPath,
            `${readSetPath}.reasons.json`,
            manifestPath,
            `${manifestPath}.meta.json`,
          ]
          const unrelated = `${readSetPath}.reasons.json.meta.json.reasons.json`
          try {
            const first = run(['--check', '--read-set', readSetPath], false)
            expect(first.status, first.stdout + first.stderr).toBe(0)
            expect(fs.existsSync(readSetPath)).toBe(true)
            expect(fs.existsSync(`${readSetPath}.reasons.json`)).toBe(true)
            fs.writeFileSync(unrelated, 'not a requested output or companion')
            const failed = run(['--check', '--read-set', readSetPath], true, manifestPath)
            expect(failed.status).not.toBe(0)
            expect(failed.stdout + failed.stderr).toContain('Output destinations must be distinct')
            for (const file of outputs) expect(fs.existsSync(file)).toBe(false)
            expect(fs.readFileSync(unrelated, 'utf8')).toBe('not a requested output or companion')
            expect(fs.readFileSync(path.join(root, 'runtime.txt'), 'utf8')).toBe('input\n')
          } finally {
            fs.rmSync(root, { recursive: true, force: true })
          }
        }),
      60_000,
    )
  }

  it.effect(
    'fails publication without retaining earlier evidence or temporary files',
    () =>
      Effect.sync(() => {
        const { root, artifact, manifest, run } = fixture()
        try {
          const result = run([
            '--check',
            '--read-set',
            path.join(root, 'missing-parent', 'evidence.json'),
          ])
          expect(result.status).not.toBe(0)
          expect(fs.existsSync(manifest)).toBe(false)
          expect(fs.existsSync(artifact)).toBe(false)
          expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.effect(
    'invocation-local caches preserve inventory and symlink conflicts instead of reusing stale evidence',
    () =>
      Effect.sync(() => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cache-stability-')),
        )
        const directory = path.join(root, 'inventory')
        const link = path.join(root, 'link')
        try {
          fs.mkdirSync(directory)
          fs.writeFileSync(path.join(directory, 'entry'), 'first')
          fs.writeFileSync(path.join(root, 'a'), 'same')
          fs.writeFileSync(path.join(root, 'b'), 'same')
          const hasSymlink = trySymlink({ target: 'a', link })
          beginInputRecording({ digests: true })
          inputReaddirSync(directory)
          inputReaddirSync(directory)
          const firstInventory = getInputRecording()!.evidence!.directories.get(directory)
          fs.unlinkSync(path.join(directory, 'entry'))
          fs.mkdirSync(path.join(directory, 'entry'))
          inputReaddirSync(directory)
          expect(getInputRecording()!.evidence!.directories.get(directory)).toEqual(firstInventory)
          expect(
            getInputRecording()!.reasons.some((reason) => reason.code === 'unstable-observation'),
          ).toBe(true)
          if (hasSymlink === true) {
            expect(fs.readlinkSync(link)).toBe('a')
            expect(inputRealpathSync(link)).toBe(fs.realpathSync(path.join(root, 'a')))
            expect(inputRealpathSync(link)).toBe(fs.realpathSync(path.join(root, 'a')))
            fs.unlinkSync(link)
            fs.symlinkSync('b', link)
            expect(fs.readlinkSync(link)).toBe('b')
            expect(inputRealpathSync(link)).toBe(fs.realpathSync(path.join(root, 'b')))
            expect(getInputRecording()!.evidence!.symlinks.get(link)).toMatchObject({
              state: 'present',
              target: 'a',
            })
            expect(
              getInputRecording()!.reasons.some(
                (reason) => reason.code === 'unstable-observation' && reason.detail.includes(link),
              ),
            ).toBe(true)
          }
          endInputRecording()
          beginInputRecording({ digests: true })
          inputReaddirSync(directory)
          if (hasSymlink === true) inputRealpathSync(link)
          expect(getInputRecording()!.evidence!.directories.get(directory)).toMatchObject({
            state: 'present',
            entries: [{ name: 'entry', type: 'directory' }],
          })
          if (hasSymlink === true)
            expect(getInputRecording()!.evidence!.symlinks.get(link)).toMatchObject({
              state: 'present',
              target: fs.readlinkSync(link),
            })
          expect(getInputRecording()!.reasons).toEqual([])
        } finally {
          endInputRecording()
          fs.rmSync(root, { recursive: true, force: true })
        }
      }),
  )
})
