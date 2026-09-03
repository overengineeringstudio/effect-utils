import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Availability contract for the CI helper scripts a generated workflow step invokes.
 *
 * `prepareCiScriptsStep` copies the *consuming* repository's `genie/ci-scripts/` into the
 * job-local `.../composition-state/ci-runtime/` directory, and the only thing that puts files
 * into a consumer's `genie/ci-scripts/` is `ciWorkflowSupportFiles`. A generated step may
 * therefore only invoke scripts that `ciWorkflowSupportFiles` emits: any other script exists in
 * this repo alone, so the step resolves here and dies with exit 127 in every consumer.
 *
 * That is not hypothetical. `validateNixStoreStepFor` invoked
 * `.../ci-runtime/resolve-devenv-ci.sh` while `resolve-devenv-ci.sh` was a hand-committed
 * effect-utils file with no support-file entry, which failed all 14 jobs of
 * schickling/schickling.dev#178 (run 33752627726) at
 * `resolve-devenv-ci.sh: No such file or directory`, while effect-utils' own CI stayed green.
 *
 * The assertions below read the shared generator source, the generated workflows and the
 * emitted scripts, so the reference and its availability can never drift apart again.
 */

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

const readRepoText = (repoRelativePath: string) =>
  readFileSync(join(repoRoot, repoRelativePath), 'utf8')

/** Recursive file walk, sorted for deterministic failure output. */
const repoFiles = (repoRelativeDir: string, extension: string): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory() === true) return walk(path)
        return entry.isFile() === true && entry.name.endsWith(extension) === true ? [path] : []
      })
      .sort()

  return walk(repoRelativeDir)
}

/**
 * Kept as literals rather than imported: this package is the generator runtime that
 * `genie/ci-workflow/` builds on, so it must not import back out of it. The two assertions in
 * `describe('ci runtime script directories')` fail the moment either literal drifts from
 * `genie/ci-workflow/shared.ts`.
 */
const ciScriptsDir = 'genie/ci-scripts'
const preparedCiScriptsDirSuffix = 'composition-state/ci-runtime'

const supportFilesModule = 'genie/ci-workflow/support-files.ts'
const sharedModule = 'genie/ci-workflow/shared.ts'

const supportFilesSource = readRepoText(supportFilesModule)
const sharedSource = readRepoText(sharedModule)

/** `export const ciWorkflowResolveDevenvScriptPath = 'genie/ci-scripts/resolve-devenv.sh'` */
const supportFilePathConstants = new Map(
  Array.from(
    supportFilesSource.matchAll(/export const (\w+Path)\s*=\s*(?:\r?\n\s*)?'([^']+)'/g),
    ([, constant, path]) => [constant ?? '', path ?? ''] as const,
  ),
)

const supportFilesEntriesSource = (() => {
  const startMarker = 'export const ciWorkflowSupportFiles = {'
  const start = supportFilesSource.indexOf(startMarker)
  if (start < 0) throw new Error(`missing ${startMarker} in ${supportFilesModule}`)

  const end = supportFilesSource.indexOf('\n} as const', start)
  if (end < 0) throw new Error(`missing end of ciWorkflowSupportFiles in ${supportFilesModule}`)

  return supportFilesSource.slice(start, end)
})()

/** Every `path:` an entry of `ciWorkflowSupportFiles` emits, as a repo-relative path. */
const emittedSupportFilePaths = Array.from(
  supportFilesEntriesSource.matchAll(/\bpath:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g),
).map(([match, literalPath, pathConstant]) => {
  if (literalPath !== undefined) return literalPath

  const resolved =
    pathConstant === undefined ? undefined : supportFilePathConstants.get(pathConstant)
  if (resolved === undefined) {
    throw new Error(`ciWorkflowSupportFiles entry has an unresolvable path: ${match}`)
  }

  return resolved
})

const emittedCiScriptNames = new Set(
  emittedSupportFilePaths
    .filter((path) => path.startsWith(`${ciScriptsDir}/`) === true)
    .map((path) => path.slice(path.lastIndexOf('/') + 1)),
)

/**
 * Script references a consumer must be able to resolve, keyed by script name so a
 * failure names both the missing script and the source that asks for it.
 */
