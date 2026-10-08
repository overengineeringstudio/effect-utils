import type { Meta, StoryObj } from '@storybook/react'
import * as React from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { readHostPreference, startHostDiagnostics } from './boundary.ts'

type HostDiagnosticsState =
  | { readonly _tag: 'Mounted' }
  | { readonly _tag: 'Disabled' }
  | { readonly _tag: 'Failed' }

/** The ordinary host imports only this guarded loader, never diagnostics eagerly. */
const HostComposition = ({
  dark = false,
  onDiagnosticsReady,
}: {
  readonly dark?: boolean
  readonly onDiagnosticsReady?: (state: HostDiagnosticsState) => void
}): React.ReactNode => {
  const lifetime = React.useRef<Promise<void>>(Promise.resolve())
  const storageKey = `host-composition.${dark === true ? 'dark' : 'light'}.panel`
  const mount = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) return undefined
      const controller = new AbortController()
      // Serialize StrictMode rehearsal behind teardown, including async scope finalizers.
      const acquired = lifetime.current.then(() =>
        startHostDiagnostics({
          node,
          dark,
          storageKey,
          signal: controller.signal,
          enabled: readHostPreference('host-composition.enabled'),
        }),
      )
      void acquired.then(
        (release) => {
          if (controller.signal.aborted === true) return
          if (release === undefined)
            node.textContent = 'Host app. Diagnostics are disabled by the host enabling boundary.'
          onDiagnosticsReady?.({ _tag: release === undefined ? 'Disabled' : 'Mounted' })
        },
        () => undefined,
      )
      void acquired.catch(() => {
        if (controller.signal.aborted === true) return
        node.textContent = 'Unable to start host diagnostics.'
        onDiagnosticsReady?.({ _tag: 'Failed' })
      })
      return () => {
        controller.abort()
        lifetime.current = acquired.then(
          async (release) => {
            await release?.()
          },
          () => undefined,
        )
      }
    },
    [dark, storageKey, onDiagnosticsReady],
  )
  return (
    <div ref={mount} aria-label="Host composition">
      <p>Starting host app…</p>
    </div>
  )
}

const meta = {
  title: 'Developer Bar/Host Composition',
  component: HostComposition,
  parameters: { layout: 'fullscreen' },
  args: { dark: false },
  beforeEach: () => {
    localStorage.removeItem('host-composition.light.panel')
    localStorage.removeItem('host-composition.dark.panel')
    localStorage.removeItem('host-composition.enabled')
  },
} satisfies Meta<typeof HostComposition>
export default meta

type Story = StoryObj<typeof meta>

/** Full enabled host: collection starts now, explorer UI only on panel activation. */
export const Light: Story = {
  play: async ({ args, mount, canvasElement }) => {
    const ready = Promise.withResolvers<void>()
    const canvas = await mount(
      <HostComposition
        dark={args.dark === true}
        onDiagnosticsReady={(state) => {
          if (state._tag === 'Mounted') ready.resolve()
          else ready.reject(new Error(`Host diagnostics ${state._tag}`))
        }}
      />,
    )
    // Await actual scoped bootstrap, including its guarded cold import, not a DOM polling deadline.
    await ready.promise
    const rpc = await canvas.findByRole('button', { name: 'RPC' })
    expect(canvasElement.querySelector('canvas')).not.toBeNull()
    expect(canvas.getByRole('button', { name: 'Freeze meters' })).toBeVisible()
    expect(canvas.getByLabelText('durationP95')).toHaveTextContent('n/a')
    expect(canvas.queryByText(/Inspector connected/)).toBeNull()
    expect(rpc).toHaveAttribute('aria-expanded', 'false')

    // Meter activation follows the same controlled state path as the RPC button.
    await userEvent.click(canvas.getByRole('button', { name: /durationP95/ }))
    // Cold compilation of the lazy UI is not RPC latency; keep the loaded-state assertion intact.
    await expect(
      canvas.findByText(/0 active · 0 done/, undefined, { timeout: 15_000 }),
    ).resolves.toBeVisible()
    expect(rpc).toHaveAttribute('aria-expanded', 'true')
    expect(localStorage.getItem('host-composition.light.panel')).toBe('rpc')

    await userEvent.click(canvas.getByRole('button', { name: 'Load project via RPC' }))
    await expect(canvas.findByText('Loaded Shared workspace')).resolves.toBeVisible()
    await expect(canvas.findByText(/0 active · 1 done/)).resolves.toBeVisible()
    await expect(canvas.findByRole('option', { name: /Host\.LoadProject/ })).resolves.toBeVisible()
    // Real lifecycle completion replaces NoSamples with measured request latency.
    await waitFor(() => expect(canvas.getByLabelText('durationP95')).toHaveTextContent(/^\d/))
    await waitFor(() => expect(canvas.getByLabelText('inFlight')).toHaveTextContent(/^0/))

    await userEvent.click(canvas.getByRole('button', { name: 'Toggle simulated sync' }))
    await waitFor(() =>
      expect(canvas.getByLabelText('Simulated host sync status')).toHaveTextContent(
        'Reconnecting (simulated)',
      ),
    )

    await userEvent.click(canvas.getByRole('button', { name: /^Approximate JS heap:/ }))
    await expect(
      canvas.findByRole('region', { name: 'Approximate JS heap details' }),
    ).resolves.toBeVisible()
    expect(localStorage.getItem('host-composition.light.panel')).toBe('heap')
  },
}

/** Shared ancestor applies shell, strip and lazy explorer dark themes together. */
export const Dark: Story = { args: { dark: true } }

/** Light and dark host configurations with independently owned scopes and storage. */
export const AllStates: Story = {
  render: () => (
    <div>
      <HostComposition />
      <HostComposition dark />
    </div>
  ),
}
