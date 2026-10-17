/**
 * The shipping devbar meter tiles (Variant A of `Developer Bar/Meter Variants`).
 *
 * Every tile is a `@overeng/meters/react` `MeterTile`, composed as an ordinary Devbar segment:
 * one canvas per tile on the session's shared frame clock, a static accessible name, and an
 * evidence card captured on focus, hover, activation (Enter/Space/click) or R. One freeze
 * button snapshots every tile at one instant. Data replays `../meter-variants/recording.ts`.
 */
import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import { Effect, Fiber, type Scope } from 'effect'
import * as React from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import type { Meters, SeriesStore } from '@overeng/meters'
import {
  darkMeterTheme,
  freezeMeters,
  lightMeterTheme,
  tileBlock,
  type CanvasBlockSpec,
  type MeterFreeze,
  type MeterTheme,
} from '@overeng/meters/canvas'
import { MeterFreezeButton, MeterTile } from '@overeng/meters/react'

import { Devbar, type DevbarSegment } from '../../Devbar.tsx'
import { devbarTokens } from '../../tokens.stylex.ts'
import {
  makeReplayMeters,
  recordingSeries,
  subscriptionCap,
  type Playback,
  type Scenario,
} from '../meter-variants/recording.ts'

/** Fits `msg 742/s` and `commit 3.8` in 11 px monospace with 4 px tile padding. */
const tileWidthPx = 64
/** Fills the 32 px bar row minus its border. */
const tileHeightPx = 30
/** 30 one-second buckets: the tile history and the evidence range window. */
const perSecond = { _tag: 'Bucket', bucketMs: 1000, buckets: 30 } as const
/** Source freshness window replayed by the Stale fixture. */
const staleWindowMs = 5_000

interface TileRow {
  readonly block: CanvasBlockSpec
  /** Higher stays longer in the bar (Devbar `fitSegments`). */
  readonly priority: number
}

const tileRows: readonly TileRow[] = [
  {
    priority: 6,
    block: tileBlock({
      id: 'api.messages',
      series: recordingSeries.messages,
      shortLabel: 'msg',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Gauge', unit: 'count/s' },
      value: (value) => value.delta + value.snapshot + value.error,
      range: 'auto',
    }),
  },
  {
    priority: 4,
    block: tileBlock({
      id: 'http.latency',
      series: recordingSeries.httpLatency,
      shortLabel: 'p95',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Gauge', unit: 'ms' },
      value: (value) => value.p95Ms,
      range: 'auto',
    }),
  },
  {
    priority: 4,
    block: tileBlock({
      id: 'http.errors',
      series: recordingSeries.httpErrors,
      shortLabel: 'err',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Event', unit: 'count/s' },
      value: () => 1,
    }),
  },
  {
    priority: 3,
    block: tileBlock({
      id: 'react.commits',
      series: recordingSeries.commits,
      shortLabel: 'commit',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Event', unit: 'ms' },
      value: (value) => value.actualDurationMs,
      nominalMax: 16,
    }),
  },
  {
    priority: 2,
    block: tileBlock({
      id: 'longFrames',
      series: recordingSeries.longFrames,
      shortLabel: 'lf',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Event', unit: 'count/s' },
      value: () => 1,
    }),
  },
  {
    priority: 1,
    block: tileBlock({
      id: 'frames',
      series: recordingSeries.frames,
      shortLabel: 'fps',
      widthPx: tileWidthPx,
      aggregation: { ...perSecond, mode: 'Gauge', unit: 'fps' },
      value: (value) => (value.durationMs > 0 ? 1000 / value.durationMs : 0),
      nominalMax: 60,
    }),
  },
]
const tileBlocks = tileRows.map((row) => row.block)

/** Tiles in light mode: a tinted tile and a darker baseline separate them from the bar. */
const lightTileTheme: MeterTheme = { ...lightMeterTheme, background: '#eeeff2', border: '#8a8f98' }

const runScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): (() => void) => {
  const fiber = Effect.runFork(Effect.scoped(program))
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}

/** The story host owns the only session lease, like a real bootstrap. */
const useReplayMeters = (options: {
  readonly playback: Playback
  readonly scenario: Scenario
}): Meters | undefined => {
  const { playback, scenario } = options
  const key = `${playback}:${scenario}`
  const [started, setStarted] = React.useState<
    { readonly key: string; readonly meters: Meters } | undefined
  >(undefined)
  React.useEffect(() => {
    // Only the Stale fixture replays source freshness; live recordings never go stale.
    const meters = makeReplayMeters({
      playback,
      scenario,
      ...(scenario === 'Stale' ? { staleAfterMs: staleWindowMs } : {}),
    })
    return runScoped(
      meters.start.pipe(
        Effect.andThen(Effect.sync(() => setStarted({ key: `${playback}:${scenario}`, meters }))),
        Effect.andThen(Effect.never),
      ),
    )
  }, [playback, scenario])
  return started?.key === key ? started.meters : undefined
}

