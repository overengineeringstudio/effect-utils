import { defineConfig } from 'vite'

const cacheDir = process.env['VITE_CACHE_DIR']

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
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
