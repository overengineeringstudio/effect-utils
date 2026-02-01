/**
 * CLI Commands
 *
 * Re-exports all CLI commands for assembly in the main CLI.
 */

export { addCommand } from './add.ts'
export { envCommand } from './env.ts'
export { execCommand } from './exec.ts'
export { initCommand } from './init.ts'
export { lsCommand } from './ls.ts'
export { pinCommand, unpinCommand } from './pin.ts'
export { rootCommand } from './root.ts'
export { statusCommand } from './status.ts'
export { syncCommand, syncMegarepo } from './sync.ts'

// Re-export errors from centralized errors module
export { NotInMegarepoError, LockFileRequiredError, StaleLockFileError } from '../errors.ts'

// Subcommand groups
export { storeCommand } from './store/mod.ts'
export { generateCommand } from './generate/mod.ts'
