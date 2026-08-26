import { unplugin as stylex } from '@stylexjs/unplugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [stylex.vite({ externalPackages: ['tailwind-stylex'] }), react()],
})
