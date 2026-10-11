import { spawnSync } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Plain-flake consumers import `genie/external.ts` from a Nix store path that has no
 * `node_modules`. A bare npm specifier anywhere in its import graph resolves to whatever the
 * consumer's Bun finds (or auto-installs), not to this repo's pinned dependency.
 */
const peerFacadePath = fileURLToPath(new URL('../../../../../genie/external.ts', import.meta.url))

/** Bun's bundler follows the same resolution as the runtime loader and records every edge. */
const traceExternalImports = (entrypoint: string): ReadonlyArray<string> => {
  const result = spawnSync(
    'bun',
    [
      '-e',
      `
        const result = await Bun.build({
          entrypoints: [${JSON.stringify(entrypoint)}],
          target: 'bun',
          packages: 'external',
          metafile: true,
          throw: false,
        })
        if (!result.success) {
          console.error(result.logs.map(String).join('\\n'))
          process.exit(1)
        }
        const external = new Set()
        for (const input of Object.values(result.metafile.inputs)) {
          for (const edge of input.imports) if (edge.external) external.add(edge.path)
        }
        console.log(JSON.stringify([...external].toSorted()))
      `,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`bun import trace failed:\n${result.stderr}`)
  return JSON.parse(result.stdout) as ReadonlyArray<string>
}

describe('peer genie facade', () => {
  it('imports no npm packages, only relative modules and runtime builtins', () => {
    const npmImports = traceExternalImports(peerFacadePath).filter(
      (specifier) => isBuiltin(specifier) === false && specifier.startsWith('bun:') === false,
    )
    expect(npmImports).toEqual([])
  })
})
