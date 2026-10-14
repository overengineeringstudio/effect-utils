import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import { expect, userEvent, within } from 'storybook/test'

import { BuildIdentitySegment } from '../BuildIdentitySegment.tsx'
import { Devbar } from '../Devbar.tsx'
import { darkDevbarTheme, lightDevbarTheme } from '../themes.ts'
import { devbarTokens } from '../tokens.stylex.ts'

const now = 1_800_000_000
const identity = {
  rev: 'a7647bb123456789',
  dirty: false,
  commitTs: now - 10800,
  buildTs: now - 720,
  displayVersion: '0.1.0+a7647bb',
  machineVersion: '0.1.0+a7647bb',
}
const entries = [
  {
    date: '2027-01-15',
    title: 'Search filters',
    description: 'Saved filters now retain their selected date range.',
  },
  {
    date: '2027-01-14',
    title: 'Export progress',
    description: 'Large exports report completed rows before the download is ready.',
  },
  {
    date: '2027-01-13',
    title: 'Keyboard navigation',
    description: 'Focus returns to the selected row after closing its detail view.',
  },
]
const styles = stylex.create({
  sample: {
    position: 'relative',
    height: 400,
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
  },
  width: (width: number) => ({ width }),
  short: { height: 240 },
  heading: { padding: '1rem', margin: 0, fontSize: '1rem' },
  status: { width: 250, display: 'inline-block', whiteSpace: 'nowrap' },
  content: { width: 340, maxWidth: '100%', whiteSpace: 'normal' },
  matrix: { display: 'grid', gap: '1rem' },
})

