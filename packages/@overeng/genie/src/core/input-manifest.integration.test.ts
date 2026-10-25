import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { it as effectIt } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  digestBytes,
  environmentDigest,
  reasonCodes,
} from '../runtime/node/input-observations.ts'
import {
  beginInputRecording,
  endInputRecording,
  getInputRecording,
  recordInput,
  recordInputCwd,
  recordInputEnvironment,
} from '../runtime/node/inputs.ts'
import { ReadSetSchema, validateReadSet } from './read-set.ts'

const decodeReasons = Schema.decodeSync(Schema.fromJsonString(ReadSetSchema.fields.reasons))
const decodeRecordedReadSet = Schema.decodeSync(Schema.fromJsonString(ReadSetSchema))

const cliPath = fileURLToPath(new URL('../../bin/genie.tsx', import.meta.url))
const readersPath = fileURLToPath(new URL('../runtime/node/inputs.ts', import.meta.url))
const repoContextPath = fileURLToPath(new URL('../runtime/repo-context/mod.ts', import.meta.url))
const generatedText = (body: string) =>
  `// Generated file - DO NOT EDIT\n// Source: result.txt.genie.ts\n${body}`

const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-input-manifest-')))
  const manifest = path.join(root, 'inputs.manifest')
  mkdirSync(path.join(root, '.git'))
  writeFileSync(path.join(root, 'input.txt'), 'first\n')
  writeFileSync(
    path.join(root, 'helper.ts'),
    `
import { defineRepoContext } from ${JSON.stringify(repoContextPath)}
import { inputExistsSync, inputReaddirSync, inputStatSync } from ${JSON.stringify(readersPath)}
const repo = defineRepoContext({ name: 'fixture', importMetaUrl: import.meta.url })
// Intentionally TS-only generic arrow syntax: the scanner must not parse .ts as TSX.
const passthrough = <TValue>(value: TValue): TValue => value
export const read = () => {
  inputReaddirSync(repo.rootPath)
  inputStatSync(repo.resolve('input.txt'))
  return passthrough(repo.readText('input.txt')) + (inputExistsSync(repo.resolve('optional.txt')) ? repo.readText('optional.txt') : '')
}
`,
  )
  writeFileSync(
    path.join(root, 'result.txt.genie.ts'),
    `
import { read } from './helper.ts'
export default { data: {}, stringify: () => read() }
`,
  )
  const run = (args: string[] = [], enabled = true) =>
    spawnSync('bun', [cliPath, '--cwd', root, '--writeable', '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GENIE_INPUT_MANIFEST: enabled === true ? manifest : '',
        XDG_STATE_HOME: path.join(root, 'state'),
      },
    })
  return { root, manifest, run }
}

