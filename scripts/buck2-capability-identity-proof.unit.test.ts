import { describe, expect, it } from 'bun:test'

import {
  assertDependencyExecution,
  assertIdentity,
  identityActions,
  type IdentityAction,
  type Phase,
} from './buck2-capability-identity-proof.ts'

const categories = ['selected', 'unselected', 'dependency_negative', 'dependency_positive']
const observations = (): Record<Phase, IdentityAction[]> => {
  const actions = (phase: Phase): IdentityAction[] =>
    categories.map((name) => ({
      category: `capability_identity_${name}`,
      digest: `${phase === 'action-env' || (phase === 'selected' && name !== 'unselected') ? phase : 'baseline'}-${name}:123`,
      executionKind: phase === 'unused' || (phase === 'selected' && name === 'unselected') ? 3 : 1,
      cacheUploadResult: phase === 'baseline' ? 1 : 0,
    }))
  return {
    baseline: actions('baseline'),
    selected: actions('selected'),
    unused: actions('unused'),
    'action-env': actions('action-env'),
  }
}

const nativeEvent = (action: unknown): string =>
  JSON.stringify({ Event: { data: { SpanEnd: { data: { ActionExecution: action } } } } })
const nativeAction = {
  name: { category: 'capability_identity_selected' },
  failed: false,
  execution_kind: 1,
  cache_upload_result: 1,
  commands: [
    {
      details: {
        command_kind: {
          command: { OmittedLocalCommand: { action_digest: `${'a'.repeat(64)}:123` } },
        },
      },
    },
  ],
}

describe('native capability action identity proof', () => {
  it('reads actual RE digests and numeric cache outcomes from native action events', () => {
    expect(identityActions(nativeEvent(nativeAction))).toEqual([
      {
        category: 'capability_identity_selected',
        digest: `${'a'.repeat(64)}:123`,
        executionKind: 1,
        cacheUploadResult: 1,
      },
    ])
  })
  it('rejects missing digests and failed actions rather than inventing evidence', () => {
    expect(() => identityActions(nativeEvent({ ...nativeAction, commands: [] }))).toThrow(
      'missing actual RE action digest',
    )
    expect(() => identityActions(nativeEvent({ ...nativeAction, failed: true }))).toThrow(
      'failed native identity action',
    )
  })
  it('requires actual local execution for both executable dependency controls', () => {
    const actions = observations().baseline.slice(2)
    expect(() => assertDependencyExecution(actions)).not.toThrow()
    expect(() =>
      assertDependencyExecution([{ ...actions[0]!, executionKind: 3 }, actions[1]!]),
    ).toThrow('must execute locally')
    expect(() => assertDependencyExecution(actions.slice(1))).toThrow('exactly two native actions')
  })
  it('proves selected users, unused-tool stability, action-env fanout and remote reuse', () => {
    expect(() =>
      assertIdentity({ observations: observations(), requireRemoteHits: true }),
    ).not.toThrow()
  })
  it.each([
    ['selected', 1],
    ['unused', 0],
    ['action-env', 2],
  ] as const)('rejects incorrect identity fanout in %s', (phase, index) => {
    const data = observations()
    data[phase][index]!.digest =
      phase === 'action-env' ? data.baseline[index]!.digest : 'unexpected:123'
    expect(() => assertIdentity({ observations: data })).toThrow('expected RE action digest')
  })
  it('rejects a generation-keyed graph and incomplete/duplicate native actions', () => {
    const data = observations()
    data.selected[1]!.digest = 'generation-rekey:123'
    expect(() => assertIdentity({ observations: data })).toThrow('remain stable')
    const incomplete = observations()
    incomplete.unused.pop()
    expect(() => assertIdentity({ observations: incomplete })).toThrow(
      'exactly four native actions',
    )
    const duplicate = observations()
    duplicate.unused[1] = { ...duplicate.unused[0]! }
    expect(() => assertIdentity({ observations: duplicate })).toThrow('missing/duplicate')
  })
  it('distinguishes read-only local outcomes from mandatory trusted remote hits', () => {
    const data = observations()
    data.unused[0]!.executionKind = 1
    expect(() => assertIdentity({ observations: data })).not.toThrow()
    expect(() => assertIdentity({ observations: data, requireRemoteHits: true })).toThrow(
      'did not hit the remote action cache',
    )
  })
})
