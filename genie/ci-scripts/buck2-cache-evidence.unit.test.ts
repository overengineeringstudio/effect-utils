import { describe, expect, it } from 'bun:test'

import { decodeOutputTinyDigests } from './buck2-action-evidence-codec.ts'
import {
  classifyCacheUploadError,
  decodeCacheUploadErrors,
  decodeGrpcCode,
} from './buck2-action-evidence-codec.ts'
import {
  darwinUnsandboxedCategories,
  localMaterializationCategories,
  type ActionInvocation,
  type ActionRecord,
} from './buck2-action-evidence.ts'
import {
  createCacheEvidenceProjector,
  decodeCacheAdmissionEvidence,
  decodeCacheAdmissionInvocation,
  decodeCacheEvidence,
  disabledCacheEvidence,
  emptyCacheEvidence,
  finalizeNativeLogFreshness,
  maxCacheEvidenceActions,
  mergeCacheEvidence,
  type ReaderReapiUnavailableShadow,
} from './buck2-cache-evidence.ts'

// Reduced native `buck2 log show` records from local-build.pb.zst, decoded by
// pinned buck2 2026-08-31-be6971d. Hit/other enum transitions below are synthetic;
// the real fixture has one uploaded Run and one nondigest SIMPLE action.
const fixtureBuildId = '4b68ac2f-58e1-4846-afb2-eff9358143b6'
const fixtureDigest = 'c1432d52d89dd523f813437947c35f80ed083ddbe2abeb00a2148bbcb2013606:142'
const fixtureIdentity = {
  key: {
    key: '_1',
    owner: {
      TargetLabel: {
        label: { package: 'effect_utils//buck2/static', name: 'devenv_trace_audit_check' },
        configuration: { full_name: 'linux_x86_64#a312ca1b' },
      },
    },
  },
  kind: 'Run',
  name: { category: 'repository_validation', identifier: 'devenv_trace_audit_check' },
}
const fixtureCommand = {
  details: {
    command_kind: {
      command: { OmittedLocalCommand: { action_digest: fixtureDigest } },
    },
  },
}
const nativeEvent = (
  phase: 'SpanStart' | 'SpanEnd',
  action: unknown,
  spanId = 20181,
  buildId = fixtureBuildId,
) => ({
  Event: {
    trace_id: buildId,
    span_id: spanId,
    parent_id: 42,
    data: { [phase]: { data: { ActionExecution: action } } },
  },
})
const actionEnd = (overrides: Record<string, unknown> = {}) => ({
  ...fixtureIdentity,
  execution_kind: 1,
  cache_upload_result: 1,
  commands: [fixtureCommand],
  ...overrides,
})
const project = (values: unknown[], context?: string) => {
  const projector = createCacheEvidenceProjector({ context })
  for (const value of values) projector.add(value)
  return projector.finish()
}

