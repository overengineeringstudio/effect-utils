import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import { Button } from 'react-aria-components'
import { expect, userEvent, within } from 'storybook/test'

import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import type { ExplorerClient } from '../projection.ts'
import { RpcExplorer } from '../RpcExplorer.tsx'
import {
  denseSnapshot,
  emptySnapshot,
  fixtureNow,
  lifecycleSnapshot,
  makeFixtureClient,
  makeLiveFixtureClient,
  safetySnapshot,
} from './fixtures.ts'
import { makeLiveCoreFixture } from './live-core.ts'
const storyStyles = stylex.create({
  allStates: { display: 'grid', gap: spacing[4] },
})

const never = <T,>(): Promise<T> => Promise.withResolvers<T>().promise

const lifecycleClient = makeFixtureClient(lifecycleSnapshot)
const emptyClient = makeFixtureClient(emptySnapshot)
const safetyClient = makeFixtureClient(safetySnapshot)
const denseClient = makeFixtureClient(denseSnapshot)
const clearFailureClient: ExplorerClient = {
  ...makeFixtureClient(lifecycleSnapshot),
  clearHistory: async () => Promise.reject(new Error('Fixture clear failed')),
}

const loadingClient: ExplorerClient = {
  getSnapshot: never,
  watch: () => ({ [Symbol.asyncIterator]: () => ({ next: never }) }),
  clearHistory: async () => undefined,
}

const makeStaleClient = (): ExplorerClient => {
  let snapshotRead = false
  return {
    getSnapshot: () => {
      if (snapshotRead === true) return never()
      snapshotRead = true
      return Promise.resolve(lifecycleSnapshot)
    },
    watch: async function* () {
      yield {
        _tag: 'Reset',
        protocolVersion: 'rpc-explorer.v1',
        reason: 'instanceChanged',
        revision: lifecycleSnapshot.revision + 1,
      }
      await never()
    },
    clearHistory: async () => undefined,
  }
}

export default {
  component: RpcExplorer,
  title: 'RPC Explorer/Explorer',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    client: lifecycleClient,
    presentation: { nowMillis: () => fixtureNow },
  },
} satisfies Meta<typeof RpcExplorer>

type Story = StoryObj<typeof RpcExplorer>

/** Empty retained history after the initial inspector snapshot. */
export const Empty: Story = { args: { client: emptyClient } }

/** Cold client before its first snapshot resolves. */
export const Loading: Story = { args: { client: loadingClient } }

/** Active and completed unary/stream lifecycles, including every terminal boundary. */
export const LifecycleWide: Story = {
  args: { presentation: { layout: 'wide', nowMillis: () => fixtureNow } },
}

/** Narrow collection drill-in and explicit Back flow. */
export const LifecycleNarrow: Story = {
  args: { presentation: { layout: 'narrow', nowMillis: () => fixtureNow } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Inspector connected')
    await userEvent.click((await canvas.findAllByRole('option'))[0]!)
    await expect(canvas.findByRole('button', { name: /Back to records/ })).resolves.toBeVisible()
    await userEvent.click(await canvas.findByRole('button', { name: /Back to records/ }))
    await expect(
      canvas.findByRole('listbox', { name: 'Observed RPC records' }),
    ).resolves.toBeVisible()
  },
}

/** All capture outcomes and normalized redacted/unsupported/truncated nodes. */
export const ContentSafety: Story = {
  args: { client: safetyClient },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Inspector connected')
    await userEvent.click(await canvas.findByRole('option'))
    await userEvent.click(await canvas.findByRole('tab', { name: 'Content' }))
    await expect(canvas.findByText('Not captured — default policy')).resolves.toBeVisible()
    await expect(canvas.findByText(/Not captured — capture policy fault/)).resolves.toBeVisible()
    await expect(canvas.findAllByText('Redacted value')).resolves.not.toHaveLength(0)
    await expect(canvas.findByText(/Unsupported value type: CustomClass/)).resolves.toBeVisible()
    const filter = canvas.getByRole('textbox', { name: 'Filter key, tag, or status' })
    await userEvent.type(filter, 'typed failure')
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(
      'Selected record is filtered out',
    )
    expect(document.activeElement).toBe(filter)
    await userEvent.clear(filter)
    await expect(canvas.findByText(/Value truncated: depth/)).resolves.toBeVisible()
  },
}

/** Content-free retention counters and retained-stream truncation evidence. */
export const RetentionEvidence: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText('3 records expired by retention')).resolves.toBeVisible()
    await expect(canvas.findAllByText(/truncated/)).resolves.not.toHaveLength(0)
  },
}
const DeterministicClearHarness = (): React.ReactNode => {
  const [client] = React.useState(makeLiveFixtureClient)
  return (
    <RpcExplorer client={client} presentation={{ layout: 'narrow', nowMillis: () => fixtureNow }} />
  )
}

