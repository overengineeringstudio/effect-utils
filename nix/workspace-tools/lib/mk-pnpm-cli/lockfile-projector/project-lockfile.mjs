import { readWantedLockfile, writeWantedLockfile } from '@pnpm/lockfile.fs'
import { pruneSharedLockfile } from '@pnpm/lockfile.pruner'

const [lockfileDir, ...importerIds] = process.argv.slice(2)
if (lockfileDir === undefined || importerIds.length === 0) {
  throw new Error('usage: project-lockfile.mjs <lockfile-dir> <importer-id>...')
}

const lockfile = await readWantedLockfile(lockfileDir, { ignoreIncompatible: false })
if (lockfile === null) {
  throw new Error(`lockfile is missing from ${lockfileDir}`)
}

const importers = Object.fromEntries(
  importerIds.map((importerId) => {
    const importer = lockfile.importers[importerId]
    if (importer === undefined) {
      throw new Error(`lockfile is missing importer ${importerId}`)
    }
    return [importerId, importer]
  }),
)

const projectedLockfile = pruneSharedLockfile(
  {
    ...lockfile,
    importers,
  },
  {
    warn: (message) => {
      throw new Error(`cannot project incomplete lockfile closure: ${message}`)
    },
  },
)

await writeWantedLockfile(lockfileDir, projectedLockfile)
