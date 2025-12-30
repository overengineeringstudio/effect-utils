import type { Preview } from '@storybook/react'
import type { ReactNode } from 'react'

import '../src/styles.css'

/** Wrapper providing design tokens and padding for all stories */
const StorybookDecorator = ({ children }: { children: ReactNode }) => (
  <div className="p-4 font-sans">{children}</div>
)

const preview: Preview = {
  decorators: [
    (Story) => (
      <StorybookDecorator>
        <Story />
      </StorybookDecorator>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
}

export default preview
