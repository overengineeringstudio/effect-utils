// Checked JavaScript: Vite config dependencies must load under Node from node_modules.
import { execFile } from 'node:child_process'
import { constants, watchFile, unwatchFile } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

/**
 * Resolve ordinary loose/packed refs without subprocesses, including linked worktrees.
 * Register each watch before reading it so atomic ref replacements cannot fall in a gap.
 * @param {string} root
 * @param {(path: string) => void} [subscribe]
 * @returns {Promise<{rev: string, paths: Set<string>}>}
 */
export const readWorktreeGitMetadata = async (root, subscribe) => {
  /** @type {Set<string>} */
  const paths = new Set()
  /** @param {string} path */
  const watch = (path) => {
    paths.add(path)
    subscribe?.(path)
  }
  try {
    let directory = resolve(root)
    /** @type {string | undefined} */
    let gitDir
    while (gitDir === undefined) {
      const candidate = join(directory, '.git')
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- discover the nearest enclosing repository
        const info = await stat(candidate)
        gitDir = info.isDirectory()
          ? candidate
          : // oxlint-disable-next-line eslint/no-await-in-loop -- gitdir files resolve relative to their repository
            resolve(directory, (await readFile(candidate, 'utf8')).trim().replace(/^gitdir: /, ''))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        const parent = dirname(directory)
        if (parent === directory) throw error
        directory = parent
      }
    }
    let commonDir = gitDir
    try {
      commonDir = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim())
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const config = await readFile(join(commonDir, 'config'), 'utf8')
    if (/^\s*refstorage\s*=\s*reftable\s*$/im.test(config)) {
      throw new Error('Reftable requires Git ref resolution')
    }
    const headPath = join(gitDir, 'HEAD')
    watch(headPath)
    watch(join(gitDir, 'index'))
    let head = (await readFile(headPath, 'utf8')).trim()
    /** @type {Set<string>} */
    const seen = new Set()
    while (head.startsWith('ref: ')) {
      const ref = head.slice(5)
      if (seen.has(ref)) throw new Error('Cyclic Git symbolic ref')
      seen.add(ref)
      const refPath = join(commonDir, ref)
      watch(refPath)
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- follow Git symbolic refs in order
        head = (await readFile(refPath, 'utf8')).trim()
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        const packedPath = join(commonDir, 'packed-refs')
        watch(packedPath)
        // oxlint-disable-next-line eslint/no-await-in-loop -- loose refs take precedence over packed refs
        const packed = await readFile(packedPath, 'utf8')
        const entry = packed.split('\n').find((line) => line.endsWith(` ${ref}`))
        if (entry === undefined) throw new Error(`Git ref not found: ${ref}`)
        head = entry.slice(0, entry.indexOf(' '))
      }
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error('Invalid Git object ID')
    if (seen.size === 0) {
      // Git verifies detached revisions whose object is packed, missing, or unreadable.
      await access(join(commonDir, 'objects', head.slice(0, 2), head.slice(2)), constants.R_OK)
    }
    return { rev: head, paths }
  } catch {
    // Git remains the authority for reftable, object alternates, and unusual layouts.
    const [rev, headPath, indexPath, branch, refFormat] = await Promise.all([
      readGit({ root, args: ['rev-parse', '--verify', 'HEAD^{commit}'] }),
      readGit({ root, args: ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'] }),
      readGit({ root, args: ['rev-parse', '--path-format=absolute', '--git-path', 'index'] }),
      readGit({ root, args: ['rev-parse', '--symbolic-full-name', 'HEAD'] }),
      readGit({ root, args: ['rev-parse', '--show-ref-format'] }),
    ])
    watch(headPath)
    watch(indexPath)
    if (branch !== 'HEAD') {
      watch(
        await readGit({
          root,
          args: ['rev-parse', '--path-format=absolute', '--git-path', branch],
        }),
      )
    }
    if (refFormat === 'reftable') {
      watch(
        await readGit({
          root,
          args: ['rev-parse', '--path-format=absolute', '--git-path', 'reftable/tables.list'],
        }),
      )
    }
    return { rev, paths }
  }
}

/**
 * @param {string} root
 * @param {ReturnType<typeof readWorktreeGitMetadata>} metadata
 * @returns {Promise<import('./cli-build-identity.js').LocalStamp>}
 */
const localStamp = async (root, metadata) => {
  const [git, status] = await Promise.all([
    metadata,
    readGit({ root, args: ['status', '--porcelain=v1', '--untracked-files=no'] }),
  ])
  return { type: 'local', rev: git.rev, ts: Math.floor(Date.now() / 1000), dirty: status !== '' }
}

/**
 * Emit the shared CLI identity as a browser-safe virtual module and JSON asset.
 * A declared deployment injects its closure identity before browser modules execute.
 * Local source identity is read from Vite's root, not a possibly stale shell's stamp.
 * @param {import('./vite-build-identity-types.d.ts').BuildIdentityPluginOptions} options
 * @returns {import('vite').Plugin & import('./vite-build-identity-types.d.ts').BuildIdentityVitePlugin}
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
  /** @type {Promise<void> | undefined} */
  let refreshFlight
  /**
   * @param {boolean} [preserveSnapshot]
   * @param {ReturnType<typeof readWorktreeGitMetadata>} [metadata]
   */
  const resolveIdentity = async (preserveSnapshot = false, metadata) => {
    const options = {
      baseVersion,
      buildStamp,
      env:
        embedded?.type === 'nix'
          ? {}
          : {
              CLI_BUILD_STAMP: JSON.stringify(
                await localStamp(root, metadata ?? readWorktreeGitMetadata(root)),
              ),
            },
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
    api: {
      async waitForRefresh() {
        await refreshFlight
      },
    },
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
      // Query closure-owned lifecycle state anew after each async boundary.
      const isStopped = () => stopped
      let pending = false
      let requestedAt = 0
      /** @type {Promise<void> | undefined} */
      let flight
      /** @type {Map<string, () => void>} */
      const watched = new Map()
      /** @param {string} path */
      const subscribe = (path) => {
        if (watched.has(path) === true || isStopped() === true) return
        const listener = () => {
          void refresh().catch(reportError)
        }
        // Poll exact files: Git replaces refs/index atomically and loose refs
        // may not exist yet. Never subscribe to sibling branches or worktrees.
        watchFile(path, { persistent: false, interval: 100 }, listener)
        watched.set(path, listener)
      }
      const updateWatches = async () => {
        const metadata = await readWorktreeGitMetadata(root, subscribe)
        const { paths } = metadata
        for (const [path, listener] of watched) {
          if (paths.has(path) === false) {
            unwatchFile(path, listener)
            watched.delete(path)
          }
        }
        return metadata
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
          while (pending === true) {
            // Coalesce source and Git events, including events received while
            // the previous async Git snapshot was being read.
            // oxlint-disable-next-line eslint/no-await-in-loop -- debounce and snapshots must remain single-flight
            await delay(Math.max(0, requestedAt + 50 - performance.now()))
            if (isStopped() === true) break
            if (performance.now() < requestedAt + 50) continue
            pending = false
            // oxlint-disable-next-line eslint/no-await-in-loop -- snapshots cannot overlap
            const changed = await resolveIdentity(true, updateWatches())
            if (changed === false || isStopped() === true) continue
            const module = server.moduleGraph.getModuleById(resolvedId)
            if (module === undefined) continue
            server.moduleGraph.invalidateModule(module)
            server.ws.send({ type: 'full-reload' })
          }
        })().finally(() => {
          flight = undefined
        })
        refreshFlight = flight
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
      await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
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
