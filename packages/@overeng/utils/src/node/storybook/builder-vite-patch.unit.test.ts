import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

const selector = '@storybook/builder-vite@10.6.0'
const distributedFileSha256 = 'c95ace27f291fb167b21e17df57c8ba276a0e5c50e59a746b3fcbf117da89363'

const originalServerShape = `      middlewareMode: !0,
      hmr: {
        port: options.port,
        server: devServer
      },`
const patchedServerShape = `      middlewareMode: !0,
      port: options.port,
      hmr: {
        server: devServer
      },`

const expectedPatch = `diff --git a/dist/index.js b/dist/index.js
--- a/dist/index.js
+++ b/dist/index.js
@@ -1753,8 +1753,8 @@ async function createViteServer(options, devServer) {
     server: {
       allowedHosts,
       middlewareMode: !0,
+      port: options.port,
       hmr: {
-        port: options.port,
         server: devServer
       },
       fs: {
`

const occurrences = (source: string, fragment: string): number => source.split(fragment).length - 1
const sha256 = (source: string): string => createHash('sha256').update(source).digest('hex')

Vitest.describe('Storybook builder-vite pnpm patch bridge', () => {
  Vitest.it('pins the published bundle and moves only the Vite server port', () => {
    const patchSource = readFileSync(
      new URL('../../../patches/@storybook__builder-vite@10.6.0.patch', import.meta.url),
      'utf8',
    )
    expect(patchSource).toBe(expectedPatch)
    expect(patchSource).not.toMatch(/client(?:Host|Port|Protocol)/u)

    const require = createRequire(import.meta.url)
    const reactViteEntry = require.resolve('@storybook/react-vite')
    const builderEntry = createRequire(reactViteEntry).resolve('@storybook/builder-vite')
    const builderRoot = dirname(dirname(builderEntry))
    expect(JSON.parse(readFileSync(join(builderRoot, 'package.json'), 'utf8'))).toMatchObject({
      name: selector.slice(0, selector.lastIndexOf('@')),
      version: selector.slice(selector.lastIndexOf('@') + 1),
    })

    const patchedBundle = readFileSync(builderEntry, 'utf8')
    expect(occurrences(patchedBundle, patchedServerShape)).toBe(1)
    expect(occurrences(patchedBundle, originalServerShape)).toBe(0)

    const publishedBundle = patchedBundle.replace(patchedServerShape, originalServerShape)
    expect(occurrences(publishedBundle, originalServerShape)).toBe(1)
    expect(sha256(publishedBundle)).toBe(distributedFileSha256)
    expect(publishedBundle.replace(originalServerShape, patchedServerShape)).toBe(patchedBundle)

    const serverStart = patchedBundle.indexOf('async function createViteServer')
    const serverEnd = patchedBundle.indexOf('\nasync function', serverStart + 1)
    expect(serverStart).toBeGreaterThanOrEqual(0)
    expect(serverEnd).toBeGreaterThan(serverStart)
    expect(patchedBundle.slice(serverStart, serverEnd)).not.toMatch(/client(?:Host|Port|Protocol)/u)
  })
})
