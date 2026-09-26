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
const openClearHistory = async (canvasElement: HTMLElement): Promise<void> => {
  const canvas = within(canvasElement)
  if (canvas.queryByRole('button', { name: 'Clear history' }) === null)
    await userEvent.click(canvas.getByRole('button', { name: /^Filters and actions/ }))
  await userEvent.click(canvas.getByRole('button', { name: 'Clear history' }))
}

const lifecycleClient = makeFixtureClient(lifecycleSnapshot)
const emptyClient = makeFixtureClient(emptySnapshot)
const safetyClient = makeFixtureClient(safetySnapshot)
const denseClient = makeFixtureClient(denseSnapshot)
const clearFailureBase = makeFixtureClient(lifecycleSnapshot)
const clearFailureClient: ExplorerClient = {
  getSnapshot: () => clearFailureBase.getSnapshot(),
  watch: () => clearFailureBase.watch(),
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
export const Empty: Story = {
  args: { client: emptyClient },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(
        'Waiting for observed RPCs. Captured calls will appear here.',
      ),
    ).resolves.toBeVisible()
  },
}

/** Cold client before its first snapshot resolves. */
export const Loading: Story = {
  args: { client: loadingClient },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText('Loading the inspector snapshot…'),
    ).resolves.toBeVisible()
  },
}

/** Active and completed unary/stream lifecycles, including every terminal boundary. */
export const LifecycleWide: Story = {
  args: { presentation: { layout: 'wide', nowMillis: () => fixtureNow } },
}

/** RPC-level documentation stays separate from channel-schema annotations. */
export const RpcDocumentation: Story = {
  args: { presentation: { layout: 'narrow', nowMillis: () => fixtureNow } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    const row = await canvas.findByRole('option', {
      name: /Look up a project by its stable identifier.*Sending/,
    })
    await expect(row).toBeVisible()
    await userEvent.click(row)
    await expect(canvas.findByRole('heading', { name: 'Find project' })).resolves.toBeVisible()
    await expect(
      canvas.findByText('Look up a project by its stable identifier.'),
    ).resolves.toBeVisible()
    await userEvent.click(await canvas.findByRole('tab', { name: 'Descriptor' }))
    await expect(
      canvas.findByText('Returns the public project record; credentials are never exposed.'),
    ).resolves.toBeVisible()
  },
}

/** A deprecated RPC retains an explicit text badge in its detail header. */
export const DeprecatedRpc: Story = {
  args: { presentation: { layout: 'narrow', nowMillis: () => fixtureNow } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await userEvent.click(await canvas.findByRole('option', { name: /events.subscribe/ }))
    await expect(
      canvas.findByRole('heading', { name: 'Subscribe to events' }),
    ).resolves.toBeVisible()
    await expect(canvas.findByText('Deprecated')).resolves.toBeVisible()
  },
}

/** Projected titles, descriptions, required fields, and examples remain readable in detail. */
export const SchemaAnnotatedPayload: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await userEvent.click((await canvas.findAllByRole('option'))[0]!)
    await userEvent.click(await canvas.findByRole('tab', { name: 'Content' }))
    await expect(
      canvas.findByRole('button', { name: 'Project lookup request · object · 1 field' }),
    ).resolves.toBeVisible()
    await expect(canvas.findByText(/Project ID:/)).resolves.toBeVisible()
    await userEvent.click(await canvas.findByRole('tab', { name: 'Descriptor' }))
    const tree = (await canvas.findAllByRole('treegrid', { name: 'Projected channel schema' }))[0]!
    const root = within(tree).getAllByRole('row')[0]!
    root.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toHaveAttribute('aria-label', 'Project ID string required')
    await userEvent.click(within(tree).getByRole('button', { name: 'Schema notes for Project ID' }))
    await expect(
      canvas.findByText('Stable identifier of the requested project.'),
    ).resolves.toBeVisible()
    await expect(canvas.findByText('Example: "prj_fixture"')).resolves.toBeVisible()
    await expect(canvas.findByText('Schema projection unavailable.')).resolves.toBeVisible()
  },
}

/** The React Aria resize handle has keyboard parity with pointer dragging. */
export const KeyboardResize: Story = {
  args: { presentation: { layout: 'wide', nowMillis: () => fixtureNow } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await userEvent.click((await canvas.findAllByRole('option'))[0]!)
    const handle = canvas.queryByRole('button', { name: 'Resize record pane' })
    if (handle === null) {
      await expect(canvas.findByRole('button', { name: 'Back to records' })).resolves.toBeVisible()
      return
    }
    await expect(handle).toHaveAccessibleDescription(/Use Left and Right arrow keys/)
    handle.focus()
    await userEvent.keyboard('{ArrowLeft}')
    const left = handle.getBoundingClientRect().left
    await userEvent.keyboard('{ArrowRight}')
    expect(handle.getBoundingClientRect().left).toBeGreaterThan(left)
  },
}

