import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Inspector } from '../src'

export default {
  title: 'DOM Node',
  component: Inspector,
} satisfies Meta<typeof Inspector>

type Story = StoryObj<typeof Inspector>

/** Element Node: body */
export const ElementNodeBody: Story = {
  render: () => <Inspector data={document.body} />,
}

/** Element Node: div */
export const ElementNodeDiv: Story = {
  render: () => <Inspector data={document.createElement('div')} />,
}

/** Element Node: div with data attributes */
export const ElementNodeDivWithDataAttributes: Story = {
  render: () => {
    const div = document.createElement('div')
    div.setAttribute('data-test', 'test')
    return <Inspector data={div} />
  },
}

/** Element Node: div with class and style */
export const ElementNodeDivWithClassAndStyle: Story = {
  render: () => {
    const div = document.createElement('div')
    div.setAttribute('class', 'test')
    div.setAttribute('style', 'font-weight: bold;')
    return <Inspector data={div} />
  },
}

/** Element Node: div with children */
export const ElementNodeDivWithChildren: Story = {
  render: () => {
    const div = document.createElement('div')
    const span = document.createElement('span')
    span.textContent = 'hello'
    div.appendChild(span)
    return <Inspector data={div} />
  },
}

export const CommentNode: Story = {
  render: () => <Inspector data={document.createComment('this is a comment')} />,
}

export const TextNode: Story = {
  render: () => <Inspector data={document.createTextNode('this is a text node')} />,
}

export const ProcessingInstructionNode: Story = {
  render: () => {
    const docu = new DOMParser().parseFromString('<xml></xml>', 'application/xml')
    const pi = docu.createProcessingInstruction(
      'xml-stylesheet',
      'href="mycss.css" type="text/css"',
    )
    return <Inspector data={pi} />
  },
}

export const DocumentTypeNode: Story = {
  render: () => {
    // document.childNodes[0] is the doctype node
    return <Inspector data={document.childNodes[0]} />
  },
}

export const DocumentNode: Story = {
  render: () => <Inspector expandLevel={2} data={document} />,
}

/**
 * DocumentFragment node.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/DocumentFragment
 */
export const DocumentFragmentNode: Story = {
  render: () => <Inspector data={document.createElement('template').content} />,
}
