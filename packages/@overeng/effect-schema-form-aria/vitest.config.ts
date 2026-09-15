import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

// StyleX styles are compiled away at build time, so unit tests that render
// components need the same transform the bundler applies. The token package
// ships uncompiled StyleX source and must be inlined so the plugin can
// transform it. No `entries` here: the virtual stylesheet is a build-only
// concern and these tests assert compiled class names, not rendered CSS.
const stylexPlugins = createStylexVitePlugins({ useCSSLayers: { before: ['overeng.reset'] } })
/** Vitest collection needs transforms, but dev-server hooks keep `vitest list` alive after its report. */
const collectionStylexCompiler = {
  ...stylexPlugins[0]!,
  configureServer: undefined,
  handleHotUpdate: undefined,
  transformIndexHtml: undefined,
}
export default defineConfig({
  plugins:
    process.argv.includes('list') === true
      ? [collectionStylexCompiler, react()]
      : [stylexPlugins, react()],
  ssr: { noExternal: ['@overeng/stylex-tokens'] },
  test: {
    exclude: ['**/dist/**', '**/node_modules/**'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