/** Narrow collection drill-in and explicit Back flow. */
export const LifecycleNarrow: Story = {
  args: { presentation: { layout: 'narrow', nowMillis: () => fixtureNow } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
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
    await canvas.findByRole('img', { name: 'Inspector connected' })
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
    await expect(canvas.findByTitle('3 records expired by retention')).resolves.toBeVisible()
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
    await expect(canvas.findByText(/1 active · 1 done/)).resolves.toBeVisible()
    const records = await canvas.findAllByRole('option')
    await userEvent.click(records[1]!)
    await openClearHistory(canvasElement)
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(canvas.findByText(/1 active · 0 done/)).resolves.toBeVisible()
    await expect(canvas.findByTitle('Last reset: cleared')).resolves.toBeVisible()
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
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await openClearHistory(canvasElement)
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(
      canvas.findByRole('img', { name: 'Inspector error: Fixture clear failed' }),
    ).resolves.toBeVisible()
  },
}

/** React Aria virtualization bounds mounted rows while retaining logical collection order. */
export const DenseLongList: Story = {
  args: { client: denseClient },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    expect((await canvas.findAllByRole('option')).length).toBeLessThan(
      denseSnapshot.active.length + denseSnapshot.completed.length,
    )
  },
}

/** Sorting by newest changes which active lifecycle is first in the collection. */
export const SortByNewest: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await expect((await canvas.findAllByRole('option'))[0]).toHaveTextContent('Sending')
    if (canvas.queryByRole('button', { name: /^Oldest first Sort/ }) === null)
      await userEvent.click(canvas.getByRole('button', { name: /^Filters and actions/ }))
    await userEvent.click(canvas.getByRole('button', { name: /^Oldest first Sort/ }))
    await userEvent.click(within(document.body).getByRole('option', { name: 'Newest first' }))
    await expect((await canvas.findAllByRole('option'))[0]).toHaveAccessibleName(
      /Cancellation requested/,
    )
  },
}

/** Sorting and resizing remain keyboard-accessible beside the virtualized ListBox. */
export const ColumnSortAndResize: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('img', { name: 'Inspector connected' })
    const sort = canvas.getByRole('button', { name: 'Sort RPC: inactive' })
    await userEvent.click(sort)
    await expect(canvas.getByRole('button', { name: 'Sort RPC: ascending' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect((await canvas.findAllByRole('option'))[0]).toHaveTextContent('events.subscribe')
    const separator = canvas.queryByRole('separator', { name: 'Resize RPC column' })
    if (separator === null) return
    const before = separator.getAttribute('aria-valuenow')
    separator.focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(separator).not.toHaveAttribute('aria-valuenow', before)
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
    await expect(
      canvas.findByRole('img', { name: 'Inspector recovering: instanceChanged' }),
    ).resolves.toBeVisible()
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
    await canvas.findByRole('img', { name: 'Inspector connected' })
    await expect(canvas.findByText(/1 active · 0 done/)).resolves.toBeVisible()
    expect(canvas.queryByText('Unknown descriptor')).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: 'Emit application lifecycle' }))
    await expect(canvas.findByText(/1 active · 1 done/)).resolves.toBeVisible()
    expect(canvas.queryByText('Unknown descriptor')).toBeNull()
    const records = await canvas.findAllByRole('option')
    await userEvent.click(records[0]!)

    await openClearHistory(canvasElement)
    const body = within(document.body)
    await userEvent.click(await body.findByRole('button', { name: 'Clear diagnostic history' }))
    await expect(canvas.findByText(/1 active · 0 done/)).resolves.toBeVisible()
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(
      '1 active and 0 completed records. Inspector connected. Reset reason: cleared',
    )
    await expect(canvas.findByTitle('Last reset: cleared')).resolves.toBeVisible()
    // Compact widths drill into the detail and unmount the list, so the preserved
    // selection is asserted on whichever surface shows it.
    const selected = canvas.queryByRole('option', { selected: true })
    await expect(
      selected ?? (await canvas.findByRole('article', { name: /Fixture\.ApplicationRpc/ })),
    ).toHaveTextContent('Fixture.ApplicationRpc')
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
