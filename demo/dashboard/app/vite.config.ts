import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { genModel } from './scripts/gen-model.ts'

// DEV server exposure: `vite` runs on DEV_PORT (127.0.0.1) and a standing
// `tailscale serve --https=TAILNET_PORT` fronts it with TLS at a clean tailnet
// URL (no filename). Ports are fixed so the tailscale mapping always lines up.
// New, distinct ports so this never disturbs the static control.html serve
// (:52606 → tailnet :8443) or the SSG-explainer HMR serve (:52608 → :8444).
const DEV_PORT = Number(process.env.DEMO_DASHBOARD_DEV_PORT ?? 5174)
const TAILNET_HOST = process.env.DEMO_DASHBOARD_TAILNET_HOST ?? 'mbp2025.tail8108.ts.net'
const TAILNET_PORT = Number(process.env.DEMO_DASHBOARD_TAILNET_PORT ?? 8445)

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
  // DEV server config (ignored by the singlefile build).
  server: {
    // Bind IPv4 127.0.0.1 (not the default localhost→::1) so the standing
    // `tailscale serve … http://127.0.0.1:DEV_PORT` proxy can reach it.
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true, // never drift off DEV_PORT — the tailscale mapping is fixed
    // Accept the tailnet FQDN Host header (tailscale terminates TLS on
    // :TAILNET_PORT and proxies to 127.0.0.1:DEV_PORT). Without this Vite
    // returns "Blocked request. This host is not allowed."
    allowedHosts: [TAILNET_HOST],
    // The page loads over wss on the tailnet port; point the injected HMR client
    // there (not the internal DEV_PORT, which tailscale doesn't proxy) so native
    // React/Tailwind HMR connects.
    hmr: { protocol: 'wss', host: TAILNET_HOST, clientPort: TAILNET_PORT },
  },
})
