import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { canonicalJson, digestBytes, directoryDigest, environmentDigest, reasonCodes } from '../runtime/node/input-observations.ts'
import { validateReadSet } from './read-set.ts'

const fixture = () => ({
  schema: 'genie-check-read-set', schemaVersion: 1,
  invocationId: '12345678-1234-4123-8123-123456789abc', checkSucceeded: true, complete: true,
  repoRoot: '/fixture', argv: ['--check'], generators: [], generatorResults: [],
  platform: { os: 'linux', arch: 'x64' },
  genie: { version: '0.1.0', files: [{ path: '/fixture/genie', digest: digestBytes('engine') }] },
  bun: { version: '1.4.2', files: [{ path: '/fixture/bun', digest: digestBytes('runtime') }] },
  envSalt: '0'.repeat(64), files: [], directories: [], environment: [], cwd: [], symlinks: [],
  resolutions: [], tools: [], stats: [], reasons: [],
})

describe('read-set schema and canonical encodings', () => {
  it.effect('encodes JCS key order and the specified directory/environment formulas', () => Effect.sync(() => {
    expect(canonicalJson({ z: 1, a: { b: 'value', a: [] } })).toBe('{"a":{"a":[],"b":"value"},"z":1}')
    expect(directoryDigest([])).toBe(digestBytes('genie-directory-v1\n[]'))
    expect(environmentDigest({ salt: '0'.repeat(64), name: 'NAME', value: '' })).toBe(digestBytes(`["genie-env-v1","${'0'.repeat(64)}","NAME",""]`))
    expect(() => canonicalJson('\ud800')).toThrow()
    expect(validateReadSet(fixture()).complete).toBe(true)
  }))

  it.effect('rejects unsupported versions, observation classes and unknown keys recursively', () => Effect.sync(() => {
    for (const input of [
      { ...fixture(), schemaVersion: 2 },
      { ...fixture(), futureObservations: [] },
      { ...fixture(), platform: { os: 'linux', arch: 'x64', hidden: true } },
      { ...fixture(), complete: false },
      { ...fixture(), invocationId: 'not-a-run' },
      { ...fixture(), genie: { version: '0.1.0', files: [] } },
      { ...fixture(), files: [{ path: '/fixture/input', by: [], state: 'unmodeled' }] },
      { ...fixture(), files: [{ path: 'relative', by: [], state: 'absent', error: 'ENOENT' }] },
      { ...fixture(), files: [{ path: '/fixture/input', by: [], state: 'present', byteLength: 1, digest: 'bad' }] },
      { ...fixture(), files: [{ path: '/fixture/input', by: [], state: 'absent', error: 'EACCES' }] },
      { ...fixture(), generators: ['b.genie.ts', 'a.genie.ts'] },
      { ...fixture(), generators: ['a.genie.ts'], generatorResults: [] },
      { ...fixture(), environment: [{ name: 'NAME', present: false, by: ['missing.genie.ts'] }] },
      { ...fixture(), directories: [{ path: '/fixture', by: [], state: 'present', entries: [], digest: digestBytes('wrong') }] },
      { ...fixture(), complete: false, reasons: [{ code: 'new-reason', operation: 'test', detail: '', source: { module: 'fixture', line: null }, generators: [], evidence: 'unproven' }] },
    ]) expect(() => validateReadSet(input)).toThrow()
    const { argv: _, ...missing } = fixture()
    expect(() => validateReadSet(missing)).toThrow()
    expect(() => validateReadSet(undefined)).toThrow()
  }))

  it.effect('retains every closed reason code and separates completeness from check success', () => Effect.sync(() => {
    for (const code of reasonCodes) {
      const reason = { code, operation: 'fixture capability', detail: '', source: { module: 'fixture/helper.ts', line: 1 }, generators: [], evidence: 'unproven' }
      expect(validateReadSet({ ...fixture(), checkSucceeded: false, complete: false, reasons: [reason] }).reasons[0]?.code).toBe(code)
    }
    expect(validateReadSet({ ...fixture(), checkSucceeded: false }).complete).toBe(true)
  }))
})
