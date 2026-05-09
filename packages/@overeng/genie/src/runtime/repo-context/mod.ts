import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo-local file access anchored at the repository that owns a generator module. */
export interface RepoContext {
  readonly name: string
  readonly rootPath: string
  readonly resolve: (...segments: ReadonlyArray<string>) => string
  readonly readText: (...segments: ReadonlyArray<string>) => string
  readonly readJson: <A = unknown>(...segments: ReadonlyArray<string>) => A
}

/** Inputs for deriving a repository context from a module's `import.meta.url`. */
export interface DefineRepoContextOptions {
  readonly name: string
  readonly importMetaUrl: string
}

const findRepoRoot = (startPath: string): string | undefined => {
  let current = dirname(startPath)
  const root = parse(current).root

  while (true) {
    if (existsSync(join(current, '.git')) === true) return current
    if (current === root) return undefined
    current = dirname(current)
  }
}

const recoverOriginalModulePath = (mirroredPath: string): string | undefined => {
  const parts = mirroredPath.split(sep).filter(Boolean)

  for (let index = 1; index < parts.length; index++) {
    const candidate = `${sep}${parts.slice(index).join(sep)}`
    if (
      isAbsolute(candidate) === true &&
      existsSync(candidate) === true &&
      findRepoRoot(candidate) !== undefined
    ) {
      return candidate
    }
  }

  return undefined
}

/** Find the closest repository root above the module identified by `importMetaUrl`. */
export const repoRootFromModuleUrl = (importMetaUrl: string): string => {
  const modulePath = fileURLToPath(importMetaUrl)
  const directRoot = findRepoRoot(modulePath)
  if (directRoot !== undefined) return directRoot

  const originalModulePath = recoverOriginalModulePath(modulePath)
  if (originalModulePath !== undefined) {
    const recoveredRoot = findRepoRoot(originalModulePath)
    if (recoveredRoot !== undefined) return recoveredRoot
  }

  throw new Error(`Could not find repository root for module ${importMetaUrl}`)
}

/** Create a repo context for generator code that may run from aggregate megarepos. */
export const defineRepoContext = ({
  name,
  importMetaUrl,
}: DefineRepoContextOptions): RepoContext => {
  const rootPath = repoRootFromModuleUrl(importMetaUrl)
  const resolve = (...segments: ReadonlyArray<string>) => join(rootPath, ...segments)

  return {
    name,
    rootPath,
    resolve,
    readText: (...segments) => readFileSync(resolve(...segments), 'utf8'),
    readJson: <A = unknown>(...segments: ReadonlyArray<string>) =>
      JSON.parse(readFileSync(resolve(...segments), 'utf8')) as A,
  }
}
