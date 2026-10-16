import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { ARTIFACT_LIMITS, type RetainedArtifact } from '../../isomorphic/Artifacts.ts'
import { renderArtifactOutput, selectArtifactMember, selectArtifactRun } from './artifacts.ts'

const selection = { repo: 'owner/repository', runId: 42, artifactId: 71 }
const artifact: RetainedArtifact = {
  id: selection.artifactId,
  name: 'test (linux)',
  size_in_bytes: 123,
  expired: false,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  expires_at: '2026-10-17T00:00:00Z',
  workflow_run: { id: selection.runId },
}
const readOutput = (text: string) => ({
  repo: selection.repo,
  runId: selection.runId,
  artifact,
  content: {
    path: 'reports/test.txt',
    text,
    decompressedBytes: new TextEncoder().encode(text).byteLength,
  },
})
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))

it.effect('renders a single metadata page without inferring a job from an artifact name', () =>
  Effect.gen(function* () {
    const output = {
      repo: selection.repo,
      runId: selection.runId,
      page: 2,
      totalCount: 201,
      artifacts: [artifact],
      hasMore: true,
    }
    const rendered = yield* renderArtifactOutput(output)
    expect(decodeJson(rendered)).toEqual(output)
    expect(rendered).not.toContain('job')
    expect(rendered).not.toContain('archive_download_url')
  }),
)

it.effect('renders members with artifact and run provenance, including directory entries', () =>
  Effect.gen(function* () {
    const output = {
      repo: selection.repo,
      runId: selection.runId,
      artifact,
      members: [
        { path: 'reports/', compressedBytes: 0, decompressedBytes: 0, directory: true },
        { path: 'reports/test.txt', compressedBytes: 5, decompressedBytes: 3, directory: false },
      ],
    }
    expect(decodeJson(yield* renderArtifactOutput(output))).toEqual(output)
  }),
)

it.effect(
  'escapes terminal controls, line separators, and Unicode format controls losslessly',
  () =>
    Effect.gen(function* () {
      const text =
        '\u001b[31mred\u001b[0m\n\r\t\u0000\u007f\u0085\u009b\u2028\u2029\u202e\u2066\u200b\u{e0001}'
      const output = readOutput(text)
      const rendered = yield* renderArtifactOutput(output)
      expect(rendered).not.toMatch(/[\p{Cc}\u2028\u2029\p{Cf}]/u)
      expect(decodeJson(rendered)).toEqual(output)
      expect(rendered).toContain('\\u001b')
      expect(rendered).toContain('\\u0085')
      expect(rendered).toContain('\\u2028')
      expect(rendered).toContain('\\u2029')
      expect(rendered).toContain('\\u202e')
      expect(rendered).toContain('\\u2066')
      expect(rendered).toContain('\\udb40\\udc01')
    }),
)

it.effect('does not serialize unmodeled transport URL or credential fields', () =>
  Effect.gen(function* () {
    const output = {
      ...readOutput('safe text'),
      artifact: {
        ...artifact,
        archive_download_url: 'private-storage-locator',
        token: 'private-token',
      },
    }
    const rendered = yield* renderArtifactOutput(output)
    expect(rendered).not.toContain('private-storage-locator')
    expect(rendered).not.toContain('private-token')
    expect(decodeJson(rendered)).toEqual(readOutput('safe text'))
  }),
)

it.effect('counts the complete UTF-8 envelope and newline, accepting exactly the cap', () =>
  Effect.gen(function* () {
    // Keep decompressedBytes fixed so changing the text does not change metadata width.
    const output = { ...readOutput(''), content: { path: 'a', text: '', decompressedBytes: 0 } }
    const baseline = new TextEncoder().encode(yield* renderArtifactOutput(output)).byteLength + 1
    const exact = {
      ...output,
      content: { ...output.content, text: 'a'.repeat(ARTIFACT_LIMITS.outputBytes - baseline) },
    }
    const rendered = yield* renderArtifactOutput(exact)
    expect(new TextEncoder().encode(rendered).byteLength + 1).toBe(ARTIFACT_LIMITS.outputBytes)
    const error = yield* Effect.flip(
      renderArtifactOutput({
        ...exact,
        content: { ...exact.content, text: exact.content.text + 'a' },
      }),
    )
    expect(error.reason).toBe('limit-exceeded')
    expect(error.repo).toBe(selection.repo)
    expect(error.runId).toBe(selection.runId)
    expect(error.artifactId).toBe(selection.artifactId)
    expect(error.member).toBe('a')
  }),
)

it.effect('rejects escaped or multibyte output exceeding the cap rather than truncating it', () =>
  Effect.gen(function* () {
    for (const text of ['\u001b'.repeat(50_000), '界'.repeat(90_000)]) {
      const error = yield* Effect.flip(renderArtifactOutput(readOutput(text)))
      expect(error.reason).toBe('limit-exceeded')
    }
  }),
)

describe('explicit run selection', () => {
  it.effect('accepts an exact numeric run ID with a repository', () =>
    Effect.gen(function* () {
      expect(yield* selectArtifactRun(selection.repo, '42')).toEqual({
        repo: selection.repo,
        runId: 42,
      })
    }),
  )
  for (const run of [
    '#42',
    'latest',
    'https://github.com/owner/repository/actions/runs/42',
    '1e3',
    '+42',
    ' 42',
    '42.0',
    '-1',
    '0',
    '9007199254740992',
  ]) {
    it.effect('rejects non-explicit or unsafe run selection: ' + run, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(selectArtifactRun(selection.repo, run))
        expect(error.reason).toBe('invalid-selection')
      }),
    )
  }
  it.effect('rejects missing or malformed repository selection', () =>
    Effect.gen(function* () {
      for (const repo of ['', 'owner', 'owner/repository/extra', 'owner/repo\n']) {
        const error = yield* Effect.flip(selectArtifactRun(repo, '42'))
        expect(error.reason).toBe('invalid-selection')
      }
    }),
  )
})

it.effect('preserves exact safe member paths without globbing or normalization', () =>
  Effect.gen(function* () {
    for (const member of ['reports/test.txt', 'reports/é.txt', 'literal*.txt']) {
      expect(yield* selectArtifactMember(selection, member)).toBe(member)
    }
  }),
)

it.effect('rejects unsafe or directory member selections before transport is needed', () =>
  Effect.gen(function* () {
    for (const member of [
      '',
      '../secret',
      './file',
      'a/../file',
      'a//file',
      '/absolute',
      'C:/file',
      'a\\file',
      'a\u0000file',
      'a\u001bfile',
      'a\u202efile',
      'a\u2066file',
      'e\u0301.txt',
      'directory/',
    ]) {
      const error = yield* Effect.flip(selectArtifactMember(selection, member))
      expect(error.reason).toBe('invalid-selection')
      expect(error.repo).toBe(selection.repo)
      expect(error.runId).toBe(selection.runId)
      expect(error.artifactId).toBe(selection.artifactId)
      // Never put the rejected control-bearing input into the printable error.
      expect(error.member).toBeNull()
    }
  }),
)
