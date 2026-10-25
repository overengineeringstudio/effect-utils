import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { canonicalJson, directoryDigest, environmentDigest } from '../runtime/node/input-observations.ts'
import {
  beginInputRecording, endInputRecording, getInputRecording, inputExistsSync, inputReadFileSync,
  inputReaddirSync, inputRealpathSync, inputStatSync, isInputRecording, recordInput,
  recordInputEnvironment,
} from '../runtime/node/inputs.ts'
import { withInputManifest } from './input-manifest.ts'
import { ReadSetSchema, validateReadSet } from './read-set.ts'

const cliPath = fileURLToPath(new URL('../../bin/genie.tsx', import.meta.url))
const readersPath = fileURLToPath(new URL('../runtime/node/inputs.ts', import.meta.url))
const decode = Schema.decodeSync(Schema.fromJsonString(ReadSetSchema), { onExcessProperty: 'error' })
const decodeMetadata = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ invocationId: Schema.String, complete: Schema.Boolean, digestEvidence: Schema.Boolean })))
const decodeReport = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ invocationId: Schema.String, reasons: ReadSetSchema.fields.reasons })))
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-read-set-')))
  const artifact = path.join(root, 'evidence.json')
  const manifest = path.join(root, 'inputs.manifest')
  fs.mkdirSync(path.join(root, 'empty'))
  fs.writeFileSync(path.join(root, 'runtime.txt'), 'input\n')
  fs.writeFileSync(path.join(root, 'shared.ts'), `
import { inputReadFileSync, inputExistsSync, inputReaddirSync, recordInputEnvironment } from ${JSON.stringify(readersPath)}
export const read = () => {
  inputExistsSync(${JSON.stringify(path.join(root, 'optional.txt'))})
  inputReaddirSync(${JSON.stringify(path.join(root, 'empty'))})
  recordInputEnvironment('GENIE_READ_SET_TEST_VALUE')
  return inputReadFileSync(${JSON.stringify(path.join(root, 'runtime.txt'))}, 'utf8')
}
`)
  for (const name of ['one', 'two']) fs.writeFileSync(path.join(root, `${name}.txt.genie.ts`), `import { read } from './shared.ts'\nexport default { data: {}, stringify: read }\n`)
  const run = (args: string[], legacy = true, manifestPath = manifest) => spawnSync('bun', [cliPath, '--cwd', root, '--json', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GENIE_INPUT_MANIFEST: legacy === true ? manifestPath : '', XDG_STATE_HOME: path.join(root, 'state') },
  })
  const generate = run(['--writeable'], false)
  expect(generate.status, generate.stdout + generate.stderr).toBe(0)
  return { root, artifact, manifest, run }
}

