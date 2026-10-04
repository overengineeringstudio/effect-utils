// Checked JavaScript: Vite config dependencies must load under Node from node_modules.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseCliBuildStamp, resolveCliBuildIdentity } from './cli-build-identity.js'

const virtualId = 'virtual:build-identity'
const resolvedId = `\0${virtualId}`

/** @param {string} root @returns {import('./cli-build-identity.js').LocalStamp} */
const localStamp = (root) => {
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return {
    type: 'local',
    rev: git(['rev-parse', '--short', 'HEAD']),
    ts: Math.floor(Date.now() / 1000),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}

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
  const resolveIdentity = () => {
    browserOptions = {
      baseVersion,
      buildStamp,
      env: embedded?.type === 'nix' ? {} : { CLI_BUILD_STAMP: JSON.stringify(localStamp(root)) },
    }
    identity = resolveCliBuildIdentity({
      ...browserOptions,
      // Only metadata is frozen to source time; the browser renders relative time at runtime.
      ...(embedded?.type === 'nix' ? { now: embedded.buildTs ?? embedded.commitTs } : {}),
    })
    if (identity.rev === undefined || identity.rev === '' || (identity.commitTs ?? identity.buildTs ?? 0) <= 0) {
      throw new Error('Browser builds require a real revision and timestamp in the shared build stamp')
    }
  }
  return {
    name: 'overeng:build-identity',
    configResolved(config) {
      root = config.root
      serving = config.command === 'serve'
      resolveIdentity()
    },
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined
    },
    load(id) {
      if (id !== resolvedId) return undefined
      const formatterPath = fileURLToPath(new URL('./cli-build-identity.js', import.meta.url))
      return `import { resolveCliBuildIdentity } from ${JSON.stringify(formatterPath)};\nexport const buildIdentity = resolveCliBuildIdentity(${JSON.stringify(browserOptions)});\nexport const deploymentId = ${serving ? JSON.stringify('dev (HMR)') : 'globalThis.__BUILD_DEPLOYMENT_ID__'};\n`
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-identity.json', source: `${JSON.stringify(identity, null, 2)}\n` })
    },
    handleHotUpdate(context) {
      if (embedded?.type === 'nix') return
      const previous = identity.machineVersion
      resolveIdentity()
      if (previous === identity.machineVersion) return
      const module = context.server.moduleGraph.getModuleById(resolvedId)
      if (module === undefined) return
      context.server.moduleGraph.invalidateModule(module)
      return [...context.modules, module]
    },
  }
}