describe('native Buck cache evidence projection', () => {
  it('counts structured archive fallbacks by reason, deduplicates native logs and drops payloads', () => {
    const sha256 = 'a'.repeat(64)
    const reasons = ['not-found', 'headers-timeout', 'connection-error', 'server-error']
    const events = reasons.map((reason, index) =>
      nativeEvent(
        'SpanEnd',
        actionEnd({
          name: { category: 'pnpm_archive' },
          commands: [
            {
              details: {
                ...fixtureCommand.details,
                cmd_stderr: `${JSON.stringify({
                  type: 'archive-origin-fallback',
                  reason,
                  sha256,
                  privateHost: 'PRIVATE_HOST',
                })}\nPRIVATE_STDERR\n`,
              },
            },
          ],
        }),
        index,
      ),
    )
    const evidence = project([...events, ...events])
    const counts = {
      'not-found': 1,
      'headers-timeout': 1,
      'connection-error': 1,
      'server-error': 1,
    }
    expect(evidence.archiveOriginFallbacks).toEqual(counts)
    expect(evidence.invocations[0]?.archiveOriginFallbacks).toEqual(counts)
    expect(evidence.admissionFallbacks).toEqual({ reapi: 0, archiveOrigin: 4 })
    const admitted = {
      ...evidence,
      admissionFallbacks: { reapi: 1, archiveOrigin: 5 },
      admissionInvocations: [
        {
          invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
          admissionFallbacks: { reapi: 1, archiveOrigin: 1 },
          admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
        },
      ],
    }
    expect(decodeCacheEvidence(admitted)).toEqual(admitted)
    const merged = mergeCacheEvidence({ previous: admitted, next: evidence })
    expect(merged.archiveOriginFallbacks).toEqual(counts)
    expect(merged.admissionFallbacks).toEqual(admitted.admissionFallbacks)
    expect(JSON.stringify(merged)).not.toContain('PRIVATE')
    expect(() =>
      decodeCacheEvidence({
        ...admitted,
        archiveOriginFallbacks: { ...counts, 'headers-timeout': 2 },
      }),
    ).toThrow('Archive origin fallback aggregate mismatch')
    expect(() =>
      decodeCacheEvidence({
        ...admitted,
        admissionFallbacks: { reapi: 1, archiveOrigin: 1 },
      }),
    ).toThrow('Cache admission aggregate mismatch')
    const second = project(
      events.map((event) =>
        Object.assign({}, event, {
          Event: { ...event.Event, trace_id: 'second-build' },
        }),
      ),
    )
    expect(mergeCacheEvidence({ previous: merged, next: second }).admissionFallbacks).toEqual({
      reapi: 1,
      archiveOrigin: 9,
    })
  })

  it('ignores fallback lookalikes outside archive actions or with invalid identities/reasons', () => {
    const diagnostic = (reason: string, sha256 = 'a'.repeat(64)) =>
      `${JSON.stringify({ type: 'archive-origin-fallback', reason, sha256 })}\n`
    const command = (stderr: string) => ({
      details: { ...fixtureCommand.details, cmd_stderr: stderr },
    })
    const evidence = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({
          commands: [command(diagnostic('headers-timeout'))],
        }),
        1,
      ),
      nativeEvent(
        'SpanEnd',
        actionEnd({
          name: { category: 'pnpm_archive' },
          commands: [
            command(
              diagnostic('unknown') +
                diagnostic('headers-timeout', 'PRIVATE_HOST') +
                '{"type":"archive-origin-fallback",broken-json\n',
            ),
          ],
        }),
        2,
      ),
    ])
    expect(evidence.archiveOriginFallbacks).toBeUndefined()
    expect(evidence.admissionFallbacks).toEqual({ reapi: 0, archiveOrigin: 0 })
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE')
  })

  it('retains ordered truncated output evidence for successful non-uploaded commands in every category', () => {
    const expected = {
      algorithm: 'buck2-tiny-digest-v1',
      outputs: [
        { index: 0, tinyDigest: 'ffffffff' },
        { index: 1, tinyDigest: '00000000' },
        { index: 2, tinyDigest: 'ffffffff' },
      ],
    }
    for (const category of [
      'rustc',
      'deps',
      'cargo_extract',
      'buildscript',
      'rustc_cfg',
      'rust_interop_napi',
      'rust_interop_service',
      'rust_wasm_guest',
      'tsgo_emit',
    ]) {
      for (const uploadResult of [0, 3, 9]) {
        const rows: ActionRecord[] = []
        const projector = createCacheEvidenceProjector({ onAction: (row) => rows.push(row) })
        projector.add(
          nativeEvent(
            'SpanEnd',
            actionEnd({
              name: { category },
              failed: false,
              cache_upload_result: uploadResult,
              outputs: expected.outputs.map((output) => ({ tiny_digest: output.tinyDigest })),
            }),
          ),
        )
        const summary = projector.finish()
        expect(rows[0]?.digest).toBe(fixtureDigest)
        expect(rows[0]?.outputTinyDigests).toEqual(expected)
        expect(summary.actions[0]?.outputTinyDigests).toEqual(expected)
        expect(decodeCacheEvidence(summary)).toEqual(summary)
      }
    }
    for (const overrides of [{ cache_upload_result: 1 }, { failed: true }, { kind: 'Write' }]) {
      const rows: ActionRecord[] = []
      const projector = createCacheEvidenceProjector({ onAction: (row) => rows.push(row) })
      projector.add(
        nativeEvent(
          'SpanEnd',
          actionEnd({
            cache_upload_result: 0,
            outputs: [{ tiny_digest: 'ffffffff' }],
            ...overrides,
          }),
        ),
      )
      expect(projector.finish().actions[0]?.outputTinyDigests).toBeUndefined()
      expect(rows[0]?.outputTinyDigests).toBeUndefined()
    }
  })

  it('distinguishes changed output indices across runs with the same action digest', () => {
    const summaries = [
      ['aaaaaaaa', 'bbbbbbbb'],
      ['aaaaaaaa', 'cccccccc'],
    ].map((digests, run) =>
      project([
        nativeEvent(
          'SpanEnd',
          actionEnd({
            name: { category: 'rustc' },
            cache_upload_result: 0,
            outputs: digests.map((tiny_digest) => ({ tiny_digest })),
          }),
          1,
          `run-${run}`,
        ),
      ]),
    )
    const first = summaries[0]!.actions[0]!
    const next = summaries[1]!.actions[0]!
    expect(first.digest).toBe(next.digest)
    expect(
      first.outputTinyDigests?.outputs.map((output, index) => ({
        index,
        equal: output.tinyDigest === next.outputTinyDigests?.outputs[index]?.tinyDigest,
      })),
    ).toEqual([
      { index: 0, equal: true },
      { index: 1, equal: false },
    ])
    const merged = mergeCacheEvidence({ previous: summaries[0]!, next: summaries[1]! })
    expect(decodeCacheEvidence(merged).actions.map((action) => action.outputTinyDigests)).toEqual([
      first.outputTinyDigests,
      next.outputTinyDigests,
    ])
  })

  it('rejects malformed output evidence without inventing missing native digests', () => {
    expect(decodeOutputTinyDigests(undefined)).toBeUndefined()
    expect(decodeOutputTinyDigests({ algorithm: 'buck2-tiny-digest-v1', outputs: [] })).toEqual({
      algorithm: 'buck2-tiny-digest-v1',
      outputs: [],
    })
    for (const value of [
      { algorithm: 'sha256', outputs: [] },
      { algorithm: 'buck2-tiny-digest-v1', outputs: null },
      ...['abc', 'AABBCCDD', 'g'.repeat(8), 'a'.repeat(64), null].map((tinyDigest) => ({
        algorithm: 'buck2-tiny-digest-v1',
        outputs: [{ index: 0, tinyDigest }],
      })),
      { algorithm: 'buck2-tiny-digest-v1', outputs: [{ index: 1, tinyDigest: 'aaaaaaaa' }] },
    ])
      expect(() => decodeOutputTinyDigests(value)).toThrow()
    expect(() =>
      project([
        nativeEvent(
          'SpanEnd',
          actionEnd({
            cache_upload_result: 0,
            outputs: [{ tiny_digest: 'not-a-digest' }],
          }),
        ),
      ]),
    ).toThrow()
  })

  it('projects explicit invocation lookup policy without relabeling native outcomes or categories', () => {
    for (const cacheReadPolicy of ['enabled', 'disabled-by-design', 'unknown'] as const) {
      const invocations: ActionInvocation[] = []
      const rows: ActionRecord[] = []
      const projector = createCacheEvidenceProjector({
        context: 'capability-identity-dependency',
        cacheReadPolicy,
        onInvocation: (invocation) => invocations.push(invocation),
        onAction: (action) => rows.push(action),
      })
      projector.add(
        nativeEvent(
          'SpanEnd',
          actionEnd({
            name: { category: 'capability_identity_dependency_negative' },
            execution_kind: 1,
            cache_upload_result: 0,
          }),
        ),
      )
      projector.finish()
      expect(invocations[0]!.cacheReadPolicy).toBe(cacheReadPolicy)
      expect(rows[0]).toMatchObject({
        category: 'capability_identity_dependency_negative',
        executionKind: 1,
        outcome: 'local',
        exclusionReason: null,
      })
    }
  })

  it('reports every materialization category separately without relabeling native outcomes', () => {
    for (const category of localMaterializationCategories) {
      for (const executionKind of [1, 3, 8, 10]) {
        const rows: ActionRecord[] = []
        const invocations: ActionInvocation[] = []
        const projector = createCacheEvidenceProjector({
          onAction: (row) => rows.push(row),
          onInvocation: (invocation) => invocations.push(invocation),
        })
        projector.add(
          nativeEvent(
            'SpanEnd',
            actionEnd({
              name: { category },
              execution_kind: executionKind,
              cache_upload_result: 0,
              commands: executionKind === 10 ? [] : [fixtureCommand],
            }),
          ),
        )
        const summary = projector.finish()
        const outcome =
          executionKind === 3 ? 'remote-hit' : executionKind === 10 ? 'local-cache' : 'local'
        expect(summary.counts[outcome]).toBe(1)
        expect(summary.excludedByDesign).toEqual({
          'local-materialization-policy': 1,
          'darwin-unsandboxed': 0,
        })
        expect(summary.invocations[0]?.excludedByDesign).toEqual(summary.excludedByDesign)
        expect(invocations[0]?.excludedByDesign).toEqual(summary.excludedByDesign)
        expect(rows[0]).toMatchObject({
          category,
          executionKind,
          outcome,
          exclusionReason: 'local-materialization-policy',
          digest: executionKind === 10 ? null : fixtureDigest,
        })
        expect(decodeCacheEvidence(summary)).toEqual(summary)
      }
    }
    const eligible = project([
      nativeEvent('SpanEnd', actionEnd({ name: { category: 'tsgo_emit' } })),
    ])
    expect(eligible.excludedByDesign).toEqual({
      'local-materialization-policy': 0,
      'darwin-unsandboxed': 0,
    })
    expect(eligible.actions[0]?.exclusionReason).toBeNull()
  })

  it('names Darwin TS exclusion without excluding Linux TS or unrelated Darwin actions', () => {
    const summaries = darwinUnsandboxedCategories.map((category, index) =>
      decodeCacheEvidence(
        project([
          nativeEvent(
            'SpanEnd',
            actionEnd({
              name: { category },
              execution_kind: 1,
              cache_upload_result: 0,
            }),
            index,
            `darwin-${index}`,
          ),
        ]),
      ),
    )
    for (const summary of summaries) {
      expect(summary.excludedByDesign).toEqual({
        'local-materialization-policy': 0,
        'darwin-unsandboxed': 1,
      })
      expect(summary.actions[0]?.exclusionReason).toBe('darwin-unsandboxed')
      expect(summary.counts.local).toBe(1)
    }
    const merged = summaries.reduce((previous, next) => mergeCacheEvidence({ previous, next }))
    expect(merged.excludedByDesign?.['darwin-unsandboxed']).toBe(darwinUnsandboxedCategories.length)
    expect(decodeCacheEvidence(merged)).toEqual(merged)
    for (const category of ['tsgo_typecheck', 'tsgo_emit', 'rust_compile']) {
      const summary = project([nativeEvent('SpanEnd', actionEnd({ name: { category } }))])
      expect(summary.actions[0]?.exclusionReason).toBeNull()
    }
  })

  it('preserves exclusion counts through bounded decoding and duplicate-aware merging', () => {
    const summaries = ['policy-first', 'policy-next'].map((buildId) =>
      decodeCacheEvidence(
        project(
          Array.from({ length: 100 }, (_, index) =>
            nativeEvent(
              'SpanEnd',
              actionEnd({
                name: {
                  category:
                    localMaterializationCategories[index % localMaterializationCategories.length],
                },
                execution_kind: 3,
                cache_upload_result: 0,
              }),
              index,
              buildId,
            ),
          ),
        ),
      ),
    )
    const first = summaries[0]!
    const next = summaries[1]!
    expect(first.actions).toHaveLength(localMaterializationCategories.length)
    const merged = mergeCacheEvidence({ previous: first, next })
    expect(merged.excludedByDesign).toEqual({
      'local-materialization-policy': 200,
      'darwin-unsandboxed': 0,
    })
    expect(merged.counts['remote-hit']).toBe(200)
    expect(merged.invocations.map((invocation) => invocation.excludedByDesign)).toEqual([
      { 'local-materialization-policy': 100, 'darwin-unsandboxed': 0 },
      { 'local-materialization-policy': 100, 'darwin-unsandboxed': 0 },
    ])
    expect(decodeCacheEvidence(merged)).toEqual(merged)
    expect(mergeCacheEvidence({ previous: merged, next })).toEqual(merged)
  })

  it('preserves the exact uploaded ActionCache key and owner, not output hashes or payloads', () => {
    const result = project(
      [
        {
          trace_id: fixtureBuildId,
          command_line_args: ['SECRET_ARG'],
          working_dir: '/private/root',
        },
        nativeEvent('SpanStart', fixtureIdentity),
        nativeEvent(
          'SpanEnd',
          actionEnd({
            hostname: 'PRIVATE_HOST',
            outputs: [{ tiny_digest: 'deadbeef' }],
            commands: [
              {
                details: {
                  cmd_stdout: 'PRIVATE_STDOUT',
                  cmd_stderr: 'PRIVATE_STDERR',
                  command_kind: {
                    command: {
                      LocalCommand: {
                        action_digest: fixtureDigest,
                        argv: ['SECRET_ARG'],
                        env: [{ key: 'AUTH', value: 'SECRET_AUTH' }],
                      },
                    },
                  },
                },
              },
            ],
          }),
        ),
      ],
      'proof-a-build',
    )
    expect(result.actions).toEqual([
      {
        buildId: fixtureBuildId,
        context: 'proof-a-build',
        category: 'repository_validation',
        exclusionReason: null,
        target: 'effect_utils//buck2/static:devenv_trace_audit_check',
        configuration: 'linux_x86_64#a312ca1b',
        digest: fixtureDigest,
        outcome: 'uploaded',
        executionKind: 1,
        cacheUploadResult: 1,
      },
    ])
    expect(result.counts.uploaded).toBe(1)
    expect(result.invocations[0]!.unpairedStartCount).toBe(0)
    const serialized = JSON.stringify(result)
    for (const secret of [
      'SECRET_ARG',
      'SECRET_AUTH',
      'PRIVATE_HOST',
      'PRIVATE_STDOUT',
      'PRIVATE_STDERR',
      '/private/root',
      'deadbeef',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('uses native numeric execution/upload results, never a remote command cache_hit boolean', () => {
    const transitions = [
      [1, 2, 'local'],
      [3, 8, 'remote-hit'],
      [2, 8, 'remote-execution'],
      [7, 2, 'local-cache'],
      [10, 2, 'local-cache'],
      [9, 5, 'remote-dep-file-hit'],
      [8, 2, 'local'],
      [11, 8, 'remote-execution'],
      [4, 3, 'other'],
      [6, 2, 'other'],
      [0, 0, 'other'],
      [99, 0, 'other'],
    ] as const
    for (const [executionKind, uploadResult, outcome] of transitions) {
      const result = project([
        nativeEvent(
          'SpanEnd',
          actionEnd({
            execution_kind: executionKind,
            cache_upload_result: uploadResult,
            commands: [
              {
                details: {
                  command_kind: {
                    command: {
                      RemoteCommand: {
                        action_digest: fixtureDigest,
                        cache_hit: executionKind !== 3,
                      },
                    },
                  },
                },
              },
            ],
          }),
        ),
      ])
      expect(result.actions[0]!.outcome).toBe(outcome)
      expect(result.counts[outcome]).toBe(1)
    }
    const stringEnum = project([
      nativeEvent('SpanEnd', actionEnd({ execution_kind: '3', cache_upload_result: '1' })),
    ])
    expect(stringEnum.actions[0]!.outcome).toBe('other')
  })

  it('selects the final attempted command native digest without hashing an earlier command', () => {
    const finalDigest = 'abcdef:321'
    const result = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({
          commands: [
            fixtureCommand,
            {
              details: {
                command_kind: {
                  command: { WorkerCommand: { action_digest: finalDigest } },
                },
              },
            },
          ],
        }),
      ),
    ])
    expect(result.actions[0]!.digest).toBe(finalDigest)
  })

  it('counts legitimate nondigest SIMPLE actions separately from missing command key evidence', () => {
    const result = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({
          kind: 'SymlinkedDir',
          execution_kind: 4,
          cache_upload_result: 3,
          commands: [],
        }),
        20180,
      ),
      nativeEvent(
        'SpanEnd',
        actionEnd({
          execution_kind: 3,
          cache_upload_result: 8,
          commands: [],
          outputs: [{ tiny_digest: 'deadbeef' }],
        }),
      ),
    ])
    expect(result.actions).toEqual([])
    expect(result.counts.other).toBe(1)
    expect(result.counts['remote-hit']).toBe(1)
    expect(result.invocations[0]).toMatchObject({
      missingDigestCount: 2,
      missingCommandDigestCount: 1,
      actionCount: 2,
    })
    expect(result.droppedActionCount).toBe(2)
  })

  it('records no-digest reasons for local cache hits without inventing RE action keys', () => {
    for (const executionKind of [7, 10]) {
      // Pinned B worktree log d4af231b has Run/kind 10/upload 3/commands [].
      // Kind 7 is the paired native local-dep-file cache transition.
      const result = project([
        nativeEvent(
          'SpanEnd',
          actionEnd({ execution_kind: executionKind, cache_upload_result: 3, commands: [] }),
        ),
      ])
      expect(result.counts['local-cache']).toBe(1)
      expect(result.actions).toEqual([])
      expect(result.invocations[0]).toMatchObject({
        missingDigestCount: 1,
        missingCommandDigestCount: 1,
        noDigestReasons: { 'local-cache': 1, 'remote-hit': 0, uploaded: 0 },
      })
      expect(decodeCacheEvidence(result)).toEqual(result)
    }
  })

  it('distinguishes missing remote cache keys from legitimate nondigest outcomes', () => {
    const result = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({ execution_kind: 3, cache_upload_result: 8, commands: [] }),
      ),
      nativeEvent('SpanEnd', actionEnd({ commands: [] }), 20182),
      nativeEvent(
        'SpanEnd',
        actionEnd({ execution_kind: 1, cache_upload_result: 2, commands: [] }),
        20183,
      ),
      nativeEvent(
        'SpanEnd',
        actionEnd({ kind: 'Write', execution_kind: 6, cache_upload_result: 2, commands: [] }),
        20184,
      ),
    ])
    expect(result.invocations[0]).toMatchObject({
      missingDigestCount: 4,
      noDigestReasons: { 'remote-hit': 1, uploaded: 1, local: 1, other: 1, 'local-cache': 0 },
    })
    expect(result.actions).toEqual([])
    expect(result.counts).toMatchObject({ 'remote-hit': 1, uploaded: 1, local: 1, other: 1 })
  })

  it('preserves earlier artifacts without fabricating unavailable omission reasons', () => {
    const original = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({ execution_kind: 10, cache_upload_result: 8, commands: [] }),
      ),
    ])
    const earlier = {
      ...original,
      invocations: original.invocations.map(
        ({ noDigestReasons: _noDigestReasons, ...invocation }) => invocation,
      ),
    }
    const decoded = decodeCacheEvidence(earlier)
    expect(decoded).toEqual(earlier)
    expect(decoded.invocations[0]!.noDigestReasons).toBeUndefined()
    expect(decoded.invocations[0]!.missingCommandDigestCount).toBe(1)
  })

  it('joins a missing end identity by span id, not parent id, and reports incomplete starts', () => {
    const result = project([
      nativeEvent('SpanStart', fixtureIdentity, 10),
      nativeEvent('SpanStart', { ...fixtureIdentity, name: { category: 'uncompleted' } }, 11),
      nativeEvent(
        'SpanEnd',
        { execution_kind: 1, cache_upload_result: 1, commands: [fixtureCommand] },
        10,
      ),
    ])
    expect(result.actions[0]).toMatchObject({
      category: 'repository_validation',
      target: 'effect_utils//buck2/static:devenv_trace_audit_check',
      digest: fixtureDigest,
    })
    expect(result.invocations[0]!.unpairedStartCount).toBe(1)
    const unmatched = project([
      nativeEvent('SpanEnd', { execution_kind: 1, commands: [fixtureCommand] }),
    ])
    expect(unmatched.invocations[0]!.missingIdentityCount).toBe(1)
    expect(unmatched.actions).toEqual([])
  })

  it('handles native test, local resource, anonymous and BXL owner variants', () => {
    for (const variant of ['TestTargetLabel', 'LocalResourceSetup']) {
      const result = project([
        nativeEvent(
          'SpanEnd',
          actionEnd({ key: { owner: { [variant]: fixtureIdentity.key.owner.TargetLabel } } }),
        ),
      ])
      expect(result.actions[0]!.target).toBe('effect_utils//buck2/static:devenv_trace_audit_check')
    }
    const anon = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({
          key: { owner: { AnonTarget: { name: { package: 'cell//anon', name: 'generated' } } } },
        }),
      ),
    ])
    expect(anon.actions[0]!.target).toBe('cell//anon:generated')
    const bxl = project([
      nativeEvent(
        'SpanEnd',
        actionEnd({
          key: {
            owner: {
              BxlFunctionKey: { label: { bxl_path: 'cell//tools/query.bxl', name: 'main' } },
            },
          },
        }),
      ),
    ])
    expect(bxl.actions[0]!.target).toBe('cell//tools/query.bxl:main')
  })

  it('keeps representative groups bounded while counting every action and balancing A/B contexts', () => {
    const makeInvocation = (
      buildId: string,
      context: string,
      executionKind: number,
      uploadResult: number,
    ) => {
      const projector = createCacheEvidenceProjector({ context })
      for (let index = 0; index < 100; index++) {
        projector.add(
          nativeEvent(
            'SpanEnd',
            actionEnd({
              name: { category: `category_${String(index).padStart(3, '0')}` },
              execution_kind: executionKind,
              cache_upload_result: uploadResult,
            }),
            index + 1,
            buildId,
          ),
        )
      }
      return projector.finish()
    }
    const writer = makeInvocation('writer-build', 'proof-a-build', 1, 1)
    const reader = makeInvocation('reader-build', 'proof-b-build', 3, 8)
    const merged = mergeCacheEvidence({ previous: writer, next: reader })
    expect(merged.actions.length).toBe(maxCacheEvidenceActions)
    expect(merged.counts).toMatchObject({ uploaded: 100, 'remote-hit': 100 })
    expect(merged.actionCount).toBe(200)
    expect(merged.droppedActionCount).toBe(136)
    const writerGroups = merged.actions
      .filter((row) => row.context === 'proof-a-build')
      .map((row) => [row.category, row.target, row.digest])
    const readerGroups = merged.actions
      .filter((row) => row.context === 'proof-b-build')
      .map((row) => [row.category, row.target, row.digest])
    expect(writerGroups).toEqual(readerGroups)
    expect(writerGroups.length).toBe(32)
  })

  it('does not let repeated actions crowd out distinct category/target representatives', () => {
    const values = Array.from({ length: 100 }, (_, index) =>
      nativeEvent(
        'SpanEnd',
        actionEnd({
          commands: [
            {
              details: {
                command_kind: {
                  command: {
                    OmittedLocalCommand: {
                      action_digest: `${index.toString(16).padStart(64, '0')}:142`,
                    },
                  },
                },
              },
            },
          ],
        }),
        index + 1,
      ),
    )
    values.push(nativeEvent('SpanEnd', actionEnd({ name: { category: 'second_family' } }), 500))
    const result = project(values)
    expect(result.actions.map((row) => row.category)).toEqual([
      'repository_validation',
      'second_family',
    ])
    expect(result.actions[0]!.digest).toBe(`${'0'.repeat(64)}:142`)
    expect(result.counts.uploaded).toBe(101)
    expect(result.droppedActionCount).toBe(99)
  })

  it('deduplicates a native build id across spool/default logs and preserves the descriptive first context', () => {
    const original = project([nativeEvent('SpanEnd', actionEnd())], 'proof-a-build')
    const discovered = project([nativeEvent('SpanEnd', actionEnd())], 'native-log')
    expect(mergeCacheEvidence({ previous: original, next: discovered })).toEqual(original)
    expect(mergeCacheEvidence({ previous: emptyCacheEvidence(), next: original })).toEqual(original)
    expect(mergeCacheEvidence({ previous: original, next: emptyCacheEvidence() })).toEqual(original)
  })

  it('keeps no-logs and disabled-by-design status honest rather than fabricating action evidence', () => {
    expect(emptyCacheEvidence()).toMatchObject({
      status: 'no-native-logs',
      actionCount: 0,
      actions: [],
      invocations: [],
    })
    const disabled = disabledCacheEvidence()
    expect(disabled).toMatchObject({
      status: 'remote-cache-disabled-by-design',
      actionCount: 0,
      actions: [],
      invocations: [],
    })
    expect(disabled.reason).toContain('Nix substitution')
    expect(() => mergeCacheEvidence({ previous: disabled, next: emptyCacheEvidence() })).toThrow(
      'Cannot combine',
    )
  })

  it('rejects mixed invocation streams and unknown persisted contracts', () => {
    expect(() =>
      project([
        nativeEvent('SpanEnd', actionEnd()),
        nativeEvent('SpanEnd', actionEnd(), 22, 'different-build'),
      ]),
    ).toThrow('one Buck invocation')
    expect(() => project([{ unrelated: true }])).toThrow('trace id')
    expect(() => decodeCacheEvidence({ schemaVersion: 2 })).toThrow('Unsupported')
  })

  it('drops unknown persisted payload fields during accumulation and preserves useful counters', () => {
    const original = project([nativeEvent('SpanEnd', actionEnd())])
    const decoded = decodeCacheEvidence({
      ...original,
      command: 'PRIVATE_COMMAND',
      metadata: { job: 'writer', arbitrary: 'PRIVATE_VALUE' },
      actions: original.actions.map((row) => ({ ...row, argv: ['PRIVATE_ARG'] })),
    })
    expect(decoded.actions).toEqual(original.actions)
    expect(decoded.counts).toEqual(original.counts)
    expect(decoded.metadata).toEqual({ job: 'writer' })
    expect(JSON.stringify(decoded)).not.toContain('PRIVATE_')
  })

  it('detects missing confirmed IDs without promoting surviving local-cache invocations', () => {
    const survivor: ActionInvocation = {
      buildId: 'survivor',
      context: 'native-log',
      cacheReadPolicy: 'unknown',
      freshRoot: true,
      actionCount: 1,
      excludedByDesign: { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
      complete: true,
      startedAt: 100,
      completedAt: 200,
    }
    expect(
      finalizeNativeLogFreshness({
        invocations: [survivor],
        confirmedBuildIds: new Set(['earliest', 'survivor']),
      }),
    ).toBe(true)
    expect(survivor.freshRoot).toBe(false)
  })

  it('compares all decoded IDs, deduplicates invocation IDs and reads legacy evidence without rotation', () => {
    const invocation: ActionInvocation = {
      buildId: 'build',
      context: 'native-log',
      cacheReadPolicy: 'unknown',
      freshRoot: true,
      actionCount: 1,
      excludedByDesign: { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
      complete: true,
      startedAt: 100,
      completedAt: 200,
    }
    const invocations = [
      invocation,
      { ...invocation },
      { ...invocation, buildId: 'audit', actionCount: 0, startedAt: 50 },
    ]
    expect(
      finalizeNativeLogFreshness({
        invocations,
        confirmedBuildIds: new Set(['audit', 'build']),
      }),
    ).toBe(false)
    expect(invocation.freshRoot).toBe(true)
    expect(invocations[2]!.freshRoot).toBe(false)
    expect(finalizeNativeLogFreshness({ invocations, confirmedBuildIds: new Set() })).toBe(false)
    expect(invocation.freshRoot).toBe(true)
  })

  it('emits every first action end alongside unchanged bounded representatives', () => {
    const rows: ActionRecord[] = []
    const invocations: ActionInvocation[] = []
    const projector = createCacheEvidenceProjector({
      context: 'populate',
      freshRoot: true,
      onAction: (row) => rows.push(row),
      onInvocation: (invocation) => invocations.push(invocation),
    })
    const command = (phase: 'SpanStart' | 'SpanEnd', seconds: number) => ({
      Event: {
        trace_id: fixtureBuildId,
        timestamp: [seconds, 0],
        span_id: 1,
        data: { [phase]: { data: { Command: {} } } },
      },
    })
    projector.add(command('SpanStart', 1700000000))
    for (let index = 0; index < 100; index++) {
      projector.add({
        Event: {
          ...nativeEvent('SpanStart', fixtureIdentity, index + 10).Event,
          timestamp: [1700000001, index * 1000000],
        },
      })
      const end = {
        Event: {
          ...nativeEvent('SpanEnd', actionEnd(), index + 10).Event,
          timestamp: [1700000002, index * 1000000],
        },
      }
      projector.add(end)
      projector.add(end)
    }
    projector.add(command('SpanEnd', 1700000003))
    const summary = projector.finish()
    expect(summary.actionCount).toBe(100)
    expect(summary.actions).toHaveLength(1)
    expect(summary.droppedActionCount).toBe(99)
    expect(rows).toHaveLength(100)
    expect(rows[0]).toMatchObject({
      type: 'action',
      context: 'populate',
      executionKind: 1,
      cacheUploadResult: 1,
      digest: fixtureDigest,
      startedAt: 1700000001000,
      completedAt: 1700000002000,
      endTime: 1700000002000,
      uploadCompletedAt: 1700000002000,
      uploadOutcome: 'uploaded',
    })
    expect(invocations).toEqual([
      {
        buildId: fixtureBuildId,
        context: 'populate',
        cacheReadPolicy: 'unknown',
        freshRoot: true,
        actionCount: 100,
        excludedByDesign: { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
        complete: true,
        startedAt: 1700000000000,
        completedAt: 1700000003000,
      },
    ])
  })

  it('retains sanitized null identity/digest rows and invalidates missing command evidence', () => {
    const rows: ActionRecord[] = []
    const invocations: ActionInvocation[] = []
    const projector = createCacheEvidenceProjector({
      onAction: (row) => rows.push(row),
      onInvocation: (invocation) => invocations.push(invocation),
    })
    projector.add(
      nativeEvent(
        'SpanEnd',
        actionEnd({
          name: { category: '/private/secret' },
          key: {
            owner: {
              TargetLabel: {
                label: { package: '/private/root', name: 'SECRET=token' },
                configuration: { full_name: '/private/host/path' },
              },
            },
          },
          commands: [
            {
              details: {
                command_kind: {
                  command: {
                    LocalCommand: { action_digest: '/private/secret:12', env: ['SECRET_ENV'] },
                  },
                },
              },
            },
          ],
        }),
      ),
    )
    projector.finish()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: null,
      target: null,
      configuration: null,
      digest: null,
      startedAt: null,
      completedAt: null,
      uploadCompletedAt: null,
    })
    expect(JSON.stringify(rows)).not.toContain('private')
    expect(JSON.stringify(rows)).not.toContain('SECRET')
    expect(invocations[0]!.complete).toBe(false)
  })

  it('retains only closed upload categories and exact gRPC codes', () => {
    for (const [message, category] of [
      ['invalid credentials', 'unauthenticated'],
      ['CAS write denied', 'permission-denied'],
      ['deadline exceeded', 'deadline'],
      ['connection reset', 'unavailable'],
      ['quota exceeded', 'resource-exhausted'],
      ['invalid argument', 'invalid-argument'],
      ['arbitrary! secret', 'other'],
    ]) {
      expect(classifyCacheUploadError(message, 'unknown!code')).toEqual({
        category,
        reErrorCode: null,
      })
    }
    expect(classifyCacheUploadError('', 'PERMISSION_DENIED')).toEqual({
      category: 'permission-denied',
      reErrorCode: 7,
    })
    for (let code = 0; code <= 16; code++) {
      expect(decodeGrpcCode(code)).toBe(code)
      expect(decodeGrpcCode(String(code))).toBe(code)
    }
    for (const code of [-1, 17, 1.5, '07', 'permission_denied', '7 secret', 'secret!'])
      expect(decodeGrpcCode(code)).toBeNull()
    expect(decodeCacheUploadErrors(undefined)).toBeUndefined()
    expect(() => decodeCacheUploadErrors([{ reErrorCode: 7 }])).toThrow()
    expect(decodeCacheUploadErrors([{ category: 'deadline', reErrorCode: 4 }])).toEqual([
      { category: 'deadline', reErrorCode: 4 },
    ])
    expect(() => decodeCacheUploadErrors([{ category: 'secret!' }])).toThrow()
  })

  it('retains each failed native cache upload, not ReUpload metrics or duplicate ends', () => {
    const rows: ActionRecord[] = []
    const projector = createCacheEvidenceProjector({ onAction: (row) => rows.push(row) })
    projector.add(nativeEvent('SpanStart', fixtureIdentity))
    const upload = (
      spanId: number,
      data: unknown,
      parentId = 20181,
      phase: 'SpanStart' | 'SpanEnd' = 'SpanEnd',
    ) => ({
      Event: {
        trace_id: fixtureBuildId,
        span_id: spanId,
        parent_id: parentId,
        data: { [phase]: { data } },
      },
    })
    const failure = upload(30001, {
      CacheUpload: {
        success: false,
        error: 'CAS write denied',
        re_error_code: 'PERMISSION_DENIED',
      },
    })
    projector.add(failure)
    projector.add(failure)
    projector.add(upload(30002, { ExecutorStage: {} }, 20181, 'SpanStart'))
    projector.add(
      upload(30003, { CacheUpload: { success: false, error: 'connection reset' } }, 30002),
    )
    projector.add(upload(30004, { ReUpload: { bytes_uploaded: 0, error: 'NOT_A_NATIVE_FIELD' } }))
    projector.add(upload(30005, { CacheUpload: { success: true, error: 'IGNORE_SUCCESS' } }))
    projector.add(upload(30006, { CacheUpload: { success: false, error: '' } }))
    projector.add(nativeEvent('SpanEnd', actionEnd({ cache_upload_result: 9 })))
    const result = projector.finish()
    const expected = [
      { category: 'permission-denied', reErrorCode: 7 },
      { category: 'unavailable', reErrorCode: null },
      { category: 'other', reErrorCode: null },
    ]
    expect(rows[0]?.uploadErrors).toEqual(expected)
    expect(result.actions[0]?.uploadErrors).toEqual(expected)
    expect(decodeCacheEvidence(result).actions[0]?.uploadErrors).toEqual(expected)
    expect(JSON.stringify({ rows, result })).not.toContain('NOT_A_NATIVE_FIELD')
    expect(JSON.stringify({ rows, result })).not.toContain('IGNORE_SUCCESS')
  })

  it('preserves upload rejection and local-dep-file raw classifications without inventing hits', () => {
    for (const cacheUploadResult of [9, 10, 11, 12, 13, 14, 15, 16]) {
      const rows: ActionRecord[] = []
      const projector = createCacheEvidenceProjector({ onAction: (row) => rows.push(row) })
      projector.add(
        nativeEvent(
          'SpanEnd',
          actionEnd({
            execution_kind: 7,
            cache_upload_result: cacheUploadResult,
          }),
        ),
      )
      projector.finish()
      expect(rows[0]).toMatchObject({
        executionKind: 7,
        cacheUploadResult,
        outcome: 'local-cache',
        uploadOutcome: cacheUploadResult === 16 ? 'not-uploaded' : 'failed',
        uploadCompletedAt: null,
      })
    }
  })

  it('invalidates unknown action kinds and mistyped native enums instead of excluding a possible command', () => {
    for (const overrides of [
      { kind: 'UnknownNativeKind' },
      { kind: undefined },
      { execution_kind: '3' },
      { cache_upload_result: '1' },
    ]) {
      const invocations: ActionInvocation[] = []
      const projector = createCacheEvidenceProjector({
        onInvocation: (invocation) => invocations.push(invocation),
      })
      projector.add({
        Event: {
          trace_id: fixtureBuildId,
          span_id: 1,
          timestamp: [1700000000, 0],
          data: { SpanStart: { data: { Command: {} } } },
        },
      })
      projector.add({
        Event: { ...nativeEvent('SpanStart', fixtureIdentity).Event, timestamp: [1700000001, 0] },
      })
      projector.add({
        Event: {
          ...nativeEvent('SpanEnd', actionEnd(overrides)).Event,
          timestamp: [1700000002, 0],
        },
      })
      projector.add({
        Event: {
          trace_id: fixtureBuildId,
          span_id: 1,
          timestamp: [1700000003, 0],
          data: { SpanEnd: { data: { Command: {} } } },
        },
      })
      expect(projector.finish().actionCount).toBe(1)
      expect(invocations[0]!.complete).toBe(false)
    }
  })
})

