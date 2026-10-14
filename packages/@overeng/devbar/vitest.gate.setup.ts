import { setProjectAnnotations } from '@storybook/react'
import { userEvent } from 'vitest/browser'

// Native popover light dismissal requires trusted pointer input. Keep the
// browser-provider dependency in the gate rather than the regular Storybook.
setProjectAnnotations([
  Reflect.get(globalThis, 'globalProjectAnnotations'),
  {
    parameters: {
      nativePointerClick: ({ element }: { readonly element: HTMLElement }) =>
        userEvent.click(element),
    },
  },
])