/** Deterministic Reset(cleared) and following Snapshot preserve the active row. */
export const ClearHistoryReset: Story = {
  render: () => <DeterministicClearHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText(/1 active · 1 completed/)).resolves.toBeVisible()
    const records = await canvas.findAllByRole('option')
    await userEvent.click(records[1]!)
    await userEvent.click(canvas.getByRole('button', { name: 'Clear history' }))
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(canvas.findByText(/1 active · 0 completed/)).resolves.toBeVisible()
    await expect(canvas.findByText('Last reset: cleared')).resolves.toBeVisible()
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(
      'Selected record expired from bounded history',
    )
    expect(document.activeElement).toBe(
      canvas.getByRole('listbox', { name: 'Observed RPC records' }),
    )
  },
}

/** Failed clear requests become visible connection errors without unhandled rejections. */
export const ClearHistoryFailure: Story = {
  args: { client: clearFailureClient },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Inspector connected')
    await userEvent.click(canvas.getByRole('button', { name: 'Clear history' }))
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(canvas.findByText('Inspector error: Fixture clear failed')).resolves.toBeVisible()
  },
}

/** React Aria virtualization bounds mounted rows while retaining logical collection order. */
export const DenseLongList: Story = {
  args: { client: denseClient },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Inspector connected')
    expect((await canvas.findAllByRole('option')).length).toBeLessThan(
      denseSnapshot.active.length + denseSnapshot.completed.length,
    )
  },
}

/** Reset makes the visible projection stale while a replacement snapshot is requested. */
const StaleResetHarness = (): React.ReactNode => {
  const [client] = React.useState(makeStaleClient)
  return <RpcExplorer client={client} presentation={{ nowMillis: () => fixtureNow }} />
}

/** Reset makes the visible projection stale while a replacement snapshot is requested. */
export const StaleResetReconnect: Story = {
  render: () => <StaleResetHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText(/Inspector recovering: instanceChanged/)).resolves.toBeVisible()
  },
}

/** Keyboard row navigation, selection, and tab activation through React Aria. */
export const KeyboardSelectionAndTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = await canvas.findByRole('listbox', { name: 'Observed RPC records' })
    list.focus()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect(canvas.findByRole('heading', { level: 2 })).resolves.toBeVisible()
    const timeline = await canvas.findByRole('tab', { name: 'Timeline' })
    timeline.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.findByText('RequestObserved')).resolves.toBeVisible()
  },
}

const LiveCoreHarness = (): React.ReactNode => {
  const [fixture] = React.useState(makeLiveCoreFixture)
  return (
    <>
      <div>
        <Button onPress={fixture.emitLifecycle}>Emit application lifecycle</Button>
      </div>
      <RpcExplorer client={fixture.client} presentation={{ nowMillis: () => fixtureNow }} />
    </>
  )
}

/**
 * Real core store → inspector handler Layer → Effect Stream → ExplorerClient.
 * The interaction proves deltas, clear Reset/Snapshot recovery, active-row
 * preservation, and inspector self-exclusion without transport polling.
 */
export const LiveCoreProtocol: Story = {
  render: () => <LiveCoreHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Inspector connected')
    await expect(canvas.findByText(/1 active · 0 completed/)).resolves.toBeVisible()
    expect(canvas.queryByText('Unknown descriptor')).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: 'Emit application lifecycle' }))
    await expect(canvas.findByText(/1 active · 1 completed/)).resolves.toBeVisible()
    expect(canvas.queryByText('Unknown descriptor')).toBeNull()
    const records = await canvas.findAllByRole('option')
    await userEvent.click(records[0]!)

    await userEvent.click(canvas.getByRole('button', { name: 'Clear history' }))
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(canvas.findByText(/1 active · 0 completed/)).resolves.toBeVisible()
    await expect(canvas.findByText('Last reset: cleared')).resolves.toBeVisible()
    await expect(canvas.findByRole('option', { selected: true })).resolves.toHaveTextContent(
      'Fixture.ApplicationRpc',
    )
  },
}

const AllStatesRender = (): React.JSX.Element => (
  <div {...stylex.props(storyStyles.allStates)}>
    <RpcExplorer
      client={emptyClient}
      presentation={{ layout: 'wide', nowMillis: () => fixtureNow }}
    />
    <RpcExplorer
      client={safetyClient}
      presentation={{ layout: 'narrow', nowMillis: () => fixtureNow }}
    />
    <RpcExplorer
      client={lifecycleClient}
      presentation={{ layout: 'wide', nowMillis: () => fixtureNow }}
    />
  </div>
)

/** Side-by-side empty, policy-safety, and complete lifecycle surfaces. */
export const AllStates: Story = { render: AllStatesRender }
