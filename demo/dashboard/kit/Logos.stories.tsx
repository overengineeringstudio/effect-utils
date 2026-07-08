/**
 * Logos.stories — the inline-SVG tech marks (`<TechLogo/>`). A grid over every
 * `LOGO_NAME` (mono `currentColor` default vs `brand` color), plus size + single-mark
 * stories. Zero network: every mark is an inline `<svg>` path.
 */
import type * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { BRAND_COLOR, LOGO_NAMES, type LogoName, TechLogo } from './logos.tsx'

const meta = {
  title: 'Kit/Atoms/TechLogo',
  component: TechLogo,
  parameters: { layout: 'centered' },
  args: { name: 'notion', size: 40 },
  argTypes: {
    name: { control: 'select', options: LOGO_NAMES },
    size: { control: { type: 'range', min: 12, max: 96, step: 2 } },
    brand: { control: 'boolean' },
  },
} satisfies Meta<typeof TechLogo>

export default meta
type Story = StoryObj<typeof meta>

/** Single mark — drive it with the controls (name / size / brand). */
export const Single: Story = {}

const cell = (label: string, node: React.ReactNode): React.ReactElement => (
  <div
    key={label}
    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 96 }}
  >
    {node}
    <code style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</code>
  </div>
)

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, maxWidth: 640 }}>{children}</div>
)

/** All ten marks in the theme-aware `currentColor` (monochrome) default. */
export const AllMono: Story = {
  render: () => (
    <Grid>
      {LOGO_NAMES.map((name) => cell(name, <TechLogo name={name} size={40} />))}
    </Grid>
  ),
}

/** All marks in `brand` mode — the ones with an official brand color paint it
 *  (react cyan, typescript blue, sqlite navy…); the color-less glyphs stay mono. */
export const AllBrand: Story = {
  render: () => (
    <Grid>
      {LOGO_NAMES.map((name) => {
        const brandable = BRAND_COLOR[name] != null
        return cell(`${name}${brandable ? '' : ' (no brand)'}`, <TechLogo name={name as LogoName} size={40} brand />)
      })}
    </Grid>
  ),
}

/** One mark across the title-bar → hero size range. */
export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
      {[14, 20, 32, 48, 72].map((s) => cell(`${s}px`, <TechLogo name="react" size={s} brand />))}
    </div>
  ),
}
