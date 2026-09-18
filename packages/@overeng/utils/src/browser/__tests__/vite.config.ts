import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

export default defineConfig({
  cacheDir: fileURLToPath(
    new URL('../../../../../../.devenv/vite-cache/utils-playwright', import.meta.url),
  ),
  root: __dirname + '/fixtures',
  server: {
    headers: {
      /** Required for SharedWorker to work in some browsers */
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
})
