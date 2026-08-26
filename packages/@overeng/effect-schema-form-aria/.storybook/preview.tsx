import type { Preview } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { spacing } from 'tailwind-stylex/tokens.stylex'

import '../src/styles.css'

const styles = stylex.create({
  page: {
    padding: spacing[4],
  },
})

/** Wrapper providing design tokens and padding for all stories */
const StorybookDecorator = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page)}>{children}</div>
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
