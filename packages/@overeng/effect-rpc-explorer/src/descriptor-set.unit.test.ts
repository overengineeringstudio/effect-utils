import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { makeDescriptorSet } from './descriptor-set.ts'
import type { MutableDescriptorSet } from './descriptor-set.ts'
import { makeRpcDescriptors } from './descriptor.ts'

const descriptorsFor = (...tags: ReadonlyArray<string>) =>
  makeRpcDescriptors(
    RpcGroup.make(
      ...tags.map((tag) => Rpc.make(tag, { payload: Schema.String, success: Schema.String })),
    ),
  )

const tags = (set: MutableDescriptorSet) =>
  set.current().descriptors.map((descriptor) => descriptor.tag)

describe('descriptor set', () => {
  it('adds and removes an owner registration with one revision per effective change', () => {
    const set = makeDescriptorSet(descriptorsFor('Base'))
    let notifications = 0
    set.subscribe(() => {
      notifications += 1
    })

    const release = set.register({ owner: 'app/a', descriptors: descriptorsFor('Mounted') })
    expect(tags(set)).toEqual(['Base', 'Mounted'])
    expect(set.current().revision).toBe(1)
    expect(set.descriptorForTag('Mounted')?.tag).toBe('Mounted')

    release()
    release()
    expect(tags(set)).toEqual(['Base'])
    expect(set.current().revision).toBe(2)
    expect(set.descriptorForTag('Mounted')).toBeUndefined()
    expect(notifications).toBe(2)
  })

  it('replaces a remounted owner without duplicates and ignores the replaced release', () => {
    const set = makeDescriptorSet([])
    const releaseFirst = set.register({ owner: 'app/a', descriptors: descriptorsFor('Read') })
    const second = descriptorsFor('Read', 'Write')
    const releaseSecond = set.register({ owner: 'app/a', descriptors: second })
    expect(tags(set)).toEqual(['Read', 'Write'])
    expect(set.descriptorForTag('Read')).toBe(second[0])

    releaseFirst()
    expect(tags(set)).toEqual(['Read', 'Write'])
    releaseSecond()
    expect(tags(set)).toEqual([])
  })

  it('keeps a shared tag while any owner holds it and serves the newest holder', () => {
    const set = makeDescriptorSet([])
    const older = descriptorsFor('Shared')
    const newer = descriptorsFor('Shared')
    const releaseOlder = set.register({ owner: 'app/a', descriptors: older })
    const releaseNewer = set.register({ owner: 'app/b', descriptors: newer })
    expect(set.current().descriptors).toEqual([newer[0]])

    releaseNewer()
    expect(set.descriptorForTag('Shared')).toBe(older[0])
    releaseOlder()
    expect(set.descriptorForTag('Shared')).toBeUndefined()
  })

  it('keeps construction descriptors authoritative over a runtime tag', () => {
    const base = descriptorsFor('Base')
    const set = makeDescriptorSet(base)
    const release = set.register({ owner: 'app/a', descriptors: descriptorsFor('Base') })
    expect(set.current().revision).toBe(0)
    expect(set.descriptorForTag('Base')).toBe(base[0])
    release()
    expect(set.descriptorForTag('Base')).toBe(base[0])
  })
})
