import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { genModel } from './scripts/gen-model.ts'

// Regenerate the SCREENPLAY→model codegen on every dev start and build.
const screenplayModel = (): Plugin => ({
  name: 'screenplay-model-codegen',
  buildStart() {
    genModel()
  },
})

export default defineConfig({
  // Build to a local dist/ then scripts/emit.ts copies dist/index.html to
  // demo/explainers/control.next.html (avoids outside-root outDir friction).
  plugins: [screenplayModel(), react(), tailwindcss(), viteSingleFile()],
  build: {
    // Inline everything; ship a single self-contained HTML file (no hashed chunks).
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
})
