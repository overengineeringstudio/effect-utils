import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        index: new URL('./src/index.ts', import.meta.url).pathname,
        'series/index': new URL('./src/series/index.ts', import.meta.url).pathname,
        'headless/index': new URL('./src/headless/index.ts', import.meta.url).pathname,
        'platform/browser': new URL('./src/platform/browser.ts', import.meta.url).pathname,
        'sources/frame/index': new URL('./src/sources/frame/index.ts', import.meta.url).pathname,
        'sources/long-frames/index': new URL('./src/sources/long-frames/index.ts', import.meta.url)
          .pathname,
        'sources/memory/index': new URL('./src/sources/memory/index.ts', import.meta.url).pathname,
        'sources/fibers/index': new URL('./src/sources/fibers/index.ts', import.meta.url).pathname,
        'sources/spans/index': new URL('./src/sources/spans/index.ts', import.meta.url).pathname,
        'sources/otel-browser/index': new URL(
          './src/sources/otel-browser/index.ts',
          import.meta.url,
        ).pathname,
        'sources/counters/index': new URL('./src/sources/counters/index.ts', import.meta.url)
          .pathname,
        'sources/status/index': new URL('./src/sources/status/index.ts', import.meta.url).pathname,
        'canvas/index': new URL('./src/canvas/index.ts', import.meta.url).pathname,
        'canvas/layout': new URL('./src/canvas/layout.ts', import.meta.url).pathname,
        'react/index': new URL('./src/react/index.tsx', import.meta.url).pathname,
      },
      formats: ['es'],
    },
    rolldownOptions: { external: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/, /^effect(?:\/|$)/] },
    sourcemap: true,
  },
})
