import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  addReason,
  canonicalJson,
  digestBytes,
  directoryDigest,
  environmentDigest,
  isCanonicalNodeBuiltin,
  makeInputRecording,
  reasonCodes,
  retainObservation,
} from '../runtime/node/input-observations.ts'
import type { FileObservation, InputReason } from '../runtime/node/input-observations.ts'
import { classifyEngineExecution, validateReadSet, validateReadSetPair } from './read-set.ts'

describe('engine execution form classification', () => {
  it('requires positive source layout and package evidence and fails closed for other forms', () => {
    const source = {
      entrypoint: '/fixture/genie/bin/genie.tsx',
      modulePath: '/fixture/genie/src/core/read-set.ts',
      packagePresent: true,
    }
    expect(classifyEngineExecution(source)).toBe('source')
    expect(classifyEngineExecution({ ...source, packagePresent: false })).toBe('unrecognized')
    expect(classifyEngineExecution({ ...source, entrypoint: '/elsewhere/entry.ts' })).toBe(
      'unrecognized',
    )
    expect(
      classifyEngineExecution({
        entrypoint: '/fixture/libexec/genie.js',
        modulePath: '/fixture/libexec/genie.js',
        packagePresent: false,
      }),
    ).toBe('bundle')
    expect(
      classifyEngineExecution({
        entrypoint: '/$bunfs/root/genie',
        modulePath: '/$bunfs/root/genie',
        packagePresent: false,
      }),
    ).toBe('compiled')
    expect(classifyEngineExecution({ ...source, entrypoint: undefined })).toBe('unrecognized')
    expect(
      classifyEngineExecution({ ...source, modulePath: '/fixture/unknown-layout/read-set.ts' }),
    ).toBe('unrecognized')
  })
})

const fixture = () => ({
  schema: 'genie-check-read-set',
  schemaVersion: 1,
  invocationId: '12345678-1234-4123-8123-123456789abc',
  checkSucceeded: true,
  complete: true,
  repoRoot: '/fixture',
  argv: ['--check'],
  generators: [],
  generatorResults: [],
  platform: { os: 'linux', arch: 'x64' },
  genie: { version: '0.1.0', files: [{ path: '/fixture/genie', digest: digestBytes('engine') }] },
  bun: { version: '1.4.2', files: [{ path: '/fixture/bun', digest: digestBytes('runtime') }] },
  envSalt: '0'.repeat(64),
  files: [],
  directories: [],
  environment: [],
  cwd: [],
  symlinks: [],
  resolutions: [],
  tools: [],
  stats: [],
  reasons: [],
})

