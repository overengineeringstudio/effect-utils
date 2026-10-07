import { describe, expect, it } from 'bun:test'

import type { ActionInvocation, ActionRecord } from './buck2-action-evidence.ts'
import {
  createCacheEvidenceProjector,
  decodeCacheAdmissionEvidence,
  decodeCacheEvidence,
  disabledCacheEvidence,
  emptyCacheEvidence,
  maxCacheEvidenceActions,
  mergeCacheEvidence,
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
          outputs: [{ tiny_digest: 'not-an-action-key' }],
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
                      action_digest: `digest-${String(index).padStart(3, '0')}:142`,
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
    expect(result.actions[0]!.digest).toBe('digest-000:142')
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
        freshRoot: true,
        actionCount: 100,
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
  it('accepts hash-shaped wrapper UUIDs without imposing random UUID version bits', () => {
    const invocation = {
      invocationId: '01234567-89ab-cdef-0123-456789abcdef',
      admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 1 },
    }
    expect(
      decodeCacheAdmissionEvidence({ admissionInvocations: [invocation] }).admissionInvocations,
    ).toEqual([invocation])
  })
})