/** `subs n/cap` deliberately stays text. */
const SubscriptionsText = (props: { readonly store: SeriesStore }): React.ReactNode => {
  const store = props.store
  const latest = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => store.subscribe({ notify }), [store]),
    () => store.read({ series: recordingSeries.subscriptions }).latest,
  )
  return (
    <output aria-label="Live subscriptions" {...stylex.props(styles.subs)}>
      subs {latest?._tag === 'Value' ? latest.value.value : 'n/a'}/{subscriptionCap}
    </output>
  )
}

const styles = stylex.create({
  frame: (widthPx: number) => ({
    position: 'relative',
    width: widthPx,
    height: 240,
    overflow: 'hidden',
    boxSizing: 'border-box',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
  }),
  caption: {
    margin: 0,
    paddingBlock: '0.75rem',
    paddingInline: '1rem',
    fontSize: '0.8125rem',
    lineHeight: 1.4,
  },
  subs: {
    fontFamily: devbarTokens.fontData,
    fontVariantNumeric: 'tabular-nums',
    color: devbarTokens.mutedText,
    whiteSpace: 'nowrap',
  },
  collection: { display: 'grid', gap: '1rem', padding: '1rem' },
})

interface MeterTilesProps {
  readonly widthPx: 1440 | 900 | 600
  readonly playback: Playback
  readonly scenario: Scenario
  readonly frozen: boolean
  readonly dark: boolean
}

const TileDevbar = (props: MeterTilesProps & { readonly meters: Meters }): React.ReactNode => {
  const { meters } = props
  const theme = props.dark === true ? darkMeterTheme : lightTileTheme
  const [freeze, setFreeze] = React.useState<MeterFreeze | undefined>(() =>
    props.frozen === true ? freezeMeters({ meters, blocks: tileBlocks }) : undefined,
  )
  const segments: readonly DevbarSegment[] = [
    {
      id: 'meters.freeze',
      label: 'Freeze meters',
      priority: 7,
      render: () => (
        <MeterFreezeButton
          frozenAtMs={freeze?.atMs}
          onToggle={() =>
            setFreeze(
              freeze === undefined ? freezeMeters({ meters, blocks: tileBlocks }) : undefined,
            )
          }
          theme={theme}
          compact={props.widthPx < 900}
        />
      ),
    },
    ...tileRows.map(
      (row): DevbarSegment => ({
        id: row.block.id,
        label: row.block.label,
        priority: row.priority,
        render: () => (
          <MeterTile
            meters={meters}
            block={row.block}
            theme={theme}
            frozen={freeze}
            heightPx={tileHeightPx}
          />
        ),
      }),
    ),
    {
      id: 'api.subscriptions',
      label: 'Live subscriptions',
      priority: 5,
      render: () => <SubscriptionsText store={meters.store} />,
    },
  ]
  return (
    <Devbar
      placement="container"
      panels={[]}
      openPanel={undefined}
      onOpenPanelChange={() => {}}
      stripMinWidth={0}
      segments={segments}
    />
  )
}

const MeterTiles = (props: MeterTilesProps): React.ReactNode => {
  const meters = useReplayMeters({ playback: props.playback, scenario: props.scenario })
  return (
    <section
      aria-label={`Meter tiles at ${props.widthPx} px, ${props.scenario}`}
      {...stylex.props(styles.frame(props.widthPx))}
    >
      <p {...stylex.props(styles.caption)}>
        {props.scenario} at {props.widthPx} px. Focus, hover or activate a tile for its evidence
        snapshot; R refreshes it. Low-priority tiles move into +N on narrow bars.
      </p>
      {meters !== undefined && (
        <TileDevbar
          // Remount on fixture change so freeze and evidence match the args.
          key={`${props.playback}-${props.scenario}-${props.frozen}`}
          {...props}
          meters={meters}
        />
      )}
    </section>
  )
}

const meta = {
  title: 'Developer Bar/Meter Tiles',
  component: MeterTiles,
  parameters: { layout: 'fullscreen' },
  args: { widthPx: 1440, playback: 'Pinned', scenario: 'Recording', frozen: false, dark: false },
  argTypes: {
    widthPx: { control: 'inline-radio', options: [1440, 900, 600] },
    playback: { control: 'inline-radio', options: ['Pinned', 'Live'] },
    scenario: {
      control: 'inline-radio',
      options: ['Recording', 'NoData', 'Stale', 'Disconnected'],
    },
  },
  // oxlint-disable-next-line overeng/named-args -- Storybook render receives positional args/context.
  render: (args, context) => (
    <MeterTiles {...args} dark={args.dark === true || context.globals['theme'] === 'dark'} />
  ),
} satisfies Meta<typeof MeterTiles>
export default meta

