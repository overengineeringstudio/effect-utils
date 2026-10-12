import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkArtifacts,
  defineArtifactRegistry,
  diffArtifacts,
  fingerprint,
  fingerprintInputs,
  writeArtifacts,
} from './artifact-registry.ts'
import { runRegistryCli } from './cli.ts'

describe('committed artifact registry', () => {
  it('detects missing, edited and byte-level drift while preserving unchanged writers', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'schema-registry-'))
    const artifacts = defineArtifactRegistry([
      { id: 'schema', path: 'generated/record.json', content: '{"type":"agent-trace/v2"}\n' },
    ])
    const path = join(repositoryRoot, artifacts[0]!.path)
    try {
      expect(diffArtifacts({ repositoryRoot, artifacts })).toEqual([
        {
          id: 'schema',
          path: artifacts[0]!.path,
          expectedFingerprint: fingerprint(artifacts[0]!.content),
        },
      ])
      expect(() => checkArtifacts({ repositoryRoot, artifacts })).toThrow('missing or stale')
      writeArtifacts({ repositoryRoot, artifacts })
      expect(() => checkArtifacts({ repositoryRoot, artifacts })).not.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(artifacts[0]!.content)
      expect(statSync(path).mode & 0o222).toBe(0)
      const time = new Date('2020-01-01T00:00:00.000Z')
      utimesSync(path, time, time)
      writeArtifacts({ repositoryRoot, artifacts })
      expect(statSync(path).mtimeMs).toBe(time.getTime())
      chmodSync(path, 0o644)
      writeFileSync(path, artifacts[0]!.content.replace('\n', '\r\n'))
      expect(diffArtifacts({ repositoryRoot, artifacts })[0]).toMatchObject({
        actualFingerprint: fingerprint(readFileSync(path)),
      })
      expect(() => checkArtifacts({ repositoryRoot, artifacts })).toThrow('generated/record.json')
      const lines: string[] = []
      expect(
        runRegistryCli({
          argv: ['diff'],
          repositoryRoot,
          artifacts,
          output: (line) => lines.push(line),
        }),
      ).toBe(1)
      expect(lines[0]).toContain('generated/record.json')
      expect(runRegistryCli({ argv: ['generate'], repositoryRoot, artifacts })).toBe(0)
      expect(runRegistryCli({ argv: ['check'], repositoryRoot, artifacts })).toBe(0)
      expect(runRegistryCli({ argv: ['diff'], repositoryRoot, artifacts })).toBe(0)
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })
  it('rejects duplicates and escaping paths', () => {
    const artifact = { id: 'schema', path: 'generated/a.json', content: '{}' }
    expect(() => defineArtifactRegistry([artifact, artifact])).toThrow('duplicate')
    expect(() => defineArtifactRegistry([artifact, { ...artifact, id: 'second' }])).toThrow(
      'duplicate',
    )
    for (const path of ['../escape', '/absolute', 'a/../escape', 'a\\b', ''])
      expect(() => defineArtifactRegistry([{ ...artifact, path }])).toThrow('Invalid')
  })
  it('fingerprints both named inputs and content without concatenation ambiguity', () => {
    expect(fingerprintInputs([{ path: 'a', content: 'bc' }])).not.toBe(
      fingerprintInputs([{ path: 'ab', content: 'c' }]),
    )
    expect(fingerprintInputs([{ path: 'a', content: 'one' }])).not.toBe(
      fingerprintInputs([{ path: 'a', content: 'two' }]),
    )
  })
})
