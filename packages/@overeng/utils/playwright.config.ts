import { createPlaywrightConfig } from './src/node/playwright-config.ts'

export default createPlaywrightConfig({
  testDir: './src/browser/__tests__',
  testIgnore: ['**/fixtures/**'],
  webServer: {
    command:
      './node_modules/.bin/vite --config src/browser/__tests__/vite.config.ts --port {{port}}',
  },
})
