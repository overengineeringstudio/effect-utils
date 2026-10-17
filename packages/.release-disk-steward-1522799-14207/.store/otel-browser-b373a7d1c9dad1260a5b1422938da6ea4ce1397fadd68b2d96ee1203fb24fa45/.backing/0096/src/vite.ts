/**
 * Dev/preview stand-in for the gateway's OTLP relay: proxies the same-origin `/otlp/*` path to the
 * collector named by `OTEL_EXPORTER_OTLP_ENDPOINT`, so the page posts exactly where it will in
 * production. Page cookies are stripped on the way (they belong to the app, not the collector).
 *
 * It also defines `import.meta.env.VITE_OTLP_ENDPOINT` as the path when a collector is configured,
 * and `undefined` otherwise, so the app passes it straight to `BrowserTelemetry.layer({ endpoint })`
 * and runs ring-only without a collector instead of posting into a 404.
 */
import type { Plugin, ProxyOptions } from 'vite'

/** Same-origin proxy configuration for Vite development and preview servers. */
export interface OtlpDevProxyOptions {
  /** Same-origin path the page posts to. @default '/otlp' */
  readonly path?: string | undefined
  /** Collector base URL (OTLP/HTTP). @default env.OTEL_EXPORTER_OTLP_ENDPOINT */
  readonly target?: string | undefined
  /** @default process.env */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

/** Environment variable exposed to browser code for the same-origin OTLP path. */
export const endpointEnvKey = 'VITE_OTLP_ENDPOINT'

/** The proxy entry on its own, for configs that assemble `server.proxy` by hand. */
export const otlpProxyEntry = ({
  path,
  target,
}: {
  readonly path: string
  readonly target: string
}): Record<string, ProxyOptions> => ({
  [path]: {
    target,
    changeOrigin: true,
    rewrite: (url) => url.slice(path.length),
    configure: (proxy) => {
      proxy.on('proxyReq', (request) => request.removeHeader('cookie'))
    },
  },
})

/** Installs a cookie-stripping OTLP proxy when a collector is configured. */
export const otlpDevProxy = (options?: OtlpDevProxyOptions): Plugin => {
  const path = (options?.path ?? '/otlp').replace(/\/+$/, '')
  const env = options?.env ?? process.env
  const target = options?.target ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
  return {
    name: '@overeng/otel-browser:otlp-dev-proxy',
    config: () =>
      target === undefined || target === ''
        ? { define: { [`import.meta.env.${endpointEnvKey}`]: 'undefined' } }
        : {
            server: { proxy: otlpProxyEntry({ path, target }) },
            preview: { proxy: otlpProxyEntry({ path, target }) },
            define: { [`import.meta.env.${endpointEnvKey}`]: JSON.stringify(path) },
          },
  }
}
