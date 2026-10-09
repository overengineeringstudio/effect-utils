import { defineConfig } from 'vitest/config'

/** Focused real-key/loopback auth tests plus existing gh-cli and log redirect regressions. */
export default defineConfig({
  root: new URL('../../../', import.meta.url).pathname,
  resolve: { alias: { '@overeng/utils/node/github-app': new URL('./src/node/github-app.ts', import.meta.url).pathname } },
  test: {
    include: [
      'packages/@overeng/utils/src/node/github-app.integration.test.ts',
      'packages/@overeng/gh-ci-utils/src/node/GitHubClient.integration.test.ts',
      'packages/@overeng/gh-ci-utils/test/cliTokenFallback.test.ts',
      'packages/@overeng/gh-ci-utils/test/GitHubClient.test.ts',
      'packages/@overeng/gh-ci-utils/test/GitHubClientLogs.test.ts',
    ],
    testTimeout: 20000,
    maxWorkers: 1,
  },
})
