import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ViteUserConfig } from 'vitest/config'

// Package-local Vitest binaries load this root workspace config, so avoid a
// runtime import that would be resolved from the dependency-less repo root.
const defineConfig = (config: ViteUserConfig): ViteUserConfig => config

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