describe('generator input manifests', () => {
  it('records transitive helpers, real reads, directory probes and missing optional inputs across CLI runs', () => {
    const { root, manifest, run } = fixture()
    try {
      const first = run()
      expect(first.status, first.stdout + first.stderr).toBe(0)
      const lines = readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(lines[0]).toBe('genie-inputs-v1')
      expect(lines.slice(1)).toEqual([...new Set(lines.slice(1))].sort())
      expect(lines.slice(1).every((input) => path.isAbsolute(input))).toBe(true)
      for (const input of [
        '',
        'input.txt',
        'optional.txt',
        'helper.ts',
        'result.txt.genie.ts',
        'megarepo.lock',
        'flake.lock',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
      ]) {
        expect(lines).toContain(path.resolve(root, input))
      }
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('first\n'))
      writeFileSync(path.join(root, 'optional.txt'), 'added\n')
      writeFileSync(path.join(root, 'input.txt'), 'changed\n')
      const second = run()
      expect(second.status, second.stdout + second.stderr).toBe(0)
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(
        generatedText('changed\nadded\n'),
      )
      rmSync(path.join(root, 'optional.txt'))
      const third = run()
      expect(third.status, third.stdout + third.stderr).toBe(0)
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('changed\n'))
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['sibling', 'index'])(
    'records resolution directory membership when a higher-priority %s JSX input appears',
    (mode) => {
      const { root, manifest, run } = fixture()
      try {
        const directory = path.join(root, 'sources', ...(mode === 'index' ? ['helper'] : []))
        mkdirSync(directory, { recursive: true })
        const basename = mode === 'index' ? 'index' : 'helper'
        writeFileSync(path.join(directory, `${basename}.ts`), "export const value = 'typescript'\n")
        writeFileSync(
          path.join(root, 'result.txt.genie.ts'),
          "import { value } from './sources/helper'\nexport default { data: {}, stringify: () => value + '\\n' }\n",
        )
        const first = run()
        expect(first.status, first.stdout + first.stderr).toBe(0)
        expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe('genie-inputs-v1')
        // Directory observations include newly introduced resolution alternatives;
        // read-set conservatism does not change legacy source-scan completeness.
        expect(readFileSync(manifest, 'utf8').split('\n')).toContain(directory)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(
          generatedText('typescript\n'),
        )
        const previousMembers = readdirSync(directory)
        writeFileSync(path.join(directory, `${basename}.jsx`), "export const value = 'jsx'\n")
        expect(readdirSync(directory)).not.toEqual(previousMembers)
        const second = run()
        expect(second.status, second.stdout + second.stderr).toBe(0)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('jsx\n'))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it.each([false, true])(
    'records nested recursive directory membership (withFileTypes=%s)',
    (withFileTypes) => {
      const { root, manifest, run } = fixture()
      try {
        const sources = path.join(root, 'sources')
        const nested = path.join(sources, 'nested', 'empty')
        mkdirSync(nested, { recursive: true })
        writeFileSync(
          path.join(root, 'result.txt.genie.ts'),
          `
import { inputReaddirSync } from ${JSON.stringify(readersPath)}
export default { data: {}, stringify: () => inputReaddirSync(${JSON.stringify(sources)}, {
  recursive: true, withFileTypes: ${withFileTypes},
}).map((entry) => typeof entry === 'string' ? entry : entry.name).sort().join('\\n') + '\\n' }
`,
        )
        const first = run()
        expect(first.status, first.stdout + first.stderr).toBe(0)
        const inputs = readFileSync(manifest, 'utf8').trimEnd().split('\n')
        expect(inputs).toContain(sources)
        expect(inputs).toContain(path.dirname(nested))
        expect(inputs).toContain(nested)
        const immediateBefore = readdirSync(sources)
        const previousOutput = readFileSync(path.join(root, 'result.txt'), 'utf8')
        writeFileSync(path.join(nested, 'new.txt'), 'new member')
        expect(readdirSync(sources)).toEqual(immediateBefore)
        const second = run()
        expect(second.status, second.stdout + second.stderr).toBe(0)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).not.toBe(previousOutput)
        expect(readFileSync(manifest, 'utf8').split('\n')).toContain(path.join(nested, 'new.txt'))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it('follows a bare workspace package symlink and records its source and export metadata', () => {
    const { root, manifest, run } = fixture()
    try {
      const localPackage = path.join(root, 'local-helper')
      mkdirSync(localPackage)
      mkdirSync(path.join(root, 'node_modules'))
      writeFileSync(
        path.join(localPackage, 'package.json'),
        '{"name":"fixture-helper","exports":"./index.ts"}\n',
      )
      writeFileSync(path.join(localPackage, 'index.ts'), "export { read } from '../helper.ts'\n")
      symlinkSync(localPackage, path.join(root, 'node_modules', 'fixture-helper'), 'dir')
      writeFileSync(
        path.join(root, 'result.txt.genie.ts'),
        `
import { read } from 'fixture-helper'
export default { data: {}, stringify: () => read() }
`,
      )
      const result = run()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const inputs = readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(inputs).toContain(path.join(localPackage, 'index.ts'))
      expect(inputs).toContain(path.join(localPackage, 'package.json'))
      expect(inputs).toContain(path.join(root, 'node_modules', 'fixture-helper', 'package.json'))
      expect(inputs).toContain(path.join(root, 'helper.ts'))
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('first\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['dynamic', 'require'])(
    'preserves caught optional %s imports and records absent-to-present inputs',
    (mode) => {
      const { root, manifest, run } = fixture()
      try {
        writeFileSync(
          path.join(root, 'result.txt.genie.ts'),
          `
// Intentionally load an optional module: a static import cannot be caught.
let value = 'absent'
try {
  value = ${mode === 'dynamic' ? "(await import('./optional.ts')).value" : "require('./optional.ts').value"}
} catch {}
export default { data: {}, stringify: () => value + '\\n' }
`,
        )
        const absent = run()
        expect(absent.status, absent.stdout + absent.stderr).toBe(0)
        expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe('genie-inputs-incomplete')
        const optional = path.join(root, 'optional.ts')
        expect(readFileSync(manifest, 'utf8').split('\n')).toContain(optional)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('absent\n'))
        writeFileSync(optional, "export const value = 'present'\n")
        const present = run()
        expect(present.status, present.stdout + present.stderr).toBe(0)
        expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe('genie-inputs-v1')
        expect(readFileSync(manifest, 'utf8').split('\n')).toContain(optional)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('present\n'))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it('fails cache publication closed for a missing optional bare-package export target', () => {
    const { root, manifest, run } = fixture()
    try {
      const localPackage = path.join(root, 'local-helper')
      mkdirSync(path.join(localPackage, 'lib'), { recursive: true })
      mkdirSync(path.join(root, 'node_modules'))
      writeFileSync(
        path.join(localPackage, 'package.json'),
        JSON.stringify({
          name: 'fixture-helper',
          exports: { './optional': './lib/optional.ts' },
        }),
      )
      symlinkSync(localPackage, path.join(root, 'node_modules', 'fixture-helper'), 'dir')
      writeFileSync(
        path.join(root, 'result.txt.genie.ts'),
        `
// Optional package export target deliberately does not exist on the first run.
let value = 'absent'
try {
  value = (await import('fixture-helper/optional')).value
} catch {}
export default { data: {}, stringify: () => value + '\\n' }
`,
      )
      const absent = run()
      expect(absent.status, absent.stdout + absent.stderr).toBe(0)
      expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe('genie-inputs-incomplete')
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('absent\n'))
      const previousPackageEntries = readdirSync(localPackage)
      const optional = path.join(localPackage, 'lib', 'optional.ts')
      writeFileSync(optional, "export const value = 'present'\n")
      expect(readdirSync(localPackage)).toEqual(previousPackageEntries)
      const present = run()
      expect(present.status, present.stdout + present.stderr).toBe(0)
      const inputs = readFileSync(manifest, 'utf8').split('\n')
      expect(inputs[0]).toBe('genie-inputs-v1')
      expect(inputs).toContain(optional)
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe(generatedText('present\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('records handwritten workspace package census directories and manifests without importing them', () => {
    const { root, manifest, run } = fixture()
    try {
      const packages = path.join(root, 'packages')
      const firstDirectory = path.join(packages, 'first')
      const firstManifest = path.join(firstDirectory, 'package.json')
      mkdirSync(firstDirectory, { recursive: true })
      writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-root","private":true}\n')
      writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
      writeFileSync(firstManifest, '{"name":"fixture-first","version":"1.0.0"}\n')
      const first = run()
      expect(first.status, first.stdout + first.stderr).toBe(0)
      const firstInputs = readFileSync(manifest, 'utf8').split('\n')
      expect(firstInputs[0]).toBe('genie-inputs-v1')
      expect(firstInputs).toContain(packages)
      expect(firstInputs).toContain(firstDirectory)
      expect(firstInputs).toContain(firstManifest)
      expect(existsSync(path.join(firstDirectory, 'package.json.genie.ts'))).toBe(false)

      writeFileSync(firstManifest, '{"name":"fixture-first","version":"2.0.0"}\n')
      const secondDirectory = path.join(packages, 'second')
      const secondManifest = path.join(secondDirectory, 'package.json')
      mkdirSync(secondDirectory)
      writeFileSync(secondManifest, '{"name":"fixture-second","version":"1.0.0"}\n')
      const second = run()
      expect(second.status, second.stdout + second.stderr).toBe(0)
      const secondInputs = readFileSync(manifest, 'utf8').split('\n')
      expect(secondInputs[0]).toBe('genie-inputs-v1')
      for (const input of [
        packages,
        firstDirectory,
        firstManifest,
        secondDirectory,
        secondManifest,
      ]) {
        expect(secondInputs).toContain(input)
      }
      expect(existsSync(path.join(secondDirectory, 'package.json.genie.ts'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not publish without opt-in, on dry/partial runs, or after a failed generation', () => {
    const { root, manifest, run } = fixture()
    try {
      const ordinary = run([], false)
      expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0)
      expect(existsSync(manifest)).toBe(false)
      writeFileSync(manifest, 'previous successful manifest\n')
      for (const args of [['--dry-run'], ['--phase', 'bootstrap']]) {
        const result = run(args)
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(readFileSync(manifest, 'utf8')).toBe('previous successful manifest\n')
      }
      writeFileSync(path.join(root, 'result.txt.genie.ts'), "throw new Error('fixture failed')\n")
      expect(run().status).not.toBe(0)
      expect(existsSync(manifest)).toBe(false)
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('historical input manifest completeness parity', () => {
  const scannerPath = fileURLToPath(new URL('./input-manifest.ts', import.meta.url))
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
  const cases = [
    {
      name: 'source read failure',
      source: undefined,
      imports: {},
      legacyComplete: false,
      operation: 'source-scan',
    },
    {
      name: 'source scan failure',
      source: 'export const value = "unterminated\n',
      imports: {},
      legacyComplete: false,
      operation: 'source-scan',
    },
    {
      name: 'import-map resolution failure',
      source: "import '#broken'\nexport default {}\n",
      imports: { '#broken': 42 },
      legacyComplete: false,
      operation: 'import-map-resolution',
    },
    {
      name: 'unresolved optional import',
      source: "try { await import('./optional.ts') } catch {}\nexport default {}\n",
      imports: {},
      legacyComplete: false,
      operation: 'resolve:./optional.ts',
    },
    {
      name: 'successful scan with unproven subprocess capability',
      source: "import { spawnSync } from 'node:child_process'\nexport const run = spawnSync\n",
      imports: {},
      legacyComplete: true,
      operation: undefined,
    },
  ]
  for (const { name, source, imports, legacyComplete, operation } of cases) {
    effectIt.effect(
      `preserves the historical header for ${name}`,
      () =>
        Effect.sync(() => {
          const { root, manifest } = fixture()
          try {
            const entry = 'parity.ts'
            if (source !== undefined) writeFileSync(path.join(root, entry), source)
            writeFileSync(path.join(root, 'package.json'), canonicalJson({ imports }))
            // Scan only: malformed, missing, and unresolvable sources must never be imported.
            const result = spawnSync(
              'bun',
              [
                '-e',
                `
import { Effect } from ${canonicalJson(import.meta.resolve('effect'))}
import { recordGeneratorSourceGraph, withInputManifest } from ${canonicalJson(scannerPath)}
import { getInputRecording } from ${canonicalJson(readersPath)}
await Effect.runPromise(withInputManifest({
  complete: true,
  effect: Effect.promise(async () => {
    await recordGeneratorSourceGraph({ entries: [${canonicalJson(entry)}], cwd: process.cwd() })
    console.log(JSON.stringify(getInputRecording().reasons))
  }),
}))
`,
              ],
              {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, GENIE_INPUT_MANIFEST: manifest },
              },
            )
            expect(result.status, result.stdout + result.stderr).toBe(0)
            expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe(
              legacyComplete === true ? 'genie-inputs-v1' : 'genie-inputs-incomplete',
            )
            expect(decodeMetadata(readFileSync(`${manifest}.meta.json`, 'utf8'))).toMatchObject({
              legacyComplete,
              readSetComplete: null,
              digestEvidence: false,
            })
            const reasons = decodeReasons(result.stdout.trim())
            if (operation !== undefined)
              expect(reasons).toContainEqual(
                expect.objectContaining({ operation, evidence: 'unproven' }),
              )
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }),
      60_000,
    )
  }

  effectIt.effect(
    'publishes a historically complete mediated generation paired with an incomplete read-set',
    () =>
      Effect.sync(() => {
        const { root, manifest, run } = fixture()
        try {
          const generated = run()
          expect(generated.status, generated.stdout + generated.stderr).toBe(0)
          const artifact = path.join(root, 'paired.read-set.json')
          const checked = run(['--check', '--read-set', artifact])
          expect(checked.status, checked.stdout + checked.stderr).toBe(0)
          const evidence = validateReadSet(decodeRecordedReadSet(readFileSync(artifact, 'utf8')))
          const metadata = decodeMetadata(readFileSync(`${manifest}.meta.json`, 'utf8'))
          expect(readFileSync(manifest, 'utf8').split('\n')[0]).toBe('genie-inputs-v1')
          expect(metadata).toMatchObject({
            invocationId: evidence.invocationId,
            legacyComplete: true,
            readSetComplete: false,
            digestEvidence: true,
          })
          expect(evidence.complete).toBe(false)
          expect(evidence.reasons).toContainEqual(
            expect.objectContaining({
              code: 'unknown-capability',
              operation: 'capability-import',
              evidence: 'unproven',
            }),
          )
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    // The paired capture includes the complete engine and dependency closure.
    120_000,
  )
})

// Producer evidence only: none of these comparisons validates current state for a
// consumer, authorizes reuse, or proves an unrestricted closure complete.
describe('recording-only mutation matrix', () => {
  const decodeReadSet = Schema.decodeSync(Schema.fromJsonString(ReadSetSchema))
  const recordingFixture = () => {
    const { root, run } = fixture()
    const artifact = path.join(root, 'evidence.json')
    const capture = () => {
      const generated = run([], false)
      expect(generated.status, generated.stdout + generated.stderr).toBe(0)
      const checked = run(['--check', '--read-set', artifact], false)
      expect(checked.status, checked.stdout + checked.stderr).toBe(0)
      const evidence = validateReadSet(decodeReadSet(readFileSync(artifact, 'utf8')))
      expect(evidence.complete).toBe(false)
      expect(evidence.checkSucceeded).toBe(true)
      return evidence
    }
    return { root, capture }
  }

  effectIt.effect(
    'transitive imported helper bytes change the recorded file digest',
    () =>
      Effect.sync(() => {
        const { root, capture } = recordingFixture()
        try {
          const helper = path.join(root, 'transitive.ts')
          writeFileSync(helper, "export const value = 'first\\n'\n")
          writeFileSync(path.join(root, 'helper.ts'), "export { value } from './transitive.ts'\n")
          writeFileSync(
            path.join(root, 'result.txt.genie.ts'),
            "import { value } from './helper.ts'\nexport default { data: {}, stringify: () => value }\n",
          )
          const first = capture()
          writeFileSync(helper, "export const value = 'second\\n'\n")
          const second = capture()
          expect(first.files.find((entry) => entry.path === helper)).toMatchObject({
            state: 'present',
            digest: digestBytes("export const value = 'first\\n'\n"),
            by: ['result.txt.genie.ts'],
          })
          expect(second.files.find((entry) => entry.path === helper)).toMatchObject({
            state: 'present',
            digest: digestBytes(readFileSync(helper)),
            by: ['result.txt.genie.ts'],
          })
          expect(second.files.find((entry) => entry.path === helper)).not.toEqual(
            first.files.find((entry) => entry.path === helper),
          )
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  effectIt.effect(
    'validator-only mediated input bytes change evidence without changing outputDigest',
    () =>
      Effect.sync(() => {
        const { root, capture } = recordingFixture()
        try {
          const input = path.join(root, 'validator-only.txt')
          writeFileSync(input, 'first validation input')
          writeFileSync(
            path.join(root, 'result.txt.genie.ts'),
            `
import { inputReadFileSync } from ${canonicalJson(readersPath)}
export default {
  data: {}, stringify: () => 'constant\\n',
  validate: () => { inputReadFileSync(${canonicalJson(input)}, 'utf8'); return [] },
}
`,
          )
          const first = capture()
          writeFileSync(input, 'second validation input')
          const second = capture()
          expect(first.files.find((entry) => entry.path === input)).toMatchObject({
            state: 'present',
            digest: digestBytes('first validation input'),
            by: ['result.txt.genie.ts'],
          })
          expect(second.files.find((entry) => entry.path === input)).toMatchObject({
            state: 'present',
            digest: digestBytes('second validation input'),
            by: ['result.txt.genie.ts'],
          })
          expect(second.generatorResults[0]!.outputDigest).toBe(
            first.generatorResults[0]!.outputDigest,
          )
          expect(second.reasons.some((reason) => reason.code === 'unknown-capability')).toBe(true)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  effectIt.effect(
    'absent→present and directory add/remove each change their own observations',
    () =>
      Effect.sync(() => {
        const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-mutation-')))
        const input = path.join(root, 'optional.txt')
        const capture = () => {
          beginInputRecording({ digests: true })
          recordInput(input)
          recordInput(root)
          const evidence = getInputRecording()!.evidence!
          const result = {
            file: evidence.files.get(input),
            directory: evidence.directories.get(root),
          }
          endInputRecording()
          return result
        }
        try {
          const absent = capture()
          expect(absent.file).toMatchObject({ state: 'absent', error: 'ENOENT' })
          expect(absent.directory).toMatchObject({ state: 'present', entries: [] })
          writeFileSync(input, 'present')
          const present = capture()
          expect(present.file).toMatchObject({ state: 'present', digest: digestBytes('present') })
          expect(present.directory).toMatchObject({
            entries: [{ name: 'optional.txt', type: 'file' }],
          })
          expect(present.directory).not.toEqual(absent.directory)
          rmSync(input)
          const removed = capture()
          expect(removed.directory).toEqual(absent.directory)
          expect(removed.directory).not.toEqual(present.directory)
          expect(removed.file).toEqual(absent.file)
        } finally {
          endInputRecording()
          rmSync(root, { recursive: true, force: true })
        }
      }),
  )

  effectIt.effect('environment value/unset/empty comparisons use the same artifact salt', () =>
    Effect.sync(() => {
      const name = 'GENIE_MUTATION_MATRIX_VALUE'
      const previous = process.env[name]
      const capture = (value: string | undefined) => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
        beginInputRecording({ digests: true })
        expect(recordInputEnvironment(name)).toBe(value)
        const evidence = getInputRecording()!.evidence!
        const result = { salt: evidence.envSalt, observation: evidence.environment.get(name) }
        endInputRecording()
        return result
      }
      try {
        const first = capture('first')
        const second = capture('second')
        const unset = capture(undefined)
        const empty = capture('')
        expect(first.salt).not.toBe(second.salt)
        expect(first.observation).toMatchObject({
          present: true,
          digest: environmentDigest({ salt: first.salt, name, value: 'first' }),
        })
        expect(second.observation).toMatchObject({
          present: true,
          digest: environmentDigest({ salt: second.salt, name, value: 'second' }),
        })
        // A cross-invocation digest inequality alone would only demonstrate salt rotation.
        expect(environmentDigest({ salt: first.salt, name, value: 'second' })).not.toBe(
          environmentDigest({ salt: first.salt, name, value: 'first' }),
        )
        expect(unset.observation).toEqual({ name, by: [], present: false })
        expect(empty.observation).toEqual({
          name,
          by: [],
          present: true,
          digest: environmentDigest({ salt: empty.salt, name, value: '' }),
        })
        expect(environmentDigest({ salt: first.salt, name, value: '' })).not.toBe(
          environmentDigest({ salt: first.salt, name, value: 'first' }),
        )
      } finally {
        endInputRecording()
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }),
  )

  effectIt.effect(
    'cwd lexical aliases and physical symlink retargeting remain distinct evidence',
    () =>
      Effect.sync(() => {
        const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-cwd-mutation-')))
        const first = path.join(root, 'first')
        const second = path.join(root, 'second')
        const alias = path.join(root, 'alias')
        const capture = (cwd: string) => {
          beginInputRecording({ digests: true })
          recordInputCwd(cwd)
          const evidence = getInputRecording()!.evidence!
          const result = { cwd: evidence.cwd.get(cwd), link: evidence.symlinks.get(alias) }
          endInputRecording()
          return result
        }
        try {
          mkdirSync(first)
          mkdirSync(second)
          symlinkSync(first, alias, 'dir')
          const direct = capture(first)
          const linked = capture(alias)
          expect(direct.cwd).toEqual({ lexical: first, physical: first, by: [] })
          expect(linked.cwd).toEqual({ lexical: alias, physical: first, by: [] })
          expect(linked.link).toMatchObject({ target: first })
          rmSync(alias)
          symlinkSync(second, alias, 'dir')
          const retargeted = capture(alias)
          expect(retargeted.cwd).toEqual({ lexical: alias, physical: second, by: [] })
          expect(retargeted.link).toMatchObject({ target: second })
          expect(retargeted.link).not.toEqual(linked.link)
        } finally {
          endInputRecording()
          rmSync(root, { recursive: true, force: true })
        }
      }),
  )

  effectIt.effect(
    'resolution alternatives change the recorded outcome and searched directory inventory',
    () =>
      Effect.sync(() => {
        const { root, capture } = recordingFixture()
        try {
          const sources = path.join(root, 'sources')
          mkdirSync(sources)
          writeFileSync(path.join(sources, 'helper.ts'), "export const value = 'typescript\\n'\n")
          const importer = path.join(root, 'result.txt.genie.ts')
          writeFileSync(
            importer,
            "import { value } from './sources/helper'\nexport default { data: {}, stringify: () => value }\n",
          )
          const first = capture()
          writeFileSync(path.join(sources, 'helper.jsx'), "export const value = 'jsx\\n'\n")
          const second = capture()
          expect(
            first.resolutions.find(
              (entry) => entry.importer === importer && entry.specifier === './sources/helper',
            ),
          ).toMatchObject({
            outcome: {
              kind: 'file',
              lexical: path.join(sources, 'helper.ts'),
              physical: path.join(sources, 'helper.ts'),
            },
          })
          expect(
            second.resolutions.find(
              (entry) => entry.importer === importer && entry.specifier === './sources/helper',
            ),
          ).toMatchObject({
            outcome: {
              kind: 'file',
              lexical: path.join(sources, 'helper.jsx'),
              physical: path.join(sources, 'helper.jsx'),
            },
          })
          expect(second.directories.find((entry) => entry.path === sources)).not.toEqual(
            first.directories.find((entry) => entry.path === sources),
          )
          expect(first.directories.find((entry) => entry.path === sources)).toMatchObject({
            state: 'present',
            entries: [{ name: 'helper.ts', type: 'file' }],
          })
          expect(second.directories.find((entry) => entry.path === sources)).toMatchObject({
            state: 'present',
            entries: [
              { name: 'helper.jsx', type: 'file' },
              { name: 'helper.ts', type: 'file' },
            ],
          })
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  effectIt.effect(
    'actual component identities/platform and generated target bytes have honest producer evidence',
    () =>
      Effect.sync(() => {
        const { root, capture } = recordingFixture()
        try {
          const first = capture()
          expect(first.platform).toEqual({ os: process.platform, arch: process.arch })
          for (const identity of [first.genie, first.bun, first.generatorResults[0]!.module]) {
            expect(identity.files.length).toBeGreaterThan(0)
            for (const file of identity.files)
              expect(file.digest).toBe(digestBytes(readFileSync(file.path)))
          }
          // Intent comparisons only: schema acceptance is NOT current-platform validation.
          const intendedPlatform = {
            ...first.platform,
            arch: `${first.platform.arch}-different-intent`,
          }
          expect(first.platform).not.toEqual(intendedPlatform)
          expect(validateReadSet({ ...first, platform: intendedPlatform }).platform).toEqual(
            intendedPlatform,
          )
          const intendedIdentity = {
            ...first.bun,
            version: `${first.bun.version}-different-intent`,
          }
          expect(first.bun).not.toEqual(intendedIdentity)
          expect(validateReadSet({ ...first, bun: intendedIdentity }).bun).toEqual(intendedIdentity)
          const target = path.join(root, 'result.txt')
          expect(first.generatorResults[0]!.outputDigest).toBe(digestBytes(readFileSync(target)))
          writeFileSync(path.join(root, 'input.txt'), 'changed generated bytes\n')
          const second = capture()
          expect(
            first.files.find((entry) => entry.path === path.join(root, 'input.txt')),
          ).toMatchObject({ state: 'present', digest: digestBytes('first\n') })
          expect(
            second.files.find((entry) => entry.path === path.join(root, 'input.txt')),
          ).toMatchObject({ state: 'present', digest: digestBytes('changed generated bytes\n') })
          expect(second.generatorResults[0]!.outputDigest).toBe(digestBytes(readFileSync(target)))
          expect(second.generatorResults[0]!.outputDigest).not.toBe(
            first.generatorResults[0]!.outputDigest,
          )
          expect(second.files.find((entry) => entry.path === target)).toMatchObject({
            state: 'present',
            digest: second.generatorResults[0]!.outputDigest,
          })
          const generator = path.join(root, 'result.txt.genie.ts')
          const beforeIdentityMutation = readFileSync(generator, 'utf8')
          writeFileSync(
            generator,
            `${beforeIdentityMutation}\n// Identity-only source byte mutation.\n`,
          )
          const identityMutation = capture()
          expect(identityMutation.generatorResults[0]!.module.files).not.toEqual(
            second.generatorResults[0]!.module.files,
          )
          expect(identityMutation.generatorResults[0]!.module.files).toContainEqual({
            path: generator,
            digest: digestBytes(readFileSync(generator)),
          })
          expect(identityMutation.generatorResults[0]!.outputDigest).toBe(
            second.generatorResults[0]!.outputDigest,
          )
          expect(identityMutation.genie).toEqual(second.genie)
          expect(identityMutation.bun).toEqual(second.bun)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    // Three complete engine/dependency closure captures, not three standalone module scans.
    180_000,
  )
})

describe('real source capability occurrence evidence', () => {
  effectIt.effect(
    'reports AST denials and observed capture faults without claiming hazardous execution',
    () =>
      Effect.sync(() => {
        const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-capability-source-')))
        const scannerPath = fileURLToPath(new URL('./input-manifest.ts', import.meta.url))
        try {
          const source = [
            "import { realpathSync } from 'node:fs'",
            '// Source inventory only; hazards are never imported or called.',
            "import * as childProcess from 'node:child_process'",
            "import * as network from 'node:https'",
            "import addon from './fixture.node'",
            'export const hazards = () => {',
            '  realpathSync(".")',
            '  process.env.GENIE_CAPABILITY_FIXTURE',
            '  Bun.spawnSync(["never-executed"])',
            '  import("./optional.ts")',
            '  fetch("https://example.invalid/never-executed")',
            '  process.dlopen({}, "./never-executed.node")',
            '  Date.now()',
            '  Bun.file("./never-read")',
            '}',
          ].join('\n')
          writeFileSync(path.join(root, 'capabilities.ts'), source)
          writeFileSync(
            path.join(root, 'fixture.node'),
            'not an executable addon; scanner presence only',
          )
          const generators = ['one.txt.genie.ts', 'two.txt.genie.ts']
          for (const generator of generators)
            writeFileSync(
              path.join(root, generator),
              "import './capabilities.ts'\nexport default {}\n",
            )
          const result = spawnSync(
            'bun',
            [
              '-e',
              `
import { beginInputRecording, endInputRecording, getInputRecording, recordInput } from ${canonicalJson(readersPath)}
import { recordGeneratorSourceGraph } from ${canonicalJson(scannerPath)}
import { canonicalJson } from ${canonicalJson(fileURLToPath(new URL('../runtime/node/input-observations.ts', import.meta.url)))}
import { writeFileSync } from 'node:fs'
const root = process.argv[1]
beginInputRecording({ digests: true })
await recordGeneratorSourceGraph({ entries: ${canonicalJson(generators)}, cwd: root })
const input = root + '/conflicting.txt'
writeFileSync(input, 'before')
recordInput(input)
writeFileSync(input, 'after')
recordInput(input)
recordInput(root + '/\\0invalid')
const recording = getInputRecording()
console.log(canonicalJson(recording.reasons.map(reason => ({
  ...reason, generators: reason.generators.length === 0 ? recording.generators : reason.generators,
}))))
endInputRecording()
`,
              root,
            ],
            { encoding: 'utf8', cwd: root },
          )
          expect(result.status, result.stdout + result.stderr).toBe(0)
          const reasons = decodeReasons(result.stdout.trim())
          for (const reason of reasons) expect(reasonCodes).toContain(reason.code)
          for (const code of [
            'unknown-capability',
            'dynamic-import',
            'unmediated-realpath',
            'native-addon',
            'unstable-observation',
            'capture-error',
          ])
            expect(reasons.some((reason) => reason.code === code)).toBe(true)
          const occurrences = [
            { code: 'unknown-capability', operation: 'capability-import', line: 1 },
            { code: 'unknown-capability', operation: 'ambient-access', line: 14 },
            { code: 'unknown-capability', operation: 'capability-import', line: 3 },
            { code: 'unknown-capability', operation: 'ambient-access', line: 9 },
            { code: 'unknown-capability', operation: 'capability-import', line: 4 },
            { code: 'unknown-capability', operation: 'unknown-global', line: 11 },
            { code: 'unknown-capability', operation: 'ambient-access', line: 8 },
            { code: 'dynamic-import', operation: 'resolve:./optional.ts', line: 10 },
            { code: 'native-addon', operation: 'native-module-import', line: 5 },
            { code: 'unknown-capability', operation: 'ambient-access', line: 12 },
            { code: 'unknown-capability', operation: 'unknown-global', line: 13 },
          ]
          for (const { code, operation, line } of occurrences) {
            expect(reasons).toContainEqual(
              expect.objectContaining({
                code,
                operation,
                source: { module: 'capabilities.ts', line },
                generators,
                evidence: 'unproven',
              }),
            )
          }
          expect(reasons).toContainEqual(
            expect.objectContaining({
              code: 'native-addon',
              operation: 'native-module',
              source: { module: 'fixture.node', line: null },
              generators,
              evidence: 'unproven',
            }),
          )
          for (const code of ['unstable-observation', 'capture-error']) {
            expect(reasons).toContainEqual(
              expect.objectContaining({
                code,
                generators,
                evidence: 'observed',
                source: {
                  module: '@overeng/genie/src/runtime/node/input-observations.ts',
                  line: null,
                },
              }),
            )
          }
          expect(
            reasons
              .filter((reason) => reason.evidence === 'observed')
              .every(
                (reason) =>
                  reason.code === 'unstable-observation' || reason.code === 'capture-error',
              ),
          ).toBe(true)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    60_000,
  )
})

describe('analyzer isolation and compiled fallback', () => {
  for (const mode of [
    'throwing-analyzer',
    'startup-failure',
    'shutdown-failure',
    'legacy-only',
    'compiled',
    'bundle',
    'unrecognized',
  ] as const) {
    it(`fails closed without changing the legacy decision: ${mode}`, () => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-analyzer-isolation-')))
      try {
        writeFileSync(path.join(root, 'one.genie.ts'), 'export default {}\n')
        const scannerPath = fileURLToPath(new URL('./input-manifest.ts', import.meta.url))
        const analyzerPath = fileURLToPath(new URL('./closure-analyzer.ts', import.meta.url))
        const result = spawnSync(
          'bun',
          [
            '-e',
            `
import { mock } from 'bun:test'
import { Schema } from 'effect'
import { beginInputRecording, endInputRecording, getInputRecording, inputReadFileSync, isInputRecordingComplete } from ${canonicalJson(readersPath)}
const mode = ${canonicalJson(mode)}
mock.module(${canonicalJson(analyzerPath)}, () => ({
  createClosureAnalyzer: () => {
    if (mode === 'legacy-only') throw new Error('Legacy recording loaded the analyzer')
    if (mode === 'startup-failure') throw new Error('Injected startup failure')
    return {
      analyze: async () => {
        if (mode !== 'shutdown-failure') throw new Error('Injected analyzer failure')
        return { imports: [], reasons: [] }
      },
      close: async () => { if (mode === 'shutdown-failure') throw new Error('Injected shutdown failure') },
    }
  },
  matchDependencyAllowlist: () => undefined,
}))
let lockDecoders = 0
let readSetSchemas = 0
const originalStruct = Schema.Struct
const originalRecord = Schema.Record
const originalEffect = { ...require('effect') }
// The analyzer's lock schema is the only Record schema built during this scan.
mock.module('effect', () => ({
  ...originalEffect,
  Schema: {
    ...Schema,
    Record: (...args) => { lockDecoders++; return originalRecord(...args) },
    Struct: (fields) => {
      if ('generatorResults' in fields && 'envSalt' in fields && 'resolutions' in fields) readSetSchemas++
      return originalStruct(fields)
    },
  },
}))
// Dynamic loading installs module-boundary faults before importing the scanner.
const { recordGeneratorSourceGraph } = await import(${canonicalJson(scannerPath)})
beginInputRecording({ digests: mode !== 'legacy-only' })
const recording = getInputRecording()
if (['compiled', 'bundle', 'unrecognized'].includes(mode)) {
  recording.evidence.genieVersion = 'fixture'
  recording.evidence.engineMode = mode
}
lockDecoders = 0
await recordGeneratorSourceGraph({ entries: ['one.genie.ts'], cwd: process.cwd() })
if (['compiled', 'bundle', 'unrecognized'].includes(mode)) {
  // Unknown runtime descriptor provenance cannot be narrowed to a source-graph consumer.
  try { inputReadFileSync(-1) } catch {}
}
console.log(JSON.stringify({ complete: isInputRecordingComplete(), reasons: recording.reasons, lockDecoders, readSetSchemas }))
endInputRecording()
`,
          ],
          { cwd: root, encoding: 'utf8' },
        )
        expect(result.status, result.stdout + result.stderr).toBe(0)
        const decode = Schema.decodeSync(
          Schema.fromJsonString(
            Schema.Struct({
              complete: Schema.Boolean,
              reasons: ReadSetSchema.fields.reasons,
              lockDecoders: Schema.Finite,
              readSetSchemas: Schema.Finite,
            }),
          ),
        )
        const observed = decode(result.stdout.trim())
        expect(observed.complete).toBe(true)
        if (mode === 'legacy-only') {
          expect(observed.lockDecoders).toBe(0)
          expect(observed.readSetSchemas).toBe(0)
          expect(observed.reasons).toEqual([])
        } else {
          expect(observed.reasons).toContainEqual(
            expect.objectContaining({ operation: 'analysis-unavailable' }),
          )
        }
        if (mode === 'compiled' || mode === 'bundle' || mode === 'unrecognized') {
          expect(observed.reasons).toContainEqual(
            expect.objectContaining({
              code: 'unknown-capability',
              operation: 'readFileSync(fd)',
              evidence: 'observed',
              generators: [],
            }),
          )
          for (const operation of [
            'engine-analysis-unavailable',
            'validator-analysis-unavailable',
          ]) {
            expect(observed.reasons).toContainEqual(
              expect.objectContaining({
                code: 'unknown-capability',
                operation,
                generators: ['one.genie.ts'],
              }),
            )
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
