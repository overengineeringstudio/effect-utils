/** Re-export all commands from the commands directory */
export {
  buildCommand,
  checkCommand,
  checkCommandCI,
  checkCommandInteractive,
  cleanCommand,
  createStandardCheckConfig,
  installCommand,
  lintCommand,
  testCommand,
  tsCommand,
} from './commands/mod.ts'

export type {
  CheckCommandConfig,
  CheckTask,
  CheckTaskError,
  CheckTaskRequirements,
} from './commands/mod.ts'
