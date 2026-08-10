import { fileURLToPath } from 'node:url'

const runnerEnabled = process.env.VITEST_OTEL_RUNNER === '1'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.fixture.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    ...(runnerEnabled === true
      ? {
          experimental: {
            openTelemetry: {
              enabled: true,
              sdkPath: '../../otel-sdk.mjs',
            },
          },
        }
      : {}),
  },
}
