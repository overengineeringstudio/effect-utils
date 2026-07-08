/**
 * Atoms.stories — the small inline primitives: StatusPill / PriorityPill (Notion-cell
 * chips) and TypingCaret (a collaborator's typewriter + name-flag). Driven by the
 * canonical option sets in fixtures.ts and the actors in actors.ts.
 */
import type * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { PriorityPill, StatusPill, TypingCaret } from './components.tsx'
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from './fixtures.ts'
import { Teammate, You } from './actors.ts'

const meta = {
  title: 'Kit/Atoms/Pills',
  parameters: { layout: 'centered' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>
)

/** Every StatusName → its pill. (`Done` reads green; the rest read "in progress".) */
export const Status: Story = {
  render: () => (
    <Row>
      {STATUS_OPTIONS.map((s) => (
        <StatusPill key={s} status={s} />
      ))}
    </Row>
  ),
}

/** Every PriorityName → its pill (High/Med/Low). */
export const Priority: Story = {
  render: () => (
    <Row>
      {PRIORITY_OPTIONS.map((p) => (
        <PriorityPill key={p} priority={p} />
      ))}
    </Row>
  ),
}

/**
 * TypingCaret — the collaborator caret with an identity-hued name flag. NOTE: the
 * typewriter reveal is gated by a `.seq[data-mode="anim"][data-step="2"]` ancestor,
 * so OUTSIDE a running <Sequence> the text renders fully with a static flag (no
 * type-in animation). See the Sequence story for the animated form.
 */
export const Carets: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <TypingCaret actor={You} ch={3}>
        $30
      </TypingCaret>
      <TypingCaret actor={Teammate} ch={16}>
        annual plans
      </TypingCaret>
    </div>
  ),
}
