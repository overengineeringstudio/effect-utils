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
  const run = (args: string[], legacy = true) => spawnSync('bun', [cliPath, '--cwd', root, '--json', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GENIE_INPUT_MANIFEST: legacy ? manifest : '', XDG_STATE_HOME: path.join(root, 'state') },
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
          : { name, by: [], present: true, digest: environmentDigest(evidence.envSalt, name, value) })
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
