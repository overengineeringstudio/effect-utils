import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { genModel } from './scripts/gen-model.ts'

// This app imports the shared mockup kit AND the per-explainer content CSS from a
// SIBLING dir (../../kit, ../../explainers/src). Both the dev server AND the build
// must be allowed to read those files from outside the app root, or the mockups +
// explainers render unstyled. Allow the parent dashboard dir (covers app + kit +
// explainers).
const DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// DEV server exposure: `vite` runs on DEV_PORT (127.0.0.1) and a standing
// `tailscale serve --https=TAILNET_PORT` fronts it with TLS at a clean tailnet
// URL (no filename). Ports are fixed so the tailscale mapping always lines up.
// :5174 → tailnet :8445 is the single serve — the legacy static/SSG servers
// (:8443/:8444) have been retired.
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
  // Native multi-chunk build (React + Tailwind). Dev is native Vite/HMR; there is
  // no single-file / SSG step — the dev server is the authoring + recording surface.
  plugins: [screenplayModel(), react(), tailwindcss()],
  // The explainer components live in a SIBLING package (../../explainers/src) with
  // its OWN node_modules/react. Without deduping, the production Rollup build bundles
  // TWO React copies and hooks fail ("Cannot read properties of null (reading
  // 'useRef')"). Force a single React instance (the app root's) for both dev + build.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // DEV server config.
  server: {
    // Allow serving the sibling kit + explainers dirs (kit-components.css +
    // components + per-explainer .css) in dev.
    fs: { allow: [DASHBOARD_DIR] },
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
