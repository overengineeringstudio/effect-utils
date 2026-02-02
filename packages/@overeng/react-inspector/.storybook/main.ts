export default {
  stories: ['../stories/*.*'],

  framework: {
    name: '@storybook/react-vite',
  },

  viteFinal: async (config) => {
    // Allow access from any host (for remote dev servers)
    config.server = {
      ...config.server,
      host: '0.0.0.0',
      allowedHosts: true,
    }
    // Disable minification to preserve function names
    if (config.build) {
      config.build.minify = false
    }

    return config
  },
}
