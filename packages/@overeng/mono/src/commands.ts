/** Re-export all commands from the commands directory */
export {
  buildCommand,
  checkCommandWithTaskSystem,
  cleanCommand,
  installCommand,
  lintCommand,
  nixCommand,
  testCommand,
  tsCommand,
} from './commands/mod.ts'
