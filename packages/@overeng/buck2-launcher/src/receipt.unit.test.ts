import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  countOutcomes,
  decodeReceipt,
  descriptorForClosureManifest,
  descriptorForFile,
  explainClosures,
  materializationsSemanticallyComplete,
  normalizeActions,
  normalizeMaterialization,
  parseJsonLines,
  sanitizeEvidenceText,
  type EvidenceDescriptor,
} from './receipt.ts'

const descriptor = (hex: string): EvidenceDescriptor => ({
  digest: `sha256:${hex.repeat(64)}`,
  byteLength: 1,
  mediaType: 'application/json',
})

describe('Buck receipt normalization', () => {
  it('keeps DICE reuse distinct from cache hits and execution', () => {
    const actions = normalizeActions([
      {
        identity: 'root//:local',
        reproducer: { executor: 'Local', details: { env: { TOKEN: 'no' } } },
      },
      { identity: 'root//:remote', reproducer: { executor: 'RE' } },
      { identity: 'root//:cached', result: 'remote_cache_hit' },
    ])
    expect(actions.map((action) => action.outcome)).toEqual([
      'local_execution',
      'remote_execution',
      'remote_cache_hit',
    ])
    expect(
      normalizeActions([
        { identity: 'root//:x', reproducer: { executor: 'Local' }, duration: '1.5s' },
      ]),
    ).toMatchObject([{ durationMs: 1500 }])
    expect(countOutcomes([], 'dice_reuse')).toEqual({ dice_reuse: 1 })
  })

  it('parses only JSON rows and aggregates materialization without retaining paths', () => {
    const rows = parseJsonLines(
      'Showing commands\n{"path":"/private/x","file_count":2,"total_bytes":42}\n',
    )
    expect(normalizeMaterialization(rows)).toEqual({ records: 1, files: 2, bytes: 42 })
  })

  it('redacts paths, credentials, and secret assignments', () => {
    const result = sanitizeEvidenceText(
      'build /home/alice/private token=hunter2 GITHUB_TOKEN=github-secret PRIVATE_TOKEN=private-secret AWS_SECRET_ACCESS_KEY=aws-secret https://alice:hunter2@example.invalid/x',
    )
    expect(result).toContain('<path>')
    expect(result).not.toContain('alice')
    expect(result).not.toContain('hunter2')
    expect(result).not.toContain('github-secret')
    expect(result).not.toContain('private-secret')
    expect(result).not.toContain('aws-secret')
  })

  it('redacts header and space-delimited credential forms', () => {
    const result = sanitizeEvidenceText(
      'authorization: Bearer header-secret token: token-secret --api-key cli-secret',
    )
    expect(result).not.toContain('header-secret')
    expect(result).not.toContain('token-secret')
    expect(result).not.toContain('cli-secret')
  })

  it('redacts authorization schemes and credentials from normalized action identities', () => {
    const actions = normalizeActions([
      { identity: 'root//:bearer --authorization Bearer bearer-secret' },
      { identity: 'root//:basic --authorization Basic basic-secret' },
    ])
    const serialized = JSON.stringify(actions)
    expect(serialized).not.toContain('bearer-secret')
    expect(serialized).not.toContain('basic-secret')
  })

  it('redacts quoted credential keys', () => {
    const result = sanitizeEvidenceText(
      '{"token":"json-token-secret","authorization":"Bearer json-header-secret"}',
    )
    expect(result).not.toContain('json-token-secret')
    expect(result).not.toContain('json-header-secret')
  })

  it('redacts camelCase credential keys from normalized action identities', () => {
    const actions = normalizeActions([
      { identity: '{"githubToken":"github-camel-secret"}' },
      { identity: 'accessToken=access-camel-secret' },
      { identity: 'apiKey: api-camel-secret' },
    ])
    const serialized = JSON.stringify(actions)
    expect(serialized).not.toContain('github-camel-secret')
    expect(serialized).not.toContain('access-camel-secret')
    expect(serialized).not.toContain('api-camel-secret')
  })

  it('requires materialization counters to be nonnegative safe integers', () => {
    const valid = { path: 'buck-out/x', method: 'copy', file_count: 1, total_bytes: 2 }
    for (const invalid of [
      { ...valid, file_count: 1.5 },
      { ...valid, total_bytes: 2.5 },
      { ...valid, file_count: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, total_bytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(materializationsSemanticallyComplete([invalid])).toBe(false)
    }
    expect(materializationsSemanticallyComplete([valid])).toBe(true)
  })

  it('describes retained evidence by its exact streamed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck-evidence-descriptor-'))
    const evidence = join(root, 'large.jsonl')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 'e')
    await writeFile(evidence, bytes)

    await expect(descriptorForFile(evidence, 'application/x-ndjson')).resolves.toEqual({
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
      mediaType: 'application/x-ndjson',
    })
  })

  it('classifies explicit failure and cancellation before executor provenance', () => {
    expect(
      normalizeActions([
        { identity: 'root//:failed', result: 'failed', executor: 'Local' },
        { identity: 'root//:cancelled', result: 'cancelled', executor: 'RE' },
      ]).map((action) => action.outcome),
    ).toEqual(['failed', 'cancelled'])
  })

  it('explains exact closure changes but does not invent another input cause', () => {
    const before = [{ label: 'root//:x', descriptor: descriptor('a') }]
    const after = [{ label: 'root//:x', descriptor: descriptor('b') }]
    expect(explainClosures(after, before, 1)).toMatchObject({
      status: 'exact',
      changedDimensions: [{ dimension: 'externalClosure', label: 'root//:x' }],
    })
    expect(explainClosures(after, after, 1)).toMatchObject({
      status: 'partial',
      changedDimensions: [],
    })
  })

  it('canonicalizes validated closure manifests before hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck-closure-canonical-'))
    const one = join(root, 'one.json')
    const two = join(root, 'two.json')
    const unsorted = join(root, 'unsorted.json')
    const semantic = {
      packagePath: 'packages/example',
      target: {
        name: 'check',
        kind: 'typescript_check',
        sources: [],
        configs: [],
        deps: [],
        closureDescriptor: 'buck2/check.json',
      },
      closure: { task: { label: 'root//:check' } },
    }
    const isRecord = (input: unknown): input is Record<string, unknown> =>
      typeof input === 'object' && input !== null
    const canonical = (input: unknown): unknown =>
      Array.isArray(input) === true
        ? input.map(canonical)
        : isRecord(input) === true
          ? Object.fromEntries(
              Object.entries(input)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, child]) => [key, canonical(child)]),
            )
          : input
    const value = {
      schemaVersion: 1,
      ...semantic,
      provenance: {
        generator: 'effect-utils/genie/buck2',
        regenerationCommand: 'genie',
        semanticFingerprint: `sha256:${createHash('sha256')
          .update(JSON.stringify(canonical(semantic)))
          .digest('hex')}`,
        semanticInputs: [],
      },
    }
    await writeFile(one, JSON.stringify(value))
    await writeFile(two, JSON.stringify({ ...value, schemaVersion: 1 }, null, 4))
    expect(await descriptorForClosureManifest(one, 'root//:check')).toEqual(
      await descriptorForClosureManifest(two, 'root//:check'),
    )
    await expect(descriptorForClosureManifest(one, 'root//:other')).rejects.toThrow(
      'label mismatch',
    )
    const unsortedSemantic = {
      ...semantic,
      target: { ...semantic.target, sources: ['z.ts', 'a.ts'] },
    }
    await writeFile(
      unsorted,
      JSON.stringify({
        schemaVersion: 1,
        ...unsortedSemantic,
        provenance: {
          ...value.provenance,
          semanticFingerprint: `sha256:${createHash('sha256')
            .update(JSON.stringify(canonical(unsortedSemantic)))
            .digest('hex')}`,
        },
      }),
    )
    await expect(descriptorForClosureManifest(unsorted, 'root//:check')).rejects.toThrow(
      'sorted and unique',
    )

    const generated = join(root, 'generated-v2.json')
    const generatedSemantic = {
      ...semantic,
      closure: { request: { label: 'root//:check' } },
    }
    await writeFile(
      generated,
      JSON.stringify({
        schemaVersion: 2,
        ...generatedSemantic,
        provenance: {
          ...value.provenance,
          semanticFingerprint: `sha256:${createHash('sha256')
            .update(JSON.stringify(canonical(generatedSemantic)))
            .digest('hex')}`,
        },
      }),
    )
    await expect(descriptorForClosureManifest(generated, 'root//:check')).resolves.toMatchObject({
      mediaType: 'application/json',
    })
  })

  it('rejects malformed nested receipt evidence', () => {
    expect(() =>
      decodeReceipt({
        schema: 'buck-run-receipt/v1',
        launcherRunId: 'x',
        closures: [],
        actions: [],
      }),
    ).toThrow('$.command')
  })
})
