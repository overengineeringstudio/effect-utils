import type { StorybookConfig } from '@storybook/react-vite'

export default {
  stories: ['../stories/*.*'],
  framework: { name: '@storybook/react-vite', options: {} },
  viteFinal: (config) => ({
    ...config,
    build: { ...config.build, minify: false },
    server: {
      ...config.server,
      host: '0.0.0.0',
      allowedHosts: true,
      watch: { ...config.server?.watch, useFsEvents: false },
    },
  }),
} satisfies StorybookConfig
