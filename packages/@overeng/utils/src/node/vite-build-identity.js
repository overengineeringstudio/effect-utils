// Checked JavaScript: Vite config dependencies must load under Node from node_modules.
import { execFile } from 'node:child_process'
import { watchFile, unwatchFile } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseCliBuildStamp, resolveCliBuildIdentity } from './cli-build-identity.js'

const virtualId = 'virtual:build-identity'
const resolvedId = `\0${virtualId}`

const execFileAsync = promisify(execFile)

/** @param {{ root: string, args: string[] }} options */
const readGit = async ({ root, args }) =>
  (
    await execFileAsync('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8',
    })
  ).stdout.trim()

/** @param {string} root @returns {Promise<import('./cli-build-identity.js').LocalStamp>} */
const localStamp = async (root) => ({
  type: 'local',
  rev: await readGit({ root, args: ['rev-parse', 'HEAD'] }),
  ts: Math.floor(Date.now() / 1000),
  dirty: (await readGit({ root, args: ['status', '--porcelain=v1', '--untracked-files=no'] })) !== '',
})

/**
 * Emit the shared CLI identity as a browser-safe virtual module and JSON asset.
 * A declared deployment injects its closure identity before browser modules execute.
 * Local source identity is read from Vite's root, not a possibly stale shell's stamp.
 * @param {import('./vite-build-identity-types.d.ts').BuildIdentityPluginOptions} options
 * @returns {import('vite').Plugin}
 */