const collectReferences = (
  sources: readonly { readonly origin: string; readonly text: string }[],
  pattern: RegExp,
): Map<string, string[]> => {
  const references = new Map<string, string[]>()

  for (const { origin, text } of sources) {
    for (const [, referenced] of text.matchAll(new RegExp(pattern.source, 'g'))) {
      if (referenced === undefined) continue
      const origins = references.get(referenced)
      if (origins === undefined) {
        references.set(referenced, [origin])
      } else if (origins.includes(origin) === false) {
        origins.push(origin)
      }
    }
  }

  return references
}

const unavailable = (references: Map<string, string[]>) =>
  Array.from(references)
    .filter(([referenced]) => emittedCiScriptNames.has(referenced) === false)
    .map(([referenced, origins]) => `${referenced} <- ${origins.join(', ')}`)
    .sort()

const generatorSources = repoFiles('genie', '.ts').map((path) => ({
  origin: path,
  text: readRepoText(path),
}))

const generatedWorkflowSources = repoFiles('.github/workflows', '.yml').map((path) => ({
  origin: path,
  text: readRepoText(path),
}))

/**
 * Emitted shell scripts as they exist in this repo. A path that is declared but not
 * materialized is skipped here so that `ships every emitted support file` reports it as a
 * list of missing paths, rather than this module throwing before any assertion runs.
 */
const emittedScriptSources = emittedSupportFilePaths
  .filter((path) => path.endsWith('.sh') === true && existsSync(join(repoRoot, path)) === true)
  .map((path) => ({ origin: path, text: readRepoText(path) }))

describe('ci runtime script directories', () => {
  it('tracks the script directory literals declared by the shared generator', () => {
    expect(sharedSource).toContain(`export const defaultCiRuntimeScriptsDir = '${ciScriptsDir}'`)
    expect(sharedSource).toContain(
      "export const ciCompositionStateRoot = '${{ runner.temp }}/composition-state'",
    )
    expect(sharedSource).toContain(
      'export const preparedCiRuntimeScriptsDir = `${ciCompositionStateRoot}/ci-runtime`',
    )
  })

  it('extracts the emitted support-file set from ciWorkflowSupportFiles', () => {
    expect(emittedSupportFilePaths).toContain(`${ciScriptsDir}/resolve-devenv.sh`)
    expect(emittedSupportFilePaths).toContain(`${ciScriptsDir}/nix-gc-race-retry.sh`)
    expect(emittedSupportFilePaths).toContain(`${ciScriptsDir}/run-with-nix-gc-race-retry.sh`)
    expect(new Set(emittedSupportFilePaths).size).toBe(emittedSupportFilePaths.length)
  })
})

describe('ci runtime scripts referenced by generated steps are emitted to consumers', () => {
  it('resolves every script the shared generator invokes through a CI scripts directory', () => {
    const references = collectReferences(
      generatorSources,
      /\$\{[A-Za-z0-9]*[sS]criptsDir\}\/([A-Za-z0-9._-]+\.(?:sh|mjs|js))/,
    )

    expect(references.size).toBeGreaterThan(0)
    expect(unavailable(references)).toEqual([])
  })

  it('resolves every ci-runtime script a generated workflow step invokes', () => {
    const references = collectReferences(
      generatedWorkflowSources,
      new RegExp(`${preparedCiScriptsDirSuffix}/([A-Za-z0-9._-]+)`),
    )

    expect(references.size).toBeGreaterThan(0)
    expect(unavailable(references)).toEqual([])
  })

  it('resolves every sibling script an emitted support script sources', () => {
    const references = collectReferences(
      emittedScriptSources,
      /\$\{?script_dir\}?\/([A-Za-z0-9._-]+)/,
    )

    expect(references.size).toBeGreaterThan(0)
    expect(unavailable(references)).toEqual([])
  })

  it('ships every emitted support file in this repo', () => {
    const missing = emittedSupportFilePaths.filter((path) => {
      const absolute = join(repoRoot, path)
      return existsSync(absolute) === false || statSync(absolute).isFile() === false
    })

    expect(missing).toEqual([])
  })
})
