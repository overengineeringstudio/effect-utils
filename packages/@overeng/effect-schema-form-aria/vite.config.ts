import { unplugin as stylex } from '@stylexjs/unplugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [stylex.vite({ externalPackages: ['tailwind-stylex'] }), react()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: new URL('./src/publish.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: 'mod',
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: [
        /^@overeng\/effect-schema-form(?:\/|$)/,
        /^@stylexjs\/stylex(?:\/|$)/,
        /^effect(?:\/|$)/,
        /^react(?:\/|$)/,
        /^react-aria-components(?:\/|$)/,
      ],
    },
    sourcemap: true,
  },
})