export const createBuildIdentityPlugin = ({ baseVersion, buildStamp }) => {
  /** @type {import('./cli-build-identity.js').CliBuildIdentity} */
  let identity
  let serving = false
  let root = ''
  /** @type {import('./cli-build-identity.js').ResolveBuildIdentityOptions} */
  let browserOptions
  const embedded = parseCliBuildStamp(buildStamp)
  /** @type {Array<() => Promise<void>>} */
  const cleanup = []
  const resolveIdentity = async (preserveSnapshot = false) => {
    const options = {
      baseVersion,
      buildStamp,
      env: embedded?.type === 'nix' ? {} : { CLI_BUILD_STAMP: JSON.stringify(await localStamp(root)) },
    }
    const nextIdentity = resolveCliBuildIdentity({
      ...options,
      // Only metadata is frozen to source time; the browser renders relative time at runtime.
      ...(embedded?.type === 'nix' ? { now: embedded.buildTs ?? embedded.commitTs } : {}),
    })
    if (
      nextIdentity.rev === undefined ||
      nextIdentity.rev === '' ||
      (nextIdentity.commitTs ?? nextIdentity.buildTs ?? 0) <= 0
    ) {
      throw new Error(
        'Browser builds require a real revision and timestamp in the shared build stamp',
      )
    }
    if (preserveSnapshot === true && identity.machineVersion === nextIdentity.machineVersion)
      return false
    browserOptions = options
    identity = nextIdentity
    return true
  }
  return {
    name: 'overeng:build-identity',
    async configResolved(config) {
      root = config.root
      serving = config.command === 'serve'
      await resolveIdentity()
    },
    async buildStart() {
      if (serving === false && embedded?.type !== 'nix') await resolveIdentity()
    },
    shouldTransformCachedModule({ id }) {
      if (id === resolvedId && embedded?.type !== 'nix') return true
      return undefined
    },
    async configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          request.url?.split('?')[0] !== '/build-identity.json' ||
          (request.method !== 'GET' && request.method !== 'HEAD')
        ) {
          next()
          return
        }
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        response.end(request.method === 'HEAD' ? undefined : `${JSON.stringify(identity)}\n`)
      })
      if (embedded?.type === 'nix') return
      let stopped = false
      let pending = false
      let requestedAt = 0
      /** @type {Promise<void> | undefined} */
      let flight
      /** @type {Map<string, () => void>} */
      const watched = new Map()
      const worktreePaths = await Promise.all(
        ['HEAD', 'index'].map((name) =>
          readGit({ root, args: ['rev-parse', '--path-format=absolute', '--git-path', name] }),
        ),
      )
      /** @param {string} path */
      const subscribe = (path) => {
        if (watched.has(path) === true || stopped === true) return
        const listener = () => {
          void refresh().catch(reportError)
        }
        // Poll exact files: Git replaces refs/index atomically and loose refs
        // may not exist yet. Never subscribe to sibling branches or worktrees.
        watchFile(path, { persistent: false, interval: 100 }, listener)
        watched.set(path, listener)
      }
      const updateWatches = async () => {
        // Subscribe to HEAD before discovering its branch, then subscribe to
        // that ref before reading identity. A checkout/commit cannot fall in
        // a gap between snapshotting and installing the new branch watch.
        for (const path of worktreePaths) subscribe(path)
        const branch = await readGit({ root, args: ['rev-parse', '--symbolic-full-name', 'HEAD'] })
        const paths = new Set(worktreePaths)
        if (branch !== 'HEAD') {
          const path = await readGit({
            root,
            args: ['rev-parse', '--path-format=absolute', '--git-path', branch],
          })
          paths.add(path)
          subscribe(path)
        }
        for (const [path, listener] of watched) {
          if (paths.has(path) === false) {
            unwatchFile(path, listener)
            watched.delete(path)
          }
        }
      }
      /** @param {unknown} error */
      const reportError = (error) =>
        server.config.logger.error(`Build identity refresh failed: ${String(error)}`)
      /** @returns {Promise<void>} */
      const refresh = () => {
        pending = true
        requestedAt = performance.now()
        if (flight !== undefined) return flight
        flight = (async () => {
          while (pending === true && stopped === false) {
            // Coalesce source and Git events, including events received while
            // the previous async Git snapshot was being read.
            await delay(Math.max(0, requestedAt + 50 - performance.now()))
            if (stopped) break
            if (performance.now() < requestedAt + 50) continue
            pending = false
            await updateWatches()
            if (stopped) break
            const changed = await resolveIdentity(true)
            if (changed === false || stopped) continue
            const module = server.moduleGraph.getModuleById(resolvedId)
            if (module === undefined) continue
            server.moduleGraph.invalidateModule(module)
            server.ws.send({ type: 'full-reload' })
          }
        })().finally(() => {
          flight = undefined
        })
        return flight
      }
      const onSourceEvent = () => {
        void refresh().catch(reportError)
      }
      server.watcher.on('add', onSourceEvent)
      server.watcher.on('unlink', onSourceEvent)
      server.watcher.on('change', onSourceEvent)
      cleanup.push(async () => {
        stopped = true
        server.watcher.off('add', onSourceEvent)
        server.watcher.off('unlink', onSourceEvent)
        server.watcher.off('change', onSourceEvent)
        for (const [path, listener] of watched) unwatchFile(path, listener)
        watched.clear()
        await flight
      })
      await refresh()
    },
    async closeBundle() {
      for (const dispose of cleanup.splice(0)) await dispose()
    },
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined
    },
    load(id) {
      if (id !== resolvedId) return undefined
      const formatterPath = fileURLToPath(new URL('./cli-build-identity.js', import.meta.url))
      return `import { resolveCliBuildIdentity } from ${JSON.stringify(formatterPath)};\nexport const buildIdentity = resolveCliBuildIdentity(${JSON.stringify(browserOptions)});\nexport const deploymentId = ${serving === true ? JSON.stringify('dev (HMR)') : 'globalThis.__BUILD_DEPLOYMENT_ID__'};\n`
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-identity.json',
        source: `${JSON.stringify(identity, null, 2)}\n`,
      })
    },
    // Source changes and Git metadata share the same debounced single-flight
    // refresh above; Vite's normal HMR processing never runs Git synchronously.
  }
}