describe('read-set schema and canonical encodings', () => {
  it('shares a closed canonical builtin vocabulary independent of runtime aliases', () => {
    const artifact = (name: string) => ({
      ...fixture(),
      files: [
        {
          path: '/fixture/importer.ts',
          by: [],
          state: 'present',
          digest: digestBytes('import'),
          byteLength: 6,
        },
      ],
      resolutions: [
        {
          importer: '/fixture/importer.ts',
          specifier: name,
          outcome: { kind: 'builtin', name },
          by: [],
          candidates: [],
          contextEnv: [],
          resolverCode: [],
        },
      ],
    })
    expect(isCanonicalNodeBuiltin('node:fs')).toBe(true)
    expect(() => validateReadSet(artifact('node:fs'))).not.toThrow()
    // A future runtime may resolve this name as builtin; the artifact contract must not.
    const syntheticRuntimeBuiltin = 'node:synthetic-runtime-only-builtin'
    expect(isCanonicalNodeBuiltin(syntheticRuntimeBuiltin)).toBe(false)
    expect(() => validateReadSet(artifact(syntheticRuntimeBuiltin))).toThrow()
  })
  it.effect('encodes JCS key order and the specified directory/environment formulas', () =>
    Effect.sync(() => {
      expect(canonicalJson({ z: 1, a: { b: 'value', a: [] } })).toBe(
        '{"a":{"a":[],"b":"value"},"z":1}',
      )
      expect(directoryDigest([])).toBe(digestBytes('genie-directory-v1\n[]'))
      expect(environmentDigest({ salt: '0'.repeat(64), name: 'NAME', value: '' })).toBe(
        digestBytes(`["genie-env-v1","${'0'.repeat(64)}","NAME",""]`),
      )
      expect(() => canonicalJson('\ud800')).toThrow()
      expect(validateReadSet(fixture()).complete).toBe(true)
    }),
  )

  it.effect('rejects unsupported versions, observation classes and unknown keys recursively', () =>
    Effect.sync(() => {
      for (const input of [
        { ...fixture(), schemaVersion: 2 },
        { ...fixture(), futureObservations: [] },
        { ...fixture(), platform: { os: 'linux', arch: 'x64', hidden: true } },
        { ...fixture(), complete: false },
        { ...fixture(), invocationId: 'not-a-run' },
        { ...fixture(), genie: { version: '0.1.0', files: [] } },
        { ...fixture(), files: [{ path: '/fixture/input', by: [], state: 'unmodeled' }] },
        { ...fixture(), files: [{ path: 'relative', by: [], state: 'absent', error: 'ENOENT' }] },
        {
          ...fixture(),
          files: [
            { path: '/fixture/input', by: [], state: 'present', byteLength: 1, digest: 'bad' },
          ],
        },
        {
          ...fixture(),
          files: [{ path: '/fixture/input', by: [], state: 'absent', error: 'EACCES' }],
        },
        { ...fixture(), generators: ['b.genie.ts', 'a.genie.ts'] },
        { ...fixture(), generators: ['a.genie.ts'], generatorResults: [] },
        { ...fixture(), environment: [{ name: 'NAME', present: false, by: ['missing.genie.ts'] }] },
        {
          ...fixture(),
          directories: [
            {
              path: '/fixture',
              by: [],
              state: 'present',
              entries: [],
              digest: digestBytes('wrong'),
            },
          ],
        },
        {
          ...fixture(),
          complete: false,
          reasons: [
            {
              code: 'new-reason',
              operation: 'test',
              detail: '',
              source: { module: 'fixture', line: null },
              generators: [],
              evidence: 'unproven',
            },
          ],
        },
      ])
        expect(() => validateReadSet(input)).toThrow()
      const { argv: _, ...missing } = fixture()
      expect(() => validateReadSet(missing)).toThrow()
      expect(() => validateReadSet(undefined)).toThrow()
    }),
  )

  it.effect(
    'requires the represented generator set, not just the number of distinct target pairs',
    () =>
      Effect.sync(() => {
        const generators = ['a.genie.ts', 'b.genie.ts']
        const targets = ['/fixture/a.txt', '/fixture/b.txt']
        const outputDigest = digestBytes('output')
        const input = {
          ...fixture(),
          generators,
          generatorResults: generators.map((generator, index) => ({
            generator,
            target: targets[index]!,
            module: fixture().genie,
            outputDigest,
          })),
          files: targets.map((target) => ({
            path: target,
            by: generators,
            state: 'present',
            digest: outputDigest,
            byteLength: 6,
          })),
        }
        expect(validateReadSet(input).generatorResults).toHaveLength(2)
        // Same count, unique [generator,target] pairs and valid target evidence, but no B result.
        const duplicate = {
          ...input,
          generatorResults: input.generatorResults.map((entry) =>
            Object.assign({}, entry, { generator: 'a.genie.ts' }),
          ),
        }
        expect(() => validateReadSet(duplicate)).toThrow()
      }),
  )

  it.effect(
    'rejects metadata with a different run or incompatible projection without claiming current-state validation',
    () =>
      Effect.sync(() => {
        const readSet = fixture()
        const metadata = {
          schema: 'genie-input-manifest-metadata',
          schemaVersion: 1,
          invocationId: readSet.invocationId,
          legacyComplete: true,
          readSetComplete: readSet.complete,
          digestEvidence: true,
        }
        expect(validateReadSetPair({ readSet, metadata }).invocationId).toBe(readSet.invocationId)
        for (const invalid of [
          { ...metadata, invocationId: '22345678-1234-4123-8123-123456789abc' },
          { ...metadata, readSetComplete: false },
          { ...metadata, readSetComplete: null },
          {
            schema: metadata.schema,
            schemaVersion: metadata.schemaVersion,
            invocationId: metadata.invocationId,
            legacyComplete: true,
            digestEvidence: true,
          },
          { ...metadata, legacyComplete: undefined },
          { ...metadata, complete: true },
          { ...metadata, digestEvidence: false },
          { ...metadata, schemaVersion: 2 },
          { ...metadata, extra: true },
        ])
          expect(() => validateReadSetPair({ readSet, metadata: invalid })).toThrow()
      }),
  )

  it.effect('accepts legacy completeness independently of conservative read-set completeness', () =>
    Effect.sync(() => {
      const readSet = {
        ...fixture(),
        complete: false,
        reasons: [
          {
            code: 'unknown-capability',
            operation: 'fixture capability',
            detail: '',
            source: { module: 'fixture/helper.ts', line: 1 },
            generators: [],
            evidence: 'unproven',
          },
        ],
      }
      const metadata = {
        schema: 'genie-input-manifest-metadata',
        schemaVersion: 1,
        invocationId: readSet.invocationId,
        legacyComplete: true,
        readSetComplete: false,
        digestEvidence: true,
      }
      expect(validateReadSetPair({ readSet, metadata })).toEqual(readSet)
      expect(() =>
        validateReadSetPair({ readSet, metadata: { ...metadata, readSetComplete: true } }),
      ).toThrow()
    }),
  )

  it.effect('retains every closed reason code and separates completeness from check success', () =>
    Effect.sync(() => {
      for (const code of reasonCodes) {
        const reason = {
          code,
          operation: 'fixture capability',
          detail: '',
          source: { module: 'fixture/helper.ts', line: 1 },
          generators: [],
          evidence: 'unproven',
        }
        expect(
          validateReadSet({
            ...fixture(),
            checkSucceeded: false,
            complete: false,
            reasons: [reason],
          }).reasons[0]?.code,
        ).toBe(code)
      }
      expect(validateReadSet({ ...fixture(), checkSucceeded: false }).complete).toBe(true)
    }),
  )

  it.effect(
    'deduplicates canonical reasons once per invocation without coalescing attribution or source',
    () =>
      Effect.sync(() => {
        const recording = makeInputRecording()
        const reason: InputReason = {
          code: 'unknown-capability',
          operation: 'closure',
          detail: 'Unaccounted closure',
          source: { module: 'helper.ts', line: null },
          generators: ['a.genie.ts'],
          evidence: 'unproven',
        }
        addReason({ recording, reason })
        addReason({ recording, reason: { ...reason, source: { line: null, module: 'helper.ts' } } })
        addReason({ recording, reason: { ...reason, generators: ['b.genie.ts'] } })
        addReason({ recording, reason: { ...reason, source: { module: 'other.ts', line: null } } })
        expect(recording.reasons).toHaveLength(3)
        expect(recording.reasons[0]).toEqual(reason)
        expect(recording.evidence).toBeUndefined()
        const next = makeInputRecording()
        addReason({ recording: next, reason })
        expect(next.reasons).toEqual([reason])
      }),
  )

  it('keeps invocation-wide attribution dominant in every stable observation merge order', () => {
    for (const { first, second, expected } of [
      { first: [], second: ['a.genie.ts'], expected: [] },
      { first: ['a.genie.ts'], second: [], expected: [] },
      { first: [], second: [], expected: [] },
      {
        first: ['b.genie.ts'],
        second: ['a.genie.ts', 'b.genie.ts'],
        expected: ['a.genie.ts', 'b.genie.ts'],
      },
    ]) {
      const recording = makeInputRecording({ digests: true })
      const map = recording.evidence!.files
      const observation: FileObservation = {
        path: '/fixture/input',
        by: first,
        state: 'present',
        digest: digestBytes('same'),
        byteLength: 4,
      }
      retainObservation({ recording, map, key: observation.path, observation })
      retainObservation({
        recording,
        map,
        key: observation.path,
        observation: { ...observation, by: second },
      })
      expect(map.get(observation.path)?.by).toEqual(expected)
      expect(recording.reasons).toEqual([])
    }
  })
  it.effect(
    'cached payloads merge attribution but retain first evidence and conflicts across repeated reads',
    () =>
      Effect.sync(() => {
        const recording = makeInputRecording({ digests: true })
        const map = recording.evidence!.files
        const observation: FileObservation = {
          path: '/fixture/input',
          by: ['b.genie.ts'],
          state: 'present',
          digest: digestBytes('first'),
          byteLength: 5,
        }
        retainObservation({ recording, map, key: observation.path, observation })
        retainObservation({
          recording,
          map,
          key: observation.path,
          observation: { ...observation, by: ['a.genie.ts'] },
        })
        retainObservation({
          recording,
          map,
          key: observation.path,
          observation: { ...observation, by: ['a.genie.ts'] },
        })
        expect(map.get(observation.path)?.by).toEqual(['a.genie.ts', 'b.genie.ts'])
        retainObservation({
          recording,
          map,
          key: observation.path,
          observation: { ...observation, digest: digestBytes('other') },
        })
        expect(map.get(observation.path)).toMatchObject({
          digest: digestBytes('first'),
          by: ['a.genie.ts', 'b.genie.ts'],
        })
        expect(recording.reasons.map((reason) => reason.code)).toEqual(['unstable-observation'])
        expect(makeInputRecording({ digests: true }).evidence!.files.size).toBe(0)
      }),
  )
})
