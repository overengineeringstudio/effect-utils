import { darwinArm64Runner, linuxArm64Runner, linuxX64Runner } from './shared.ts'
import type { BinaryCacheDescriptor } from './binary-cache-descriptors.ts'

export class PrivateBinaryCacheRunnerError extends Error {
  readonly _tag = 'PrivateBinaryCacheRunnerError'
  constructor(readonly cacheName: string, readonly runner: string | readonly string[]) {
    super(`Private build cache ${cacheName} requires a static fleet sh-* runner`)
    this.name = 'PrivateBinaryCacheRunnerError'
  }
}

export class ConflictingBinaryCacheError extends Error {
  readonly _tag = 'ConflictingBinaryCacheError'
  constructor(readonly cacheName: string) {
    super(`Conflicting build cache descriptor: ${cacheName}`)
    this.name = 'ConflictingBinaryCacheError'
  }
}

const fleetLabels: readonly string[] = [
  linuxX64Runner[0],
  linuxArm64Runner[0],
  darwinArm64Runner[0],
]

/** Static fleet labels only; namespace, GitHub-hosted, dynamic and mixed selectors fail closed. */
export const isFleetCacheRunner = (runner: string | readonly string[]): boolean => {
  const labels = typeof runner === 'string' ? [runner] : runner
  return labels.some((label) => fleetLabels.includes(label)) &&
    labels.every((label) => label === 'nix' || fleetLabels.includes(label))
}

/** A descriptor never carries credentials. REAPI metadata does not become Nix config. */
export const binaryCachesExtraConfForJob = ({ runner, caches }: {
  readonly runner: string | readonly string[]
  readonly caches: readonly BinaryCacheDescriptor[]
}): string => {
  const resolved = new Map<string, BinaryCacheDescriptor>()
  for (const cache of caches) {
    if (cache.visibility === 'private' && !isFleetCacheRunner(runner)) {
      throw new PrivateBinaryCacheRunnerError(cache.name, runner)
    }
    const previous = resolved.get(cache.name)
    const conflict = previous !== undefined && (
      previous.kind !== cache.kind ||
      previous.visibility !== cache.visibility ||
      (previous.kind === 'nix-binary' && cache.kind === 'nix-binary' &&
        (previous.uri !== cache.uri || previous.publicKey !== cache.publicKey)) ||
      (previous.kind === 'reapi' && cache.kind === 'reapi' &&
        (previous.endpoint !== cache.endpoint || previous.instanceName !== cache.instanceName || previous.digest !== cache.digest))
    )
    if (conflict) {
      throw new ConflictingBinaryCacheError(cache.name)
    }
    resolved.set(cache.name, cache)
  }
  const nixCaches = [...resolved.values()].filter((cache) => cache.kind === 'nix-binary')
  const uris = new Map<string, string>()
  for (const cache of nixCaches) {
    const previous = uris.get(cache.uri)
    if (previous !== undefined && previous !== cache.publicKey) {
      throw new ConflictingBinaryCacheError(cache.name)
    }
    uris.set(cache.uri, cache.publicKey)
  }
  return [
    `extra-substituters = ${nixCaches.map((cache) => cache.uri).join(' ')}`,
    `extra-trusted-public-keys = ${nixCaches.map((cache) => cache.publicKey).join(' ')}`,
  ].join('\n')
}