type Story = StoryObj<typeof meta>

/** Desktop width: every tile visible; keyboard evidence, refresh and freeze. */
export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tile = await canvas.findByRole('button', { name: 'p95' })
    await expect(tile).toHaveAttribute('title', 'HTTP latency p50/p95')
    await expect(canvas.queryByRole('tooltip')).toBeNull()
    // Focus shows the card and describes the tile with it.
    await userEvent.click(canvas.getByRole('button', { name: 'msg' }))
    await userEvent.tab()
    await expect(tile).toHaveFocus()
    const card = await canvas.findByRole('tooltip')
    await expect(tile).toHaveAttribute('aria-describedby', card.id)
    await expect(card).toHaveTextContent('Snapshot taken on focus')
    await expect(card).toHaveTextContent(/range over the 30\.0 s before evaluation: min .* \/ max /)
    // Enter and Space activate: the explicit refresh.
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Snapshot taken on activation')
    await userEvent.keyboard('r')
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Snapshot refreshed')
    await userEvent.keyboard(' ')
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Snapshot taken on activation')
    // The name stays the meter name, never a value.
    await expect(tile).toHaveAccessibleName('p95')
    // Freeze toggles one shared snapshot; the card then reads it.
    const freeze = canvas.getByRole('button', { name: 'Freeze meters' })
    await expect(freeze).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(freeze)
    await expect(freeze).toHaveAttribute('aria-pressed', 'true')
    tile.focus()
    await waitFor(() => expect(canvas.getByRole('tooltip')).toHaveTextContent('(frozen)'))
    await userEvent.keyboard('{Escape}')
    await expect(canvas.queryByRole('tooltip')).toBeNull()
    await userEvent.click(freeze)
    await expect(freeze).toHaveAttribute('aria-pressed', 'false')
  },
}

/** 900 px: the lowest priorities move into +N, named by their display labels. */
export const Narrow: Story = {
  args: { widthPx: 900 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('button', { name: 'msg' })
    const overflow = await canvas.findByRole('button', { name: /more status items:/ })
    await expect(overflow).toHaveAccessibleName(/Frame rate/)
  },
}

/** 600 px: icon-only freeze with the same accessible name, more tiles in +N. */
export const ExtraNarrow: Story = {
  args: { widthPx: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const freeze = await canvas.findByRole('button', { name: 'Freeze meters' })
    await expect(freeze).toHaveTextContent('')
  },
}

/** Live replay through the real frame clock. */
export const Live: Story = { args: { playback: 'Live' } }

/** No samples before evaluation: tiles draw n/a, the card names the reason. */
export const NoData: Story = {
  args: { scenario: 'NoData' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tile = await canvas.findByRole('button', { name: 'msg' })
    tile.focus()
    const card = await canvas.findByRole('tooltip')
    await expect(card).toHaveTextContent('n/a (NoSamples)')
    await expect(card).toHaveTextContent('no sample before evaluation')
  },
}

/**
 * The recording ended 15 s before evaluation and each source's 5 s freshness window lapsed:
 * tiles keep their label, mute the sparkline and read `stale`; the card dates the last sample.
 */
export const Stale: Story = {
  args: { scenario: 'Stale' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tile = await canvas.findByRole('button', { name: 'p95' })
    tile.focus()
    const card = await canvas.findByRole('tooltip')
    await expect(card).toHaveTextContent('unavailable (Stale)')
    await expect(card).toHaveTextContent(/last sample \d+\.\d s before evaluation/)
    await expect(card).not.toHaveTextContent(/\bago\b/)
    await expect(tile).toHaveAccessibleName('p95')
  },
}

/** Dark theme at desktop width. */
export const Dark: Story = { args: { dark: true } }

/** Every width and fixture state, stacked for review. */
export const AllStates: Story = {
  // oxlint-disable-next-line overeng/named-args -- Storybook render receives positional args/context.
  render: (args, context) => {
    const dark = args.dark === true || context.globals['theme'] === 'dark'
    return (
      <div {...stylex.props(styles.collection)}>
        <MeterTiles {...args} dark={dark} widthPx={1440} />
        <MeterTiles {...args} dark={dark} widthPx={900} />
        <MeterTiles {...args} dark={dark} widthPx={600} />
        <MeterTiles {...args} dark={dark} scenario="NoData" />
        <MeterTiles {...args} dark={dark} scenario="Stale" />
        <MeterTiles {...args} dark={dark} frozen />
      </div>
    )
  },
}
