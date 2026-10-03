import type { Preview } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'

import { darkDevbarTheme, lightDevbarTheme } from '../src/themes.ts'
import { devbarTokens } from '../src/tokens.stylex.ts'

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
  },
})

const ThemePreview = ({
  children,
  isDark,
}: {
  children: ReactNode
  isDark: boolean
}): ReactNode => (
  <div {...stylex.props(styles.page, isDark === true ? darkDevbarTheme : lightDevbarTheme)}>
    {children}
  </div>
)

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Developer bar color scheme',
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
    // oxlint-disable-next-line overeng/named-args -- Storybook decorators receive positional story/context arguments.
    (Story, context) => (
      <ThemePreview isDark={context.globals.theme === 'dark'}>
        <Story />
      </ThemePreview>
    ),
  ],
}

export default preview
