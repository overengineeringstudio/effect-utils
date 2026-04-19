import type { Preview } from '@storybook/react'

import '../src/web/styles.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'notion',
      values: [{ name: 'notion', value: '#ffffff' }],
    },
  },
}

export default preview
