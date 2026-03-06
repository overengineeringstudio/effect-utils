/** @vitest-environment happy-dom */
import { Effect, SubscriptionRef } from 'effect'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { makeSubscriptionRefStore, useSubscriptionRef } from '../src/external-store.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: Array<ReturnType<typeof createRoot>> = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }

  for (const container of containers.splice(0)) {
    container.remove()
  }
})

describe('makeSubscriptionRefStore', () => {
  it('reads the latest snapshot and notifies subscribers', async () => {
    const ref = Effect.runSync(SubscriptionRef.make(1))
    const store = makeSubscriptionRefStore(ref)
    const notifications: number[] = []

    const unsubscribe = store.subscribe(() => {
      notifications.push(store.getSnapshot())
    })

    expect(store.getSnapshot()).toBe(1)

    await Effect.runPromise(SubscriptionRef.set(ref, 2))
    await Effect.runPromise(Effect.yieldNow())

    expect(store.getSnapshot()).toBe(2)
    expect(notifications).toEqual([2])

    unsubscribe()
  })
})

describe('useSubscriptionRef', () => {
  it('rerenders when the ref changes', async () => {
    const ref = Effect.runSync(SubscriptionRef.make(1))
    const renders: number[] = []
    const values: number[] = []

    const View = () => {
      const value = useSubscriptionRef(ref)
      renders.push(value)
      values.push(value)
      return <div data-value={value}>{value}</div>
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)

    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<View />)
    })

    expect(values.at(-1)).toBe(1)

    await act(async () => {
      await Effect.runPromise(SubscriptionRef.set(ref, 2))
      await Effect.runPromise(Effect.yieldNow())
    })

    expect(values.at(-1)).toBe(2)
    expect(container.textContent).toBe('2')
    expect(renders).toEqual([1, 2])
  })
})
