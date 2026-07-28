/** @vitest-environment happy-dom */
import { Context, Effect, Layer, SubscriptionRef } from 'effect'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import {
  EffectProvider,
  extractErrorMessage,
  useEffectRunner,
  useRuntime,
} from '../src/context.tsx'
import { makeSubscriptionRefStore } from '../src/external-store.ts'

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

class ProbeService extends Context.Tag('ProbeService')<
  ProbeService,
  { readonly label: string }
>() {}

const flushReactEffects = async (): Promise<void> => {
  await act(async () => {
    await Effect.runPromise(Effect.yieldNow())
  })
}

const createMountedRoot = () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)

  const root = createRoot(container)
  roots.push(root)

  return { container, root }
}

describe('effect-react runtime baselines (cross-major invariant)', () => {
  it('captures provider runtime construction, provision order, and scoped teardown', async () => {
    const events: string[] = []
    const layer = Layer.scoped(
      ProbeService,
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push('layer:acquire')
          return { label: 'runtime-service' }
        }),
        () => Effect.sync(() => events.push('layer:release')),
      ),
    )

    const Child = () => {
      const runtime = useRuntime<ProbeService>()
      const runEffect = useEffectRunner<ProbeService>()
      events.push(`render:runtime:${typeof runtime}`)

      Effect.runSync(
        Effect.gen(function* () {
          const probe = yield* ProbeService
          events.push(`runtime:direct:${probe.label}`)
        }).pipe(Effect.provide(runtime)),
      )

      React.useEffect(() => {
        events.push('effect:mount')
        runEffect(
          Effect.gen(function* () {
            const probe = yield* ProbeService
            events.push(`runner:service:${probe.label}`)
            yield* Effect.acquireRelease(
              Effect.sync(() => events.push('runner:scope-acquire')),
              () => Effect.sync(() => events.push('runner:scope-release')),
            )
          }),
        )
        return () => {
          events.push('effect:cleanup')
        }
      }, [runEffect])

      return <div data-state="ready">ready</div>
    }

    const { container, root } = createMountedRoot()

    await act(async () => {
      root.render(
        <EffectProvider layer={layer} Loading={() => <div data-state="loading">loading</div>}>
          <Child />
        </EffectProvider>,
      )
    })
    expect(container.textContent).toBe('ready')

    await flushReactEffects()

    await act(async () => {
      root.unmount()
    })
    roots.splice(roots.indexOf(root), 1)
    await flushReactEffects()

    expect(events).toMatchInlineSnapshot(`
      [
        "layer:acquire",
        "render:runtime:object",
        "runtime:direct:runtime-service",
        "effect:mount",
        "runner:service:runtime-service",
        "runner:scope-acquire",
        "runner:scope-release",
        "layer:release",
        "effect:cleanup",
      ]
    `)
  })

  it('captures failing layer error partition and retry construction count', async () => {
    const events: string[] = []
    let attempts = 0
    const layer = Layer.effect(
      ProbeService,
      Effect.gen(function* () {
        attempts += 1
        events.push(`layer:attempt:${attempts}`)
        if (attempts === 1) {
          return yield* Effect.fail('first runtime failure')
        }
        return { label: 'ready-after-retry' }
      }),
    )

    const Child = () => {
      const runtime = useRuntime<ProbeService>()
      const label = Effect.runSync(
        Effect.gen(function* () {
          const probe = yield* ProbeService
          return probe.label
        }).pipe(Effect.provide(runtime)),
      )
      events.push(`child:${label}`)
      return <div data-state="ready">{label}</div>
    }

    const { container, root } = createMountedRoot()

    await act(async () => {
      root.render(
        <EffectProvider
          layer={layer}
          Error={({ cause, onRetry }) => {
            events.push(`error:${extractErrorMessage(cause)}`)
            return (
              <button type="button" onClick={onRetry}>
                retry
              </button>
            )
          }}
        >
          <Child />
        </EffectProvider>,
      )
    })

    await flushReactEffects()
    expect(container.textContent).toBe('retry')

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await flushReactEffects()
    expect(container.textContent).toBe('ready-after-retry')

    await act(async () => {
      root.unmount()
    })
    roots.splice(roots.indexOf(root), 1)

    expect(events).toMatchInlineSnapshot(`
      [
        "layer:attempt:1",
        "error:first runtime failure",
        "error:first runtime failure",
        "layer:attempt:2",
        "child:ready-after-retry",
      ]
    `)
  })

  it('captures external-store subscriber observations and unsubscribe boundary', async () => {
    const ref = Effect.runSync(
      SubscriptionRef.make<{ value: number; note: string | null }>({ value: 1, note: '' }),
    )
    const store = makeSubscriptionRefStore(ref)
    const observations: string[] = []

    const unsubscribeA = store.subscribe(() => {
      observations.push(`a:${JSON.stringify(store.getSnapshot())}`)
    })
    const unsubscribeB = store.subscribe(() => {
      observations.push(`b:${JSON.stringify(store.getSnapshot())}`)
    })

    observations.push(`initial:${JSON.stringify(store.getSnapshot())}`)

    await Effect.runPromise(SubscriptionRef.set(ref, { value: 2, note: null }))
    await Effect.runPromise(Effect.yieldNow())

    unsubscribeA()

    await Effect.runPromise(SubscriptionRef.set(ref, { value: 3, note: 'ß' }))
    await Effect.runPromise(Effect.yieldNow())

    unsubscribeB()

    await Effect.runPromise(SubscriptionRef.set(ref, { value: 4, note: 'after-unsubscribe' }))
    await Effect.runPromise(Effect.yieldNow())

    expect(observations).toMatchInlineSnapshot(`
      [
        "initial:{"value":1,"note":""}",
        "a:{"value":1,"note":""}",
        "b:{"value":1,"note":""}",
        "a:{"value":2,"note":null}",
        "b:{"value":2,"note":null}",
        "b:{"value":3,"note":"ß"}",
      ]
    `)
  })

  it('captures hook failure partition outside provider', () => {
    const UseRuntimeOutsideProvider = () => {
      useRuntime()
      return null
    }

    const failure = (() => {
      const { root } = createMountedRoot()
      try {
        act(() => {
          root.render(<UseRuntimeOutsideProvider />)
        })
        return { _tag: 'succeeded' as const }
      } catch (error) {
        return {
          _tag: 'failed' as const,
          error: error instanceof Error ? String(error) : String(error),
        }
      }
    })()

    expect(failure).toMatchInlineSnapshot(`
      {
        "_tag": "failed",
        "error": "Error: useRuntime must be used within an EffectProvider",
      }
    `)
  })
})
