import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import { expect, userEvent, within } from 'storybook/test'

import { BuildIdentitySegment, type BuildIdentitySegmentProps } from '../BuildIdentitySegment.tsx'
import { Devbar } from '../Devbar.tsx'
import { darkDevbarTheme, lightDevbarTheme } from '../themes.ts'
import { devbarTokens } from '../tokens.stylex.ts'

const now = 1_800_000_000
const clean = {
  rev: 'a7647bb123456789',
  dirty: false,
  commitTs: now - 3 * 3600,
  buildTs: now - 720,
  displayVersion: '0.1.0+a7647bb — committed 3 hours ago',
  machineVersion: '0.1.0+a7647bb',
}
const dirty = {
  ...clean,
  dirty: true,
  commitTs: now - 2 * 86_400,
  displayVersion: '0.1.0+a7647bb-dirty — committed 2 days ago, with uncommitted changes',
  machineVersion: '0.1.0+a7647bb-dirty',
}
const missingCommitTime = {
  ...dirty,
  commitTs: undefined,
  displayVersion: '0.1.0 — running from local source (a7647bb, 12 min ago)',
  machineVersion: '0.1.0+local.a7647bb.dirty',
}

const styles = stylex.create({
  collection: { display: 'grid', gap: '1rem', padding: '1rem' },
  sample: {
    position: 'relative',
    height: '10rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
  },
  label: { margin: '1rem', fontFamily: devbarTokens.fontUi, color: devbarTokens.mutedText },
})

const Sample = ({
  label,
  dark = false,
  ...props
}: BuildIdentitySegmentProps & {
  readonly label: string
  readonly dark?: boolean
}): React.ReactNode => (
  <section
    aria-label={label}
    {...stylex.props(styles.sample, dark === true ? darkDevbarTheme : lightDevbarTheme)}
  >
    <p {...stylex.props(styles.label)}>{label}</p>
    <Devbar
      placement="container"
      panels={[]}
      openPanel={undefined}
      onOpenPanelChange={() => {}}
      segments={[{ id: 'build', render: () => <BuildIdentitySegment {...props} /> }]}
    />
  </section>
)

const meta = {
  component: BuildIdentitySegment,
  title: 'Developer Bar/Build Identity Segment',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { identity: clean, now },
  render: (args) => <Sample {...args} label="Build identity" />,
} satisfies Meta<typeof BuildIdentitySegment>

export default meta

type Story = StoryObj<typeof meta>

export const Clean: Story = {}
export const Dirty: Story = { args: { identity: dirty } }
export const MissingCommitTime: Story = { args: { identity: missingCommitTime } }

export const AllStates: Story = {
  render: () => (
    <div {...stylex.props(styles.collection)}>
      <Sample label="Clean / light" identity={clean} now={now} />
      <Sample label="Dirty / light" identity={dirty} now={now} />
      <Sample label="Missing commit time / light" identity={missingCommitTime} now={now} />
      <Sample label="Clean / dark" identity={clean} now={now} dark />
      <Sample label="Dirty / dark" identity={dirty} now={now} dark />
      <Sample label="Missing commit time / dark" identity={missingCommitTime} now={now} dark />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sample = within(canvas.getByRole('region', { name: 'Clean / light' }))
    const trigger = sample.getByRole('button', { name: 'Build identity: a7647bb · 3h' })
    await expect(sample.queryByRole('tooltip')).not.toBeInTheDocument()
    await userEvent.hover(trigger)
    const details = sample.getByRole('tooltip')
    await expect(details).toBeVisible()
    await expect(details).toHaveTextContent(clean.displayVersion)
    await expect(details).toHaveTextContent(`machineVersion ${clean.machineVersion}`)
    await expect(details).toHaveTextContent('deployed 12m ago')
    await expect(trigger).toHaveAttribute('aria-describedby', details.id)
    // The details themselves remain hoverable, including within the scrollable shell row.
    await userEvent.hover(details)
    await expect(details).toBeVisible()
    await userEvent.unhover(details)
    await expect(sample.queryByRole('tooltip')).not.toBeInTheDocument()
    await userEvent.tab()
    await expect(trigger).toHaveFocus()
    await expect(sample.getByRole('tooltip')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect(sample.queryByRole('tooltip')).not.toBeInTheDocument()
    await expect(trigger).toHaveFocus()
    await userEvent.tab()
    const dirtySample = within(canvas.getByRole('region', { name: 'Dirty / light' }))
    await expect(
      dirtySample.getByRole('button', { name: 'Build identity: a7647bb* · 2d' }),
    ).toHaveFocus()
    await expect(dirtySample.getByRole('tooltip')).toHaveTextContent(dirty.machineVersion)
    await userEvent.tab()
    const missingSample = within(
      canvas.getByRole('region', { name: 'Missing commit time / light' }),
    )
    await expect(
      missingSample.getByRole('button', { name: 'Build identity: a7647bb* · n/a' }),
    ).toHaveFocus()
    await expect(missingSample.getByRole('tooltip')).toHaveTextContent('deployed 12m ago')
  },
}
