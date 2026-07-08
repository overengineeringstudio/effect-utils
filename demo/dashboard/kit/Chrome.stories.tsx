/**
 * Chrome.stories — the macOS window frame (`MacWindow`) and its title-bar inner
 * (`WinTitle`). MacWindow paints only the bar + border; each variant expects its
 * own `*-body` wrapper as children (see the Surfaces stories for filled variants).
 */
import type { Meta, StoryObj } from '@storybook/react'
import { type MacVariant, MacWindow, WinTitle } from './components.tsx'

const meta = {
  title: 'Kit/Chrome/MacWindow',
  component: MacWindow,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MacWindow>

export default meta
type Story = StoryObj<typeof meta>

const PlaceholderBody = ({ label }: { label: string }) => (
  <div style={{ padding: 20, font: '12px var(--mono, monospace)', color: 'var(--muted)' }}>{label}</div>
)

/** Default `plain` window with a logo title. */
export const Plain: Story = {
  args: {
    title: <WinTitle logo="macos" label="Finder" />,
    tag: 'window',
    children: <PlaceholderBody label="— window body goes here —" />,
  },
}

const VARIANTS: readonly MacVariant[] = ['dbb', 'ntn', 'tmnl', 'ide', 'plain']

/** All five chrome variants side by side (bar + border only; bodies are placeholders). */
export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 480 }}>
      {VARIANTS.map((variant) => (
        <MacWindow
          key={variant}
          variant={variant}
          tag={variant}
          title={<WinTitle logo="terminal" label={`variant="${variant}"`} />}
        >
          <PlaceholderBody label={`.${variant === 'plain' ? 'macw' : variant}-body`} />
        </MacWindow>
      ))}
    </div>
  ),
}

/**
 * WinTitle — the title-bar inner. Four shapes: a brand `logo`, a raw-glyph `icon`,
 * a mono `file`, and a plain `label`. Rendered inside a MacWindow bar so the
 * `.macw-title` styling (mono filename, icon opacity) applies.
 */
export const TitleVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <MacWindow title={<WinTitle logo="react" file="App.tsx" />}>
        <PlaceholderBody label="logo (react) + file" />
      </MacWindow>
      <MacWindow title={<WinTitle logo="typescript" file="sync.ts" label="editor" />}>
        <PlaceholderBody label="logo (typescript) + file + label" />
      </MacWindow>
      <MacWindow title={<WinTitle icon="❯_" file="claude code" />}>
        <PlaceholderBody label="raw icon + file" />
      </MacWindow>
      <MacWindow title={<WinTitle label="no logo — plain label" />}>
        <PlaceholderBody label="label only" />
      </MacWindow>
    </div>
  ),
}
