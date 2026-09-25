import type { Preview } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'

import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import '../src/styles.css'
import { darkExplorerTheme } from '../src/themes.ts'
import { explorerTokens } from '../src/tokens.stylex.ts'

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    padding: spacing[2],
    backgroundColor: explorerTokens.canvas,
    color: explorerTokens.text,
  },
})

const StorybookDecorator = ({
  children,
  isDark,
}: {
  children: ReactNode
  isDark: boolean
}): ReactNode => (
  <div {...stylex.props(styles.page, isDark ? darkExplorerTheme : undefined)}>
    {children}
  </div>
)

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Explorer color scheme',
      defaultValue: 'light',
      toolbar: {
        icon: 'contrast',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => (
      <StorybookDecorator isDark={context.globals.theme === 'dark'}>
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
