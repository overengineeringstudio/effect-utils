import type { Meta, StoryObj } from '@storybook/react'
import { expect, userEvent } from 'storybook/test'

import { LiteralField } from '../components/LiteralField.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { TextField } from '../components/TextField.tsx'

/**
 * Keyboard-focused controls, one story per element that paints a focus ring.
 *
 * Additive coverage, and it is a prerequisite rather than a nicety: before this
 * file no story in the package rendered a focused control, so the focus ring was
 * outside the visual gate entirely. Every other property of these components is
 * gated; the ring was the one thing a conversion could silently repaint with a
 * full pass. That is the same blind spot that let a real ring defect ship
 * unnoticed in the design system this package borrows its conventions from.
 *
 * Three properties make these captures usable as baselines:
 *
 * 1. The gate's setup freezes transitions AND sets `caret-color: transparent`,
 *    so a focused text input has no blinking caret to make the capture
 *    non-deterministic. Without the caret rule a focused-input story could not
 *    have a stable baseline at all.
 * 2. Focus is taken with `userEvent.tab()` rather than `element.focus()`. The
 *    accessible-component library decides `data-focus-visible` from its own
 *    input-modality tracking, which only flips to keyboard on a key event —
 *    a bare `.focus()` focuses the element and paints no ring.
 * 3. Each `play` asserts the focus state actually landed. A story that captured
 *    an unfocused element would still produce a stable baseline and a green
 *    gate, so the assertion is what makes the capture evidence rather than a
 *    picture. It fails loudly if the modality trick ever stops working.
 */
export default {
  title: 'Components/FocusRing',
} satisfies Meta

type Story = StoryObj

/** These stories never change a value; the ring is the subject. */
const noop = (): void => undefined

/**
 * Move keyboard focus to the first tabbable control in the canvas and confirm it
 * is the intended one.
 *
 * Asserting the active element rather than counting tabs means a change in the
 * component's internal tab order fails the story instead of silently capturing
 * a different element.
 */
const focusFirstControl = async ({
  canvasElement,
  selector,
}: {
  canvasElement: HTMLElement
  selector: string
}): Promise<HTMLElement> => {
  const target = canvasElement.querySelector<HTMLElement>(selector)
  if (target === null) {
    throw new Error(`[focus-ring story] no element in the canvas matched \`${selector}\``)
  }
  await userEvent.tab()
  expect(document.activeElement).toBe(target)
  return target
}

/**
 * `TextField`'s `input`, keyboard-focused.
 *
 * Ring state: the library's `[data-focus-visible]` attribute condition.
 */
export const TextFieldFocused: Story = {
  name: 'TextField input',
  render: () => <TextField id="focus-text" label="Name" value="Ada Lovelace" onChange={noop} />,
  play: async ({ canvasElement }) => {
    const input = await focusFirstControl({ canvasElement, selector: 'input' })
    expect(input.hasAttribute('data-focus-visible')).toBe(true)
  },
}

/**
 * `NumberField`'s required-variant `input`, keyboard-focused.
 *
 * Ring state: the library's `[data-focus-visible]` attribute condition.
 */
export const NumberFieldFocused: Story = {
  name: 'NumberField input',
  render: () => <NumberField id="focus-number" label="Age" value={42} onChange={noop} />,
  play: async ({ canvasElement }) => {
    const input = await focusFirstControl({ canvasElement, selector: 'input' })
    expect(input.hasAttribute('data-focus-visible')).toBe(true)
  },
}

/**
 * `NumberField`'s optional-variant compact `input`, keyboard-focused.
 *
 * Ring state: the NATIVE `:focus-visible` pseudo-class. This is a plain
 * `<input>` rather than a library one, so it is the only ring site in the
 * package whose condition is a pseudo-class — which is exactly the condition
 * kind affected by the upstream priority-table defect, and the reason this
 * variant gets its own story instead of being folded into the one above.
 *
 * `value` is a number so the input is enabled; the optional variant disables it
 * while the value is `undefined`, and a disabled input cannot take focus.
 */
export const OptionalNumberFieldFocused: Story = {
  name: 'NumberField compact input (optional variant)',
  render: () => (
    <NumberField id="focus-compact" label="Count" value={7} onChange={noop} isOptional={true} />
  ),
  play: async ({ canvasElement }) => {
    const input = await focusFirstControl({
      canvasElement,
      selector: 'input[type="number"]',
    })
    expect(input.matches(':focus-visible')).toBe(true)
  },
}

/**
 * `LiteralField`'s select trigger, keyboard-focused.
 *
 * Ring state: the library's `[data-focus-visible]` attribute condition.
 *
 * Six literals, one more than `MAX_SEGMENTED_OPTIONS`, so the component takes
 * its select branch. The segmented branch is deliberately not covered here: its
 * segments paint no focus ring at all today, and a story implying otherwise
 * would be a claim this change does not make.
 */
export const LiteralFieldTriggerFocused: Story = {
  name: 'LiteralField select trigger',
  render: () => (
    <LiteralField
      id="focus-select"
      label="Region"
      value="eu-central-1"
      onChange={noop}
      literals={['eu-central-1', 'eu-west-1', 'us-east-1', 'us-west-2', 'ap-south-1', 'sa-east-1']}
    />
  ),
  play: async ({ canvasElement }) => {
    const trigger = await focusFirstControl({ canvasElement, selector: 'button' })
    expect(trigger.hasAttribute('data-focus-visible')).toBe(true)
  },
}
