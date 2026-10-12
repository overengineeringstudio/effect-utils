import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { composeRegistry, defineAuthority, RegistryId } from './authority.ts'

const fragment = {
  id: 'agent-trace/v2',
  schema: Schema.Struct({ type: Schema.Literal('agent-trace/v2') }),
}
describe('registry authority composition', () => {
  it.each(['agent-trace/v2', 'trailer/v1', 'a/v99', 'foo-1/v123'])(
    'accepts canonical id %s',
    (id) => expect(Schema.is(RegistryId)(id)).toBe(true),
  )
  it.each([
    'AgentTrace/v2',
    'agent_trace/v2',
    'agent-trace/v0',
    'agent-trace/v01',
    'agent-trace/v-1',
    'agent-trace/v2/path',
    'org/agent-trace/v2',
    'a/v1\n',
    '/v1',
  ])('rejects noncanonical id %s', (id) => expect(Schema.is(RegistryId)(id)).toBe(false))
  it('rejects duplicate names across authorities', () => {
    const result = composeRegistry({
      authorities: [
        defineAuthority({ id: 'first', owner: 'a', fragments: [fragment] }),
        defineAuthority({ id: 'second', owner: 'b', fragments: [fragment] }),
      ],
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: 'DuplicateRegistryIdError',
        id: fragment.id,
        previousAuthority: 'first',
        authority: 'second',
      })
  })
  it('rejects duplicates within one authority', () => {
    const result = composeRegistry({
      authorities: [defineAuthority({ id: 'first', owner: 'a', fragments: [fragment, fragment] })],
    })
    expect(Result.isFailure(result)).toBe(true)
  })
  it('rejects invalid ids at composition even without the author helper', () => {
    const result = composeRegistry({
      authorities: [{ id: 'first', owner: 'a', fragments: [{ ...fragment, id: 'Invalid/v0' }] }],
    })
    if (Result.isFailure(result)) expect(result.failure._tag).toBe('InvalidRegistryIdError')
    else expect.fail('Invalid id was accepted')
  })
  it('composes distinct release versions without merging records', () => {
    const result = composeRegistry({
      authorities: [
        defineAuthority({
          id: 'first',
          owner: 'a',
          fragments: [fragment, { ...fragment, id: 'agent-trace/v1' }],
        }),
      ],
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result))
      expect(result.success.fragments.map(({ id }) => id)).toEqual([
        'agent-trace/v2',
        'agent-trace/v1',
      ])
  })
  it.each([
    ['gate-slot-receipt/v1', 'gate-slot.receipt/v1'],
    ['andon/v1', 'andon:v1'],
    ['legacy/v1', 'v0'],
  ])('binds %s to existing wire tag %s', (id, wireTag) => {
    const result = composeRegistry({
      authorities: [
        defineAuthority({ id: 'owner', owner: 'seat', fragments: [{ ...fragment, id, wireTag }] }),
      ],
    })
    if (Result.isFailure(result)) expect.fail(result.failure.message)
    else {
      expect(result.success.wireTags.get(wireTag)?.id).toBe(id)
      expect(result.success.wireTags.has(id)).toBe(false)
    }
  })
  it('resolves the canonical id as the default wire spelling', () => {
    const result = composeRegistry({
      authorities: [defineAuthority({ id: 'owner', owner: 'seat', fragments: [fragment] })],
    })
    if (Result.isFailure(result)) expect.fail(result.failure.message)
    else expect(result.success.wireTags.get(fragment.id)).toEqual(fragment)
  })
  it.each(['', ' v0', 'v0\n'])('rejects invalid wire spelling %j', (wireTag) => {
    const result = composeRegistry({
      authorities: [
        defineAuthority({ id: 'owner', owner: 'seat', fragments: [{ ...fragment, wireTag }] }),
      ],
    })
    if (Result.isSuccess(result)) expect.fail('Invalid wire spelling accepted')
    else expect(result.failure._tag).toBe('InvalidWireTagError')
  })
  it('rejects wire alias collisions including a canonical default spelling', () => {
    const result = composeRegistry({
      authorities: [
        defineAuthority({
          id: 'owner',
          owner: 'seat',
          fragments: [fragment, { ...fragment, id: 'other/v1', wireTag: fragment.id }],
        }),
      ],
    })
    if (Result.isSuccess(result)) expect.fail('Ambiguous wire alias accepted')
    else expect(result.failure._tag).toBe('DuplicateWireTagError')
  })
})