/** Deterministic host state, including mark-seen and retry policy, never kit loading UI. */
const ChangelogHost = ({
  unseen = true,
  state = 'entries',
  dark = false,
  width = 1440,
  panel = false,
  short = false,
}: {
  readonly unseen?: boolean
  readonly state?: 'entries' | 'empty' | 'failure'
  readonly dark?: boolean
  readonly width?: number
  readonly panel?: boolean
  readonly short?: boolean
}): React.ReactNode => {
  const [hasUnseen, setHasUnseen] = React.useState(unseen)
  const [retried, setRetried] = React.useState(false)
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(
    panel === true ? 'logs' : undefined,
  )
  return (
    <section
      aria-label={`${width}px ${dark === true ? 'dark' : 'light'} changelog`}
      {...stylex.props(
        styles.sample,
        styles.width(width),
        short === true && styles.short,
        dark === true ? darkDevbarTheme : lightDevbarTheme,
      )}
    >
      <h2 {...stylex.props(styles.heading)}>Host app release notes</h2>
      <Devbar
        placement="container"
        strip={<span>Host-owned meter strip</span>}
        stripMinWidth={360}
        panels={[
          {
            id: 'logs',
            label: 'Logs',
            render: () => <p>Recent requests remain visible while release notes are open.</p>,
          },
        ]}
        openPanel={openPanel}
        onOpenPanelChange={setOpenPanel}
        segments={[
          {
            id: 'connection',
            priority: 4,
            render: () => (
              <span {...stylex.props(styles.status)}>Connection: healthy · 12 subscriptions</span>
            ),
          },
          {
            id: 'requests',
            priority: 3,
            render: () => (
              <span {...stylex.props(styles.status)}>Requests: 128 completed · 0 failures</span>
            ),
          },
          {
            id: 'build',
            priority: 0,
            hasAlert: hasUnseen,
            render: () => (
              <BuildIdentitySegment
                identity={identity}
                now={now}
                disclosure={{
                  label: 'Changelog',
                  hasUnseen,
                  onOpenChange: (open) => {
                    if (open === true) setHasUnseen(false)
                  },
                  render: () => (
                    <div {...stylex.props(styles.content)}>
                      <h3>Changelog</h3>
                      {state === 'empty' ? (
                        <p>No changes recorded.</p>
                      ) : state === 'failure' && retried === false ? (
                        <>
                          <p>
                            Release notes could not be fetched. The host app is still available.
                          </p>
                          <button type="button" onClick={() => setRetried(true)}>
                            Retry
                          </button>
                        </>
                      ) : (
                        <ol>
                          {entries.map((entry) => (
                            <li key={entry.date}>
                              <time>{entry.date}</time>
                              <h4>{entry.title}</h4>
                              <p>{entry.description}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ),
                }}
              />
            ),
          },
        ]}
      />
    </section>
  )
}

const meta = {
  component: ChangelogHost,
  title: 'Developer Bar/Build Identity Disclosure',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { width: 1440, unseen: true, dark: false },
} satisfies Meta<typeof ChangelogHost>
export default meta
type Story = StoryObj<typeof meta>

const playChangelog: NonNullable<Story['play']> = async ({ canvasElement, args, parameters }) => {
  const canvas = within(canvasElement)
  const overflow = canvas.queryByRole('button', { name: /more status items/ })
  if (args.width === 900) {
    await expect(overflow).toBeVisible()
    if (args.unseen !== false)
      await expect(overflow).toHaveAccessibleName(/including unseen changes/)
    await userEvent.click(overflow!)
  }
  const trigger = canvas.getByRole('button', { name: /Build identity: .*show Changelog/ })
  if (args.unseen !== false) await expect(trigger).toHaveAccessibleName(/unseen changes/)
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const dialog = canvas.getByRole('dialog', { name: 'Changelog' })
  await expect(dialog).toBeVisible()
  await expect(trigger).not.toHaveAccessibleName(/unseen changes/)
  await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument()
  if (args.state === 'empty') await expect(dialog).toHaveTextContent('No changes recorded.')
  else if (args.state === 'failure') {
    await expect(dialog).toHaveTextContent('Release notes could not be fetched.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await expect(dialog).toHaveTextContent('Search filters')
  } else await expect(dialog).toHaveTextContent('Search filters')
  if (args.panel === true) await expect(canvas.getByRole('region', { name: 'Logs' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect(trigger).toHaveFocus()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  if (args.panel === true) await expect(canvas.getByRole('region', { name: 'Logs' })).toBeVisible()
  if (args.width === 900) {
    await expect(overflow).toHaveAttribute('aria-expanded', 'true')
    await userEvent.unhover(trigger)
    // Focus return may reveal the identity tooltip; consume it independently.
    if (canvas.queryByRole('tooltip') !== null) await userEvent.keyboard('{Escape}')
    await userEvent.keyboard('{Escape}')
    await expect(overflow).toHaveFocus()
    await expect(overflow).toHaveAttribute('aria-expanded', 'false')
  }
  if (args.panel === true) {
    if (canvas.queryByRole('tooltip') !== null) await userEvent.keyboard('{Escape}')
    await userEvent.keyboard('{Escape}')
    await expect(canvas.queryByRole('region', { name: 'Logs' })).not.toBeInTheDocument()
  }
  // Keep keyboard dismissal portable; the gate supplies trusted browser clicks.
  if (args.panel === true)
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle developer tools' }))
  if (args.width !== 900) {
    trigger.focus()
    await userEvent.keyboard(' ')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    if (typeof parameters.nativePointerClick === 'function')
      await parameters.nativePointerClick({
        element:
          args.panel === true
            ? canvas.getByText('Recent requests remain visible while release notes are open.')
            : canvas.getByRole('heading', { name: 'Host app release notes' }),
      })
    else await userEvent.keyboard('{Escape}')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  } else {
    await userEvent.click(overflow!)
    const nestedTrigger = within(
      canvas.getByRole('dialog', { name: 'More status items' }),
    ).getByRole('button', { name: /show Changelog/ })
    nestedTrigger.focus()
    await userEvent.keyboard(' ')
    await expect(canvas.getByRole('dialog', { name: 'Changelog' })).toBeVisible()
    await expect(overflow).toHaveAttribute('aria-expanded', 'true')
    if (typeof parameters.nativePointerClick === 'function')
      await parameters.nativePointerClick({
        element:
          args.panel === true
            ? canvas.getByText('Recent requests remain visible while release notes are open.')
            : canvas.getByRole('heading', { name: 'Host app release notes' }),
      })
    else {
      await userEvent.keyboard('{Escape}')
      if (canvas.queryByRole('tooltip') !== null) await userEvent.keyboard('{Escape}')
      await userEvent.keyboard('{Escape}')
    }
    await expect(canvas.queryByRole('dialog', { name: 'Changelog' })).not.toBeInTheDocument()
    await expect(overflow).toHaveAttribute('aria-expanded', 'false')
  }
  await expect(canvas.queryByRole('dialog', { name: 'Changelog' })).not.toBeInTheDocument()
  await expect(document.activeElement?.closest('[data-devbar-disclosure]') ?? null).toBeNull()
  if (args.panel === true) await expect(canvas.getByRole('region', { name: 'Logs' })).toBeVisible()
}

export const ChangelogUnseen: Story = { play: playChangelog }
export const ChangelogSeen: Story = { args: { unseen: false }, play: playChangelog }
export const ChangelogEmpty: Story = { args: { state: 'empty' }, play: playChangelog }
export const ChangelogLoadFailure: Story = { args: { state: 'failure' }, play: playChangelog }
export const ChangelogDark: Story = { args: { dark: true }, play: playChangelog }
export const ChangelogNarrow900: Story = { args: { width: 900 }, play: playChangelog }
export const ChangelogNarrow900Dark: Story = {
  args: { width: 900, dark: true },
  play: playChangelog,
}
export const WithPanelOpen: Story = { args: { panel: true }, play: playChangelog }
export const WithPanelOpenNarrowDark: Story = {
  args: { panel: true, width: 900, dark: true },
  play: playChangelog,
}
export const ChangelogSeenDark: Story = { args: { unseen: false, dark: true }, play: playChangelog }
export const ChangelogSeenNarrow900: Story = {
  args: { unseen: false, width: 900 },
  play: playChangelog,
}
export const ChangelogSeenNarrow900Dark: Story = {
  args: { unseen: false, width: 900, dark: true },
  play: playChangelog,
}
export const ChangelogEmptyDark: Story = {
  args: { state: 'empty', dark: true },
  play: playChangelog,
}
export const ChangelogEmptyNarrow900: Story = {
  args: { state: 'empty', width: 900 },
  play: playChangelog,
}
export const ChangelogEmptyNarrow900Dark: Story = {
  args: { state: 'empty', width: 900, dark: true },
  play: playChangelog,
}
export const ChangelogLoadFailureDark: Story = {
  args: { state: 'failure', dark: true },
  play: playChangelog,
}
export const ChangelogLoadFailureNarrow900: Story = {
  args: { state: 'failure', width: 900 },
  play: playChangelog,
}
export const ChangelogLoadFailureNarrow900Dark: Story = {
  args: { state: 'failure', width: 900, dark: true },
  play: playChangelog,
}
export const WithPanelOpenDark: Story = { args: { panel: true, dark: true }, play: playChangelog }
export const WithPanelOpenNarrow900: Story = {
  args: { panel: true, width: 900 },
  play: playChangelog,
}
export const ChangelogShortViewportOverflow: Story = {
  args: { width: 900, short: true },
  parameters: {
    viewport: {
      options: {
        short: { name: 'Short developer viewport', styles: { width: '900px', height: '320px' } },
      },
    },
  },
  globals: { viewport: { value: 'short', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const overflow = canvas.getByRole('button', { name: /more status items/ })
    await userEvent.click(overflow)
    const trigger = within(canvas.getByRole('dialog', { name: 'More status items' })).getByRole(
      'button',
      { name: /show Changelog/ },
    )
    await userEvent.click(trigger)
    const dialog = canvas.getByRole('dialog', { name: 'Changelog' })
    await expect(dialog).toBeVisible()
    const anchor = trigger.getBoundingClientRect()
    const bounds = dialog.getBoundingClientRect()
    const above = Math.max(0, anchor.top - 8)
    const below = Math.max(0, window.innerHeight - anchor.bottom - 8)
    await expect(bounds.top).toBeGreaterThanOrEqual(8)
    await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 8)
    await expect(bounds.left).toBeGreaterThanOrEqual(8)
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 8)
    if (above < below) await expect(bounds.top).toBeCloseTo(anchor.bottom, 0)
    else await expect(bounds.bottom).toBeCloseTo(anchor.top, 0)
    await expect(bounds.height).toBeLessThanOrEqual(Math.max(above, below))
    await expect(overflow).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    await expect(trigger).toHaveFocus()
    await expect(overflow).toHaveAttribute('aria-expanded', 'true')
  },
}
export const AllStates: Story = {
  render: () => (
    <div {...stylex.props(styles.matrix)}>
      <ChangelogHost />
      <ChangelogHost dark />
      <ChangelogHost width={900} />
      <ChangelogHost width={900} dark />
      <ChangelogHost unseen={false} />
      <ChangelogHost state="empty" />
      <ChangelogHost state="failure" />
      <ChangelogHost panel />
      <ChangelogHost width={900} short />
    </div>
  ),
}
