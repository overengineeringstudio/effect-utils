import type { Meta, StoryObj } from '@storybook/react'

import { Equation, Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'
import { InlineEquation } from '../inline.tsx'

const meta = {
  title: 'Demo/08 — Math & Equations',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Math & equations</Heading1>

      <Heading2>Inline</Heading2>
      <Paragraph>
        Euler's identity <InlineEquation expression="e^{i\pi} + 1 = 0" /> connects five fundamental
        constants. The Pythagorean theorem <InlineEquation expression="a^2 + b^2 = c^2" /> relates
        the sides of a right triangle.
      </Paragraph>

      <Heading2>Block</Heading2>
      <Equation expression="\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}" />
      <Equation expression="\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}" />
      <Equation expression="\begin{pmatrix} a & b \\ c & d \end{pmatrix} \cdot \begin{pmatrix} x \\ y \end{pmatrix} = \begin{pmatrix} ax + by \\ cx + dy \end{pmatrix}" />
    </Page>
  ),
}
