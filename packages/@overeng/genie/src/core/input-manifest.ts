import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'

import { Effect, Semaphore } from 'effect'

import {
  beginInputRecording,
  endInputRecording,
  inputReadFileSync,
  isInputRecording,
  isInputRecordingComplete,
  markInputRecordingIncomplete,
  recordInput,
} from '../runtime/node/inputs.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { resolveImportMapSpecifierForImporterSync } from './import-map/sync-resolver.ts'

const recordingPermit = Semaphore.makeUnsafe(1)

/** Record the runtime source graph even when Bun has already cached imported modules. */
export const recordGeneratorSourceGraph = ({
  entries,
  cwd,
}: {
  entries: ReadonlyArray<string>
  cwd: string
}): void => {
  const pending = [...entries]
  if (isInputRecording() === false) return
  const seen = new Set<string>()
  const recordedScopes = new Set<string>()
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })
  while (pending.length > 0) {
    const sourcePath = pending.pop()!
    if (seen.has(sourcePath) === true) continue
    seen.add(sourcePath)
    recordInput(sourcePath)
    let scope = path.dirname(sourcePath)
    while (recordedScopes.has(scope) === false) {
      recordedScopes.add(scope)
      recordInput(path.join(scope, 'package.json'))
      const parent = path.dirname(scope)
      if (parent === scope) break
      scope = parent
    }
    if (/\.[cm]?[jt]sx?$/.test(sourcePath) === false) continue
    let imports: ReadonlyArray<{ path: string }>
    try {
      imports = transpiler.scanImports(inputReadFileSync(sourcePath, 'utf8'))
    } catch {
      // Optional imports keep their runtime semantics, but unknown closure is not cacheable.
      markInputRecordingIncomplete()
      continue
    }
    for (const { path: specifier } of imports) {
      if (isBuiltin(specifier) === true) continue
      let mapped: string | undefined
      try {
        mapped =
          specifier.startsWith('#') === true
            ? resolveImportMapSpecifierForImporterSync({
                specifier,
                importerPath: sourcePath,
                workspaceRoot: cwd,
              })
            : undefined
      } catch {
        // Resolver errors leave the closure unknown, even when the runtime catches them.
        markInputRecordingIncomplete()
        continue
      }
      const base = mapped ?? specifier
      if (
        base.startsWith('.') === false &&
        base.startsWith('#') === false &&
        path.isAbsolute(base) === false
      ) {
        const packageName = base
          .split('/')
          .slice(0, base.startsWith('@') === true ? 2 : 1)
          .join('/')
        let directory = path.dirname(sourcePath)
        while (true) {
          recordInput(path.join(directory, 'node_modules', packageName))
          recordInput(path.join(directory, 'node_modules', packageName, 'package.json'))
          const parent = path.dirname(directory)
          if (parent === directory) break
          directory = parent
        }
      }
      // Record candidate paths too: adding a higher-priority file can change resolution.
      if (base.startsWith('.') === true || path.isAbsolute(base) === true) {
        const absolute = path.resolve(path.dirname(sourcePath), base)
        for (const suffix of [
          '',
          '.ts',
          '.tsx',
          '.mts',
          '.cts',
          '.js',
          '.mjs',
          '/index.ts',
          '/index.tsx',
          '/index.js',
          '/mod.ts',
          '/mod.tsx',
        ]) {
          recordInput(`${absolute}${suffix}`)
        }
      }
      let resolved: string
      let canonical: string
      try {
        resolved = Bun.resolveSync(base, path.dirname(sourcePath))
        canonical = realpathSync(resolved)
      } catch {
        // Missing optional exports can resolve through arbitrary package metadata.
        // Do not guess their eventual targets or publish a cacheable closure.
        markInputRecordingIncomplete()
        continue
      }
      // A bare workspace package can resolve through a node_modules symlink. Decide
      // whether this is installed dependency code only after following that symlink.
      if (canonical.includes(`${path.sep}node_modules${path.sep}`) === false) {
        recordInput(resolved)
        pending.push(canonical)
      }
    }
  }
}

/** Publish only a successfully completed full generation, using a same-directory rename. */
export const withInputManifest = <TOutput, TError, TRequirements>({
  effect,
  complete,
}: {
  effect: Effect.Effect<TOutput, TError, TRequirements>
  complete: boolean
}): Effect.Effect<TOutput, TError | GenieGenerationFailedError, TRequirements> => {
  const destination = process.env.GENIE_INPUT_MANIFEST
  if (destination === undefined || destination === '' || complete === false) return effect
  const manifestPath = path.resolve(destination)
  return recordingPermit.withPermits(1)(
    Effect.acquireUseRelease(
      Effect.sync(beginInputRecording),
      (inputs) =>
        effect.pipe(
          Effect.tap(() =>
            Effect.tryPromise({
              try: async () => {
                const temporary = `${manifestPath}.${randomUUID()}.tmp`
                try {
                  await fs.writeFile(
                    temporary,
                    `${isInputRecordingComplete() === true ? 'genie-inputs-v1' : 'genie-inputs-incomplete'}\n${[
                      ...inputs,
                    ]
                      .sort()
                      .map((input) => `${input}\n`)
                      .join('')}`,
                    { flag: 'wx' },
                  )
                  if ([...inputs].some((input) => /[\r\n]/.test(input)) === true) {
                    throw new Error('Generator input paths cannot contain newlines')
                  }
                  await fs.rename(temporary, manifestPath)
                } finally {
                  await fs.rm(temporary, { force: true })
                }
              },
              catch: (cause) =>
                new GenieGenerationFailedError({
                  failedCount: 1,
                  message: `Failed to publish generator input manifest ${manifestPath}: ${String(cause)}`,
                  files: [],
                }),
            }),
          ),
        ),
      () => Effect.sync(endInputRecording),
    ),
  )
}