describe('check read-set recording', () => {
  it.effect('dispatches the original effect without installing a recorder when outputs are absent', () => Effect.sync(() => {
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
  }))

  it.effect('retains bytes, typed inventories, absences, exact stat and symlink inputs', () => Effect.sync(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-observations-'))
    try {
      fs.mkdirSync(path.join(root, 'empty'))
      fs.writeFileSync(path.join(root, 'input'), 'bytes')
      fs.symlinkSync('input', path.join(root, 'link'))
      beginInputRecording({ digests: true })
      expect(inputReadFileSync(path.join(root, 'input'), 'utf8')).toBe('bytes')
      expect(inputExistsSync(path.join(root, 'absent'))).toBe(false)
      inputReaddirSync(path.join(root, 'empty'))
      inputStatSync(path.join(root, 'input'))
      inputRealpathSync(path.join(root, 'link'))
      const evidence = getInputRecording()!.evidence!
      expect(evidence.files.get(path.join(root, 'input'))).toMatchObject({ state: 'present', byteLength: 5 })
      expect(evidence.files.get(path.join(root, 'absent'))).toMatchObject({ state: 'absent', error: 'ENOENT' })
      expect(evidence.directories.get(path.join(root, 'absent'))).toMatchObject({ state: 'absent', error: 'ENOENT' })
      expect(evidence.directories.get(path.join(root, 'empty'))).toMatchObject({ state: 'present', entries: [], digest: directoryDigest([]) })
      expect([...evidence.stats.values()][0]).toMatchObject({ state: 'present', followSymlinks: true, values: { size: '5' } })
      expect(evidence.symlinks.get(path.join(root, 'link'))).toMatchObject({ state: 'present', target: 'input' })
      fs.writeFileSync(path.join(root, 'input'), 'changed')
      inputReadFileSync(path.join(root, 'input'))
      expect(getInputRecording()!.reasons.some((reason) => reason.code === 'unstable-observation')).toBe(true)
      endInputRecording()
      beginInputRecording({ digests: true })
      expect(getInputRecording()!.paths.size).toBe(0)
    } finally {
      endInputRecording()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }))

  it.effect('captures read-only directory inventories exactly under Bun and rejects non-Unicode names', () => Effect.sync(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-readonly-observations-'))
    const directory = path.join(root, 'dependency')
    const empty = path.join(directory, 'empty')
    try {
      fs.mkdirSync(empty, { recursive: true })
      fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../worktrees/dependency\n')
      fs.writeFileSync(path.join(directory, 'input.txt'), 'bytes')
      fs.symlinkSync('missing', path.join(directory, 'link'))
      fs.chmodSync(empty, 0o555)
      fs.chmodSync(directory, 0o555)
      const observationsPath = fileURLToPath(new URL('../runtime/node/input-observations.ts', import.meta.url))
      const result = spawnSync('bun', ['-e', `
        import assert from 'node:assert/strict'
        import * as fs from 'node:fs'
        import path from 'node:path'
        import { makeInputRecording, capturePath, directoryDigest } from ${canonicalJson(observationsPath)}
        const directory = process.argv[1]
        const recording = makeInputRecording({ digests: true })
        capturePath({ recording, input: directory })
        capturePath({ recording, input: path.join(directory, 'empty') })
        const entries = [
          { name: '.git', type: 'file' }, { name: 'empty', type: 'directory' },
          { name: 'input.txt', type: 'file' }, { name: 'link', type: 'symlink' },
        ]
        assert.deepEqual(recording.evidence.directories.get(directory), {
          path: directory, by: [], state: 'present', entries, digest: directoryDigest(entries),
        })
        assert.deepEqual(recording.evidence.directories.get(path.join(directory, 'empty')).entries, [])
        assert.deepEqual(recording.reasons, [])
        fs.chmodSync(directory, 0o755)
        fs.writeFileSync(Buffer.concat([Buffer.from(directory + path.sep), Buffer.from([0xff])]), '')
        const invalid = makeInputRecording({ digests: true })
        capturePath({ recording: invalid, input: directory })
        assert.equal(invalid.evidence.directories.has(directory), false)
        assert.equal(invalid.reasons.some(reason => reason.code === 'capture-error'), true)
      `, directory], { encoding: 'utf8' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    } finally {
      fs.chmodSync(directory, 0o755)
      fs.chmodSync(empty, 0o755)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }), 60_000)

  it.effect('fails closed when a listed child disappears before its type is observed', () => Effect.sync(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-directory-race-'))
    try {
      fs.writeFileSync(path.join(root, 'child'), 'bytes')
      const observationsUrl = new URL('../runtime/node/input-observations.ts', import.meta.url).href
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
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
      `, root], { encoding: 'utf8' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }), 60_000)

  it.effect('distinguishes ENOTDIR from ENOENT and fails closed on capture errors', () => Effect.sync(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-observation-errors-'))
    try {
      fs.writeFileSync(path.join(root, 'file'), '')
      beginInputRecording({ digests: true })
      recordInput(path.join(root, 'file', 'child'))
      expect(getInputRecording()!.evidence!.files.get(path.join(root, 'file', 'child'))).toMatchObject({ state: 'absent', error: 'ENOTDIR' })
      recordInput(path.join(root, '\0invalid'))
      expect(getInputRecording()!.reasons.some((reason) => reason.code === 'capture-error')).toBe(true)
    } finally {
      endInputRecording()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }))

  it.effect('salts every environment value, preserving unset and empty without plaintext', () => Effect.sync(() => {
    const name = 'GENIE_READ_SET_TEST_VALUE'
    const previous = process.env[name]
    try {
      for (const value of [undefined, '', 'private fixture value']) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
        beginInputRecording({ digests: true })
        expect(recordInputEnvironment(name)).toBe(value)
        const evidence = getInputRecording()!.evidence!
        expect(evidence.environment.get(name)).toEqual(value === undefined
          ? { name, by: [], present: false }
          : { name, by: [], present: true, digest: environmentDigest({ salt: evidence.envSalt, name: name, value: value }) })
        expect(canonicalJson([...evidence.environment.values()])).not.toContain('private fixture value')
        endInputRecording()
      }
    } finally {
      endInputRecording()
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }))

  it.effect('publishes one successful recording, exact legacy projection and expanded private reports', () => Effect.sync(() => {
    const { root, artifact, manifest, run } = fixture()
    try {
      const result = run(['--check', '--read-set', artifact])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const readSet = validateReadSet(decode(fs.readFileSync(artifact, 'utf8')))
      expect(readSet.checkSucceeded).toBe(true)
      expect(readSet.complete).toBe(false)
      expect(readSet.generatorResults.map((entry) => entry.generator)).toEqual(['one.txt.genie.ts', 'two.txt.genie.ts'])
      expect(readSet.generatorResults.every((entry) => entry.outputDigest.startsWith('sha256:'))).toBe(true)
      const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(lines[0]).toBe('genie-inputs-incomplete')
      expect(lines.slice(1).sort()).toEqual([...new Set([...readSet.files, ...readSet.directories].map((entry) => entry.path))].sort())
      expect(readSet.files.find((entry) => entry.path === path.join(root, 'optional.txt'))).toMatchObject({ state: 'absent' })
      expect(readSet.reasons.find((reason) => reason.code === 'unknown-capability' && reason.source.module === 'shared.ts')).toMatchObject({ generators: ['one.txt.genie.ts', 'two.txt.genie.ts'] })
      expect(readSet.resolutions.find((entry) => entry.importer === path.join(root, 'one.txt.genie.ts') && entry.specifier === './shared.ts')).toMatchObject({
        outcome: { kind: 'file', lexical: path.join(root, 'shared.ts'), physical: path.join(root, 'shared.ts') },
      })
      expect(readSet.resolutions.some((entry) => entry.outcome.kind === 'builtin' && entry.outcome.name === 'node:fs')).toBe(true)
      const metadata = decodeMetadata(fs.readFileSync(`${manifest}.meta.json`, 'utf8'))
      expect(metadata).toMatchObject({ invocationId: readSet.invocationId, complete: readSet.complete, digestEvidence: true })
      const report = decodeReport(fs.readFileSync(`${artifact}.reasons.json`, 'utf8'))
      expect(report).toMatchObject({ invocationId: readSet.invocationId, reasons: readSet.reasons })
      for (const file of [artifact, manifest, `${manifest}.meta.json`, `${artifact}.reasons.json`]) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }), 60_000)

  it.effect('removes stale successful artifacts when one generator fails the combined check', () => Effect.sync(() => {
    const { root, artifact, manifest, run } = fixture()
    try {
      const first = run(['--check', '--read-set', artifact])
      expect(first.status, first.stdout + first.stderr).toBe(0)
      fs.writeFileSync(path.join(root, 'one.txt'), 'drift')
      const failed = run(['--check', '--read-set', artifact])
      expect(failed.status).not.toBe(0)
      for (const file of [artifact, manifest, `${manifest}.meta.json`, `${artifact}.reasons.json`]) expect(fs.existsSync(file)).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }), 60_000)

  for (const collision of ['same output', 'manifest at read-set companion', 'read-set at manifest companion']) {
    it.effect(`removes stale artifacts after a collision: ${collision}`, () => Effect.sync(() => {
      const { root, artifact, manifest, run } = fixture()
      const readSetPath = collision === 'read-set at manifest companion' ? `${manifest}.meta.json` : artifact
      const manifestPath = collision === 'same output' ? artifact
        : collision === 'manifest at read-set companion' ? `${artifact}.reasons.json` : manifest
      const outputs = [readSetPath, `${readSetPath}.reasons.json`, manifestPath, `${manifestPath}.meta.json`]
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
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }), 60_000)
  }

  it.effect('fails publication without retaining earlier evidence or temporary files', () => Effect.sync(() => {
    const { root, artifact, manifest, run } = fixture()
    try {
      const result = run(['--check', '--read-set', path.join(root, 'missing-parent', 'evidence.json')])
      expect(result.status).not.toBe(0)
      expect(fs.existsSync(manifest)).toBe(false)
      expect(fs.existsSync(artifact)).toBe(false)
      expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }), 60_000)
})