describe('cache admission evidence schema', () => {
  it('decodes bounded failure categories, rejects unknown values and preserves legacy rows', () => {
    const row = {
      invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
      admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
    }
    expect(decodeCacheAdmissionInvocation(row)).toEqual(row)
    expect(() => decodeCacheAdmissionInvocation({ ...row, event: 'unknown-event' })).toThrow()
    const failure = { class: 'deadline', phase: 'tls', elapsedMs: 2510, deadlineMs: 2500 }
    expect(decodeCacheAdmissionInvocation({ ...row, reapiFailure: failure }).reapiFailure).toEqual(
      failure,
    )
    for (const reapiDecision of [
      'first-probe-for-ci-job',
      'pinned-from-first-probe',
      'unpinned-missing-job-instance',
    ])
      expect(decodeCacheAdmissionInvocation({ ...row, reapiDecision }).reapiDecision).toBe(
        reapiDecision,
      )
    expect(() =>
      decodeCacheAdmissionInvocation({ ...row, reapiDecision: 'planted-secret' }),
    ).toThrow()
    for (const invalid of [
      { ...failure, class: 'private-host.example' },
      { ...failure, phase: 'unknown' },
      { ...failure, elapsedMs: -1 },
      { ...failure, deadlineMs: Infinity },
      { ...failure, elapsedMs: 1.5 },
      null,
    ])
      expect(() => decodeCacheAdmissionInvocation({ ...row, reapiFailure: invalid })).toThrow()
    expect(() =>
      decodeCacheAdmissionInvocation({
        ...row,
        admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
        reapiFailure: failure,
      }),
    ).toThrow()
    const rows = [
      { ...row, reapiFailure: failure },
      {
        ...row,
        invocationId: 'c568610f-0ddf-40c5-99df-d178142b9dad',
        reapiFailure: { ...failure, elapsedMs: 2600 },
      },
    ]
    const evidence = decodeCacheAdmissionEvidence({ admissionInvocations: rows })
    expect(evidence.reapiFailures).toEqual([
      { class: 'deadline', phase: 'tls', count: 2, maxElapsedMs: 2600 },
    ])
    expect(decodeCacheAdmissionEvidence(evidence).reapiFailures).toEqual(evidence.reapiFailures)
    expect(() => decodeCacheAdmissionEvidence({ ...evidence, reapiFailures: [] })).toThrow()
    expect(decodeCacheAdmissionEvidence({ admissionInvocations: [row] }).reapiFailures).toEqual([])
  })

  it('retains measured #2165 rerun rows and their original invocation pair as read-only legacy evidence', () => {
    const original = {
      invocationId: '9552ef6c-294e-4a51-9100-9006d6f2c343',
      admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
    }
    // Exact old wire shape: the rerun received a fresh invocation UUID and
    // one REAPI fallback, with no shadow payload or provenance tag on disk.
    const rerun = {
      invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
      admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
      event: 'reader-reapi-unavailable-rerun',
    }
    const decoded = decodeCacheAdmissionInvocation(rerun)
    expect(decoded).toEqual({ ...rerun, legacyRerun: true })
    expect(decoded.shadow).toBeUndefined()
    const projected = decodeCacheAdmissionEvidence({ admissionInvocations: [original, rerun] })
    expect(projected.admissionInvocations).toEqual([original, decoded])
    expect(projected.admissionFallbacks).toEqual({ reapi: 1, archiveOrigin: 0 })
    expect(decodeCacheAdmissionEvidence(projected)).toEqual(projected)
    const retained = { ...emptyCacheEvidence(), ...projected }
    const reprojected = mergeCacheEvidence({ previous: retained, next: retained })
    expect(reprojected.admissionInvocations).toEqual([original, decoded])
    expect(reprojected.admissionFallbacks).toEqual({ reapi: 1, archiveOrigin: 0 })
    for (const invalid of [
      { ...rerun, admissionFallbacks: { reapi: 0, archiveOrigin: 0 } },
      { ...rerun, shadow: {} },
      { ...rerun, legacyRerun: false },
      { ...rerun, invocationId: 'invalid' },
      { ...rerun, admissionRetrySuccesses: { reapi: 1, archiveOrigin: 0 } },
      { ...original, legacyRerun: true },
    ])
      expect(() => decodeCacheAdmissionInvocation(invalid)).toThrow()
  })

  it('validates and projects shadow evidence without inventing a fallback or a second invocation', () => {
    const base = decodeCacheAdmissionInvocation({
      invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
      admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
    })
    const shadow: ReaderReapiUnavailableShadow = {
      cause: {
        capabilitiesUnavailable: true,
        connectRetry: true,
        clientInitialization: true,
        connectUnavailable: false,
        transportMessage: 'tls-handshake-eof',
      },
      command: { subcommand: 'build', argumentCount: 4 },
      nativeExitCode: 1,
      durationMs: 47000,
      failedActionCount: 1,
      wouldDisableRemoteCache: true,
    }
    const row = decodeCacheAdmissionInvocation({
      ...base,
      event: 'reader-reapi-unavailable-shadow',
      shadow,
    })
    expect(row.shadow).toEqual(shadow)
    for (const invalid of [
      { ...row, shadow: undefined },
      { ...row, event: undefined },
      {
        ...row,
        event: 'reader-reapi-unavailable-rerun',
        admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      },
      { ...row, admissionFallbacks: { reapi: 1, archiveOrigin: 0 } },
      { ...row, legacyRerun: true },
    ])
      expect(() => decodeCacheAdmissionInvocation(invalid)).toThrow()
    for (const invalidShadow of [
      { ...shadow, nativeExitCode: 0 },
      { ...shadow, nativeExitCode: 256 },
      { ...shadow, durationMs: -1 },
      { ...shadow, durationMs: 0.5 },
      { ...shadow, failedActionCount: -1 },
      { ...shadow, wouldDisableRemoteCache: false },
      { ...shadow, command: { subcommand: 'secret-command', argumentCount: 2 } },
      { ...shadow, cause: { ...shadow.cause, transportMessage: 'unbounded free text' } },
      {
        ...shadow,
        cause: { ...shadow.cause, capabilitiesUnavailable: false, clientInitialization: false },
      },
    ])
      expect(() => decodeCacheAdmissionInvocation({ ...row, shadow: invalidShadow })).toThrow()
    const initial = { ...emptyCacheEvidence(), admissionInvocations: [base] }
    const observed = { ...emptyCacheEvidence(), admissionInvocations: [row] }
    for (const options of [
      { previous: initial, next: observed },
      { previous: observed, next: initial },
      { previous: observed, next: observed },
    ]) {
      const merged = mergeCacheEvidence(options)
      expect(merged.admissionInvocations).toEqual([row])
      expect(merged.admissionFallbacks).toEqual({ reapi: 0, archiveOrigin: 0 })
    }
    expect(() =>
      mergeCacheEvidence({
        previous: observed,
        next: {
          ...emptyCacheEvidence(),
          admissionInvocations: [{ ...row, shadow: { ...shadow, failedActionCount: 2 } }],
        },
      }),
    ).toThrow()
  })

  it('normalizes retained summaries to explicit zero admission evidence', () => {
    const { admissionFallbacks, admissionRetrySuccesses, admissionInvocations, ...legacy } =
      emptyCacheEvidence()
    expect(decodeCacheEvidence(legacy)).toEqual(emptyCacheEvidence())
    expect(admissionFallbacks).toEqual({ reapi: 0, archiveOrigin: 0 })
    expect(admissionRetrySuccesses).toEqual({ reapi: 0, archiveOrigin: 0 })
    expect(admissionInvocations).toEqual([])
  })
  it('merges invocation evidence independently of native logs and recomputes totals', () => {
    const row = {
      invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
      admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 1 },
    }
    const previous = { ...emptyCacheEvidence(), admissionInvocations: [row] }
    const merged = mergeCacheEvidence({ previous, next: previous })
    expect(merged.admissionInvocations).toEqual([row])
    expect(merged.admissionFallbacks).toEqual(row.admissionFallbacks)
    expect(merged.admissionRetrySuccesses).toEqual(row.admissionRetrySuccesses)
    expect(decodeCacheAdmissionEvidence(merged).admissionInvocations).toEqual([row])
    expect(() =>
      decodeCacheAdmissionEvidence({ ...merged, admissionInvocations: [row, row] }),
    ).toThrow()
  })
  it('canonicalizes every Buck UUID spelling without imposing random UUID version bits', () => {
    const invocation = {
      invocationId: '01234567-89ab-cdef-0123-456789abcdef',
      admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 1 },
    }
    for (const invocationId of [
      invocation.invocationId,
      '0123456789ABCDEF0123456789ABCDEF',
      '{01234567-89AB-CDEF-0123-456789ABCDEF}',
      'urn:uuid:01234567-89AB-CDEF-0123-456789ABCDEF',
    ]) {
      expect(
        decodeCacheAdmissionEvidence({
          admissionInvocations: [{ ...invocation, invocationId }],
        }).admissionInvocations,
      ).toEqual([invocation])
    }
  })
})
