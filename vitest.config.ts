import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const packagesRoot = resolve(rootDir, 'packages', '@overeng')
const exclude = ['**/dist/**', '**/node_modules/**']
const inlineDeps = ['@effect/vitest']

const hasVitestConfig = (root: string): boolean => {
  const absRoot = resolve(rootDir, root)
  return ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.cjs'].some(
    (name) => existsSync(resolve(absRoot, name)),
  )
}

const projectRoots = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/@overeng/${entry.name}`)

const projects = projectRoots.map((root) =>
  hasVitestConfig(root) === true
    ? root
    : { root, test: { exclude, server: { deps: { inline: inlineDeps } } } },
)

// Native Vitest OTEL (runner-mechanics span tree) is enabled when a collector
// context is present — the devenv test task sets VITEST_OTEL_RUNNER=1 so the run
// nests under the ambient devenv/CI task trace (via TRACEPARENT). Off for bare
// local/interactive runs (no collector, watch-mode latency).
const otelRunnerEnabled = process.env.VITEST_OTEL_RUNNER === '1'

// We mostly have this file for VSC test explorer support
export default defineConfig({
  test: {
    exclude,
    server: { deps: { inline: inlineDeps } },
    ...(otelRunnerEnabled === true
      ? {
          experimental: {
            openTelemetry: {
              enabled: true,
              sdkPath: './packages/@overeng/utils-dev/src/node-vitest/otel-sdk.mjs',
            },
          },
        }
      : {}),
    projects,
  },
})
