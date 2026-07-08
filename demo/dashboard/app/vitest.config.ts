import { defineConfig } from 'vitest/config'

// Minimal, plugin-free vitest config: the causality test only CONSTRUCTS story
// objects (it never renders React), so it needs neither the react/tailwind plugins
// nor the screenplay-model codegen from vite.config.ts. esbuild transforms the
// imported .tsx automatically; node is the default (fine — no DOM). Keeping this
// separate from vite.config.ts avoids running genModel() on every test invocation.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
